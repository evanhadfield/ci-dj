/** Per-room signals state (Phase 1; docs/collective/PLAN.md §5).
 *
 * Holds everything the aggregation tick consumes plus a hook to fan the
 * applied blend out to the bridge. Stubs are left for the Phase 2/3
 * pieces (vibe-prompt suggestions, opinion matrix, clusters) so those
 * phases land in clearly-marked seams (PROMPT.md "stubs present but
 * minimal"). */

import { uniformBlend, type VibeBlend } from './blend.js'
import {
  applyReaction,
  applySeedPicks,
  emptyTasteState,
  type Reaction,
  type TasteState,
} from './taste.js'
import {
  applyReactionToTemperature,
  decayedTemperature,
  emptyTemperature,
  type Temperature,
} from './temperature.js'
import { tick, type PipelineOutputs } from './pipeline.js'
import { SEED_VIBE_IDS, type VibePromptId } from './vibes.js'

/** Default tick cadence. Matches a musical phrase (§5 closing), giving
 * the slew limiter (§5.8) time to look like drift, not jitter. */
export const TICK_INTERVAL_MS = 1500

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
  /** Per-prompt support — sum of every user's positive taste mass on
   * that prompt. Drives the host-screen single-organism vibe map's
   * circle sizes (PLAN.md §7c). */
  vibeSupport: ReadonlyMap<VibePromptId, number>
}

/** Phase-1 minimal stubs that Phases 2/3 expand. They live on the
 * room state so callers see the seams now (PROMPT.md). */
export type RoomStubs = {
  /** PLAN.md §1 signal 2: user-suggested + curated vibe-prompt pool. */
  suggestions: readonly { id: string; text: string; support: number }[]
  /** PLAN.md §5.5 + §6: clusters and the resulting policy decision. */
  clusters: readonly never[]
  /** PLAN.md §9: moderation queue. */
  moderationQueue: readonly never[]
}

export class RoomSignalsState {
  private readonly tastes = new Map<string, TasteState>()
  private temperature: Temperature
  private applied: VibeBlend = uniformBlend()
  private target: VibeBlend = uniformBlend()
  private crowdRaw: VibeBlend = uniformBlend()
  private effective = 0
  private readonly listeners = new Set<(signals: RoomSignals) => void>()

  constructor(now: number = Date.now()) {
    this.temperature = emptyTemperature(now)
  }

  /** Seat a phone. Idempotent — a reconnect with the same `userId`
   * resumes the existing taste vector (PLAN.md §7a reconnect path). */
  seat(userId: string, now: number = Date.now()): void {
    if (!this.tastes.has(userId)) {
      this.tastes.set(userId, emptyTasteState(now))
    }
  }

  /** Apply the onboarding pick-3 (§7b). */
  applySeed(userId: string, picks: readonly VibePromptId[], now: number = Date.now()): void {
    const state = this.tastes.get(userId) ?? emptyTasteState(now)
    this.tastes.set(userId, applySeedPicks(state, picks, now))
  }

  ingestReaction(userId: string, sign: 1 | -1, ts: number = Date.now()): void {
    const state = this.tastes.get(userId) ?? emptyTasteState(ts)
    const updated = applyReaction(state, { sign, activeBlend: this.applied, ts })
    this.tastes.set(userId, updated)
    this.temperature = applyReactionToTemperature(this.temperature, sign, ts)
  }

  /** Run one aggregation tick and return the new signals snapshot. */
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
      vibeSupport: this.computeVibeSupport(),
    }
  }

  /** Drop a user — they walked away or the WS closed for good. */
  evict(userId: string): void {
    this.tastes.delete(userId)
  }

  subscribe(listener: (signals: RoomSignals) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** Phase-2/3 stubs surfaced through the snapshot so consumers can
   * subscribe to one shape (PROMPT.md). */
  stubs(): RoomStubs {
    return { suggestions: [], clusters: [], moderationQueue: [] }
  }

  private computeVibeSupport(): ReadonlyMap<VibePromptId, number> {
    const out = new Map<VibePromptId, number>()
    for (const id of SEED_VIBE_IDS) out.set(id, 0)
    for (const taste of this.tastes.values()) {
      for (const [id, value] of taste.liked) {
        const positive = value - (taste.disliked.get(id) ?? 0)
        if (positive > 0) out.set(id, (out.get(id) ?? 0) + positive)
      }
    }
    return out
  }
}
