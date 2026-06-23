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
    like: 'Love this',
    dislike: 'Pass',
    added: 'added to the room',
    participants: '{n} here',
  },
  vibes: {
    tab: 'Vibes',
    comingSoon:
      "Vibe voting lands soon — for now your taps on the Now screen steer the room.",
  },
  room: {
    tab: 'Room',
    comingSoon:
      'A peek at the room view lands soon — for now watch the projection screen.',
  },
} as const

export type Strings = typeof STRINGS

export function interpolate(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_, key) => String(values[key] ?? ''))
}
