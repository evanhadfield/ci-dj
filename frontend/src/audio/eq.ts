/** The deck EQ's knob-value → gain curve and band layout (roadmap M6).
 *
 * Classic DJ-mixer behaviour: centre is flat, the top half boosts modestly,
 * the bottom half cuts down to -40dB. The low/high shelves attenuate their
 * whole band at that gain (a true kill); the mid is a bell at 1 kHz, so its
 * bottom is a deep notch rather than a full-band kill — the same trade-off
 * as a shelf+peak mixer EQ. */

export type EqBand = 'low' | 'mid' | 'high'

export const EQ_BANDS: EqBand[] = ['low', 'mid', 'high']

export const EQ_FLAT = 0.5
export const EQ_BOOST_DB = 6
export const EQ_KILL_DB = -40

/** Crossover layout: low shelf below ~250 Hz, mid bell around 1 kHz, high
 * shelf above ~2.5 kHz — conventional 3-band DJ isolator points. */
export const EQ_FILTERS: Record<
  EqBand,
  { type: BiquadFilterType; frequency: number; q?: number }
> = {
  low: { type: 'lowshelf', frequency: 250 },
  mid: { type: 'peaking', frequency: 1_000, q: 0.7 },
  high: { type: 'highshelf', frequency: 2_500 },
}

/** Map a control value in [0, 1] to filter gain in dB: 0 → kill,
 * 0.5 → flat, 1 → boost; linear within each half. */
export function eqValueToDb(value: number): number {
  const clamped = Math.min(1, Math.max(0, value))
  if (clamped >= EQ_FLAT) {
    return ((clamped - EQ_FLAT) / (1 - EQ_FLAT)) * EQ_BOOST_DB
  }
  return (1 - clamped / EQ_FLAT) * EQ_KILL_DB
}
