/** Pure transport math for a playback-mode deck (M19, ADR-0013). An
 * AudioBufferSourceNode can neither pause nor report a playhead, so the
 * channel anchors an offset against context time and derives the rest
 * here — unit-tested, no Web Audio in sight. */

export type TrackTransport =
  | { state: 'paused'; offset: number }
  | { state: 'playing'; offset: number; startedAt: number; rate: number }
  | { state: 'ended'; offset: number }

/** The playhead in seconds, clamped into the track. While playing it
 * advances at `rate` track-seconds per context-second (varispeed,
 * M20); the channel re-anchors on every rate change, so this stays
 * exact across changes and bends. */
export function positionAt(
  transport: TrackTransport,
  now: number,
  duration: number,
): number {
  const raw =
    transport.state === 'playing'
      ? transport.offset + (now - transport.startedAt) * transport.rate
      : transport.offset
  return Math.min(Math.max(raw, 0), duration)
}

/** Varispeed bounds (ADR-0014): ±8 %, the classic DJ envelope. */
export const TRACK_RATE_RANGE = 0.08

export function clampRate(rate: number): number {
  if (!Number.isFinite(rate)) return 1
  return Math.min(Math.max(rate, 1 - TRACK_RATE_RANGE), 1 + TRACK_RATE_RANGE)
}

/** The phase nudge's bend strength: how far the rate steps while a
 * nudge is slipping (ADR-0014 — the platter-drag metaphor). */
export const NUDGE_BEND_FRACTION = 0.05

/** Plan a stepped bend that slips `slipSeconds` of phase: the bent
 * rate to hold and for how long. Positive slip pushes the playhead
 * ahead (briefly faster), negative drags it back. */
export function bendPlan(
  slipSeconds: number,
  baseRate: number,
): { rate: number; durationSeconds: number } {
  const direction = slipSeconds >= 0 ? 1 : -1
  return {
    rate: baseRate * (1 + direction * NUDGE_BEND_FRACTION),
    durationSeconds:
      Math.abs(slipSeconds) / (baseRate * NUDGE_BEND_FRACTION),
  }
}

/** Phase slipped after `elapsed` seconds bent to `bentRate` against
 * `baseRate` — what a bend interrupted mid-flight already consumed. */
export function bendConsumed(
  elapsedSeconds: number,
  baseRate: number,
  bentRate: number,
): number {
  return (bentRate - baseRate) * elapsedSeconds
}

/** Where a seek lands: clamped into the track, garbage to the top. */
export function clampOffset(seconds: number, duration: number): number {
  if (!Number.isFinite(seconds) || seconds < 0) return 0
  return Math.min(seconds, duration)
}

/** Min/max envelope per bucket across both channels — the static
 * overview a decoded track can afford that the live stream cannot.
 * Buckets cover the buffer evenly; a short final bucket still counts. */
export function trackPeaks(
  left: Float32Array,
  right: Float32Array,
  buckets: number,
): { min: Float32Array; max: Float32Array } {
  const min = new Float32Array(buckets)
  const max = new Float32Array(buckets)
  const frames = left.length
  if (frames === 0 || buckets === 0) return { min, max }
  for (let bucket = 0; bucket < buckets; bucket++) {
    const start = Math.floor((bucket * frames) / buckets)
    const end = Math.max(Math.floor(((bucket + 1) * frames) / buckets), start + 1)
    let lo = Infinity
    let hi = -Infinity
    for (let i = start; i < end && i < frames; i++) {
      const l = left[i]
      const r = right[i]
      if (l < lo) lo = l
      if (r < lo) lo = r
      if (l > hi) hi = l
      if (r > hi) hi = r
    }
    min[bucket] = lo === Infinity ? 0 : lo
    max[bucket] = hi === -Infinity ? 0 : hi
  }
  return { min, max }
}

/** Map the FLX4 tempo slider (14-bit, 0..1) onto the varispeed range.
 * Orientation MEASURED on the device (M20 checklist): this firmware
 * sends low values at the slow end — the opposite of the chart
 * assumption, which shipped inverted and was caught on hardware. */
export function tempoSliderToRate(value: number): number {
  return clampRate(1 + (value - 0.5) * 2 * TRACK_RATE_RANGE)
}

/** Phase offset between two beat clocks, wrapped to [-0.5, 0.5)
 * beats — what the phase meter shows. */
export function phaseOffsetBeats(
  a: { periodSeconds: number; beatAtContext: number },
  b: { periodSeconds: number; beatAtContext: number },
): number {
  const raw = (a.beatAtContext - b.beatAtContext) / b.periodSeconds
  return ((((raw % 1) + 1) % 1) + 0.5) % 1 - 0.5
}
