/** DJ influence macro state (Phase 0; docs/collective/PLAN.md §2, §7c).
 *
 * The macro is `0` (ignore crowd) … `1` (crowd drives). Phase 0 only
 * scaffolds the control + the crowd's pad target — neither is consumed
 * yet, so toggling does nothing audible.
 *
 * Phase 1 will wire this into the bridge: the crowd's `set_style` will
 * scale by `influence`, and the crowd target on the DJ's pad will render
 * at that weight. */

import { isCollectiveEnabled } from './flag'

/** Phase 3 §6: the DJ-selectable social-choice policy that decides how
 * the aggregator composes cluster preferences into the crowd target.
 * `auto` = centroid below CLUSTER_MIN_N, pr over (the default — the
 * room rotates the featured vibe through opinion groups by size). */
export type PolicyChoice = 'centroid' | 'pr' | 'maximin' | 'auto'

export type CrowdInfluence = {
  /** `0` ignore crowd, `1` crowd drives. Off by construction when the
   * feature flag is off. */
  amount: number
  /** "Lock for the drop" toggle (§2): when true, the crowd is muted
   * regardless of `amount`. */
  locked: boolean
  /** Phase 3 §6: the active social-choice policy. Sent to the
   * aggregator over the bridge socket as a `policy_select` message. */
  policy: PolicyChoice
}

export const INITIAL_INFLUENCE: CrowdInfluence = { amount: 0, locked: false, policy: 'auto' }

/** True only when both the flag is on AND influence is engaged. The
 * Phase 1 bridge will gate on this; Phase 0 callers can assume `false`. */
export function isInfluenceActive(influence: CrowdInfluence): boolean {
  return isCollectiveEnabled() && !influence.locked && influence.amount > 0
}
