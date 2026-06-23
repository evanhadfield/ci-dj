/** Approval temperature (Phase 1; docs/collective/PLAN.md §1, §7c).
 *
 * The room's EWMA net-approval, −1…+1: the trace the host screen draws
 * and the gauge each phone shows. Every counted reaction lands here
 * with sign ±1; rate of taps doesn't matter (cap on each user keeps
 * this a *mood*, not a tap count). */

export const TEMPERATURE_HALFLIFE_MS = 15_000

export type Temperature = {
  /** EWMA mean of recent reaction signs in `[-1, +1]`. */
  value: number
  /** Wall time the EWMA was last advanced. */
  updatedAt: number
}

export function emptyTemperature(now: number): Temperature {
  return { value: 0, updatedAt: now }
}

function decayFactor(dtMs: number): number {
  if (dtMs <= 0) return 1
  const lambda = Math.LN2 / TEMPERATURE_HALFLIFE_MS
  return Math.exp(-lambda * dtMs)
}

/** Decay the temperature to `now`. */
export function decayedTemperature(temperature: Temperature, now: number): Temperature {
  const factor = decayFactor(now - temperature.updatedAt)
  return { value: temperature.value * factor, updatedAt: now }
}

/** Mix one reaction into the temperature with a small step weight so a
 * single tap nudges the gauge but never pegs it. The §1 cap on per-user
 * contribution is what keeps a mashing user from pegging the trace; the
 * weight here just sets the per-tap nudge size. */
export const TEMPERATURE_TAP_WEIGHT = 0.05

export function applyReactionToTemperature(
  temperature: Temperature,
  sign: 1 | -1,
  ts: number,
): Temperature {
  const decayed = decayedTemperature(temperature, ts)
  const blended = decayed.value + TEMPERATURE_TAP_WEIGHT * (sign - decayed.value)
  return { value: Math.max(-1, Math.min(1, blended)), updatedAt: ts }
}
