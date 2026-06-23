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
import type { EmbedClient } from './embed.js'
import type { VibeCard } from './messages.js'

/** Default tick cadence. Matches a musical phrase (§5 closing), giving
 * the slew limiter (§5.8) time to look like drift, not jitter. */
export const TICK_INTERVAL_MS = 1500

/** Default size of a card deal. The phone re-requests when it runs low. */
export const DEFAULT_CARD_LIMIT = 12

/** When the active pool is small the dealer rotates through it from
 * least-seen first; a tiny shuffle slot keeps two phones from getting
 * identical decks. */
export const CARD_RANDOM_JITTER = 0.001

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
  /** Per-prompt support driven by Phase 2's OpinionMatrix Wilson lower
   * bound (PLAN.md §7c single-organism map). Phase 1's "liked mass per
   * seed id" was a pre-card-stack fallback; Phase 2 sources this from
   * card-stack votes on the prompt pool. */
  vibeSupport: ReadonlyMap<VibePromptId, number>
  /** The active prompt pool — every prompt the room can vote on, both
   * seed and user-submitted, minus retired (satisfied) and unapproved. */
  activePrompts: readonly VibePrompt[]
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
  /** Per-user "cards dealt so far this session" — used to keep the
   * coverage-balanced dealer from re-dealing the same card to the
   * same phone unless we've exhausted the pool (PLAN.md §7b). */
  private readonly dealtBy = new Map<string, Set<VibePromptId>>()
  /** Per-prompt deal count, drives the least-shown-first deal order. */
  private readonly dealtCount = new Map<VibePromptId, number>()

  constructor(now: number = Date.now(), options: RoomStateOptions = {}) {
    this.temperature = emptyTemperature(now)
    this.pool = new VibePromptPool(now)
    this.embedClient = options.embedClient ?? null
  }

  /** Seat a phone. Idempotent — a reconnect with the same `userId`
   * resumes the existing taste vector (PLAN.md §7a reconnect path). */
  seat(userId: string, now: number = Date.now()): void {
    if (!this.tastes.has(userId)) {
      this.tastes.set(userId, emptyTasteState(now))
    }
  }

  /** Apply the onboarding pick-3 (§7b). The picks also land as +1
   * agree votes on the corresponding prompts so the Phase 2 host-
   * screen vibe map shows non-zero support immediately — PLAN.md §1
   * signal 3: "seeds a taste vector + casts 3 first votes." */
  applySeed(userId: string, picks: readonly VibePromptId[], now: number = Date.now()): void {
    const state = this.tastes.get(userId) ?? emptyTasteState(now)
    this.tastes.set(userId, applySeedPicks(state, picks, now))
    for (const id of picks) {
      if (this.pool.get(id)) {
        this.matrix.vote(userId, id, 1, now)
        const summary = this.matrix.summary(id)
        this.pool.setSupport(id, summary.support, now)
      }
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

  /** Coverage-balanced card deal for the Phase 2 Vibes screen. Picks
   * the least-globally-shown active prompts the user hasn't already
   * voted on, with a small random jitter so two phones don't get
   * identical decks (PLAN.md §7b). */
  dealCards(userId: string, limit: number = DEFAULT_CARD_LIMIT): VibeCard[] {
    const seen = this.dealtBy.get(userId) ?? new Set<VibePromptId>()
    const active = this.pool.active()
    const candidates = active.filter((p) => !seen.has(p.id))
    const ordered = candidates
      .map((p) => ({
        prompt: p,
        // Least-shown-first + tiny jitter; ties resolve randomly.
        score: (this.dealtCount.get(p.id) ?? 0) + Math.random() * CARD_RANDOM_JITTER,
      }))
      .sort((a, b) => a.score - b.score)
      .slice(0, Math.max(1, limit))
    const cards: VibeCard[] = []
    for (const { prompt } of ordered) {
      const summary = this.matrix.summary(prompt.id)
      cards.push({
        id: prompt.id,
        label: prompt.label,
        voteCount: summary.agree + summary.disagree + summary.pass,
      })
      this.dealtCount.set(prompt.id, (this.dealtCount.get(prompt.id) ?? 0) + 1)
      this.markDealt(userId, prompt.id)
    }
    return cards
  }

  /** Run one aggregation tick and return the new signals snapshot.
   *
   * Phase 2 also runs the prompt-pool sweep: decay support against
   * staleness, retire prompts whose embedding has caught up to the
   * applied blend (PLAN.md §4 "satisfied"). The sweep's eviction
   * cascade drops orphan opinion-matrix rows so a long set doesn't
   * grow unbounded. */
  tick(now: number = Date.now()): RoomSignals {
    this.temperature = decayedTemperature(this.temperature, now)
    const outputs: PipelineOutputs = tick({
      tastes: this.tastes,
      previousApplied: this.applied,
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
      vibeSupport: this.computePromptSupport(),
      activePrompts: this.pool.active(),
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

