/** Phase 2 stub for the moderation classifier (PLAN.md §9).
 *
 * The DJ approve/veto lane is the real moderation lever for v1; the
 * automated classifier is the Phase 4 piece that scores submissions
 * before they hit the pool. Phase 2 ships a no-op classifier so the
 * `VibePromptPool.suggest` path can be wired against the same shape
 * Phase 4 will replace — and so the room state's `moderationQueue`
 * remains empty here without losing the seam. */

export type ModerationVerdict =
  | { kind: 'approve' }
  /** Phase 4: a classifier flags this for the DJ approve/veto lane. */
  | { kind: 'queue'; reason: string }
  /** Phase 4: hard-block before the DJ ever sees it (slurs, etc.). */
  | { kind: 'block'; reason: string }

export type ModerationClassifier = {
  classify: (text: string) => Promise<ModerationVerdict>
}

/** Phase 2 default: auto-approve everything. The DJ approve/veto lane
 * is still the human-in-the-loop check (PROMPT.md "DJ approve/veto
 * lane wired through the existing `RoomStubs.moderationQueue` shape;
 * a real moderation classifier stays a stub"). */
export const autoApproveClassifier: ModerationClassifier = {
  async classify(): Promise<ModerationVerdict> {
    return { kind: 'approve' }
  },
}
