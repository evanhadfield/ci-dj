/** Seed vibe-prompt catalog (Phase 1; docs/collective/PLAN.md §1, §7b).
 *
 * The 9 cards the onboarding pick-3 surfaces and the slots the Phase 1
 * single-organism centroid lives in. Each prompt is a `set_style` text
 * the deck worker already understands — so the bridge can send the
 * crowd target straight through without an embedding round-trip.
 *
 * Phase 2 grows this into a user-suggestable pool (with semantic dedupe
 * via /api/embed). Phase 3 lights up cluster sentiment per card. Keeping
 * the seed catalog fixed and exported lets crowd-web, host-screen, and
 * the aggregator share one source of truth for the early experiments. */

export type VibePromptId = string

export type VibePrompt = {
  id: VibePromptId
  /** Phone card label — short, glanceable in a dark venue. */
  label: string
  /** The `set_style` text the deck worker actually consumes. The label
   * and the text diverge so we can ship "Sunset disco" on a card and
   * still send a richer prompt downstream. */
  text: string
}

export const SEED_VIBES: readonly VibePrompt[] = [
  { id: 'sunset-disco', label: 'Sunset disco', text: 'warm sunset disco · groove · mid-tempo' },
  { id: 'deep-house', label: 'Deep house', text: 'deep house · rolling bass · 122 bpm' },
  { id: 'hard-techno', label: 'Hard techno', text: 'hard techno · driving · 140 bpm' },
  { id: 'liquid-dnb', label: 'Liquid d&b', text: 'liquid drum and bass · soulful · 174 bpm' },
  { id: 'afro-house', label: 'Afro house', text: 'afro house · percussive · uplifting' },
  { id: 'minimal', label: 'Minimal', text: 'minimal techno · hypnotic · stripped back' },
  { id: 'breaks', label: 'Breaks', text: 'breakbeat · funky · 130 bpm' },
  { id: 'ambient', label: 'Ambient', text: 'ambient downtempo · drifting · low-bpm' },
  { id: 'acid', label: 'Acid', text: 'acid 303 · squelchy · 128 bpm' },
]

export const SEED_VIBE_IDS: readonly VibePromptId[] = SEED_VIBES.map((v) => v.id)

export const SEED_VIBE_BY_ID: ReadonlyMap<VibePromptId, VibePrompt> = new Map(
  SEED_VIBES.map((v) => [v.id, v]),
)

export function vibeText(id: VibePromptId): string | null {
  return SEED_VIBE_BY_ID.get(id)?.text ?? null
}
