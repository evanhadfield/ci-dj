/** ControlTransport — how the bridge speaks `set_style` into SlipMate
 * (docs/collective/PLAN.md §3).
 *
 * v1 build target: `WorkerWsTransport`, applying the crowd's blend via
 * the same deck-worker command channel the frontend already uses. The
 * Phase 1 implementation is a fan-out publisher (a subscriber callback
 * registered by the WS bridge endpoint): every `setStyle` call is
 * broadcast to whichever bridge clients are connected. Concretely the
 * SlipMate frontend opens that channel, gates by the DJ influence
 * macro, and invokes the existing Tauri-IPC `deck_set_style` command
 * (`frontend/src/deck/nativeDeck.ts`).
 *
 * Choosing the frontend-as-bridge-client over an auth'd loopback
 * endpoint exposed by the Rust shell keeps the influence gate and the
 * "lock for the drop" co-located with the macro (one source of truth)
 * and gives §9's fail-safe for free: an aggregator that goes down
 * closes the bridge socket, which the frontend treats as influence
 * = 0, with the deck unaffected.
 *
 * End-state (capture, don't build): `McpTransport`, proxying through
 * the native MCP server to the Rust store described by ADR-0020 —
 * Proposed, not built. The transport interface exists so Phase N can
 * swap implementations without touching the pipeline. */

export type DeckId = 'a' | 'b'

export type StylePrompt = {
  text: string
  weight: number
  /** A sampled style reference (ADR-0011) — opaque id; aggregator-level
   * crowd targets won't use this, but the type stays parallel with the
   * worker's so consumers see exactly one shape. */
  sample?: string
}

export type SetStyleIntent = {
  deck: DeckId
  prompts: StylePrompt[]
  /** Slew step the bridge already applied (§5.8); the transport itself
   * does nothing with it, but logging the request alongside the slew is
   * what makes "a sudden attack reads as drift" verifiable. */
  slewStepCos?: number
}

export type ControlTransport = {
  /** Send the merged style for `deck`. Returns once the intent has been
   * dispatched (not when the deck has played it back). */
  setStyle: (intent: SetStyleIntent) => Promise<void>
  /** Probe the link health; `false` here flips the bridge into the
   * "DJ drives solo" fail-safe (§9). */
  isHealthy: () => Promise<boolean>
}

/** v1 transport: a fan-out publisher whose subscribers (the bridge WS
 * clients in Phase 1, an MCP proxy in Phase 4+) receive every queued
 * intent. `isHealthy` reports `true` only while at least one subscriber
 * is connected — with no consumer the bridge would be shouting into
 * the void and the §9 fail-safe should kick in. */
export class WorkerWsTransport implements ControlTransport {
  private readonly subscribers = new Set<(intent: SetStyleIntent) => void>()

  /** Register a fan-out target. Returns an unsubscribe; safe to call
   * after the transport itself is gone. */
  subscribe(listener: (intent: SetStyleIntent) => void): () => void {
    this.subscribers.add(listener)
    return () => {
      this.subscribers.delete(listener)
    }
  }

  /** True iff there's somewhere to deliver intents to (PLAN.md §9). */
  hasSubscribers(): boolean {
    return this.subscribers.size > 0
  }

  async setStyle(intent: SetStyleIntent): Promise<void> {
    for (const listener of this.subscribers) {
      try {
        listener(intent)
      } catch {
        // A misbehaving subscriber must not stall the pipeline; the
        // operator will see it on the listener's own logs.
      }
    }
  }

  async isHealthy(): Promise<boolean> {
    return this.hasSubscribers()
  }
}

/** End-state transport via the native MCP server (ADR-0020 target).
 * Stub only — calling either method throws, so a misconfigured bridge
 * fails loudly rather than silently dropping crowd intents. */
export class McpTransport implements ControlTransport {
  async setStyle(_intent: SetStyleIntent): Promise<void> {
    throw new Error('McpTransport is a stub; ADR-0020 is Proposed, not built')
  }
  async isHealthy(): Promise<boolean> {
    return false
  }
}
