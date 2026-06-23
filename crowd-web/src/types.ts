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

/** A card the Vibes screen renders. Mirrors `VibeCard` on the
 * aggregator side — id, label, and the running vote count for the
 * gentle "rated 6 — keep going?" progress copy. */
export type VibeCard = {
  id: string
  label: string
  voteCount: number
}

export type PhoneClientMessage =
  | { type: 'hello'; sessionToken?: string }
  | { type: 'seed'; picks: string[] }
  | { type: 'react'; sign: 1 | -1 }
  | { type: 'suggest'; text: string }
  | { type: 'vote'; promptId: string; vote: 1 | 0 | -1 }
  | { type: 'request_cards'; limit?: number }

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
  | {
      type: 'cards'
      cards: VibeCard[]
    }
  | {
      type: 'suggest_ack'
      result: 'created' | 'deduped' | 'rate-limited' | 'invalid'
      card?: VibeCard
    }
  | { type: 'error'; message: string }
