/** Render a blend as a short human label (PLAN.md §7b "current vibe
 * label — short, human; e.g. 'sunset disco · warm · mid-tempo'").
 *
 * Phase 1 uses the top-3 supported labels concatenated with a separator;
 * a Phase 2 NLP pass over the embedded prompts can replace this. */

import { topKEntries, type VibeBlend } from './blend.js'
import { SEED_VIBE_BY_ID } from './vibes.js'

export function describeBlend(blend: VibeBlend, k = 3): string {
  const entries = topKEntries(blend, k)
  if (entries.length === 0) return ''
  const labels = entries
    .map(({ id }) => SEED_VIBE_BY_ID.get(id)?.label)
    .filter((label): label is string => Boolean(label))
  return labels.join(' · ')
}
