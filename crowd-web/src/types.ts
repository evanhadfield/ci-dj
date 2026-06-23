/** Wire-format messages mirroring the aggregator's
 * `aggregator/src/signals/messages.ts`. We don't share the file at
 * build-time (the aggregator is a Node package and crowd-web is a
 * static SPA), but any drift here is loud — the welcome / now handlers
 * type the parsed JSON against this shape. */

export type VibePrompt = {
  id: string
  label: string
  text: string
}

export type PhoneClientMessage =
  | { type: 'hello'; sessionToken?: string }
  | { type: 'seed'; picks: string[] }
  | { type: 'react'; sign: 1 | -1 }

export type PhoneServerMessage =
  | {
      type: 'welcome'
      userId: string
      sessionToken: string
      vibes: VibePrompt[]
      seeded: boolean
    }
  | {
      type: 'now'
      label: string
      temperature: number
      shifting: boolean
      participantCount: number
    }
  | { type: 'error'; message: string }
