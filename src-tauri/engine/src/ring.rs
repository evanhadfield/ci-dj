//! Per-deck player ring over `rtrb` (one SPSC ring per deck, never shared).
//!
//! The handoff is the whole point of Slice 1: a single non-RT producer (the
//! decode/transport IO thread, here driven by `DeckHandle::post_pcm`) is the
//! SOLE writer; the RT `Engine::render()` is the SOLE drainer. `rtrb` is a
//! wait-free single-producer / single-consumer ring, so neither side ever takes
//! a lock and the consumer side allocates nothing. The producer allocates the
//! ring's backing store ONCE at construction (off the RT path) and never again.
//!
//! Ported from the per-deck rings in the Spike A `rt_engine`
//! (`spike/rust-audio/engine/src/bin/rt_engine.rs`), split into a producer half
//! (`RingProducer`, lives behind `DeckHandle`) and a consumer half
//! (`RingConsumer`, lives inside `Engine` and is only touched by `render()`).

use std::sync::Arc;

use rtrb::{Consumer, Producer, RingBuffer};

use crate::telemetry::Telemetry;
use crate::{CHANNELS, PREBUFFER_FRAMES, RING_FRAMES, SAMPLE_RATE};

/// Interleaved-stereo samples per frame.
const SAMPLES_PER_FRAME: usize = CHANNELS as usize;

/// Ring capacity in interleaved f32 samples (frames × channels).
const RING_CAPACITY_SAMPLES: usize = RING_FRAMES * SAMPLES_PER_FRAME;

/// Prebuffer high-water mark in interleaved f32 samples.
const PREBUFFER_SAMPLES: usize = PREBUFFER_FRAMES * SAMPLES_PER_FRAME;

/// Construct the producer + consumer halves of one deck's ring.
///
/// Allocates the ring backing store once, here, on the calling (non-RT) thread.
/// Both halves carry the deck index and a shared `Telemetry` handle so the
/// consumer can attribute fill / underrun stats to the right deck.
pub(crate) fn new_deck_ring(
    deck: usize,
    telemetry: Arc<Telemetry>,
) -> (RingProducer, RingConsumer) {
    let (producer, consumer) = RingBuffer::<f32>::new(RING_CAPACITY_SAMPLES);
    (
        RingProducer { producer },
        RingConsumer {
            deck,
            consumer,
            primed: false,
            telemetry,
        },
    )
}

/// The non-RT producer half of a deck's ring. The sole writer. Lives behind the
/// public `DeckHandle`. `post_pcm` is the one entry point; it is wait-free per
/// `rtrb` chunk write and never blocks (it drops the tail if the ring is full,
/// counted by the consumer as the resulting underrun if it starves).
pub(crate) struct RingProducer {
    producer: Producer<f32>,
}

impl RingProducer {
    /// Append interleaved stereo f32 samples to the deck's ring.
    ///
    /// Returns the number of samples actually written. If the ring has less
    /// free space than `samples.len()`, only the prefix that fits is written and
    /// the rest is dropped — the non-RT side must not block the producer thread,
    /// and a persistently full ring means the consumer is keeping up. Callers
    /// that care can compare the return value to `samples.len()`.
    ///
    /// This is the producer side of the SPSC handoff: it never locks and only
    /// touches `rtrb`'s wait-free write path.
    pub(crate) fn post_pcm(&mut self, samples: &[f32]) -> usize {
        let want = samples.len().min(self.producer.slots());
        if want == 0 {
            return 0;
        }
        match self.producer.write_chunk_uninit(want) {
            Ok(chunk) => {
                let n = chunk.len();
                chunk.fill_from_iter(samples[..n].iter().copied());
                n
            }
            Err(_) => 0,
        }
    }

    /// Free space (in interleaved samples) currently available to the producer.
    #[allow(dead_code)] // used by the device_run binary / future flow control
    pub(crate) fn free_samples(&self) -> usize {
        self.producer.slots()
    }
}

/// The RT consumer half of a deck's ring. The sole drainer, only ever touched by
/// `Engine::render()`. Holds the per-deck prebuffer-gate state so the engine
/// stays a thin orchestrator.
pub(crate) struct RingConsumer {
    deck: usize,
    consumer: Consumer<f32>,
    /// Set once the ring first reaches the prebuffer high-water mark. Before
    /// that, shortfalls are the expected initial fill, not underruns.
    primed: bool,
    telemetry: Arc<Telemetry>,
}

impl RingConsumer {
    /// Samples currently available to read (the ring fill). For an `rtrb`
    /// `Consumer`, `slots()` IS the count available for reading — not the free
    /// space — so the fill is read directly, no `capacity − slots` inversion.
    #[inline]
    fn filled_samples(&self) -> usize {
        self.consumer.slots()
    }

    /// RT-side per-block bookkeeping: update the prebuffer gate, record fill
    /// stats, and count an underrun if a *primed* ring cannot satisfy
    /// `frames`. Called once per deck per `render()` block, before the drain.
    ///
    /// Wait-free: only atomic stores and `rtrb` slot reads. No alloc, no lock.
    #[inline]
    pub(crate) fn account_block(&mut self, frames: usize) {
        let need = frames * SAMPLES_PER_FRAME;
        let filled = self.filled_samples();

        // Prebuffer gate: once the ring has buffered at least PREBUFFER_SAMPLES,
        // the deck is "primed" and from then on shortfalls count as underruns.
        if !self.primed && filled >= PREBUFFER_SAMPLES {
            self.primed = true;
            self.telemetry.set_primed(self.deck);
        }

        if self.primed {
            self.telemetry.record_fill(self.deck, filled / SAMPLES_PER_FRAME);
            if filled < need {
                self.telemetry.note_underrun();
            }
        }
    }

    /// Pop one interleaved stereo frame, or `(0.0, 0.0)` if the ring is short.
    /// The drain primitive `render()` calls per frame.
    #[inline]
    pub(crate) fn pop_frame(&mut self) -> (f32, f32) {
        if self.consumer.slots() >= SAMPLES_PER_FRAME {
            let l = self.consumer.pop().unwrap_or(0.0);
            let r = self.consumer.pop().unwrap_or(0.0);
            (l, r)
        } else {
            (0.0, 0.0)
        }
    }

    /// Reset the prebuffer gate (e.g. after a deck reload). The ring itself is
    /// drained by the producer side; this only re-arms the gate so the next
    /// fill is treated as a fresh prebuffer, not an underrun.
    #[allow(dead_code)] // wired up by Engine::reset_deck in a later slice
    pub(crate) fn rearm_prebuffer(&mut self) {
        self.primed = false;
    }
}

/// Compile-time sanity: the prebuffer must fit inside the ring, with headroom.
const _: () = assert!(PREBUFFER_SAMPLES < RING_CAPACITY_SAMPLES);
/// Document the realised sizes so a reviewer sees the seconds, not just frames.
const _: () = assert!(RING_FRAMES == 30 * SAMPLE_RATE as usize);
