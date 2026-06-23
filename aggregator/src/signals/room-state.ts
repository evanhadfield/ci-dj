/** Per-room signals state (Phase 1 reactive backbone + Phase 2 prompt
 * pool & opinion matrix; docs/collective/PLAN.md §5).
 *
 * Holds everything the aggregation tick consumes plus a hook to fan
 * the applied blend out to the bridge. Phase 2 adds the user-
 * suggestable `VibePromptPool` and the sparse `OpinionMatrix`; their
 * surface lives on this class so the WS server only talks to one
 * object per room. Phase 3 swaps the centroid policy + clustering in
 * over the same shapes (the `clusters`/`policyChoice` seams are kept
 * empty here — `clusters.ts` will fill them). */

import { topKEntries, uniformBlend, type VibeBlend } from './blend.js'
import {
  applyReaction,
  applySeedPicks,
  emptyTasteState,
  type TasteState,
} from './taste.js'
import {
  applyReactionToTemperature,
  decayedTemperature,
  emptyTemperature,
  type Temperature,
} from './temperature.js'
import { tick, type PipelineOutputs } from './pipeline.js'
import { type VibePromptId } from './vibes.js'
import { VibePromptPool, type SuggestResult, type VibePrompt } from './prompts.js'
import { OpinionMatrix, type Vote } from './opinion-matrix.js'
import { recencyBonus, sampleBeta, type RandomFn } from './sampling.js'
import type { EmbedClient } from './embed.js'
import type { VibeCard } from './messages.js'
import {
  clusterMatrix,
  clusterMass,
  computePolicies,
  type ClusterMass,
  type OpinionCluster,
  type PolicyChoice,
  type PolicyOutputs,
} from './clusters.js'

export { CLUSTER_MIN_N } from './clusters.js'

/** Default tick cadence. Matches a musical phrase (§5 closing), giving
 * the slew limiter (§5.8) time to look like drift, not jitter. */
export const TICK_INTERVAL_MS = 1500

/** Default size of a card deal for the Vibes tab. The phone re-
 * requests when it runs low. */
export const DEFAULT_CARD_LIMIT = 12

/** Size of the onboarding "tap 3" deal — the welcome message hands
 * the phone exactly this many cards drawn from the unified pool. */
export const ONBOARDING_CARD_LIMIT = 9

export type RoomSignals = {
  applied: VibeBlend
  target: VibeBlend
  crowdRaw: VibeBlend
  effectiveParticipants: number
  temperature: Temperature
  /** Number of seated phones — the host screen's "n people are here"
   * line, also the `effectiveParticipants` quorum check (§5.5
   * `CLUSTER_MIN_N`). */
  participantCount: number
  /** Number of active voters (rows with at least one vote on the
   * OpinionMatrix). The §5.5 `CLUSTER_MIN_N` gate reads this — Phase 3
   * splits the room into clusters only when this clears the floor. */
  activeVoters: number
  /** Per-prompt support driven by Phase 2's OpinionMatrix Wilson lower
   * bound (PLAN.md §7c single-organism map). Phase 1's "liked mass per
   * seed id" was a pre-card-stack fallback; Phase 2 sources this from
   * card-stack votes on the prompt pool. */
  vibeSupport: ReadonlyMap<VibePromptId, number>
  /** The active prompt pool — every prompt the room can vote on, both
   * seed and user-submitted, minus retired (satisfied) and unapproved. */
  activePrompts: readonly VibePrompt[]
  /** Phase 3: the opinion groups discovered by PCA + K-means on the
   * OpinionMatrix. Empty below `CLUSTER_MIN_N` — the room renders in
   * single-organism mode and the policy collapses to centroid. */
  clusters: readonly OpinionCluster[]
  /** Phase 3: per-vibe cluster sentiment, keyed by prompt id. The
   * host-screen split-ring renderer reads this directly. Empty below
   * the gate. */
  clusterMass: ReadonlyMap<VibePromptId, readonly ClusterMass[]>
  /** Phase 3: per-user cosine distance to the dominant PCA subspace
   * (PLAN.md §5 deferred ledger — "logged, not driving"). Phase 4
   * closes the loop into the contribution cap. */
  outlierDistances: ReadonlyMap<string, number>
  /** Phase 3 §6: all three policy blends computed this tick + which
   * one drove the applied target. Logged so the operator can see the
   * three side-by-side (auto / pr / maximin) even when only one is
   * driving the deck. */
  policy: PolicyOutputs
}

/** Phase 2 surfaces the suggestion pool and the moderation lane; the
 * cluster slot is the Phase 3 hook (`pca-kmeans.ts` lands behind it). */
export type RoomStubs = {
  /** PLAN.md §1 signal 2: the active vibe-prompt pool (seed + user). */
  suggestions: readonly { id: string; text: string; support: number; satisfied: boolean }[]
  /** PLAN.md §5.5 + §6: clusters and the resulting policy decision.
   * Phase 3 fills this — `clusters.ts` is the seam. */
  clusters: readonly never[]
  /** PLAN.md §9: prompts awaiting DJ approve/veto. Phase 2 keeps it
   * empty (the moderation classifier is a stub; submissions land
   * auto-approved), but the field is on-wire so a Phase 4 classifier
   * can populate it without a schema bump. */
  moderationQueue: readonly { id: string; text: string }[]
}

export type RoomStateOptions = {
  embedClient?: EmbedClient
  /** Override the dealer's RNG. Production uses `Math.random`; tests
   * inject a seeded PRNG (Mulberry32) for deterministic deal orders. */
  random?: RandomFn
}

export class RoomSignalsState {
  private readonly tastes = new Map<string, TasteState>()
  private temperature: Temperature
  private applied: VibeBlend = uniformBlend()
  private target: VibeBlend = uniformBlend()
  private crowdRaw: VibeBlend = uniformBlend()
  private effective = 0
  private readonly listeners = new Set<(signals: RoomSignals) => void>()
  private readonly pool: VibePromptPool
  private readonly matrix = new OpinionMatrix()
  private readonly embedClient: EmbedClient | null
  private readonly random: RandomFn
  /** Per-user "cards dealt so far this session" — Phase 2 still
   * filters dealt cards so a user doesn't see the same prompt twice
   * in their stack (the Thompson sampler is independent of this set). */
  private readonly dealtBy = new Map<string, Set<VibePromptId>>()
  /** Phase 3 §6: the DJ's policy selection, defaulting to `auto`.
   * `setPolicyChoice` mutates this; the next tick reads it. */
  private policyChoice: PolicyChoice = 'auto'
  /** Monotonic tick counter that feeds the `pr` rotation slot. */
  private tickCount = 0
  private lastClusters: readonly OpinionCluster[] = []
  private lastClusterMass: ReadonlyMap<VibePromptId, readonly ClusterMass[]> = new Map()
  private lastOutliers: ReadonlyMap<string, number> = new Map()
  private lastPolicy: PolicyOutputs = {
    centroid: new Map(),
    pr: new Map(),
    maximin: new Map(),
    resolved: new Map(),
    choice: 'auto',
    appliedPolicy: 'centroid',
  }

  constructor(now: number = Date.now(), options: RoomStateOptions = {}) {
    this.temperature = emptyTemperature(now)
    this.pool = new VibePromptPool(now)
    this.embedClient = options.embedClient ?? null
    this.random = options.random ?? Math.random
  }

  /** Phase 3 §6: the DJ-selectable social-choice policy. Stored on the
   * room so a reconnecting bridge sees the active choice without
   * re-pushing it. `auto` = centroid under `CLUSTER_MIN_N`, `pr` over. */
  setPolicyChoice(choice: PolicyChoice): void {
    this.policyChoice = choice
  }

  policyChoiceValue(): PolicyChoice {
    return this.policyChoice
  }

  /** Seat a phone. Idempotent — a reconnect with the same `userId`
   * resumes the existing taste vector (PLAN.md §7a reconnect path). */
  seat(userId: string, now: number = Date.now()): void {
    if (!this.tastes.has(userId)) {
      this.tastes.set(userId, emptyTasteState(now))
    }
  }

  /** Apply the onboarding pick-3 (§7b). Phase 2 unifies onboarding
   * with the Vibes-tab card stack: picks may now be user-submitted
   * prompts, not just the seed catalog. Each accepted pick lands as:
   *
   *   - +1 mass on the user's taste vector — so it influences the
   *     deck blend through the pipeline (PLAN.md §5.7 "Suggestions
   *     inject vocabulary the audio can't imply").
   *   - +1 agree vote on the OpinionMatrix — so the host-screen vibe
   *     map and the Thompson dealer see fresh support immediately.
   *
   * Unknown ids are dropped at this boundary; the inner taste helper
   * trusts its input. */
  applySeed(userId: string, picks: readonly VibePromptId[], now: number = Date.now()): void {
    const state = this.tastes.get(userId) ?? emptyTasteState(now)
    const valid = picks.filter((id) => this.pool.get(id) !== null)
    this.tastes.set(userId, applySeedPicks(state, valid, now))
    for (const id of valid) {
      this.matrix.vote(userId, id, 1, now)
      const summary = this.matrix.summary(id)
      this.pool.setSupport(id, summary.support, now)
    }
  }

  ingestReaction(userId: string, sign: 1 | -1, ts: number = Date.now()): void {
    const state = this.tastes.get(userId) ?? emptyTasteState(ts)
    const updated = applyReaction(state, { sign, activeBlend: this.applied, ts })
    this.tastes.set(userId, updated)
    this.temperature = applyReactionToTemperature(this.temperature, sign, ts)
  }

  /** Phase 2 §7b "Suggest a vibe": semantic-deduped via the embed
   * client (when wired) against the existing pool, otherwise added
   * straight in. Per-user rate limit lives inside the pool. */
  async suggest(input: { userId: string; text: string; now?: number }): Promise<SuggestResult> {
    return this.pool.suggest({
      userId: input.userId,
      text: input.text,
      embed: this.embedClient
        ? (text: string) => this.embedClient!.embedText(text)
        : undefined,
      now: input.now,
    })
  }

  /** Cast a Phase 2 card-stack vote. Idempotent on `(user, prompt)` —
   * a re-vote overwrites the previous opinion. The host-screen support
   * map updates on the next tick. */
  castVote(
    userId: string,
    promptId: VibePromptId,
    vote: Vote,
    now: number = Date.now(),
  ): { ok: boolean } {
    if (!this.pool.get(promptId)) return { ok: false }
    this.matrix.vote(userId, promptId, vote, now)
    const summary = this.matrix.summary(promptId)
    this.pool.setSupport(promptId, summary.support, now)
    // Mark the prompt as "shown to this user" — if the phone is
    // mid-stack and we deal more cards, we don't re-deal a voted-on one.
    this.markDealt(userId, promptId)
    return { ok: true }
  }

  /** Deal cards from the unified pool to a phone. Used by both the
   * onboarding "tap 3" screen (via `welcome`) and the Vibes-tab card
   * stack (via `request_cards`).
   *
   * Surfacing algorithm — Thompson sampling on Beta(α, β) with a
   * linear recency bonus (`signals/sampling.ts`):
   *
   *   - α = agree + 0.5·pass + 1   (Laplace prior, passes count half)
   *   - β = disagree + 0.5·pass + 1
   *   - score = sampleBeta(α, β) + recencyBonus(age)
   *
   * Sorting by `score` descending gives a stochastic order that
   * prefers high-agreement prompts on average but always leaves room
   * for exploration — no "top-K trap", downvoted prompts naturally
   * sink, and fresh suggestions can rise rapidly if their first few
   * votes are positive. Tests pin the distribution; production runs
   * Math.random.
   *
   * The per-user dealt-set still filters out prompts the user has
   * already seen this session, so the stack never repeats. */
  dealCards(
    userId: string,
    limit: number = DEFAULT_CARD_LIMIT,
    options: { markDealt?: boolean; now?: number } = {},
  ): VibeCard[] {
    const now = options.now ?? Date.now()
    // `markDealt` defaults to true for the Vibes-tab card stack (so a
    // mid-stack re-request doesn't re-serve unvoted cards). The
    // onboarding welcome path passes `false`: a card glanced at in
    // the picker but not chosen is still fair game for the Vibes tab.
    const markDealt = options.markDealt ?? true
    const seen = this.dealtBy.get(userId) ?? new Set<VibePromptId>()
    const active = this.pool.active()
    const candidates = active.filter((p) => !seen.has(p.id))
    const ordered = candidates
      .map((p) => {
        const summary = this.matrix.summary(p.id)
        const alpha = summary.agree + 0.5 * summary.pass + 1
        const beta = summary.disagree + 0.5 * summary.pass + 1
        const sample = sampleBeta(alpha, beta, this.random)
        const age = Math.max(0, now - p.createdAt)
        return { prompt: p, score: sample + recencyBonus(age) }
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(1, limit))
    const cards: VibeCard[] = []
    for (const { prompt } of ordered) {
      const summary = this.matrix.summary(prompt.id)
      cards.push({
        id: prompt.id,
        label: prompt.label,
        voteCount: summary.agree + summary.disagree + summary.pass,
      })
      if (markDealt) this.markDealt(userId, prompt.id)
    }
    return cards
  }

  /** Resolve the `set_style` text for a prompt id. The deck worker
   * accepts arbitrary text (it embeds via MusicCoCa), so user-
   * submitted prompts like `bluegrass` flow through unchanged — they
   * just need a valid lookup, not a seed-catalog entry. */
  promptText(id: VibePromptId): string | null {
    return this.pool.get(id)?.text ?? null
  }

  /** True iff this user has cast at least one card-stack vote or
   * onboarding pick. The welcome handler reports this as `seeded` so
   * a refresh after an abandoned onboarding doesn't claim the user
   * finished — only a real interaction counts. */
  hasInteracted(userId: string): boolean {
    const row = this.matrix.rows().get(userId)
    return row !== undefined && row.size > 0
  }

  /** Run one aggregation tick and return the new signals snapshot.
   *
   * Phase 2 also runs the prompt-pool sweep: decay support against
   * staleness, retire prompts whose embedding has caught up to the
   * applied blend (PLAN.md §4 "satisfied"). The sweep's eviction
   * cascade drops orphan opinion-matrix rows so a long set doesn't
   * grow unbounded. */
  tick(now: number = Date.now()): RoomSignals {
    this.tickCount++
    this.temperature = decayedTemperature(this.temperature, now)
    // Phase 3 cluster + policy pass runs before the pipeline so the
    // policy's explicit blend can compose with the taste-EWMA target
    // (§5.7).
    const clustering = clusterMatrix(this.matrix, { random: this.random })
    this.lastClusters = clustering.clusters
    this.lastOutliers = clustering.outlierDistances
    const promptWeights = this.computePromptSupport()
    this.lastPolicy = computePolicies(this.lastClusters, {
      choice: this.policyChoice,
      rotationTick: this.tickCount,
      promptWeights,
    })
    this.lastClusterMass = this.computeClusterMass(this.lastClusters)
    const outputs: PipelineOutputs = tick({
      tastes: this.tastes,
      previousApplied: this.applied,
      policyTarget: this.lastPolicy.resolved,
    })
    this.applied = outputs.applied
    this.target = outputs.target
    this.crowdRaw = outputs.crowdRaw
    this.effective = outputs.effectiveParticipants
    const sweep = this.pool.sweep({
      appliedEmbedding: this.dominantPromptEmbedding(),
      now,
    })
    for (const evictedId of sweep.evicted) this.matrix.forgetPrompt(evictedId)
    const snapshot = this.snapshot()
    for (const listener of this.listeners) listener(snapshot)
    return snapshot
  }

  snapshot(): RoomSignals {
    return {
      applied: this.applied,
      target: this.target,
      crowdRaw: this.crowdRaw,
      effectiveParticipants: this.effective,
      temperature: this.temperature,
      participantCount: this.tastes.size,
      activeVoters: this.matrix.activeVoters(),
      vibeSupport: this.computePromptSupport(),
      activePrompts: this.pool.active(),
      clusters: this.lastClusters,
      clusterMass: this.lastClusterMass,
      outlierDistances: this.lastOutliers,
      policy: this.lastPolicy,
    }
  }

  /** Drop a user — they walked away or the WS closed for good. Phase 2
   * also forgets their opinion-matrix row so the support scores fall
   * back to the room's actual present voters. */
  evict(userId: string): void {
    this.tastes.delete(userId)
    this.matrix.forgetUser(userId)
    this.dealtBy.delete(userId)
    for (const prompt of this.pool.all()) {
      const summary = this.matrix.summary(prompt.id)
      this.pool.setSupport(prompt.id, summary.support, Date.now())
    }
  }

  subscribe(listener: (signals: RoomSignals) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  stubs(): RoomStubs {
    const suggestions = this.pool.all().map((p) => ({
      id: p.id,
      text: p.text,
      support: p.support,
      satisfied: p.satisfied,
    }))
    return { suggestions, clusters: [], moderationQueue: [] }
  }

  /** The active prompts, used by the host-screen vibe map renderer. */
  activePrompts(): VibePrompt[] {
    return this.pool.active()
  }

  /** Approximate the applied vibe's embedding by the dominant
   * prompt's embedding. Phase 3 swaps this for the master-audio
   * embedding routed through `/api/embed` (PLAN.md §4 vibeRef path);
   * Phase 2's proxy is enough to retire user prompts that get
   * absorbed into the active vibe. */
  private dominantPromptEmbedding(): Float32Array | null {
    const top = topKEntries(this.applied, 1)
    if (top.length === 0) return null
    const prompt = this.pool.get(top[0]!.id)
    return prompt?.embedding ?? null
  }

  private computeClusterMass(
    clusters: readonly OpinionCluster[],
  ): ReadonlyMap<VibePromptId, readonly ClusterMass[]> {
    if (clusters.length === 0) return new Map()
    const out = new Map<VibePromptId, readonly ClusterMass[]>()
    for (const prompt of this.pool.all()) {
      if (!prompt.approved) continue
      const mass = clusterMass(clusters, this.matrix, prompt.id)
      // Only surface prompts where at least one cluster has weighed
      // in — the host-screen's empty-segment ring is more confusing
      // than just keeping the legacy single-organism ring for those.
      if (mass.some((m) => m.agree + m.disagree + m.pass > 0)) {
        out.set(prompt.id, mass)
      }
    }
    return out
  }

  private computePromptSupport(): ReadonlyMap<VibePromptId, number> {
    const out = new Map<VibePromptId, number>()
    for (const prompt of this.pool.all()) {
      if (!prompt.approved) continue
      // Active and retired-but-satisfied prompts both surface here so
      // the host-screen can show a brief "we just played this" trail
      // even after the prompt retires from the card stack.
      out.set(prompt.id, prompt.support)
    }
    return out
  }

  private markDealt(userId: string, promptId: VibePromptId): void {
    const seen = this.dealtBy.get(userId) ?? new Set<VibePromptId>()
    seen.add(promptId)
    this.dealtBy.set(userId, seen)
  }
}

