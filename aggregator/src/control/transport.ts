/** ControlTransport — how the bridge speaks `set_style` into SlipMate
 * (Phase 0 seam; docs/collective/PLAN.md §3).
 *
 * v1 build target: `WorkerWsTransport`, applying the crowd's blend via
 * the same deck-worker command channel the frontend already uses. In
 * the native shell that means a Tauri IPC `deck_set_style` call (today
 * it lives in `frontend/src/deck/nativeDeck.ts`); the name keeps the
 * historical WS-era label so the codebase reads continuously with the
 * design doc.
 *
 * End-state (capture, don't build): `McpTransport`, proxying through
 * the native MCP server to the Rust store described by ADR-0020 — which
 * is Proposed, not built. The transport interface exists so the bridge
 * can compose against it now and Phase N can swap the implementation. */

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

/** v1 transport (real-but-idle in Phase 0). Phase 1 will wire it to
 * SlipMate's deck command channel; until then both methods are no-ops
 * and `isHealthy` reports `true` so the bridge can exercise its full
 * pipeline against the seam. */
export class WorkerWsTransport implements ControlTransport {
  async setStyle(_intent: SetStyleIntent): Promise<void> {
    // No-op in Phase 0; Phase 1 will dispatch the deck command here.
  }
  async isHealthy(): Promise<boolean> {
    return true
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
