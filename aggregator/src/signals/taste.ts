/** Per-user taste vector (Phase 1; docs/collective/PLAN.md §4, §5.2-3).
 *
 * Each user has a sparse weighted preference over the seed vibe catalog.
 * Reactions to the currently-active blend update it via an EWMA that
 * lets recent taps move the vector while preserving the room-scale
 * shape. The §5.3 per-window cap is applied to the *contribution*
 * (post-EWMA, pre-aggregation) so a single mashing user can't outvote
 * anyone — the cap is bounded magnitude per window, not per tap. */

import type { VibeBlend } from './blend.js'
import { SEED_VIBES, type VibePromptId } from './vibes.js'

/** EWMA half-life for a user's taste vector. Closer to the music's
 * natural reaction phrase (PLAN.md §5 closing note) than to a single
 * tap — the goal is "the room is shifting", not whiplash. */
export const TASTE_HALFLIFE_MS = 20_000
/** Bound on a single window's contribution magnitude (L1) — the §5.3
 * per-user cap. Independent of tap count: a hundred taps in 20 s still
 * contribute at most this much. */
export const PER_USER_CAP_L1 = 1
/** Cooldown between counted taps from a single user (§7b "subtle cooldown
 * animation discourages mashing; capping is server-side regardless").
 * Taps inside this window still display locally but don't move the
 * server's vector — they're free for engagement, not for influence. */
export const TAP_COOLDOWN_MS = 600

export type TasteVector = ReadonlyMap<VibePromptId, number>

export type TasteState = {
  /** Liked-centroid mass per prompt (the §4 EWMA `TasteVector(user)`). */
  liked: Map<VibePromptId, number>
  /** Disliked-centroid mass per prompt. Kept separate so a future
   * policy can ask "what does the room reject?", which a single signed
   * vector loses to cancellation. */
  disliked: Map<VibePromptId, number>
  /** Last-updated wall time, drives the EWMA decay between events. */
  updatedAt: number
  /** Last counted (uncapped-by-cooldown) tap time, drives the §7b
   * cooldown without forcing the user to wait visibly. */
  lastTapAt: number
}

export function emptyTasteState(now: number): TasteState {
  return {
    liked: new Map(),
    disliked: new Map(),
    updatedAt: now,
    lastTapAt: 0,
  }
}

/** Seed a fresh user from their onboarding "pick 3" — each pick lands
 * one bounded unit on the liked side, so the room sees their first
 * three votes the moment they finish onboarding (PLAN.md §1 signal 3,
 * §7b onboarding overlay). Unknown ids are ignored, not rejected: a
 * stale crowd-web build shouldn't 500 the join. */
export function applySeedPicks(
  state: TasteState,
  picks: readonly VibePromptId[],
  now: number,
): TasteState {
  const liked = new Map(state.liked)
  for (const id of picks) {
    if (!SEED_VIBES.some((v) => v.id === id)) continue
    liked.set(id, (liked.get(id) ?? 0) + 1)
  }
  return { ...state, liked, updatedAt: now }
}

function decayed(value: number, dtMs: number, halfLifeMs: number): number {
  if (value === 0) return 0
  const lambda = Math.LN2 / halfLifeMs
  return value * Math.exp(-lambda * dtMs)
}

function decayMap(
  map: ReadonlyMap<VibePromptId, number>,
  dtMs: number,
  halfLifeMs: number,
): Map<VibePromptId, number> {
  const out = new Map<VibePromptId, number>()
  if (dtMs <= 0) {
    for (const [id, value] of map) out.set(id, value)
    return out
  }
  for (const [id, value] of map) {
    const decayedValue = decayed(value, dtMs, halfLifeMs)
    if (decayedValue > 1e-6) out.set(id, decayedValue)
  }
  return out
}

/** Decay both sides of the taste state to `now`. Pure — does not mutate. */
export function decayedAt(state: TasteState, now: number): TasteState {
  const dt = Math.max(0, now - state.updatedAt)
  return {
    liked: decayMap(state.liked, dt, TASTE_HALFLIFE_MS),
    disliked: decayMap(state.disliked, dt, TASTE_HALFLIFE_MS),
    updatedAt: now,
    lastTapAt: state.lastTapAt,
  }
}

export type Reaction = {
  /** `+1` (like) or `-1` (dislike) — the only two signs Phase 1 carries. */
  sign: 1 | -1
  /** The crowd's currently-applied blend at the moment of the tap; this
   * is what we attribute the reaction to (PLAN.md §4 vibeRef cheaper
   * proxy: the active blend instead of the master-audio embedding). */
  activeBlend: VibeBlend
  ts: number
}

/** Ingest one reaction, returning the updated state. A tap inside the
 * cooldown window is dropped — the state is returned unchanged, so a
 * mashing user can't even nudge the EWMA decay clock. Accepted taps
 * decay the prior mass to `ts`, then add the active blend on the
 * matching side. */
export function applyReaction(state: TasteState, reaction: Reaction): TasteState {
  if (reaction.ts - state.lastTapAt < TAP_COOLDOWN_MS && state.lastTapAt !== 0) {
    return state
  }
  const decayedState = decayedAt(state, reaction.ts)
  const target = reaction.sign === 1 ? decayedState.liked : decayedState.disliked
  for (const [id, weight] of reaction.activeBlend) {
    if (weight <= 0) continue
    target.set(id, (target.get(id) ?? 0) + weight)
  }
  return { ...decayedState, lastTapAt: reaction.ts }
}

/** Project a taste state to a positive, capped contribution (§5.3) the
 * aggregator can sum across users. The output is `liked - disliked`,
 * floored at 0 (a strong dislike doesn't push into a negative weight on
 * a prompt — it merely cancels the like mass), then L1-rescaled to at
 * most `PER_USER_CAP_L1` so a heavy tapper can't out-weight a quiet one. */
export function contribution(state: TasteState): Map<VibePromptId, number> {
  const out = new Map<VibePromptId, number>()
  const ids = new Set<VibePromptId>([...state.liked.keys(), ...state.disliked.keys()])
  for (const id of ids) {
    const net = (state.liked.get(id) ?? 0) - (state.disliked.get(id) ?? 0)
    if (net > 0) out.set(id, net)
  }
  let total = 0
  for (const value of out.values()) total += value
  if (total > PER_USER_CAP_L1) {
    const scale = PER_USER_CAP_L1 / total
    for (const [id, value] of out) out.set(id, value * scale)
  }
  return out
}
