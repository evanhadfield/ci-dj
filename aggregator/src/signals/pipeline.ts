/** The Phase 1 aggregation pipeline (docs/collective/PLAN.md §5).
 *
 * Order matters; the steps below correspond 1:1 to §5:
 *
 *   1. Ingest reactions + onboarding picks (deduped by userId).
 *   2. Per-user taste EWMA (taste.ts).
 *   3. Per-user contribution, capped (taste.ts).
 *   4. Shrinkage toward the DJ baseline (§5.4 `w = n_eff / (n_eff + k)`).
 *   5. Cluster — Phase 1 stays in single-organism mode, so this step
 *      is the centroid; Phase 3 swaps in PCA + K-means and a policy.
 *   6. Policy — Phase 1 uses the centroid directly.
 *   7. Compose streams — Phase 1 has only the taste-field target.
 *   8. Slew-limit the applied blend toward the target.
 *   9. Influence gate — applied client-side in the frontend bridge so
 *      the DJ macro and "lock for the drop" can drop influence to 0
 *      immediately (PLAN.md §9 fail-safe; PROMPT.md Phase 1 bullet 2).
 *
 * The pipeline is a pure step function over `RoomState`. The WS server
 * around it (ws/server.ts) drives the clock — calls `tick()` at the
 * cadence of the music's natural reaction time (§5 closing). */

import { lerpBlend, sumBlends, type VibeBlend, uniformBlend, cosineDistance } from './blend.js'
import { contribution } from './taste.js'
import type { TasteState } from './taste.js'

/** Shrinkage prior weight (§5.4 `k`). With this many "synthetic" prior
 * voters, the crowd needs visible agreement-mass to pull away from the
 * DJ baseline — so a single tapper at the start of the set doesn't
 * swing the room. */
export const SHRINKAGE_K = 6
/** Cap on the slew step per tick, measured as cosine distance between
 * the previous applied blend and the target (§5.8). 0.08 matches the
 * model's ~3 s reaction phrase under our default 1.5 s tick — full
 * traversal from "off" to "on" ≈ 12 ticks ≈ 18 s. */
export const MAX_SLEW_STEP_COS = 0.08

export type PipelineInputs = {
  /** Per-user taste state after decay + tap ingest (§5.1–.2). */
  tastes: ReadonlyMap<string, TasteState>
  /** The DJ baseline, the shrinkage prior (§5.4). Phase 1 uses the
   * uniform blend so the crowd's first agreement is what moves the
   * target; a Phase 2 DJ can publish their own baseline here. */
  djBaseline?: VibeBlend
  /** The blend the bridge applied last tick — the slew anchor (§5.8). */
  previousApplied: VibeBlend
}

export type PipelineOutputs = {
  /** The capped, summed crowd contribution (§5.3, pre-shrinkage). */
  crowdRaw: VibeBlend
  /** The shrunk centroid the policy outputs (§5.4–.6). */
  target: VibeBlend
  /** The blend the bridge should apply this tick — `previousApplied`
   * stepped toward `target` by at most `MAX_SLEW_STEP_COS` (§5.8). */
  applied: VibeBlend
  /** `n_eff`, the active-participant count used in shrinkage. Logged
   * so the operator can see when the centroid crosses out of the
   * shrinkage-dominated zone. */
  effectiveParticipants: number
}

/** §5.3: sum the per-user capped contributions into one crowd vector. */
function sumContributions(tastes: ReadonlyMap<string, TasteState>): {
  blend: VibeBlend
  effective: number
} {
  const blends: VibeBlend[] = []
  let effective = 0
  for (const taste of tastes.values()) {
    const c = contribution(taste)
    if (c.size === 0) continue
    let mass = 0
    for (const value of c.values()) mass += value
    if (mass <= 0) continue
    blends.push(c)
    // n_eff counts each user by their cap utilisation (a fully-engaged
    // user is one vote; a barely-warmed user is a fraction). A pure
    // headcount would let a flood of cold reactions outweigh a quorum
    // of warm ones — exactly what §5.4 is built to resist.
    effective += mass
  }
  return { blend: sumBlends(blends), effective }
}

/** §5.4: shrink the crowd raw toward the DJ baseline. The crowd's pull
 * scales with agreement-mass (the §5.4 `n_eff`), not headcount. */
function shrink(crowd: VibeBlend, prior: VibeBlend, nEff: number): VibeBlend {
  const w = nEff / (nEff + SHRINKAGE_K)
  return lerpBlend(prior, crowd, w)
}

/** §5.8: cap the cosine step from previous to target. If the desired
 * move is small, we land at the target; if it's large, we lerp the way
 * there. Either way the applied blend never jumps. */
function slew(previous: VibeBlend, target: VibeBlend): VibeBlend {
  const distance = cosineDistance(previous, target)
  if (distance <= MAX_SLEW_STEP_COS) return target
  const t = MAX_SLEW_STEP_COS / distance
  return lerpBlend(previous, target, t)
}

/** Run one aggregation tick. Pure. */
export function tick(inputs: PipelineInputs): PipelineOutputs {
  const prior = inputs.djBaseline ?? uniformBlend()
  const { blend: crowdRaw, effective } = sumContributions(inputs.tastes)
  const target = shrink(crowdRaw, prior, effective)
  const applied = slew(inputs.previousApplied, target)
  return {
    crowdRaw,
    target,
    applied,
    effectiveParticipants: effective,
  }
}
