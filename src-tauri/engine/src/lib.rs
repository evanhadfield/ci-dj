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

mod graph;
mod ring;
pub mod telemetry;

#[cfg(not(target_arch = "wasm32"))]
pub mod device;

use std::sync::Arc;

use graph::MixGraph;
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
    decks: Vec<Option<RingConsumer>>,
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
            graph: MixGraph::new(),
            telemetry: Arc::new(Telemetry::new()),
        }
    }

    /// Create deck `id` and return its non-RT [`DeckHandle`] (the producer side).
    /// The consumer side is retained inside the engine for [`Engine::render`].
    /// Allocates the ring backing store once, here, off the RT path.
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
        self.decks[index] = Some(consumer);
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

        // Per-block accounting first (prebuffer gate, fill stats, underruns),
        // then the per-frame drain + mix.
        for deck in self.decks.iter_mut().flatten() {
            deck.account_block(frames);
        }

        let mut master_peak = 0.0f32;
        let mut min_gain = 1.0f32;
        for f in 0..frames {
            // Pop one stereo frame from each deck (zero-fill on shortfall).
            let mut pairs = [(0.0f32, 0.0f32); DECK_COUNT];
            for (d, slot) in self.decks.iter_mut().enumerate() {
                if let Some(deck) = slot {
                    pairs[d] = deck.pop_frame();
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
}
