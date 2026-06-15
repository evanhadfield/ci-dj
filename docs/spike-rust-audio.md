# Spike A — Rust audio core + PCM transport

**Status: spec (2026-06-15); results pending.** The executable spec for Phase 0,
Spike A of the [native migration](native-migration-plan.md). It **gates
[ADR-0017](adr/0017-native-rust-audio-engine-superseding-web-audio.md)** (Rust
audio engine) and
**[ADR-0019](adr/0019-pcm-transport-from-python-sidecars-to-the-rust-engine.md)**
(PCM transport): a PASS moves both from Proposed toward Accepted. Throwaway,
exploratory code; the deliverable is the measured **Results** section at the
bottom, not production code.

The reference constants below were verified against the source (file:line cited);
trust them over re-reading unless something looks off.

## Objective

Prove a Rust engine (`cpal` + `rtrb` + `fundsp`) can drive **two decks** of real
SlipMate 48 kHz/stereo PCM glitch-free, reach **stated** parity with the Web
Audio engine on the load-bearing nodes, and choose the PCM transport — or surface
exactly where it can't.

## What is bit-exact vs what is not (read first)

The single most important method point. The Rust graph renders with different math
than Web Audio (different biquad coefficient formulas, op order, denormal
handling), so **cross-engine bit-exactness is impossible for any DSP path.** Claim
it only where no DSP runs:

- **Bit-exact (IEEE-754, ULP == 0):** (a) the **dead-zone bypass** — dry
  passthrough; (b) the **clip-guard ceiling invariant** — no output sample exceeds
  `0.9296875`.
- **Within-epsilon (state the number):** EQ, crossfade, and the limiter/FX **body**
  — compared against an `OfflineAudioContext` golden with **static** params, after
  removing fixed group delay (cross-correlate, then diff). Target: per-sample
  max-abs ≤ `1e-4`, or transfer-function magnitude within ±0.1 dB across
  20 Hz–20 kHz.
- **Invariant tests, not waveform diffs:** the **M17 limiter** — its Web Audio
  reference is a `DynamicsCompressorNode` whose curve is implementation-defined and
  unspecified, so do **not** diff its waveform. Test two contracts instead: a hot
  input never exceeds `0.9296875`; a sub-threshold signal (peaks below −6 dB)
  passes level-transparent (proving the makeup-gain cancellation holds).
- **Documented divergence (parity not required):** Space (FDN ≠ convolution),
  Crush (needs a hand-rolled hold), Noise (different PRNG) — measure and **record**
  the divergence rather than chase parity.

## Verified reference constants

**EQ** (`frontend/src/audio/eq.ts`): low `lowshelf` @ 250 Hz (L23); mid `peaking`
@ 1000 Hz, Q 0.7 (L24); high `highshelf` @ 2500 Hz (L25). `eqValueToDb`: 0 →
**−40 dB** kill, 0.5 → 0 dB, 1 → **+6 dB**, linear in each half (L13–15).
*fundsp note:* Web Audio shelves take **no Q** (frequency+gain only); fundsp
shelves do — the shelf slope is a free variable to tune to WA's fixed slope. Mid
must be `bell_hz` (has gain), not `peak_hz`. Pass Q = 0.707 to biquad LP/HP to
match WA defaults.

**Master** (`frontend/src/audio/master.ts`): limiter `DynamicsCompressorNode` thr
−6 dB, knee 0, ratio 20, attack 0.002 s, release 0.25 s (L22–26); implicit makeup
`(1/fullScaleGain)^0.6` (~+3.4 dB) cancelled by `LIMITER_MAKEUP_DB` (L28–37);
clip-guard hard ceiling **`0.9296875`** = 119/128 ≈ −0.6 dBFS (L17); auto-gain
target 0.15 RMS, ±12 dB, floor 0.005 (L53–57); loudness window 10 s (L88).

**Color FX** (`frontend/src/audio/fx.ts`, `fxGraphs.ts`, `public/crusher-kernel.js`):
`FX_DEAD_ZONE = 0.02` on `|amount − rest|`; bypass is bit-transparent inside it
(L19, 27–29).

| FX | curve | Web Audio graph |
| --- | --- | --- |
| filter | bipolar: <0.5 lowpass `logSweep(18000→80)`, ≥0.5 highpass `logSweep(30→6000)` | one `BiquadFilterNode` |
| dub_echo | wet `amount*0.9`, feedback `min(0.82, amount*0.9)`; delay 0.35 s free or beat-fractions `[0.25,0.375,0.5,0.75,1]`; tone lowpass 2500 Hz in loop | Gain→Delay→Biquad(LP 2.5k)→Gain(fb)→Delay; Delay→Gain(wet) |
| space | wet = amount | `ConvolverNode` (2.5 s, decay^3 noise IR)→Gain |
| crush | bits `16−amount*12` (16→4), reduction `1+round(amount*39)` (1→40) | `AudioWorkletNode` `bit-crusher` |
| noise | level `amount*0.35`, centre `logSweep(120→9000)` | BufferSource(1 s white loop)→Bandpass(Q0.8)→Gain |
| sweep | rate `0.5+amount*7.5` Hz, depth `min(1, amount*1.2)` | Sine LFO→Gain(depth)→modulates duck Gain |

Bit-crusher kernel: `levels = 2^(bits-1)`; on `counter==0` quantize
`round(x*levels)/levels`, hold for `reduction` samples (`crusher-kernel.js:9–24`).

**Player ring** (`frontend/public/player-worklet.js`): capacity 30 s (L22),
prebuffer 1.5 s (L23), stats every 1 s (L24).

**Wire format** (`backend/slipmate/worker.py`, `controller.py`): **interleaved
stereo float32 little-endian, 48 kHz**, ~1.0 s chunks; frame = `4 * 2` bytes;
whole stereo frames only. Worker paces to stay **3.0 s ahead** of playback
(`worker.py:24`). Control messages: `play/stop/restart/set_prompt/set_style/
set_model/render_clip/embed_sample/shutdown`. **It is f32, not int16** — do not
scale by 32768.

## Interface contract (the bare-mix subset)

The engine implements the `engine.ts` `DeckChannel`/`AudioEngine` surface. Spike A
needs: `postPcm`, `setVolume`, `setEq`, `setFx`, `setFxAmount`, `setOnAir`,
`setTrim`, `getLevel`; engine `createDeckChannel`, `setCrossfade`,
`getMasterLevel`, `getMasterGainReduction`. (The A/B crossfade is an **equal-power
cos/sin pair** — `a=cos(p·π/2)`, `b=sin(p·π/2)` — two gains, **not**
`Net::crossfade`. `Net::crossfade(node_id, Fade::Smooth, secs, …)` is for the
click-free FX-node swap.)

## fundsp coverage map (verified against docs.rs/fundsp)

| Target | fundsp | risk | note |
| --- | --- | --- | --- |
| 3-band EQ | `lowshelf_hz`→`bell_hz`→`highshelf_hz` | MED | coeff divergence; tune shelf Q to WA's fixed slope |
| **M17 limiter** | — | **HIGH / no** | fundsp `limiter` is a fixed-ceiling peak limiter (no thr/ratio/knee/makeup, adds latency); test **invariants**, or hand-roll a feed-forward compressor |
| clip-guard | `shape(Shape::ClipTo(±0.9296875))` | LOW | maps cleanly; bit-exact ceiling |
| filter | `lowpass_hz`/`highpass_hz` (Q 0.707) | LOW | same biquad family |
| dub_echo | `delay` + in-loop lowpass + feedback | LOW-MED | `delay` rounds to nearest sample; retune zippers |
| **space** | `reverb_stereo` (FDN) | **HIGH / approx** | FDN ≠ convolution IR; document divergence or hand-roll partitioned convolution |
| **crush** | `shape(Shape::Crush)` | **HIGH / partial** | Crush is quantize-only; **hand-roll** the sample-and-hold decimation |
| noise | `white`→`bandpass_hz(Q0.8)`→gain | LOW-MED | different PRNG; non-looping — sample parity meaningless |
| sweep | `sine_hz`·depth + offset, mul | LOW | reproducible bar float |

For Spike A, prove parity on the **clean** ones (filter, EQ-within-epsilon, the
crossfade, the bypass, the ceiling). The three HIGH-risk targets are the point of
the exercise: **measure and record** how far the fundsp approximation sits from the
Web Audio reference; that data decides hand-roll vs accept per effect.

## Real-time discipline + hazard checklist

Fixed regardless of transport: a **non-RT IO thread** decodes transport frames
into a **per-deck wait-free `rtrb`** (SPSC — one producer, one consumer, **one
ring per deck**, never shared); the **`cpal` callback only drains**. Assert under
load:

1. Callback does **zero** alloc / lock / syscall / log / panic — verified with a
   real allocator guard (e.g. `assert_no_alloc`) during the run, not by inspection.
2. Telemetry out (meters, ring fill, underrun count) is **wait-free** (atomics or a
   second SPSC ring) — never a mutex / `mpsc` on the callback.
3. `fundsp Net` mutation (`commit`/`crossfade`) runs **off** the audio thread; the
   callback only adopts an already-built graph. Verify the swap is click-free **and**
   alloc-free.
4. **FTZ/DAZ** set on the audio thread at stream start; include a denormal-storm
   input (a reverb/echo tail decaying to silence) in the run to prove no CPU spike.

## PCM transport selection (ADR-0019)

Measure candidates **under load** (model inference running, cores busy): **loopback
TCP/WebSocket** (reuses v0 framing), **Unix domain socket**, **shared-memory ring**.
Report per candidate: inter-frame arrival-gap distribution (p50/p99/p99.9/**max**),
frames arriving later than one callback period, throughput (must sustain
~1.5 MB/s aggregate with headroom), CPU/frame, and underruns over the run.
**Decision rule:** the channel whose **worst-case arrival gap** stays comfortably
inside the ring drain margin with zero underruns under load; break ties on p99.9
jitter then CPU — **not** mean throughput. Record shared-memory's lifetime/cleanup
complexity as a method cost.

## Scope / build steps

1. Capture golden **input** PCM: dump real worker chunks (`('audio', bytes)`,
   48 k/stereo f32 LE) to file, OR a deterministic synthetic signal at fixed seed.
   The **same bytes** feed both the Rust engine and the Web Audio golden render.
2. Minimal Rust binary: two player rings drained from `rtrb` → per-deck 3-band EQ →
   equal-power crossfade → limiter + clip-guard → `cpal` CoreAudio output, as a
   `fundsp Net`.
3. Golden **render**: `OfflineAudioContext({sampleRate:48000, channels:2})` through
   the same graph with **static** params (no `setTargetAtTime` ramps), dumped and
   checked in.
4. Parity per the bit-exact/epsilon/invariant rules above (align before diffing).
5. Transport prototypes + measurement; pick one.
6. Sustained run; measure underruns/latency/CPU.

## Config & environment

- **Buffer:** request `cpal BufferSize::Fixed(256)` (5.33 ms @ 48 k); **log the
  granted size** (CoreAudio may round) and use it for the latency budget and the
  underrun definition. Latency target ≤ ~12 ms round-trip.
- **Device rate:** require an exact **48000** output config; enumerate
  `supported_output_configs` and **fail fast** if none (resampling out of scope for
  the spike). macOS built-in default is often **44100** — handle explicitly.
- **Channels:** stereo; on a >2ch device (FLX4 3/4) write 0/1, zero the rest. Cue/
  multi-out is out of scope here.
- **Replay must mimic worker pacing** (~1.0 s chunks, ~3.0 s ahead, realistic
  jitter) — a firehose replay never underruns and proves nothing. Per-deck ring
  30 s, prebuffer 1.5 s (in frames).
- Pin crate versions (`cpal`, `rtrb`, `fundsp`, `rubato`); record them for the
  `security.md` justification.

## Pass / fail

PASS requires all of:

1. **Zero underruns** at the granted buffer over a **≥10 min** two-deck run, counted
   the worklet's way (callback with fewer frames than requested) — **excluding** the
   initial prebuffer fill.
2. **Bit-exact bypass:** output == insert input (ULP 0; −0.0 ≡ +0.0; no NaN) at
   steady state inside the dead zone, **excluding** the ~20 ms ramp window.
3. **Ceiling invariant** holds on a hot input; **sub-threshold transparency** holds
   (makeup cancellation).
4. EQ / crossfade **within epsilon** (≤ 1e-4 or ±0.1 dB) after alignment.
5. **Click-free FX swap** via `Net::crossfade(Fade::Smooth)` — no discontinuity at
   the boundary.
6. A **transport chosen** on measured worst-case jitter under load.

**Fail path (not a phase failure):** an effect that can't reach parity in fundsp
drops to hand-rolled DSP — record which, and why, in Results.

## Results

_Pending execution. Fill with: the verdict per criterion (1–6); measured numbers
(underruns, granted buffer, latency, CPU; per-transport jitter table; per-target
parity error / magnitude divergence); the chosen transport with rationale; the
pinned crate versions; and the list of effects that need hand-rolled DSP. A PASS
flips ADR-0017 and ADR-0019 toward Accepted._
