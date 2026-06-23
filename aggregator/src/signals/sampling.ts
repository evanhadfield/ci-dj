/** Thompson sampling on Beta posteriors — the surfacing algorithm
 * the card dealer uses (PLAN.md §1 signal 2 + §7b coverage-balanced).
 *
 * Each prompt has agree / disagree / pass counts. We treat agreement
 * as a Bernoulli trial with prior Beta(1, 1) (uniform — Laplace
 * smoothing). The posterior is Beta(agree + 0.5·pass + 1,
 * disagree + 0.5·pass + 1) — passes contribute neutrally.
 *
 * Drawing once from that posterior per prompt gives us the four
 * properties we want simultaneously:
 *
 *   - **No self-fulfilling top-K cycle.** The sample is stochastic;
 *     high-mass prompts win *most* of the time, never always.
 *   - **Downvote suppression.** Beta(α, β) shifts toward 0 as β grows.
 *   - **Recalibration.** Every new vote updates α or β; a prompt that
 *     was downvoted early but later upvoted moves with the evidence.
 *   - **Fresh-entry exploration.** A new prompt is Beta(1, 1) = uniform,
 *     so it has ~50% odds of beating even a 9-agree seed in any draw.
 *
 * A small linear recency bonus on top of the sample fast-tracks the
 * very newest prompts so a popular "bluegrass" suggestion can lead
 * the deal within the first few minutes. The bonus decays to zero so
 * the bandit term takes over once the prompt has votes to ground it.
 *
 * The functions take an explicit `random` function so tests are
 * deterministic with a seeded PRNG. */

export type RandomFn = () => number

/** Time window over which the recency bonus decays. Five minutes
 * matches the typical room-warm-up: enough time for a few votes,
 * short enough that the catalog isn't dominated by every new
 * submission forever. */
export const FRESH_BOOST_MS = 5 * 60_000

/** Max additive bonus on a brand-new prompt's sample score. The Beta
 * sample sits in [0, 1]; 0.3 is "this fresh prompt looks roughly as
 * appealing as a Wilson-rate-0.8 incumbent" — enough to surface, not
 * enough to dominate. */
export const FRESH_BOOST_AMOUNT = 0.3

/** Linear-decay recency bonus on a sample-rate. `ageMs < 0` is
 * clamped to 0; `ageMs >= FRESH_BOOST_MS` returns 0. */
export function recencyBonus(ageMs: number): number {
  if (ageMs <= 0) return FRESH_BOOST_AMOUNT
  if (ageMs >= FRESH_BOOST_MS) return 0
  return FRESH_BOOST_AMOUNT * (1 - ageMs / FRESH_BOOST_MS)
}

/** Sample a Beta(alpha, beta) variate via two Gamma samples. Valid
 * for any α, β > 0. */
export function sampleBeta(alpha: number, beta: number, random: RandomFn = Math.random): number {
  const a = sampleGamma(alpha, random)
  const b = sampleGamma(beta, random)
  const sum = a + b
  if (sum === 0) return 0.5
  return a / sum
}

/** Sample a Gamma(shape, scale=1) variate.
 *
 * Marsaglia & Tsang's method for shape ≥ 1 (Ahrens-Dieter for shape
 * < 1 falls back through a single boost step). Both are textbook
 * algorithms — see "A Simple Method for Generating Gamma Variables",
 * ACM TOMS 26(3), 2000. */
export function sampleGamma(shape: number, random: RandomFn = Math.random): number {
  if (shape < 1) {
    return sampleGamma(shape + 1, random) * Math.pow(random(), 1 / shape)
  }
  const d = shape - 1 / 3
  const c = 1 / Math.sqrt(9 * d)
  // Bounded loop guards against pathological RNGs in tests; in
  // practice the acceptance probability is ≥ 0.95.
  for (let attempt = 0; attempt < 100; attempt++) {
    let x: number
    let v: number
    do {
      x = sampleNormal(random)
      v = 1 + c * x
    } while (v <= 0)
    v = v * v * v
    const u = random()
    if (u < 1 - 0.0331 * x * x * x * x) return d * v
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v
  }
  // Effectively unreachable; falls back to the expectation E[Gamma] = shape.
  return shape
}

/** Sample a standard normal via Box-Muller. Uses `1 - random()` so
 * `Math.log(0)` is never invoked. */
export function sampleNormal(random: RandomFn = Math.random): number {
  const u = 1 - random()
  const v = random()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}

/** A deterministic PRNG for tests. Mulberry32 — small, fast, and
 * well-distributed enough for unit-test sampling. */
export function mulberry32(seed: number): RandomFn {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return (((t ^ (t >>> 14)) >>> 0) / 0x1_0000_0000)
  }
}
