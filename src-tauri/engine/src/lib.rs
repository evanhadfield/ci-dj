//! SlipMate native audio engine (Phase 1, Slice 1).
//!
//! A device-free, RT-safe two-deck mix core plus a thin cpal device wrapper.
//! This is the production home of the engine ported from the Spike A
//! `rt_engine` (`spike/rust-audio/engine/src/bin/rt_engine.rs`); the spike
//! proved feasibility, this crate is the real thing.
//!
//! # Shape
//!
//! - [`Engine`] owns the device-free core. [`Engine::render`] is a **pure**,
//!   RT-safe drain-and-mix over an output buffer — no device, no allocation, no
//!   lock, no syscall — so the whole mix is testable headless in CI
//!   (`cargo test`). The [`device`] module is a thin cpal wrapper that calls
//!   `render` from its callback.
//! - Each deck is fed by its **own** `rtrb` SPSC ring (30 s capacity, 1.5 s
//!   prebuffer). A [`DeckHandle`] is the non-RT producer side; its
//!   [`DeckHandle::post_pcm`] is the SOLE writer. `Engine::render` is the SOLE
//!   drainer. Neither side locks; the consumer side never allocates.
//!
//! # The non-RT → RT handoff (the load-bearing design)
//!
//! `post_pcm` (non-RT) and `render` (RT) communicate ONLY through the per-deck
//! `rtrb` ring, a wait-free single-producer/single-consumer queue. The producer
//! half lives behind [`DeckHandle`] (moved to the IO/transport thread); the
//! consumer half lives inside [`Engine`] (moved to the audio thread). Because
//! each ring has exactly one writer and one reader and they are split across the
//! two halves, the handoff needs no mutex and the RT side allocates nothing —
//! it only pops samples and ticks pre-built `fundsp` nodes.
//!
//! Control values that the RT path reads (the crossfade gains, and in later
//! slices EQ/FX) live on the `Engine` itself and are set through `&mut Engine`,
//! so by Rust's ownership rules a control mutation and a `render` call cannot
//! overlap. When the device wrapper owns the `Engine` in its callback, control
//! commands are delivered to that thread over a separate wait-free channel (the
//! device layer's job, a later slice); the core API here keeps the mutation and
//! the render on the same `&mut self` so it stays trivially data-race-free and
//! fully testable.

mod fx;
mod graph;
mod playback;
mod ring;
pub mod telemetry;

pub use fx::FxKind;
pub use playback::{LoopRegion, TrackStatus};

#[cfg(not(target_arch = "wasm32"))]
pub mod device;

use std::sync::Arc;

use graph::MixGraph;
use playback::{BufferSource, DeckSource};
use ring::{new_deck_ring, RingConsumer, RingProducer};
use telemetry::Telemetry;

/// Output sample rate. The engine renders at exactly this rate; the device
/// wrapper requires an exact-match device config (resampling is out of scope).
pub const SAMPLE_RATE: u32 = 48_000;

/// Output channel count (interleaved stereo).
pub const CHANNELS: u16 = 2;

/// Number of model decks. Two for the foreseeable design (deck A + deck B).
pub const DECK_COUNT: usize = 2;

/// Master output ceiling, clamped per channel. Matches the Web Audio master
/// chain's hard clip guard (the parity constant from the spike).
pub const MASTER_CEILING: f32 = 0.9296875;

/// Per-deck ring capacity in frames (30 s of stereo audio).
pub const RING_SECS: usize = 30;
pub const RING_FRAMES: usize = RING_SECS * SAMPLE_RATE as usize;

/// Prebuffer high-water mark in frames (1.5 s). A deck is not "primed" — and so
/// its shortfalls are not counted as underruns — until its ring first fills to
/// here.
pub const PREBUFFER_SECS: f64 = 1.5;
pub const PREBUFFER_FRAMES: usize = (PREBUFFER_SECS * SAMPLE_RATE as f64) as usize;

/// Identifies a deck. Slice 1 has exactly [`DECK_COUNT`] decks; `DeckId` is a
/// thin index newtype so callers don't pass bare `usize`s and later slices can
/// attach per-deck control without reshaping the API.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct DeckId(usize);

impl DeckId {
    /// The deck's index in `[0, DECK_COUNT)`.
    pub fn index(self) -> usize {
        self.0
    }
}

/// A deck's 3-band EQ band. The layout matches the Web Audio engine
/// (`frontend/src/audio/eq.ts`): a low shelf at 250 Hz, a mid bell at 1 kHz,
/// and a high shelf at 2.5 kHz.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum EqBand {
    Low,
    Mid,
    High,
}

impl EqBand {
    /// The band's index into a deck's `[low, mid, high]` EQ value triple.
    fn index(self) -> usize {
        match self {
            EqBand::Low => 0,
            EqBand::Mid => 1,
            EqBand::High => 2,
        }
    }
}

/// The non-RT producer side of a deck. Held by whoever feeds the deck (the
/// transport/decode thread). Its `post_pcm` is the SOLE writer of the deck's
/// ring; see the module-level note on the SPSC handoff.
///
/// A `DeckHandle` is `Send` (it owns one `rtrb::Producer`) so it can be moved to
/// the IO thread. It is intentionally NOT `Clone`: a ring has exactly one
/// producer.
pub struct DeckHandle {
    id: DeckId,
    producer: RingProducer,
}

impl DeckHandle {
    /// Append interleaved stereo f32 samples (`[L, R, L, R, …]`) to this deck's
    /// ring. Returns the number of samples actually buffered; if the ring is
    /// near-full only the prefix that fits is written and the rest dropped, so
    /// the producer thread never blocks. Non-RT producer side; wait-free.
    pub fn post_pcm(&mut self, samples: &[f32]) -> usize {
        self.producer.post_pcm(samples)
    }

    /// Free space in this deck's ring, in interleaved samples. Lets the feeder
    /// pace itself (e.g. stay ≤ N seconds ahead) without blocking.
    pub fn free_samples(&self) -> usize {
        self.producer.free_samples()
    }

    /// This handle's deck id.
    pub fn id(&self) -> DeckId {
        self.id
    }
}

/// The device-free audio engine core. Owns the consumer half of every deck ring,
/// the mix graph, and the telemetry. [`Engine::render`] is the only RT entry
/// point; everything else is non-RT control/setup.
pub struct Engine {
    /// Each deck's active source (ADR-0013): the live ring consumer
    /// ([`DeckSource::Realtime`], Slices 1–3) or one decoded track
    /// ([`DeckSource::Playback`]). `None` until [`Engine::create_deck`].
    decks: Vec<Option<DeckSource>>,
    /// The live ring consumer **parked** while a deck is in Playback mode
    /// (ADR-0013: the live ring is kept, not destroyed). `load_track` moves the
    /// `Realtime` consumer here and installs a `Playback` source; `unload_track`
    /// moves it back. The matching producer ([`DeckHandle`]) keeps feeding it; the
    /// engine just stops draining it until the deck returns to Realtime.
    parked_rings: Vec<Option<RingConsumer>>,
    graph: MixGraph,
    telemetry: Arc<Telemetry>,
}

impl Engine {
    /// Create a new engine at [`SAMPLE_RATE`] / [`CHANNELS`]. Allocates the mix
    /// graph (off the RT path). No decks exist yet — call [`Engine::create_deck`]
    /// for each.
    pub fn new() -> Self {
        Engine {
            decks: (0..DECK_COUNT).map(|_| None).collect(),
            parked_rings: (0..DECK_COUNT).map(|_| None).collect(),
            graph: MixGraph::new(),
            telemetry: Arc::new(Telemetry::new()),
        }
    }

    /// Create deck `id` and return its non-RT [`DeckHandle`] (the producer side).
    /// The consumer side is retained inside the engine for [`Engine::render`], as
    /// a [`DeckSource::Realtime`] source (the live stream — loading later switches
    /// it to Playback). Allocates the ring backing store once, here, off the RT
    /// path.
    ///
    /// # Panics
    /// Panics if `index >= DECK_COUNT` or the deck was already created — both are
    /// caller programming errors, not runtime conditions.
    pub fn create_deck(&mut self, index: usize) -> DeckHandle {
        assert!(index < DECK_COUNT, "deck index {index} out of range");
        assert!(
            self.decks[index].is_none(),
            "deck {index} already created"
        );
        let (producer, consumer) = new_deck_ring(index, self.telemetry.clone());
        self.decks[index] = Some(DeckSource::Realtime(consumer));
        DeckHandle {
            id: DeckId(index),
            producer,
        }
    }

    /// Set the crossfader position in `[0, 1]` (0 = deck A, 1 = deck B). Non-RT
    /// control; recomputes the equal-power mix gains the RT path reads.
    pub fn set_crossfade(&mut self, position: f32) {
        self.graph.set_crossfade(position);
    }

    /// Set a deck's EQ `band` knob value in `[0, 1]` (0 = kill, 0.5 = flat,
    /// 1 = boost; see `EqBand` / the `eqValueToDb` curve). Non-RT control.
    ///
    /// This rebuilds that deck's EQ filter chain **off the RT path** (it takes
    /// `&mut self`, so it can never overlap a `render` call — Rust's ownership
    /// rules make the allocation safe here). `render` only ticks the
    /// already-built fixed-coefficient nodes; it allocates nothing. See
    /// `MixGraph::set_eq` for how a future device-command channel would deliver
    /// the change RT-safely once the audio thread owns the `Engine`.
    ///
    /// # Panics
    /// Panics if `deck_index >= DECK_COUNT` (a caller programming error).
    pub fn set_eq(&mut self, deck_index: usize, band: EqBand, value: f32) {
        assert!(deck_index < DECK_COUNT, "deck index {deck_index} out of range");
        self.graph.set_eq(deck_index, band.index(), value);
    }

    /// Set a deck's channel-fader volume (linear gain, `0..1+`; default 1.0),
    /// applied before the crossfade. Non-RT control; writes a gain the RT path
    /// reads.
    ///
    /// # Panics
    /// Panics if `deck_index >= DECK_COUNT` (a caller programming error).
    pub fn set_volume(&mut self, deck_index: usize, gain: f32) {
        assert!(deck_index < DECK_COUNT, "deck index {deck_index} out of range");
        self.graph.set_volume(deck_index, gain);
    }

    /// Select a deck's Color FX effect (ADR-0008). The insert sits post-EQ,
    /// pre-fader; at the new effect's rest position it is a bit-exact dry
    /// passthrough until the knob is moved out of the dead zone.
    ///
    /// This **rebuilds the effect's nodes off the RT path** — it takes `&mut self`,
    /// so by Rust's ownership rules a `set_fx` call and a `render` call can never
    /// overlap (the same RT-safety argument as `set_eq`). `render` only ticks the
    /// already-built nodes; it allocates nothing.
    ///
    /// # Panics
    /// Panics if `deck_index >= DECK_COUNT` (a caller programming error).
    pub fn set_fx(&mut self, deck_index: usize, kind: FxKind) {
        assert!(deck_index < DECK_COUNT, "deck index {deck_index} out of range");
        self.graph.set_fx(deck_index, kind);
    }

    /// Set a deck's Color FX knob amount in `[0, 1]` (the one-knob convention from
    /// `fx.ts`; `0.5` rests the bipolar filter, `0` rests the rest). Non-RT
    /// control: reconfigures the active effect's parameters off the RT path while
    /// keeping its per-channel state. Within the effect's dead zone the insert is a
    /// bit-exact dry passthrough.
    ///
    /// # Panics
    /// Panics if `deck_index >= DECK_COUNT` (a caller programming error).
    pub fn set_fx_amount(&mut self, deck_index: usize, amount: f32) {
        assert!(deck_index < DECK_COUNT, "deck index {deck_index} out of range");
        self.graph.set_fx_amount(deck_index, amount);
    }

    // --- Slice 4a: the playback deck (M19/M20/M21/M23, ADR-0013…0016) ---
    //
    // Loading decides the mode (ADR-0013): `load_track` switches a deck to
    // Playback and PARKS its live ring; `unload_track` restores Realtime. All of
    // these are non-RT (`&mut self`, like `set_eq`/`set_fx`) — they cannot overlap
    // a `render` call by Rust's ownership rules, so the buffer allocation in
    // `load_track` and the transport mutations never land on the RT thread. The RT
    // `render` only reads the buffer + linear-interpolates.

    /// Load a decoded track onto a deck, switching it to Playback mode and
    /// **parking** its live ring (ADR-0013). `samples` is decoded interleaved
    /// stereo f32 at [`SAMPLE_RATE`] (the shell decodes WAV + resamples in Phase
    /// 2; this slice takes 48 k f32). Replaces any track already loaded. The track
    /// starts paused at the top, rate 1.0, no loop.
    ///
    /// # Panics
    /// Panics if `deck_index >= DECK_COUNT` (a caller programming error).
    pub fn load_track(&mut self, deck_index: usize, samples: Vec<f32>) {
        assert!(deck_index < DECK_COUNT, "deck index {deck_index} out of range");
        let source = BufferSource::new(samples);
        match self.decks[deck_index].take() {
            // Park the live ring (kept, not destroyed) so `unload_track` restores
            // it. Its producer keeps feeding; the engine just stops draining it.
            Some(DeckSource::Realtime(ring)) => {
                self.parked_rings[deck_index] = Some(ring);
            }
            // Reloading a Playback deck: drop the old track, keep any parked ring.
            Some(DeckSource::Playback(_)) | None => {}
        }
        self.decks[deck_index] = Some(DeckSource::Playback(source));
    }

    /// Unload the track and return the deck to Realtime, restoring the parked live
    /// ring (ADR-0013). A no-op on a deck that is already Realtime or uncreated.
    ///
    /// # Panics
    /// Panics if `deck_index >= DECK_COUNT` (a caller programming error).
    pub fn unload_track(&mut self, deck_index: usize) {
        assert!(deck_index < DECK_COUNT, "deck index {deck_index} out of range");
        if let Some(DeckSource::Playback(_)) = self.decks[deck_index] {
            self.decks[deck_index] = self.parked_rings[deck_index].take().map(DeckSource::Realtime);
        }
    }

    /// Start (or resume) the loaded track; from the ended state it restarts at the
    /// top (ADR-0013). A no-op unless the deck is in Playback mode.
    ///
    /// # Panics
    /// Panics if `deck_index >= DECK_COUNT`.
    pub fn play_track(&mut self, deck_index: usize) {
        if let Some(track) = self.track_mut(deck_index) {
            track.play();
        }
    }

    /// Park the track's playhead where it is (ADR-0013). A no-op off Playback.
    ///
    /// # Panics
    /// Panics if `deck_index >= DECK_COUNT`.
    pub fn pause_track(&mut self, deck_index: usize) {
        if let Some(track) = self.track_mut(deck_index) {
            track.pause();
        }
    }

    /// Jump the track playhead to `frames` (clamped into the track) and **exit any
    /// active loop** — the one rule (ADR-0015). A no-op off Playback.
    ///
    /// # Panics
    /// Panics if `deck_index >= DECK_COUNT`.
    pub fn seek_track(&mut self, deck_index: usize, frames: f64) {
        if let Some(track) = self.track_mut(deck_index) {
            track.seek(frames);
        }
    }

    /// Set the track's varispeed rate, clamped to the ±8 % envelope (ADR-0014).
    /// A no-op off Playback.
    ///
    /// # Panics
    /// Panics if `deck_index >= DECK_COUNT`.
    pub fn set_track_rate(&mut self, deck_index: usize, rate: f64) {
        if let Some(track) = self.track_mut(deck_index) {
            track.set_rate(rate);
        }
    }

    /// Set the track loop region in frames (ADR-0015/0016). Runs the pure
    /// `plan_loop_set` decision; a region that cannot loop is refused. A no-op off
    /// Playback.
    ///
    /// # Panics
    /// Panics if `deck_index >= DECK_COUNT`.
    pub fn set_track_loop(&mut self, deck_index: usize, start: u64, end: u64) {
        if let Some(track) = self.track_mut(deck_index) {
            track.set_loop(start, end);
        }
    }

    /// Clear the active track loop, re-anchoring on the folded seam (ADR-0015). A
    /// no-op off Playback.
    ///
    /// # Panics
    /// Panics if `deck_index >= DECK_COUNT`.
    pub fn clear_track_loop(&mut self, deck_index: usize) {
        if let Some(track) = self.track_mut(deck_index) {
            track.clear_loop();
        }
    }

    /// A snapshot of the track's transport (playhead in frames, playing, duration,
    /// rate, ended, loop), or `None` off Playback. Mirrors `getTrackStatus`.
    ///
    /// # Panics
    /// Panics if `deck_index >= DECK_COUNT`.
    pub fn get_track_status(&self, deck_index: usize) -> Option<TrackStatus> {
        self.track_ref(deck_index).map(|track| track.status())
    }

    /// Min/max overview of the loaded track for the waveform UI (`buckets`
    /// downsampled buckets across both channels), or `None` off Playback.
    ///
    /// # Panics
    /// Panics if `deck_index >= DECK_COUNT`.
    pub fn get_track_peaks(&self, deck_index: usize, buckets: usize) -> Option<(Vec<f32>, Vec<f32>)> {
        self.track_ref(deck_index).map(|track| track.peaks(buckets))
    }

    /// The active Playback source for a deck, or `None` if the deck is Realtime /
    /// uncreated. Shared accessor for the track control methods.
    ///
    /// # Panics
    /// Panics if `deck_index >= DECK_COUNT`.
    fn track_mut(&mut self, deck_index: usize) -> Option<&mut BufferSource> {
        assert!(deck_index < DECK_COUNT, "deck index {deck_index} out of range");
        match self.decks[deck_index].as_mut() {
            Some(DeckSource::Playback(track)) => Some(track),
            _ => None,
        }
    }

    /// Read-only sibling of [`Engine::track_mut`].
    ///
    /// # Panics
    /// Panics if `deck_index >= DECK_COUNT`.
    fn track_ref(&self, deck_index: usize) -> Option<&BufferSource> {
        assert!(deck_index < DECK_COUNT, "deck index {deck_index} out of range");
        match self.decks[deck_index].as_ref() {
            Some(DeckSource::Playback(track)) => Some(track),
            _ => None,
        }
    }

    /// Shared telemetry handle. Cheap to clone (`Arc`); a UI/monitor thread can
    /// hold one and read stats while `render` runs — all reads are wait-free.
    pub fn telemetry(&self) -> Arc<Telemetry> {
        self.telemetry.clone()
    }

    /// **The RT path.** Drain `frames` from every deck's ring, mix them through
    /// the bare graph (per-deck EQ, equal-power crossfade, master clamp), and
    /// write `frames` interleaved stereo samples into `out`.
    ///
    /// `out` must have room for `frames * CHANNELS` samples; any device channels
    /// beyond stereo are the device wrapper's concern (it deinterleaves to the
    /// device width). This function does NO allocation, takes NO lock, makes NO
    /// syscall — it is safe to call inside a cpal callback under
    /// `assert_no_alloc`.
    #[inline]
    pub fn render(&mut self, out: &mut [f32], frames: usize) {
        debug_assert!(
            out.len() >= frames * CHANNELS as usize,
            "render: output buffer too small"
        );
        self.telemetry.note_block();

        // Per-block accounting first (prebuffer gate, fill stats, underruns) for
        // the live (Realtime) decks only — a Playback deck reads a finished buffer
        // with no ring to prime or starve. Then the per-frame drain + mix.
        for deck in self.decks.iter_mut().flatten() {
            if let DeckSource::Realtime(ring) = deck {
                ring.account_block(frames);
            }
        }

        let mut master_peak = 0.0f32;
        let mut min_gain = 1.0f32;
        for f in 0..frames {
            // Pop one stereo frame from each deck's active source (zero-fill on a
            // ring shortfall; silence for a paused/ended track).
            let mut pairs = [(0.0f32, 0.0f32); DECK_COUNT];
            for (d, slot) in self.decks.iter_mut().enumerate() {
                if let Some(deck) = slot {
                    pairs[d] = match deck {
                        DeckSource::Realtime(ring) => ring.pop_frame(),
                        DeckSource::Playback(track) => track.pop_frame(),
                    };
                }
            }

            let (ol, or, gain_reduction) = self.graph.mix_frame(pairs);

            let base = f * CHANNELS as usize;
            out[base] = ol;
            out[base + 1] = or;

            let peak = ol.abs().max(or.abs());
            if peak > master_peak {
                master_peak = peak;
            }
            // Fold the limiter's per-frame applied gain into the GR meter
            // (monotone-min over the block; the deepest reduction wins).
            if gain_reduction < min_gain {
                min_gain = gain_reduction;
            }
        }
        self.telemetry.record_master_peak(master_peak);
        self.telemetry.record_master_gain_reduction(min_gain);
    }
}

impl Default for Engine {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const BLOCK: usize = 256;

    /// A deterministic synthetic stereo producer: a per-deck sine, generated in
    /// frame-aligned chunks. Mirrors the spike's producer but is pure (no
    /// threads) so tests drive it directly.
    struct SineSource {
        phase: f32,
        dphase: f32,
        amp: f32,
    }

    impl SineSource {
        fn new(freq: f32, amp: f32) -> Self {
            SineSource {
                phase: 0.0,
                dphase: 2.0 * std::f32::consts::PI * freq / SAMPLE_RATE as f32,
                amp,
            }
        }

        /// Fill `frames` interleaved stereo frames into `buf` (len = frames*2).
        fn fill(&mut self, buf: &mut [f32], frames: usize) {
            for f in 0..frames {
                let s = self.phase.sin() * self.amp;
                self.phase += self.dphase;
                if self.phase > std::f32::consts::TAU {
                    self.phase -= std::f32::consts::TAU;
                }
                buf[2 * f] = s;
                buf[2 * f + 1] = s;
            }
        }
    }

    /// The reference bare mix for a single pair of stereo inputs: flat EQ (every
    /// band at 0.5 is unity, so a passthrough), unity volume, equal-power
    /// crossfade, then the master clamp. This is the parity oracle the engine
    /// output must match **for a sub-threshold signal**, where the Slice-2
    /// limiter is level-transparent (its makeup is cancelled). Tests that use it
    /// keep peaks below the −6 dB limiter threshold so the limiter does not
    /// engage; the clamp here is just the never-exceeded ceiling guard. Biquad
    /// arithmetic is not bit-exact identity, so the test uses an epsilon.
    fn expected_mix(a: (f32, f32), b: (f32, f32), position: f32) -> (f32, f32) {
        let angle = position.clamp(0.0, 1.0) * std::f32::consts::FRAC_PI_2;
        let ga = angle.cos();
        let gb = angle.sin();
        let l = (a.0 * ga + b.0 * gb).clamp(-MASTER_CEILING, MASTER_CEILING);
        let r = (a.1 * ga + b.1 * gb).clamp(-MASTER_CEILING, MASTER_CEILING);
        (l, r)
    }

    /// Feed `frames` of a deck's sine through `post_pcm`, in one shot.
    fn feed(handle: &mut DeckHandle, src: &mut SineSource, frames: usize) {
        let mut buf = vec![0.0f32; frames * CHANNELS as usize];
        src.fill(&mut buf, frames);
        let written = handle.post_pcm(&buf);
        assert_eq!(written, buf.len(), "ring should have had room for the feed");
    }

    /// (1) Prebuffer gating: no underruns are counted during the initial 1.5 s
    /// fill, even though each block is rendered before the ring is primed.
    #[test]
    fn prebuffer_gate_suppresses_initial_underruns() {
        let mut engine = Engine::new();
        let mut deck_a = engine.create_deck(0);
        let mut deck_b = engine.create_deck(1);
        let tele = engine.telemetry();

        // Render ~1.0 s of blocks WITHOUT ever priming (feed a trickle smaller
        // than the prebuffer so neither deck crosses the high-water mark).
        let mut out = vec![0.0f32; BLOCK * CHANNELS as usize];
        let blocks = (SAMPLE_RATE as usize) / BLOCK; // ~1 s
        let mut sa = SineSource::new(220.0, 0.25);
        let mut sb = SineSource::new(330.0, 0.25);
        // Feed only a little each block — never reaching 1.5 s buffered.
        for _ in 0..blocks {
            feed(&mut deck_a, &mut sa, BLOCK / 2);
            feed(&mut deck_b, &mut sb, BLOCK / 2);
            engine.render(&mut out, BLOCK);
        }

        assert!(
            !tele.primed(0) && !tele.primed(1),
            "decks must not be primed before the 1.5 s high-water"
        );
        assert_eq!(
            tele.underruns(),
            0,
            "no underruns may be counted during the prebuffer fill"
        );
    }

    /// (2) Zero underruns once primed and fed at ≥ realtime; plus (3) ring-fill
    /// stats track correctly (min/max within sane bounds, current fill > 0).
    #[test]
    fn primed_and_fed_has_zero_underruns_and_tracks_fill() {
        let mut engine = Engine::new();
        let mut deck_a = engine.create_deck(0);
        let mut deck_b = engine.create_deck(1);
        let tele = engine.telemetry();

        let mut sa = SineSource::new(220.0, 0.25);
        let mut sb = SineSource::new(330.0, 0.25);

        // Prime: buffer > 1.5 s up front so both decks cross the high-water.
        let prime_frames = PREBUFFER_FRAMES + BLOCK;
        feed(&mut deck_a, &mut sa, prime_frames);
        feed(&mut deck_b, &mut sb, prime_frames);

        // Now render many blocks, refeeding exactly one block of audio each time
        // (realtime pace) so the ring never starves.
        let mut out = vec![0.0f32; BLOCK * CHANNELS as usize];
        let blocks = 2000; // ~10.7 s of audio
        for _ in 0..blocks {
            feed(&mut deck_a, &mut sa, BLOCK);
            feed(&mut deck_b, &mut sb, BLOCK);
            engine.render(&mut out, BLOCK);
        }

        assert!(tele.primed(0) && tele.primed(1), "both decks should be primed");
        assert_eq!(
            tele.underruns(),
            0,
            "a primed deck fed at realtime must never underrun"
        );

        // Ring-fill stats: each deck holds ≳ the prebuffer and < the ring cap.
        for d in 0..DECK_COUNT {
            let now = tele.ring_fill(d);
            let mn = tele.ring_fill_min(d);
            let mx = tele.ring_fill_max(d);
            assert!(now > 0, "deck {d} ring should be non-empty");
            assert!(now < RING_FRAMES, "deck {d} fill must stay under the cap");
            assert!(mn <= now && now <= mx, "deck {d} min ≤ now ≤ max");
            assert!(
                mn >= PREBUFFER_FRAMES - BLOCK,
                "deck {d} stays near the prebuffer high-water once primed"
            );
        }
    }

    /// (4) The mixed output equals the expected bare mix (flat EQ, unity volume,
    /// equal-power crossfade, transparent limiter) sample-for-sample (within a
    /// tiny epsilon for the flat biquads), and never exceeds the master ceiling,
    /// swept across positions. Amplitudes are deliberately sub-threshold so the
    /// Slice-2 limiter is level-transparent and the flat-mix oracle still holds:
    /// the worst-case post-crossfade peak is about `0.3 * sqrt(2)` (~0.42), under
    /// the limiter threshold of 0.501 (the -6 dB point).
    #[test]
    fn output_matches_bare_mix_and_respects_ceiling() {
        // Sub-threshold amplitude (see the doc note): keeps the limiter idle.
        const AMP: f32 = 0.3;
        for &position in &[0.0f32, 0.25, 0.5, 0.75, 1.0] {
            let mut engine = Engine::new();
            let mut deck_a = engine.create_deck(0);
            let mut deck_b = engine.create_deck(1);
            engine.set_crossfade(position);

            // Two independent reference sources; we replay the SAME phase
            // progression into the oracle to predict the mix.
            let mut sa = SineSource::new(220.0, AMP);
            let mut sb = SineSource::new(330.0, AMP);
            let mut ref_a = SineSource::new(220.0, AMP);
            let mut ref_b = SineSource::new(330.0, AMP);

            // Prime well past the high-water so nothing zero-fills.
            let prime = PREBUFFER_FRAMES + 4 * BLOCK;
            feed(&mut deck_a, &mut sa, prime);
            feed(&mut deck_b, &mut sb, prime);

            // Drop the prebuffer's worth of frames from the oracle too, so the
            // oracle and the engine read the same samples once we compare.
            let mut out = vec![0.0f32; BLOCK * CHANNELS as usize];
            let mut a_buf = vec![0.0f32; BLOCK * CHANNELS as usize];
            let mut b_buf = vec![0.0f32; BLOCK * CHANNELS as usize];

            let mut max_out = 0.0f32;
            let blocks = 8;
            for _ in 0..blocks {
                engine.render(&mut out, BLOCK);
                ref_a.fill(&mut a_buf, BLOCK);
                ref_b.fill(&mut b_buf, BLOCK);
                for f in 0..BLOCK {
                    let a = (a_buf[2 * f], a_buf[2 * f + 1]);
                    let b = (b_buf[2 * f], b_buf[2 * f + 1]);
                    let (el, er) = expected_mix(a, b, position);
                    let ol = out[2 * f];
                    let or = out[2 * f + 1];
                    // Flat EQ is a near-unity biquad chain, not bit-exact
                    // identity; a small epsilon absorbs the filter arithmetic.
                    assert!(
                        (ol - el).abs() < 1e-3,
                        "pos={position} frame={f} L: got {ol}, expected {el}"
                    );
                    assert!(
                        (or - er).abs() < 1e-3,
                        "pos={position} frame={f} R: got {or}, expected {er}"
                    );
                    max_out = max_out.max(ol.abs()).max(or.abs());
                }
            }
            assert!(
                max_out <= MASTER_CEILING,
                "output must never exceed the master ceiling (pos={position})"
            );
        }
    }

    /// (4b) The master never exceeds the ceiling under a loud DC input — the
    /// clip-guard invariant. (Slice 1 expected the clamp to *pin* loud DC to the
    /// ceiling; Slice 2's limiter tames it BELOW the ceiling first, so the
    /// guard rarely fires — the invariant is "never above", which still holds.
    /// The taming itself is covered by `limiter_*` below.)
    #[test]
    fn loud_in_phase_decks_never_exceed_ceiling() {
        let mut engine = Engine::new();
        let mut deck_a = engine.create_deck(0);
        let mut deck_b = engine.create_deck(1);
        engine.set_crossfade(0.5); // both decks at cos(π/4) ≈ 0.707

        // DC-ish full-scale: post-crossfade sum ≈ 2 * 1.0 * 0.707 = 1.414 > ceil.
        let prime = PREBUFFER_FRAMES + 2 * BLOCK;
        let a = vec![1.0f32; prime * CHANNELS as usize];
        let b = vec![1.0f32; prime * CHANNELS as usize];
        assert_eq!(deck_a.post_pcm(&a), a.len());
        assert_eq!(deck_b.post_pcm(&b), b.len());

        let mut out = vec![0.0f32; BLOCK * CHANNELS as usize];
        // Render a couple of blocks past the EQ settling transient.
        for _ in 0..4 {
            engine.render(&mut out, BLOCK);
        }
        for &s in out.iter() {
            assert!(
                s.abs() <= MASTER_CEILING + 1e-7,
                "sample {s} exceeded the ceiling"
            );
        }
    }

    /// (5) An underrun IS counted when a primed ring is starved: prime a deck,
    /// then render more than was buffered so the ring runs dry.
    #[test]
    fn starved_primed_ring_counts_underrun() {
        let mut engine = Engine::new();
        let mut deck_a = engine.create_deck(0);
        let _deck_b = engine.create_deck(1); // left empty/unprimed on purpose
        let tele = engine.telemetry();

        let mut sa = SineSource::new(220.0, 0.25);
        // Prime deck A to just over the high-water, then stop feeding it.
        let prime_frames = PREBUFFER_FRAMES + BLOCK;
        feed(&mut deck_a, &mut sa, prime_frames);

        // Drain every block with NO refeed. Once the buffered ~1.5 s is gone the
        // primed ring is short of a full block → underruns start counting.
        let mut out = vec![0.0f32; BLOCK * CHANNELS as usize];
        let blocks = (prime_frames / BLOCK) + 50; // outrun the buffer
        for _ in 0..blocks {
            engine.render(&mut out, BLOCK);
        }

        assert!(tele.primed(0), "deck A should have primed before starving");
        assert!(
            tele.underruns() > 0,
            "a primed, starved ring must count underruns"
        );
        // Deck B never primed (never fed), so it contributes no underruns — the
        // gate must not falsely count an unprimed deck.
        assert!(!tele.primed(1), "unfed deck B must stay unprimed");
    }

    /// The handoff stays SPSC under realistic over-feeding: post_pcm drops the
    /// tail (returns < len) rather than blocking or growing when the ring fills.
    #[test]
    fn post_pcm_drops_tail_when_ring_full_never_blocks() {
        let mut engine = Engine::new();
        let mut deck_a = engine.create_deck(0);

        // Try to push more than the whole ring in one go.
        let huge = vec![0.5f32; (RING_FRAMES + 1) * CHANNELS as usize];
        let written = deck_a.post_pcm(&huge);
        assert!(written < huge.len(), "a full ring must drop the overflow tail");
        assert_eq!(deck_a.free_samples(), 0, "ring should be full after the push");
    }

    // --- Slice 2 tests: the real EQ curve, per-deck volume, master limiter ---
    //
    // The exact Chromium-vs-fundsp WAVEFORM parity was already proven in Spike A
    // (`docs/spike-rust-audio.md`, golden `spike/rust-audio/golden/`): EQ shelves
    // /bell to ~1e-6, limiter invariants exact. These headless tests verify the
    // CURVE (kill/flat/boost band levels) and the limiter INVARIANTS (ceiling +
    // sub-threshold transparency) — not a waveform diff, which was the spike's
    // job.

    /// Drive deck A alone (crossfade fully on A) with a steady sine at `freq`,
    /// amplitude `amp`, render `blocks` blocks past a settling skip, and return
    /// the RMS of the left channel over the last `measure_blocks`. The signal
    /// stays on A so the EQ under test is the only colouring.
    fn deck_a_rms(engine: &mut Engine, deck_a: &mut DeckHandle, freq: f32, amp: f32) -> f32 {
        let mut src = SineSource::new(freq, amp);
        // Prime well past the high-water plus settling headroom.
        let prime = PREBUFFER_FRAMES + 12 * BLOCK;
        feed(deck_a, &mut src, prime);

        let mut out = vec![0.0f32; BLOCK * CHANNELS as usize];
        // Skip the EQ transient, then measure several blocks of steady state.
        let skip_blocks = 8;
        let measure_blocks = 16;
        for _ in 0..skip_blocks {
            engine.render(&mut out, BLOCK);
        }
        let mut sum_sq = 0.0f64;
        let mut n = 0u64;
        for _ in 0..measure_blocks {
            engine.render(&mut out, BLOCK);
            for f in 0..BLOCK {
                let l = out[2 * f] as f64;
                sum_sq += l * l;
                n += 1;
            }
        }
        (sum_sq / n as f64).sqrt() as f32
    }

    /// (S2-1) The EQ curve: at each band's centre, kill (0) ≈ −40 dB, flat (0.5)
    /// ≈ 0 dB, boost (1) ≈ +6 dB relative to the flat passthrough. Low/high are
    /// true shelves (measured well inside the shelf band); the mid is a bell at
    /// its centre.
    #[test]
    fn eq_curve_kill_flat_boost_per_band() {
        // The `eqValueToDb` curve targets (frontend/src/audio/eq.ts).
        const EQ_KILL_DB_TARGET: f32 = -40.0;
        const EQ_BOOST_DB_TARGET: f32 = 6.0;
        // (band, test frequency). Shelves measured deep in-band (low 60 Hz, high
        // 8 kHz) so the full shelf gain shows; the mid bell at its 1 kHz centre.
        let cases = [(EqBand::Low, 60.0f32), (EqBand::Mid, 1_000.0), (EqBand::High, 8_000.0)];
        // Sub-threshold amplitude: even a +6 dB boost (×2) stays under the −6 dB
        // limiter threshold, so the limiter never colours the measurement.
        const AMP: f32 = 0.2;

        for (band, freq) in cases {
            // Flat baseline (all bands 0.5).
            let flat = {
                let mut engine = Engine::new();
                let mut deck_a = engine.create_deck(0);
                let _deck_b = engine.create_deck(1);
                engine.set_crossfade(0.0); // full deck A
                deck_a_rms(&mut engine, &mut deck_a, freq, AMP)
            };

            // Kill (band → 0): expect ≈ −40 dB relative.
            let killed = {
                let mut engine = Engine::new();
                let mut deck_a = engine.create_deck(0);
                let _deck_b = engine.create_deck(1);
                engine.set_crossfade(0.0);
                engine.set_eq(0, band, 0.0);
                deck_a_rms(&mut engine, &mut deck_a, freq, AMP)
            };

            // Boost (band → 1): expect ≈ +6 dB relative.
            let boosted = {
                let mut engine = Engine::new();
                let mut deck_a = engine.create_deck(0);
                let _deck_b = engine.create_deck(1);
                engine.set_crossfade(0.0);
                engine.set_eq(0, band, 1.0);
                deck_a_rms(&mut engine, &mut deck_a, freq, AMP)
            };

            let kill_db = 20.0 * (killed / flat).log10();
            let boost_db = 20.0 * (boosted / flat).log10();

            // Kill target is −40 dB. The mid bell at its centre hits it exactly
            // (≈ −40.0 dB); the low/high shelves measured deep in-band approach it
            // (≈ −38 dB) — both are a true kill within ~3 dB of the −40 target.
            assert!(
                (kill_db - EQ_KILL_DB_TARGET).abs() < 3.0,
                "{band:?} @ {freq} Hz kill should be ≈ {EQ_KILL_DB_TARGET} dB, got {kill_db:.2} dB"
            );
            // Boost is the clean target: +6 dB within ~0.2 dB.
            assert!(
                (boost_db - EQ_BOOST_DB_TARGET).abs() < 0.2,
                "{band:?} @ {freq} Hz boost should be ≈ {EQ_BOOST_DB_TARGET} dB, got {boost_db:.2} dB"
            );
        }
    }

    /// (S2-1b) Flat (every band 0.5) is a near-unity passthrough on a deck: the
    /// per-band EQ at flat colours the signal by < ~0.1 dB at a mid frequency.
    #[test]
    fn eq_flat_is_unity_passthrough() {
        const AMP: f32 = 0.2;
        let freq = 1_000.0f32;

        // Engine EQ at default-flat vs the raw input level (a deck at unity
        // volume, full crossfade on A, no EQ change) — the same code path with
        // every band left at 0.5.
        let mut engine = Engine::new();
        let mut deck_a = engine.create_deck(0);
        let _deck_b = engine.create_deck(1);
        engine.set_crossfade(0.0);
        let out_rms = deck_a_rms(&mut engine, &mut deck_a, freq, AMP);

        // A pure sine at amplitude AMP has RMS = AMP/√2.
        let in_rms = AMP / std::f32::consts::SQRT_2;
        let db = 20.0 * (out_rms / in_rms).log10();
        assert!(
            db.abs() < 0.2,
            "flat EQ should pass at unity, got {db:.3} dB"
        );
    }

    /// (S2-2) Per-deck volume scales a deck's contribution linearly: deck A at
    /// volume g produces g× the output of deck A at volume 1.0 (full crossfade on
    /// A, sub-threshold so the limiter stays out of it).
    #[test]
    fn volume_scales_deck_contribution() {
        const AMP: f32 = 0.2;
        let freq = 440.0f32;
        let g = 0.5f32;

        let full = {
            let mut engine = Engine::new();
            let mut deck_a = engine.create_deck(0);
            let _deck_b = engine.create_deck(1);
            engine.set_crossfade(0.0);
            deck_a_rms(&mut engine, &mut deck_a, freq, AMP)
        };
        let scaled = {
            let mut engine = Engine::new();
            let mut deck_a = engine.create_deck(0);
            let _deck_b = engine.create_deck(1);
            engine.set_crossfade(0.0);
            engine.set_volume(0, g);
            deck_a_rms(&mut engine, &mut deck_a, freq, AMP)
        };

        let ratio = scaled / full;
        assert!(
            (ratio - g).abs() < 1e-3,
            "volume {g} should scale the contribution by {g}, got ratio {ratio}"
        );
    }

    /// (S2-3a) Limiter ceiling invariant: a hot input (peaks well above the
    /// ceiling) never produces |out| > MASTER_CEILING. This is the load-bearing
    /// safety contract the clip guard guarantees.
    #[test]
    fn limiter_hot_input_never_exceeds_ceiling() {
        let mut engine = Engine::new();
        let mut deck_a = engine.create_deck(0);
        let mut deck_b = engine.create_deck(1);
        engine.set_crossfade(0.5);

        // Full-scale sines on both decks — post-crossfade peaks ≈ √2 ≈ 1.41.
        let mut sa = SineSource::new(220.0, 1.0);
        let mut sb = SineSource::new(330.0, 1.0);
        let prime = PREBUFFER_FRAMES + 2 * BLOCK;
        feed(&mut deck_a, &mut sa, prime);
        feed(&mut deck_b, &mut sb, prime);

        let mut out = vec![0.0f32; BLOCK * CHANNELS as usize];
        let mut max_out = 0.0f32;
        for _ in 0..64 {
            // ~0.34 s
            feed(&mut deck_a, &mut sa, BLOCK);
            feed(&mut deck_b, &mut sb, BLOCK);
            engine.render(&mut out, BLOCK);
            for &s in out.iter() {
                assert!(
                    s.abs() <= MASTER_CEILING + 1e-7,
                    "hot input produced {s}, above the ceiling"
                );
                max_out = max_out.max(s.abs());
            }
        }
        // Sanity: it really was loud enough to be limited (not trivially quiet).
        assert!(max_out > 0.5, "hot test should drive a substantial level");
    }

    /// (S2-3b) Sub-threshold transparency: a quiet steady signal (peaks below the
    /// −6 dB threshold) passes at unity within a small epsilon — proving the
    /// makeup cancellation. Also (S2-3c): gain reduction is ~0 dB below
    /// threshold.
    #[test]
    fn limiter_sub_threshold_is_transparent() {
        let mut engine = Engine::new();
        let mut deck_a = engine.create_deck(0);
        let _deck_b = engine.create_deck(1);
        let tele = engine.telemetry();
        engine.set_crossfade(0.0); // full deck A

        // Peak 0.3 < threshold 0.501 (−6 dB) → the limiter must not engage.
        const AMP: f32 = 0.3;
        let out_rms = deck_a_rms(&mut engine, &mut deck_a, 440.0, AMP);
        let in_rms = AMP / std::f32::consts::SQRT_2;
        let db = 20.0 * (out_rms / in_rms).log10();
        assert!(
            db.abs() < 0.2,
            "sub-threshold signal must pass level-transparent, got {db:.3} dB"
        );
        // The gain-reduction meter should read ≈ 0 dB (idle) below threshold.
        let gr = tele.master_gain_reduction_db();
        assert!(
            gr > -0.1,
            "gain reduction must be ~0 dB below threshold, got {gr:.3} dB"
        );
    }

    /// (S2-3c) Gain reduction engages above threshold: a hot input drives the
    /// gain-reduction telemetry meaningfully negative.
    #[test]
    fn limiter_gain_reduction_engages_above_threshold() {
        let mut engine = Engine::new();
        let mut deck_a = engine.create_deck(0);
        let _deck_b = engine.create_deck(1);
        let tele = engine.telemetry();
        engine.set_crossfade(0.0); // full deck A

        // Peak 1.0 ≫ threshold 0.501 → strong reduction expected.
        let mut src = SineSource::new(440.0, 1.0);
        let prime = PREBUFFER_FRAMES + 2 * BLOCK;
        feed(&mut deck_a, &mut src, prime);
        let mut out = vec![0.0f32; BLOCK * CHANNELS as usize];
        for _ in 0..32 {
            feed(&mut deck_a, &mut src, BLOCK);
            engine.render(&mut out, BLOCK);
        }
        let gr = tele.master_gain_reduction_db();
        assert!(
            gr < -1.0,
            "a hot input must register gain reduction, got {gr:.2} dB"
        );
    }

    /// (S2-3d) The gain-reduction meter `take_*` reads then resets to unity
    /// (0 dB), like the peak meter — a UI reader sampling each frame.
    #[test]
    fn gain_reduction_meter_resets_on_take() {
        let mut engine = Engine::new();
        let mut deck_a = engine.create_deck(0);
        let _deck_b = engine.create_deck(1);
        let tele = engine.telemetry();
        engine.set_crossfade(0.0);

        let mut src = SineSource::new(440.0, 1.0);
        let prime = PREBUFFER_FRAMES + 2 * BLOCK;
        feed(&mut deck_a, &mut src, prime);
        let mut out = vec![0.0f32; BLOCK * CHANNELS as usize];
        for _ in 0..16 {
            feed(&mut deck_a, &mut src, BLOCK);
            engine.render(&mut out, BLOCK);
        }
        let taken = tele.take_master_gain_reduction_db();
        assert!(taken < -1.0, "should have captured reduction, got {taken:.2} dB");
        // After the take, the window is reset to unity until the next render.
        assert!(
            tele.master_gain_reduction_db() > -0.1,
            "meter must reset to ~0 dB after take"
        );
    }

    // --- Slice 3 tests: the per-deck Color FX insert (ADR-0008) ---
    //
    // The exact effect maths (bit-exact bypass, crush quantize-and-hold, the
    // dub-echo impulse spacing, the sweep LFO formula, replace-vs-add) is unit
    // tested in `fx.rs` against the `fx.ts` curves and the Spike A facts. These
    // integration tests verify the insert is wired into `render()` correctly: the
    // bypass stays bit-exact through the WHOLE mix path, and an active filter
    // colours the deck audibly.

    /// (Slice-3 integration) With an effect SELECTED but parked at its rest amount,
    /// the rendered output is bit-identical to the engine with no FX touched at
    /// all — the dead-zone bypass survives the whole post-insert mix path
    /// (volume → crossfade → limiter → clamp), 0 ULP. Checked for every effect.
    #[test]
    fn fx_at_rest_renders_bit_identical_to_no_fx() {
        use fx::FxKind;
        let kinds = [
            FxKind::Filter,
            FxKind::DubEcho,
            FxKind::Space,
            FxKind::Crush,
            FxKind::Noise,
            FxKind::Sweep,
        ];
        for kind in kinds {
            // Reference engine: no FX call at all.
            let mut ref_engine = Engine::new();
            let mut ref_a = ref_engine.create_deck(0);
            let _ref_b = ref_engine.create_deck(1);
            ref_engine.set_crossfade(0.0); // full deck A so the insert is in-path

            // Subject engine: select the effect, park it at its rest amount.
            let mut sub_engine = Engine::new();
            let mut sub_a = sub_engine.create_deck(0);
            let _sub_b = sub_engine.create_deck(1);
            sub_engine.set_crossfade(0.0);
            sub_engine.set_fx(0, kind);
            // Rest amount: 0.5 for the filter, 0.0 otherwise — inside the dead zone.
            let rest = if kind == FxKind::Filter { 0.5 } else { 0.0 };
            sub_engine.set_fx_amount(0, rest);

            // Identical input to both decks.
            let mut src_ref = SineSource::new(440.0, 0.3);
            let mut src_sub = SineSource::new(440.0, 0.3);
            let prime = PREBUFFER_FRAMES + 4 * BLOCK;
            feed(&mut ref_a, &mut src_ref, prime);
            feed(&mut sub_a, &mut src_sub, prime);

            let mut ref_out = vec![0.0f32; BLOCK * CHANNELS as usize];
            let mut sub_out = vec![0.0f32; BLOCK * CHANNELS as usize];
            for _ in 0..8 {
                ref_engine.render(&mut ref_out, BLOCK);
                sub_engine.render(&mut sub_out, BLOCK);
                for (r, s) in ref_out.iter().zip(sub_out.iter()) {
                    assert_eq!(
                        r.to_bits(),
                        s.to_bits(),
                        "{kind:?} at rest must render bit-identical to no FX"
                    );
                }
            }
        }
    }

    /// (Slice-3 integration) An active lowpass filter (amount 0.25 → ~1200 Hz)
    /// attenuates a high tone well below the cutoff-pass and leaves a low tone
    /// (well inside the passband) essentially intact.
    #[test]
    fn filter_lowpass_attenuates_high_passes_low() {
        use fx::FxKind;
        const AMP: f32 = 0.2;
        let low_freq = 200.0f32; // ≪ ~1200 Hz cutoff
        let high_freq = 10_000.0f32; // ≫ cutoff

        // RMS at a frequency, with the lowpass filter active on deck A.
        let measure = |freq: f32| {
            let mut engine = Engine::new();
            let mut deck_a = engine.create_deck(0);
            let _deck_b = engine.create_deck(1);
            engine.set_crossfade(0.0);
            engine.set_fx(0, FxKind::Filter);
            engine.set_fx_amount(0, 0.25); // lowpass ~1200 Hz
            deck_a_rms(&mut engine, &mut deck_a, freq, AMP)
        };
        // Flat reference (filter at rest = bypass) at each frequency.
        let reference = |freq: f32| {
            let mut engine = Engine::new();
            let mut deck_a = engine.create_deck(0);
            let _deck_b = engine.create_deck(1);
            engine.set_crossfade(0.0);
            deck_a_rms(&mut engine, &mut deck_a, freq, AMP)
        };

        let low_db = 20.0 * (measure(low_freq) / reference(low_freq)).log10();
        let high_db = 20.0 * (measure(high_freq) / reference(high_freq)).log10();

        // Low tone: near-unity through the lowpass (within ~1 dB).
        assert!(low_db.abs() < 1.0, "low tone should pass, got {low_db:.2} dB");
        // High tone: strongly attenuated (a 12 dB/oct lowpass an octave+ above the
        // ~1200 Hz cutoff cuts it heavily).
        assert!(high_db < -20.0, "high tone should be attenuated, got {high_db:.2} dB");
        // And the filter clearly separates them.
        assert!(
            low_db - high_db > 20.0,
            "lowpass must pass low far more than high (Δ {:.2} dB)",
            low_db - high_db
        );
    }

    // --- Slice 4a tests: the playback deck wired into the engine ---
    //
    // The BufferSource transport (rate-1.0 verbatim, varispeed resampling, loop
    // fold, seek-exits-loop, pause, peaks, plan_loop_set edges) is unit-tested in
    // `playback.rs` against the `track.ts` / `engine.ts` behaviour. These tests
    // verify the SOURCE abstraction is wired into `Engine`/`render` correctly: a
    // load switches the deck to Playback and parks the ring, a Realtime deck is
    // unaffected, the mixed output carries the track frame through the unchanged
    // channel, and `render` stays alloc-free with a Playback source in path.

    /// A flat ramp track buffer: L = frame index, R = its negation, so the source
    /// frame is unambiguous after the (flat) channel arithmetic.
    fn ramp_track(frames: usize) -> Vec<f32> {
        let mut buf = vec![0.0f32; frames * CHANNELS as usize];
        for f in 0..frames {
            buf[2 * f] = f as f32;
            buf[2 * f + 1] = -(f as f32);
        }
        buf
    }

    /// (S4-1) `load_track` switches the deck to Playback and a Realtime deck is
    /// unaffected: deck A loads a track (status Some), deck B stays Realtime
    /// (status None) and still drains its ring.
    #[test]
    fn load_track_switches_mode_and_leaves_realtime_deck_alone() {
        let mut engine = Engine::new();
        let _deck_a = engine.create_deck(0);
        let mut deck_b = engine.create_deck(1);

        assert!(engine.get_track_status(0).is_none(), "deck A starts Realtime");
        engine.load_track(0, ramp_track(1000));
        let status = engine.get_track_status(0).expect("deck A is now Playback");
        assert_eq!(status.duration_frames, 1000);
        assert!(!status.playing, "a fresh track loads paused at the top");

        // Deck B is still Realtime: no track status, and its ring still feeds.
        assert!(engine.get_track_status(1).is_none(), "deck B stays Realtime");
        let mut sb = SineSource::new(330.0, 0.25);
        feed(&mut deck_b, &mut sb, PREBUFFER_FRAMES + BLOCK);
        let tele = engine.telemetry();
        let mut out = vec![0.0f32; BLOCK * CHANNELS as usize];
        for _ in 0..8 {
            feed(&mut deck_b, &mut sb, BLOCK);
            engine.render(&mut out, BLOCK);
        }
        assert!(tele.primed(1), "the Realtime deck B still primes and drains its ring");
    }

    /// (S4-2) A loaded, playing track is pulled through `render`: crossfaded fully
    /// to the playback deck, the mixed output reproduces the track's ramp frames
    /// (within the flat-channel epsilon). A paused track is silent.
    #[test]
    fn render_pulls_the_playback_source() {
        let mut engine = Engine::new();
        let _deck_a = engine.create_deck(0);
        let _deck_b = engine.create_deck(1);
        engine.set_crossfade(0.0); // full deck A so the track is the whole mix

        // A small-amplitude ramp keeps the mix sub-threshold (the limiter idle)
        // and EQ near-unity: frame f maps to 0.2 * (f / N) in both channels.
        const N: usize = 1024;
        let track = |frames: usize| {
            let mut buf = vec![0.0f32; frames * CHANNELS as usize];
            for f in 0..frames {
                let s = 0.2 * (f as f32 / frames as f32);
                buf[2 * f] = s;
                buf[2 * f + 1] = s;
            }
            buf
        };

        // Paused: render is silent.
        engine.load_track(0, track(N));
        let mut out = vec![0.0f32; N * CHANNELS as usize];
        engine.render(&mut out, N);
        assert!(out.iter().all(|&s| s == 0.0), "a paused track renders silence");

        // Playing from the top: the output follows the track ramp, full deck A
        // (cos(0) = 1). The flat EQ/limiter chain is near-unity sub-threshold, so
        // the ramp shows within a small biquad-settling epsilon — checked past the
        // first few frames where the EQ filters are still warming up.
        engine.load_track(0, track(N));
        engine.play_track(0);
        engine.render(&mut out, N);
        let mut max_err = 0.0f32;
        for f in 64..N {
            let want = 0.2 * (f as f32 / N as f32);
            max_err = max_err.max((out[2 * f] - want).abs());
        }
        assert!(max_err < 2e-3, "the track ramp must reach the mix output, max err {max_err}");
    }

    /// (S4-3) `unload_track` returns the deck to Realtime and restores the parked
    /// ring: after unload the deck has no track status and the live ring (fed
    /// throughout) drains again.
    #[test]
    fn unload_track_restores_the_parked_ring() {
        let mut engine = Engine::new();
        let mut deck_a = engine.create_deck(0);
        let _deck_b = engine.create_deck(1);
        let tele = engine.telemetry();

        // Prime the ring, then load a track — the ring is PARKED, not destroyed.
        let mut sa = SineSource::new(220.0, 0.25);
        feed(&mut deck_a, &mut sa, PREBUFFER_FRAMES + 4 * BLOCK);
        engine.load_track(0, ramp_track(1000));
        assert!(engine.get_track_status(0).is_some(), "deck A is in Playback");

        // The producer keeps feeding the parked ring across playback.
        let mut out = vec![0.0f32; BLOCK * CHANNELS as usize];
        for _ in 0..4 {
            feed(&mut deck_a, &mut sa, BLOCK);
            engine.render(&mut out, BLOCK);
        }

        // Unload: back to Realtime, no track status, and the ring drains again.
        engine.unload_track(0);
        assert!(engine.get_track_status(0).is_none(), "unload returns to Realtime");
        let under_before = tele.underruns();
        for _ in 0..4 {
            feed(&mut deck_a, &mut sa, BLOCK);
            engine.render(&mut out, BLOCK);
        }
        assert_eq!(
            tele.underruns(),
            under_before,
            "the restored ring (still fed) must not underrun"
        );
    }

    /// (S4-4) Engine-level track controls map to the source: play/seek/rate/loop
    /// are reflected in `get_track_status`, and a seek exits a loop (ADR-0015).
    #[test]
    fn engine_track_controls_reach_the_source() {
        let mut engine = Engine::new();
        let _deck_a = engine.create_deck(0);
        let _deck_b = engine.create_deck(1);
        engine.load_track(0, ramp_track(20_000));

        engine.play_track(0);
        engine.set_track_rate(0, 1.05);
        let s = engine.get_track_status(0).unwrap();
        assert!(s.playing);
        assert!((s.rate - 1.05).abs() < 1e-9);

        // A valid loop installs; a seek exits it (the one rule).
        engine.set_track_loop(0, 5_000, 9_000);
        assert!(engine.get_track_status(0).unwrap().loop_region.is_some());
        engine.seek_track(0, 12_000.0);
        let s = engine.get_track_status(0).unwrap();
        assert_eq!(s.loop_region, None, "any seek exits the loop");
        assert_eq!(s.playhead, 12_000.0);

        engine.pause_track(0);
        assert!(!engine.get_track_status(0).unwrap().playing, "pause stops the transport");

        // Peaks come through the engine API too.
        let (min, max) = engine.get_track_peaks(0, 16).unwrap();
        assert_eq!(min.len(), 16);
        assert_eq!(max.len(), 16);
        assert!(max.iter().any(|&v| v > 0.0), "the ramp's max overview is non-trivial");

        // Track controls on a Realtime deck are inert (no panic, no status).
        engine.play_track(1);
        engine.set_track_rate(1, 1.05);
        assert!(engine.get_track_status(1).is_none(), "a Realtime deck has no track");
    }

    /// (S4-5) `render` runs cleanly with both source kinds in path over many
    /// blocks: a Playback deck (looping, varispeed) on B and a primed Realtime
    /// deck on A, mixed through the unchanged channel. Alloc-freeness of the RT
    /// path is structural (the playback `pop_frame` only reads the buffer +
    /// interpolates — no Vec/Box), the same discipline Slices 1–3 hold; the
    /// armed `assert_no_alloc` guard runs in the `device_run` binary and on
    /// hardware (the lib's warn-only feature set makes a CI guard a no-op assert).
    #[test]
    fn render_runs_with_both_source_kinds() {
        let mut engine = Engine::new();
        let mut deck_a = engine.create_deck(0); // Realtime, fed below
        let _deck_b = engine.create_deck(1);
        engine.set_crossfade(0.5);

        engine.load_track(1, ramp_track(48_000));
        engine.play_track(1);
        engine.set_track_loop(1, 6_000, 12_000);
        engine.set_track_rate(1, 1.03);

        let mut sa = SineSource::new(220.0, 0.25);
        feed(&mut deck_a, &mut sa, PREBUFFER_FRAMES + 64 * BLOCK);

        let mut out = vec![0.0f32; BLOCK * CHANNELS as usize];
        for _ in 0..32 {
            feed(&mut deck_a, &mut sa, BLOCK);
            engine.render(&mut out, BLOCK);
            for &s in out.iter() {
                assert!(s.abs() <= MASTER_CEILING + 1e-7, "ceiling held with a playback deck");
                assert!(s.is_finite(), "no NaN/Inf from the mixed playback path");
            }
        }
        // The looping varispeed track keeps its playhead inside the region.
        let p = engine.get_track_status(1).unwrap().playhead;
        assert!((6_000.0..12_000.0).contains(&p), "the looped track folds inside the region, got {p}");
    }
}
