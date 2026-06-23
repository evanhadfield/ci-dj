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

/** Per-cluster sentiment on a single prompt — the host-screen split-
 * ring renderer and the Room-tab vibe map both pivot off this. */
export type ClusterMass = {
  clusterId: string
  agree: number
  disagree: number
  pass: number
}

export type PeekVibeSupport = {
  id: string
  label: string
  support: number
  clusterMass: ClusterMass[]
}

export type PeekPolicy = {
  choice: 'centroid' | 'pr' | 'maximin' | 'auto'
  appliedPolicy: 'centroid' | 'pr' | 'maximin'
}

/** Phase 3 §7b.3: read-only mirror of the host channel sized for
 * crowd-web's Room tab. Mirrors `PeekServerMessage` in the aggregator. */
export type PeekServerMessage = {
  type: 'peek'
  label: string
  temperature: number
  shifting: boolean
  participantCount: number
  effectiveParticipants: number
  activeVoters: number
  vibeSupport: PeekVibeSupport[]
  clusters: { id: string; size: number }[]
  policy: PeekPolicy
}

export type PhoneServerMessage =
  | {
      type: 'welcome'
      userId: string
      sessionToken: string
      /** Phase 2: cards dealt from the unified pool by the same
       * Thompson sampler the Vibes tab uses. Onboarding renders these
       * directly — user-submitted prompts can land here. */
      vibes: VibeCard[]
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
