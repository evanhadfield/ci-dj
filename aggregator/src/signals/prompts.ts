/** The user-suggestable vibe-prompt pool (Phase 2; PLAN.md §4, §10).
 *
 * Phase 1 used a fixed seed catalog (`vibes.ts`). Phase 2 grows that
 * into a real pool — every prompt the room can vote on, including
 * user-submitted suggestions. The seed catalog is the initial set.
 *
 * Each prompt carries its 768-dim MusicCoCa embedding (when available;
 * see `embed.ts`), the support score (Wilson lower-bound on its
 * agree-vs-disagree votes — see `opinion-matrix.ts`), and a `satisfied`
 * flag that flips when the current applied vibe is within ε of the
 * prompt's embedding (PLAN.md §4 — "the audio said it; no need to keep
 * voting"). Stale prompts decay out of the active pool too.
 *
 * Phase 3 reads the same shape and lays out the host-screen map on the
 * prompt embeddings, and runs PCA + K-means over the opinion matrix
 * indexed by these prompt ids. */

import { cosineSimilarity, EMBED_DIM } from './embed.js'
import { SEED_VIBES, type VibePrompt as SeedVibePrompt } from './vibes.js'

export type VibePromptId = string

export type VibePrompt = {
  id: VibePromptId
  /** Short label for the phone card (PLAN.md §7b). For user-submitted
   * prompts the label and the text are the same trimmed input. */
  label: string
  /** The `set_style` text the deck worker consumes (PLAN.md §3). */
  text: string
  /** MusicCoCa 768-dim embedding. `null` when the backend was
   * unreachable at submit time — Phase 3 PCA layout treats those as
   * un-positioned, but votes still aggregate normally. */
  embedding: Float32Array | null
  /** Wilson lower-bound support score on the agree/disagree votes
   * (see `opinion-matrix.ts`). Drives the host-screen vibe map sizes
   * and the card-stack coverage policy. */
  support: number
  /** Wall time of the most recent vote on this prompt. Drives decay
   * (PLAN.md §4 — "stale prompts decay"). */
  lastVoteTs: number
  /** True once the current applied blend is within ε of `embedding`
   * (PLAN.md §4 — "satisfied flips when the current vibe is within ε
   * of embedding"). Satisfied prompts are retired from the active card
   * stack — they don't disappear, but they stop being served. */
  satisfied: boolean
  /** True if a DJ explicitly approved this prompt past the moderation
   * lane (PLAN.md §9). For Phase 2 the seed catalog is auto-approved;
   * user submissions land approved (moderation classifier stub) — the
   * DJ approve/veto lane still has the final say (Phase 4 expands). */
  approved: boolean
  /** Wall time the prompt entered the pool. */
  createdAt: number
}

/** Default cosine similarity threshold for the Phase 2 semantic dedupe
 * (PLAN.md §10 — "cosine ≥ ε to an existing prompt's embedding,
 * collapse into it"). Conservative enough that "warm sunset disco" and
 * "hot summer disco" collapse, but "warm sunset disco" and "hard
 * techno" don't. */
export const DEDUPE_COSINE_THRESHOLD = 0.92

/** When the applied blend's embedding (approximated via the dominant-
 * prompt embedding for Phase 2; Phase 3 swaps in the audio embedding)
 * is at least this cosine-similar to a prompt, the prompt flips
 * `satisfied=true` and retires from the active pool. The threshold
 * sits below the dedupe one — we only retire when the audio is
 * unambiguously *playing* the prompt. */
export const SATISFIED_COSINE_THRESHOLD = 0.85

/** Half-life of `support` against staleness. A prompt with no new vote
 * loses half its mass over this window (PLAN.md §4 decay). Matched to
 * a typical set length — a vibe stays in the active pool for tens of
 * minutes even with zero new votes, but a multi-hour-old prompt
 * eventually retires. */
export const SUPPORT_HALFLIFE_MS = 20 * 60_000

/** Cap on the total number of prompts in the active pool. Beyond this,
 * the lowest-support stale prompts are evicted on each tick. Phase 2's
 * card stack serves at most ~30 anyway; the cap keeps the per-tick
 * decay sweep bounded. */
export const MAX_ACTIVE_PROMPTS = 64

/** Per-user rate limit on suggestions, to keep the §7b "suggest a
 * vibe" surface honest without making it feel constrained. */
export const SUGGEST_WINDOW_MS = 60_000
export const SUGGEST_PER_USER_PER_WINDOW = 3

/** Maximum length of a user-submitted vibe text (PLAN.md §7b "short
 * text field, char-limited"). */
export const SUGGEST_MAX_LENGTH = 80

export type SuggestResult =
  | { kind: 'created'; prompt: VibePrompt }
  | { kind: 'deduped'; prompt: VibePrompt }
  | { kind: 'rate-limited' }
  | { kind: 'invalid' }

/** Pool of vibe-prompts the room votes on. The seed catalog is loaded
 * eagerly; user submissions land via `suggest()`.
 *
 * The pool is intentionally not generic over the embedding backend —
 * `embed.ts` is the seam to swap in a mock for tests. */
export class VibePromptPool {
  private readonly prompts = new Map<VibePromptId, VibePrompt>()
  private readonly suggestTimestamps = new Map<string, number[]>()

  constructor(now: number = Date.now()) {
    for (const seed of SEED_VIBES) this.prompts.set(seed.id, seedToPrompt(seed, now))
  }

  /** Every prompt in the pool, active or retired. Phase 3's host-
   * screen layout walks this list, then filters by `satisfied`. */
  all(): readonly VibePrompt[] {
    return [...this.prompts.values()]
  }

  /** Active prompts: not satisfied, approved. The card stack and the
   * vibe map both pull from here. */
  active(): VibePrompt[] {
    return [...this.prompts.values()].filter((p) => p.approved && !p.satisfied)
  }

  get(id: VibePromptId): VibePrompt | null {
    return this.prompts.get(id) ?? null
  }

  /** Submit a new vibe text. The optional `embed` callback (set by the
   * room state to wire `embed.ts` in) decides dedupe; without it the
   * suggestion is added as-is and Phase 3 layout fills in the
   * embedding later if it lands. */
  async suggest(input: {
    userId: string
    text: string
    embed?: (text: string) => Promise<Float32Array | null>
    now?: number
  }): Promise<SuggestResult> {
    const now = input.now ?? Date.now()
    const cleaned = input.text.trim()
    if (cleaned.length === 0 || cleaned.length > SUGGEST_MAX_LENGTH) {
      return { kind: 'invalid' }
    }
    if (!this.allowSuggestion(input.userId, now)) {
      return { kind: 'rate-limited' }
    }
    // Cheap pre-check: exact text match wins instantly, no embed
    // round-trip needed. Phase 2's pool is small enough to iterate.
    const cleanedLower = cleaned.toLowerCase()
    for (const prompt of this.prompts.values()) {
      if (prompt.text.toLowerCase() === cleanedLower || prompt.label.toLowerCase() === cleanedLower) {
        this.recordSuggestion(input.userId, now)
        return { kind: 'deduped', prompt }
      }
    }
    const embedding = input.embed ? await input.embed(cleaned) : null
    if (embedding && embedding.length === EMBED_DIM) {
      let bestScore = -Infinity
      let bestPrompt: VibePrompt | null = null
      for (const prompt of this.prompts.values()) {
        if (!prompt.embedding) continue
        const score = cosineSimilarity(embedding, prompt.embedding)
        if (score > bestScore) {
          bestScore = score
          bestPrompt = prompt
        }
      }
      if (bestPrompt && bestScore >= DEDUPE_COSINE_THRESHOLD) {
        this.recordSuggestion(input.userId, now)
        return { kind: 'deduped', prompt: bestPrompt }
      }
    }
    const prompt: VibePrompt = {
      id: `user-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      label: cleaned,
      text: cleaned,
      embedding,
      support: 0,
      lastVoteTs: now,
      // The seed catalog is auto-approved; user submissions also land
      // approved because the Phase 2 moderation classifier is the stub
      // (PROMPT.md — "real moderation classifier stays a stub"). The DJ
      // approve/veto lane already lives on the room moderationQueue
      // shape; Phase 4 wires the classifier into the gate.
      approved: true,
      satisfied: false,
      createdAt: now,
    }
    this.prompts.set(prompt.id, prompt)
    this.recordSuggestion(input.userId, now)
    return { kind: 'created', prompt }
  }

  /** Update a prompt's support score (called by the OpinionMatrix
   * after votes land). Also bumps `lastVoteTs` so decay restarts. */
  setSupport(id: VibePromptId, support: number, now: number = Date.now()): void {
    const prompt = this.prompts.get(id)
    if (!prompt) return
    prompt.support = support
    prompt.lastVoteTs = now
  }

  /** Decay stale prompts' support, retire satisfied ones, and evict
   * the long tail when the pool overflows `MAX_ACTIVE_PROMPTS`.
   *
   * `appliedEmbedding` lets us flip `satisfied` when the current vibe
   * is within ε of a prompt — Phase 3 swaps in the audio embedding;
   * Phase 2 uses the dominant-prompt embedding as a faithful proxy. */
  sweep(input: {
    appliedEmbedding?: Float32Array | null
    now?: number
  }): { retired: VibePromptId[]; evicted: VibePromptId[] } {
    const now = input.now ?? Date.now()
    const retired: VibePromptId[] = []
    const evicted: VibePromptId[] = []
    // Decay support against staleness, satisfied-retire on similarity.
    for (const prompt of this.prompts.values()) {
      const dt = Math.max(0, now - prompt.lastVoteTs)
      if (dt > 0) {
        const lambda = Math.LN2 / SUPPORT_HALFLIFE_MS
        prompt.support = prompt.support * Math.exp(-lambda * dt)
      }
      if (
        !prompt.satisfied &&
        prompt.embedding &&
        input.appliedEmbedding &&
        cosineSimilarity(prompt.embedding, input.appliedEmbedding) >= SATISFIED_COSINE_THRESHOLD
      ) {
        prompt.satisfied = true
        retired.push(prompt.id)
      }
    }
    // Evict the lowest-support stale prompts when over the cap. Seed
    // prompts are never evicted — they're the floor of the card stack.
    const userPrompts = [...this.prompts.values()].filter(
      (p) => !SEED_VIBES.some((s) => s.id === p.id),
    )
    if (userPrompts.length > MAX_ACTIVE_PROMPTS) {
      const sorted = userPrompts.sort((a, b) => a.support - b.support)
      const overflow = sorted.length - MAX_ACTIVE_PROMPTS
      for (let i = 0; i < overflow; i++) {
        const victim = sorted[i]!
        this.prompts.delete(victim.id)
        evicted.push(victim.id)
      }
    }
    return { retired, evicted }
  }

  private allowSuggestion(userId: string, now: number): boolean {
    const window = this.suggestTimestamps.get(userId) ?? []
    const fresh = window.filter((ts) => now - ts < SUGGEST_WINDOW_MS)
    if (fresh.length >= SUGGEST_PER_USER_PER_WINDOW) {
      this.suggestTimestamps.set(userId, fresh)
      return false
    }
    return true
  }

  private recordSuggestion(userId: string, now: number): void {
    const window = this.suggestTimestamps.get(userId) ?? []
    const fresh = window.filter((ts) => now - ts < SUGGEST_WINDOW_MS)
    fresh.push(now)
    this.suggestTimestamps.set(userId, fresh)
  }
}

function seedToPrompt(seed: SeedVibePrompt, now: number): VibePrompt {
  return {
    id: seed.id,
    label: seed.label,
    text: seed.text,
    embedding: null,
    support: 0,
    lastVoteTs: now,
    approved: true,
    satisfied: false,
    createdAt: now,
  }
}
