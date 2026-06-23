/** Phone PWA copy (PLAN.md §7b). Hard-coded English for v1; the i18n
 * solution kicks in when more languages land. Keys carry intent, not
 * the literal text, so copy iteration doesn't churn this file. */

export const STRINGS = {
  joining: 'Joining the room…',
  joinError: "The DJ's driving solo right now",
  joinErrorHint:
    "We couldn't reach the room. Your taps still feel good — they just won't move the music until the room's back.",
  onboarding: {
    title: 'Help steer the music.',
    seedLabel: 'What do you want to hear?',
    seedPlaceholder: 'tell us in a few words…',
    seedConfirm: 'Save',
    /** Phase 2 promise: the free-text seed becomes a deduped vibe-prompt
     * that other phones can vote on. Phase 1 stored the text client-
     * side as a placeholder; the Vibes screen submit path now matches
     * this copy. */
    seedNote: 'added — others can vote on it soon',
    seedEdit: 'Edit',
    seedRemove: 'Remove',
    chips: ['Surprise me', "I'm open", 'Not sure'],
    pickPrompt: 'Tap 3 vibes you’re into',
    pickProgress: '{n} of 3',
    submit: 'Done',
    submitEmpty: 'Type, pick a chip, or tap 3 vibes',
    skip: 'Skip',
  },
  now: {
    eyebrow: 'Now playing',
    waiting: 'waiting for the first reactions…',
    shifting: 'the room is shifting…',
    like: 'Love the vibe',
    dislike: 'Meh',
    added: 'added to the room',
    participants: '{n} here',
  },
  vibes: {
    tab: 'Vibes',
    eyebrow: 'Rate the vibe',
    empty: 'Be the first — suggest a vibe.',
    /** Shown once the user has voted on every card the pool currently
     * carries (PROMPT.md Phase 2 polish): we stop the infinite
     * `request_cards` poll and ask the room for fresh material. */
    allRated: "you've rated everything in the pool — suggest a new vibe to keep it moving",
    waitingForCards: 'Pulling cards from the room…',
    progress: 'rated {n} — keep going?',
    progressFirst: 'first one in — keep going?',
    /** Accessibility labels — screen-readers announce these while the
     * visible button shows just the emoji glyph below. */
    agree: 'Agree',
    pass: 'Pass',
    disagree: 'Disagree',
    agreeEmoji: '👍',
    passEmoji: '🤷',
    disagreeEmoji: '👎',
    suggestEyebrow: 'Suggest a vibe',
    suggestPlaceholder: 'short description, like "warm sunset disco"',
    suggestSubmit: 'Suggest',
    /** Mirrors `onboarding.seedNote` — the same promise reached through
     * a different surface. */
    suggestAddedCreated: 'added — others can vote on it soon',
    suggestAddedDeduped: 'people are already vibing on that',
    suggestRateLimited: "easy — give the room a moment, then suggest again",
    suggestInvalid: "couldn't add that — try a shorter line",
    /** Network drop / aggregator unreachable while a suggestion is in
     * flight. The user's text stays in the field so they can retry. */
    suggestNetwork: 'the room dropped — try again in a moment',
  },
  room: {
    tab: 'Room',
    eyebrow: 'A peek at the room',
    /** Used while the host-peek socket is still warming up. */
    waiting: 'tuning in…',
    /** Pre-clusters single-organism state: just temperature + sizes. */
    singleOrganism: 'one room, one vibe — clusters appear with more voters',
    /** Above CLUSTER_MIN_N: per-vibe cluster sentiment is on the map. */
    multiCluster: 'clusters: how each faction feels about each vibe',
    /** Aggregator unreachable. */
    offline: 'projection screen is the truth right now',
    /** Empty vibe map. */
    emptyMap: 'no vibes ranked yet — head over to the Vibes tab',
  },
} as const

export type Strings = typeof STRINGS

export function interpolate(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_, key) => String(values[key] ?? ''))
}
