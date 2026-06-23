/** Wire-format messages exchanged with the phone, host, and bridge
 * (docs/collective/PLAN.md §3, §7). Kept in one place so a stale crowd-
 * web or host-screen build can be diffed against the aggregator. */


/** A card-stack item served to the phone (PLAN.md §7b Vibes screen).
 * The aggregator deals the least-shown prompts first, lightly
 * randomised; the phone renders one card at a time. */
export type VibeCard = {
  id: string
  label: string
  /** Total agree+disagree+pass on this prompt across the room — drives
   * the phone's gentle "rated 6 — keep going?" copy. */
  voteCount: number
}

/** Phone → aggregator. */
export type PhoneClientMessage =
  | { type: 'hello'; sessionToken?: string }
  | { type: 'seed'; picks: string[] }
  | { type: 'react'; sign: 1 | -1 }
  | {
      type: 'suggest'
      /** Free-text suggestion; aggregator normalises + dedupes. */
      text: string
    }
  | {
      type: 'vote'
      promptId: string
      /** +1 agree · 0 pass · -1 disagree (PLAN.md §1 signal 2). */
      vote: 1 | 0 | -1
    }
  | {
      type: 'request_cards'
      /** Hint at how many cards to deal next; the server may serve
       * fewer when the active pool is small. */
      limit?: number
    }

/** Aggregator → phone. */
export type PhoneServerMessage =
  | {
      type: 'welcome'
      userId: string
      sessionToken: string
      /** Phase 2: cards dealt from the unified prompt pool via the
       * Thompson sampler — same shape and same surfacing algorithm
       * the Vibes-tab card stack uses, just sized for the onboarding
       * "tap 3" grid. User-submitted prompts can land here too, so a
       * `bluegrass` submission visible to one phone shows up on the
       * next joiner's onboarding screen. */
      vibes: readonly VibeCard[]
      seeded: boolean
    }
  | {
      type: 'now'
      /** Current applied blend the deck is hearing — `[label, weight]` so
       * the phone can render the "currently playing" pill without a
       * second round-trip to look up labels. */
      label: string
      /** EWMA net-approval in [-1, +1]; the gauge target. */
      temperature: number
      /** True while the applied blend is mid-slew toward target — the
       * "the room is shifting…" indicator (PLAN.md §7b). */
      shifting: boolean
      participantCount: number
    }
  | {
      /** A fresh deal of cards for the Vibes screen (PLAN.md §7b). The
       * server sorts by least-shown-first, applies light randomisation,
       * and filters out anything the phone has already voted on this
       * session. */
      type: 'cards'
      cards: VibeCard[]
    }
  | {
      /** Acknowledgement of a `suggest` message. `created` means the
       * text became a new prompt; `deduped` means it semantically
       * matched an existing one (the §7b "people are already vibing
       * on that" copy). */
      type: 'suggest_ack'
      result: 'created' | 'deduped' | 'rate-limited' | 'invalid'
      card?: VibeCard
    }
  | { type: 'error'; message: string }

/** Aggregator → host. */
export type HostServerMessage =
  | { type: 'room'; code: string; joinUrl: string; qrSvg: string }
  | {
      type: 'signals'
      label: string
      temperature: number
      shifting: boolean
      participantCount: number
      effectiveParticipants: number
      /** Per-vibe support (PLAN.md §7c single-organism mode).
       *
       * Phase 1 sized this by per-seed "liked mass". Phase 2 sizes it
       * by `VibePrompt.support` from the OpinionMatrix's Wilson lower
       * bound, so user-suggested prompts share the same scale as the
       * seed catalog. */
      vibeSupport: { id: string; label: string; support: number }[]
    }

/** Aggregator → bridge (frontend). */
export type BridgeServerMessage =
  | {
      type: 'set_style'
      deck: 'a' | 'b'
      prompts: { text: string; weight: number }[]
      slewStepCos?: number
    }
  | { type: 'hello'; deck: 'a' | 'b' }
