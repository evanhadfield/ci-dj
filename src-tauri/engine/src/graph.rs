//! The bare mix, ported from the Spike A `rt_engine` callback
//! (`spike/rust-audio/engine/src/bin/rt_engine.rs`): per-deck 3-band EQ
//! (flat for Slice 1), an equal-power crossfade, and the master limiter clamp.
//!
//! Built OFF the RT thread (the `fundsp` nodes allocate at construction). On the
//! RT path only `tick` / arithmetic run — both alloc-free on a pre-built node.

use fundsp::prelude32::*;

use crate::{CHANNELS, DECK_COUNT, MASTER_CEILING, SAMPLE_RATE};

/// Shelf Q matching the Web Audio fixed-slope shelves (S = 1 → Q = 1/√2). The
/// offline parity renderer uses the same value; see `spike/rust-audio`.
const EQ_SHELF_Q: f32 = std::f32::consts::FRAC_1_SQRT_2;

/// One stateful 3-band EQ chain per (deck, channel). `fundsp` filters are
/// stateful, so each channel needs its own instance.
const EQ_CHAINS: usize = DECK_COUNT * CHANNELS as usize;

/// The mix graph: per-channel EQ chains plus the crossfade gains. Holds no ring
/// state — `render()` feeds it frame samples and reads back the mixed pair.
pub(crate) struct MixGraph {
    /// Layout: `[deckA_L, deckA_R, deckB_L, deckB_R]`. Boxed trait objects so the
    /// chain type need not be named; built once, ticked in place on the RT path.
    eq: Vec<Box<dyn AudioUnit>>,
    /// Equal-power crossfade gains, one per deck. `gains[0]` weights deck A,
    /// `gains[1]` weights deck B. Recomputed by `set_crossfade` (non-RT).
    gains: [f32; DECK_COUNT],
}

impl MixGraph {
    /// Build the graph off-thread. EQ is flat (unity gain) for Slice 1; the real
    /// EQ-value→gain curve is Slice 2.
    pub(crate) fn new() -> Self {
        let eq = (0..EQ_CHAINS)
            .map(|_| {
                // TODO(slice-2): drive the shelf/bell gains from the
                // eqValueToDb curve (−40 dB kill at 0, 0 dB at 0.5, +6 dB at 1)
                // instead of the fixed unity gains here.
                let node = lowshelf_hz(250.0, EQ_SHELF_Q, 1.0)
                    >> bell_hz(1000.0, 0.7, 1.0)
                    >> highshelf_hz(2500.0, EQ_SHELF_Q, 1.0);
                let mut boxed: Box<dyn AudioUnit> = Box::new(node);
                boxed.set_sample_rate(SAMPLE_RATE as f64);
                boxed.reset();
                boxed
            })
            .collect();

        let mut graph = MixGraph {
            eq,
            gains: [0.0; DECK_COUNT],
        };
        // Centre crossfade by default (equal-power 0.5).
        graph.set_crossfade(0.5);
        graph
    }

    /// Set the crossfader position in `[0, 1]` (0 = full deck A, 1 = full deck
    /// B) and recompute the equal-power gains. Non-RT (called from a control
    /// path); cheap arithmetic, but it writes `self.gains` which the RT
    /// `mix_frame` reads — see the note in `lib.rs` on the single-threaded
    /// ownership that keeps this sound for Slice 1.
    pub(crate) fn set_crossfade(&mut self, position: f32) {
        let p = position.clamp(0.0, 1.0);
        // Equal-power law: gain_a = cos(p·π/2), gain_b = sin(p·π/2). At p = 0.5
        // both are cos(π/4) = sin(π/4), matching the Spike A constant mix.
        let angle = p * std::f32::consts::FRAC_PI_2;
        self.gains[0] = angle.cos();
        self.gains[1] = angle.sin();
    }

    /// Process one frame: per-deck EQ both channels, equal-power crossfade, then
    /// the master ceiling clamp. `decks[d] = (left, right)` pre-EQ.
    ///
    /// RT-safe: only `tick` on pre-built nodes (alloc-free) and arithmetic.
    /// Returns the mixed, clamped `(left, right)` output pair.
    #[inline]
    pub(crate) fn mix_frame(&mut self, decks: [(f32, f32); DECK_COUNT]) -> (f32, f32) {
        let mut in1 = [0.0f32; 1];
        let mut out1 = [0.0f32; 1];

        let mut mixed_l = 0.0f32;
        let mut mixed_r = 0.0f32;

        for (d, (l, r)) in decks.into_iter().enumerate() {
            let li = d * CHANNELS as usize;
            in1[0] = l;
            self.eq[li].tick(&in1, &mut out1);
            let l = out1[0];
            in1[0] = r;
            self.eq[li + 1].tick(&in1, &mut out1);
            let r = out1[0];

            let g = self.gains[d];
            mixed_l += l * g;
            mixed_r += r * g;
        }

        // TODO(slice-2): replace this hard clamp with the M17 limiter +
        // clip-guard parity (compressor thr −6 dB, ratio 20, attack 2 ms,
        // release 250 ms) feeding the SAME 0.9296875 ceiling. The clamp here
        // guarantees the ceiling so the slice never exceeds it.
        let mut ol = mixed_l.clamp(-MASTER_CEILING, MASTER_CEILING);
        let mut or = mixed_r.clamp(-MASTER_CEILING, MASTER_CEILING);

        // Flush any denormal that slipped through (belt-and-braces; FTZ/DAZ on
        // the device thread handles the rest).
        if ol.abs() < 1.0e-30 {
            ol = 0.0;
        }
        if or.abs() < 1.0e-30 {
            or = 0.0;
        }
        (ol, or)
    }

    /// Reset all EQ filter state (e.g. on a hard engine reset). Non-RT.
    #[allow(dead_code)] // wired up by Engine::reset in a later slice
    pub(crate) fn reset(&mut self) {
        for node in &mut self.eq {
            node.reset();
        }
    }
}
