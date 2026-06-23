/** Phase 3 seam — clusters on the OpinionMatrix (PLAN.md §5.5, §6).
 *
 * Phase 3 plugs PCA + K-means in here, gated on `CLUSTER_MIN_N` active
 * participants. Phase 2 only exports the empty shape and the `auto`
 * fallback so the rest of the pipeline can subscribe to the seam
 * without behaviour drift.
 *
 * Keeping this file in place ahead of Phase 3 makes the cluster fan-out
 * a one-import change for the WS server and the host-screen: replace
 * `clusterStub()` with the real PCA + K-means routine, and the
 * downstream code keeps its types. */

import type { OpinionMatrix } from './opinion-matrix.js'
import type { VibePromptId } from './prompts.js'

/** §5.5: below this active-participant count, cluster analysis is
 * disabled and the pipeline falls back to a single shrunk centroid.
 * Phase 3 reads this value too. */
export const CLUSTER_MIN_N = 18

/** A single opinion cluster discovered by PCA + K-means on the
 * OpinionMatrix. Phase 3 will populate this; Phase 2 only carries the
 * shape so the wire format is forward-compatible. */
export type OpinionCluster = {
  id: string
  /** Number of voters in this cluster. */
  size: number
  /** Per-prompt mean opinion in `[-1, +1]` (the cluster's centroid). */
  meanVotes: ReadonlyMap<VibePromptId, number>
}

/** Phase-3 social-choice policy selector (PLAN.md §6). Phase 2 carries
 * the type but doesn't surface a UI toggle. */
export type PolicyChoice = 'centroid' | 'pr' | 'maximin' | 'auto'

/** Phase-2 default: no clusters, centroid policy. Phase 3 replaces the
 * implementation with the real one and keeps the same return shape. */
export function clusterStub(_matrix: OpinionMatrix): {
  clusters: readonly OpinionCluster[]
  policy: PolicyChoice
} {
  return { clusters: [], policy: 'centroid' }
}
