/** Sparse user × vibe-prompt opinion matrix (Phase 2; PLAN.md §4).
 *
 * The Pol.is-style object the Phase 2 card stack writes into and that
 * Phase 3 runs PCA + K-means on. v1 keeps it sparse, mean-centered,
 * no imputation (PLAN.md §4). Wilson lower-bound scoring on the
 * agree/disagree counts gives the support number the host-screen
 * vibe map sizes circles by.
 *
 * Wire format for a vote on a prompt:
 *   +1 agree · 0 pass · -1 disagree (PLAN.md §1 signal 2). */

import type { VibePromptId } from './prompts.js'

export type Vote = -1 | 0 | 1

/** z-score for a 95% one-sided Wilson lower bound. The card stack and
 * the host-screen map both sort by this score — it down-weights low-
 * vote prompts without making them invisible (PLAN.md §10 — "Wilson /
 * Bayesian support scoring"). */
const WILSON_Z = 1.96

/** Wilson lower bound on the agree-rate, given agrees vs total.
 *
 * `passes` are counted in `total` but not in `agrees`: they're
 * neither-agree-nor-disagree (the §4 mean-centered shape), so the
 * lower bound treats them as half-agree. A pure disagree pile gives 0;
 * a pure agree pile gives a number < 1 that climbs toward 1 with more
 * votes. */
export function wilsonScore(agrees: number, total: number): number {
  if (total <= 0) return 0
  const p = agrees / total
  const z2 = WILSON_Z * WILSON_Z
  const numerator = p + z2 / (2 * total) - WILSON_Z * Math.sqrt((p * (1 - p) + z2 / (4 * total)) / total)
  const denominator = 1 + z2 / total
  return Math.max(0, numerator / denominator)
}

export type PromptVoteSummary = {
  agree: number
  disagree: number
  pass: number
  /** Wilson lower bound on the (agree + 0.5·pass) rate. */
  support: number
  lastVoteTs: number
}

/** Sparse `user × prompt → vote` store. Iteration cost is O(votes),
 * not O(users × prompts) — Phase 3's PCA will need the rows directly
 * (mean-centered), so the sparse-row representation is what unlocks it. */
export class OpinionMatrix {
  private readonly byUser = new Map<string, Map<VibePromptId, Vote>>()
  private readonly summaries = new Map<VibePromptId, PromptVoteSummary>()

  /** Record (or overwrite) a single vote. Idempotent on `(user, prompt)`. */
  vote(userId: string, promptId: VibePromptId, vote: Vote, now: number = Date.now()): void {
    const row = this.byUser.get(userId) ?? new Map<VibePromptId, Vote>()
    const previous = row.get(promptId) ?? 0
    if (previous === vote && row.has(promptId)) return
    row.set(promptId, vote)
    this.byUser.set(userId, row)
    this.rebuildSummary(promptId, now)
  }

  /** Forget every vote a user cast (eviction). */
  forgetUser(userId: string): void {
    const row = this.byUser.get(userId)
    if (!row) return
    const touched = [...row.keys()]
    this.byUser.delete(userId)
    for (const promptId of touched) this.rebuildSummary(promptId, Date.now())
  }

  /** Drop a vote — e.g. when a prompt is evicted from the pool. */
  forgetPrompt(promptId: VibePromptId): void {
    for (const row of this.byUser.values()) row.delete(promptId)
    this.summaries.delete(promptId)
  }

  summary(promptId: VibePromptId): PromptVoteSummary {
    return this.summaries.get(promptId) ?? emptySummary()
  }

  /** Phase 3 hook: every row as a sparse map. Mean-centering and the
   * PCA pass live in Phase 3 (`clusters.ts`); the matrix-level seam is
   * just "give me the data". */
  rows(): Map<string, ReadonlyMap<VibePromptId, Vote>> {
    return new Map(this.byUser)
  }

  /** Total active voters (rows with at least one vote). The §5.5
   * `CLUSTER_MIN_N` gate reads this in Phase 3. */
  activeVoters(): number {
    let n = 0
    for (const row of this.byUser.values()) if (row.size > 0) n++
    return n
  }

  private rebuildSummary(promptId: VibePromptId, now: number): void {
    let agree = 0
    let disagree = 0
    let pass = 0
    for (const row of this.byUser.values()) {
      const vote = row.get(promptId)
      if (vote === 1) agree++
      else if (vote === -1) disagree++
      else if (vote === 0) pass++
    }
    const total = agree + disagree + pass
    const support = wilsonScore(agree + 0.5 * pass, total)
    if (total === 0) {
      this.summaries.delete(promptId)
      return
    }
    this.summaries.set(promptId, { agree, disagree, pass, support, lastVoteTs: now })
  }
}

function emptySummary(): PromptVoteSummary {
  return { agree: 0, disagree: 0, pass: 0, support: 0, lastVoteTs: 0 }
}
