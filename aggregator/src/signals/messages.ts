/** Wire-format messages exchanged with the phone, host, and bridge
 * (docs/collective/PLAN.md §3, §7). Kept in one place so a stale crowd-
 * web or host-screen build can be diffed against the aggregator. */

import type { VibePrompt } from './vibes.js'

/** Phone → aggregator. */
export type PhoneClientMessage =
  | { type: 'hello'; sessionToken?: string }
  | { type: 'seed'; picks: string[] }
  | { type: 'react'; sign: 1 | -1 }

/** Aggregator → phone. */
export type PhoneServerMessage =
  | {
      type: 'welcome'
      userId: string
      sessionToken: string
      vibes: readonly VibePrompt[]
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
      /** Per-vibe support (PLAN.md §7c single-organism mode). */
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
