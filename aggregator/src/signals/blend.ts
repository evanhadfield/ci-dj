/** Vibe blend — a sparse non-negative weight per seed vibe, summing to 1.
 *
 * The "single shrunk centroid" of Phase 1 (docs/collective/PLAN.md §5)
 * lives in this space. The full design models a centroid in MusicCoCa's
 * 768-dim embedding space (§0), but a Phase 1 blend over a fixed seed
 * catalog is the operationally faithful, embedding-free version: the
 * arithmetic — weighted mean, shrinkage, slew — is the same. Phase 3
 * swaps this layer for vectors once `/api/embed` is in the loop. */

import { SEED_VIBES, type VibePromptId } from './vibes.js'

export type VibeBlend = ReadonlyMap<VibePromptId, number>

/** A uniform blend across the seed catalog — the DJ's neutral baseline
 * when no crowd target has formed yet. Phase 1 also uses this as the
 * shrinkage prior (§5.4). */
export function uniformBlend(): VibeBlend {
  const weight = 1 / SEED_VIBES.length
  return new Map(SEED_VIBES.map((v) => [v.id, weight]))
}

/** A blend with all weight on a single prompt (the seed-pick onboarding
 * contribution before reactions stack on it). */
export function singletonBlend(id: VibePromptId, weight = 1): VibeBlend {
  return new Map([[id, weight]])
}

/** Sum a list of blends into one, normalising to sum 1. Empty inputs
 * fall back to the uniform baseline so a sub-N crowd doesn't crash the
 * downstream slew/transport into a NaN target. */
export function sumBlends(blends: readonly VibeBlend[]): VibeBlend {
  if (blends.length === 0) return uniformBlend()
  const totals = new Map<VibePromptId, number>()
  let sum = 0
  for (const blend of blends) {
    for (const [id, weight] of blend) {
      if (weight <= 0) continue
      totals.set(id, (totals.get(id) ?? 0) + weight)
      sum += weight
    }
  }
  if (sum === 0) return uniformBlend()
  for (const [id, weight] of totals) totals.set(id, weight / sum)
  return totals
}

/** Linear interpolation between two blends. `t = 0` returns `a`, `t = 1`
 * returns `b`. Used for the shrinkage step (§5.4) and the slew step
 * (§5.8), where the same convex combination is the right primitive. */
export function lerpBlend(a: VibeBlend, b: VibeBlend, t: number): VibeBlend {
  const clamped = Math.max(0, Math.min(1, t))
  const ids = new Set<VibePromptId>([...a.keys(), ...b.keys()])
  const out = new Map<VibePromptId, number>()
  let sum = 0
  for (const id of ids) {
    const value = (1 - clamped) * (a.get(id) ?? 0) + clamped * (b.get(id) ?? 0)
    if (value > 0) {
      out.set(id, value)
      sum += value
    }
  }
  if (sum === 0) return uniformBlend()
  for (const [id, value] of out) out.set(id, value / sum)
  return out
}

/** Cosine distance between two blends viewed as vectors. The slew limit
 * (§5.8) caps movement by this distance per tick: matches the model's
 * ~3 s reaction latency and turns attacks into vetoable drift. */
export function cosineDistance(a: VibeBlend, b: VibeBlend): number {
  let dot = 0
  let aMag = 0
  let bMag = 0
  const ids = new Set<VibePromptId>([...a.keys(), ...b.keys()])
  for (const id of ids) {
    const av = a.get(id) ?? 0
    const bv = b.get(id) ?? 0
    dot += av * bv
    aMag += av * av
    bMag += bv * bv
  }
  if (aMag === 0 || bMag === 0) return 1
  const cosine = dot / (Math.sqrt(aMag) * Math.sqrt(bMag))
  return 1 - Math.max(-1, Math.min(1, cosine))
}

/** A blend serialised as a top-K weighted prompt list — the shape the
 * deck worker's `set_style` consumes (frontend/src/deck/nativeDeck.ts).
 * `k` defaults to the deck worker's 8-prompt ceiling (PLAN.md §0). */
export function topKEntries(
  blend: VibeBlend,
  k = 8,
): { id: VibePromptId; weight: number }[] {
  const entries = [...blend.entries()]
    .filter(([, w]) => w > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, k)
  const total = entries.reduce((sum, [, w]) => sum + w, 0)
  if (total === 0) return []
  return entries.map(([id, weight]) => ({ id, weight: weight / total }))
}
