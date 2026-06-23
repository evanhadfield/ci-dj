/** Collective bridge client (Phase 1; docs/collective/PLAN.md §3, §9).
 *
 * The frontend acts as the bridge between the aggregator's crowd
 * target and the deck worker. Per PLAN.md §3 the crowd target is
 * applied via the *same* `set_style` command the UI already uses, so
 * this module:
 *
 *   1. Opens a WebSocket to `${aggregatorUrl}/ws/bridge?code={code}`
 *      once the feature flag is on.
 *   2. Receives `set_style` intents from the aggregator.
 *   3. Scales each prompt's weight by the DJ influence macro; when the
 *      macro is `lock`ed or `amount === 0`, drops to no-op (§7c "lock
 *      drops crowd influence to 0 immediately").
 *   4. Forwards the result through the existing `sendNativeDeckCommand`
 *      IPC — the same path `nativeDeck.ts` uses, so the deck has one
 *      place that receives style updates.
 *
 * The §9 "absence degrades, never crashes" fail-safe is automatic: a
 * dropped socket / unreachable aggregator means no intents arrive, so
 * the deck simply keeps the last DJ-applied style. */

import { sendNativeDeckCommand, type DeckCommand } from '../deck/nativeDeck'
import type { CrowdInfluence, PolicyChoice } from './influence'

export type BridgeIntent = {
  deck: 'a' | 'b'
  prompts: { text: string; weight: number }[]
  slewStepCos?: number
}

export type BridgeOptions = {
  /** Aggregator base URL (e.g. `http://localhost:3030`). Read from
   * `VITE_AGGREGATOR_URL` at build time. */
  aggregatorUrl: string
  /** Active room code, fetched from `GET /api/rooms/active`. */
  roomCode: string
  /** Optional bridge token (`VITE_AGGREGATOR_BRIDGE_TOKEN`); only set
   * when the aggregator is non-loopback. */
  token?: string
  /** Read the live influence macro. Phase 1 gates by this on every
   * incoming intent so a lock or zeroed amount drops crowd influence
   * with the deck unaffected. */
  influenceRef: { current: CrowdInfluence }
  /** Override for tests; production uses the Tauri IPC path. */
  dispatch?: (deck: 'a' | 'b', command: DeckCommand) => void
  /** Surface bridge connection state to the UI. */
  onState?: (state: BridgeState) => void
  /** Surface incoming crowd target to the UI (the influence panel
   * shows it as the "crowd is asking for X" pill). */
  onIntent?: (intent: BridgeIntent) => void
}

export type BridgeState =
  | { kind: 'idle' }
  | { kind: 'connecting' }
  | { kind: 'open' }
  | { kind: 'offline' }

export const COLLECTIVE_PROMPT_MAX = 8

const RECONNECT_INITIAL_MS = 1_000
const RECONNECT_MAX_MS = 8_000

/** Run-time bridge handle: `start()` opens the socket, `stop()` closes
 * it and drops any pending reconnect. */
export class CollectiveBridge {
  private ws: WebSocket | null = null
  private reconnectMs = RECONNECT_INITIAL_MS
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private stopped = true
  private readonly options: BridgeOptions
  private readonly dispatch: (deck: 'a' | 'b', command: DeckCommand) => void

  constructor(options: BridgeOptions) {
    this.options = options
    this.dispatch = options.dispatch ?? sendNativeDeckCommand
  }

  start(): void {
    this.stopped = false
    this.openSocket()
  }

  /** Phase 3 §6: push the DJ's social-choice policy to the aggregator.
   * Idempotent — re-sending the same choice is a no-op on the server.
   * When the socket is closed (offline / reconnecting) the call is a
   * no-op; the next reconnect re-sends from `openSocket`. */
  selectPolicy(choice: PolicyChoice): void {
    const ws = this.ws
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    ws.send(JSON.stringify({ type: 'policy_select', choice }))
  }

  stop(): void {
    this.stopped = true
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.ws?.close()
    this.ws = null
    this.setState({ kind: 'idle' })
  }

  private setState(next: BridgeState): void {
    this.options.onState?.(next)
  }

  private openSocket(): void {
    const baseWs = this.options.aggregatorUrl.replace(/^http/, 'ws')
    const query = new URLSearchParams({ code: this.options.roomCode })
    if (this.options.token) query.set('token', this.options.token)
    const url = `${baseWs.replace(/\/$/, '')}/ws/bridge?${query.toString()}`
    this.setState({ kind: 'connecting' })
    let ws: WebSocket
    try {
      ws = new WebSocket(url)
    } catch {
      this.scheduleReconnect()
      return
    }
    this.ws = ws
    ws.addEventListener('open', () => {
      this.reconnectMs = RECONNECT_INITIAL_MS
      this.setState({ kind: 'open' })
      // Phase 3 §6: re-send the active policy choice on every connect
      // so a reconnect or aggregator restart picks the DJ's selection
      // back up without a round trip through `InfluencePanel`.
      const choice = this.options.influenceRef.current.policy
      ws.send(JSON.stringify({ type: 'policy_select', choice }))
    })
    ws.addEventListener('message', (event) => {
      let parsed: unknown
      try {
        parsed = JSON.parse(String((event as MessageEvent).data))
      } catch {
        return
      }
      if (!isBridgeIntent(parsed)) return
      this.applyIntent(parsed)
    })
    ws.addEventListener('close', () => {
      this.ws = null
      this.setState({ kind: 'offline' })
      this.scheduleReconnect()
    })
    ws.addEventListener('error', () => {
      // Close event will run; let it own the retry.
    })
  }

  private scheduleReconnect(): void {
    if (this.stopped) return
    if (this.reconnectTimer !== null) return
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.openSocket()
    }, this.reconnectMs)
    this.reconnectMs = Math.min(this.reconnectMs * 2, RECONNECT_MAX_MS)
  }

  /** Visible for tests — also called from message handler. */
  applyIntent(intent: BridgeIntent): void {
    this.options.onIntent?.(intent)
    const influence = this.options.influenceRef.current
    const amount = influence.locked ? 0 : Math.max(0, Math.min(1, influence.amount))
    if (amount <= 0) return
    const scaled = intent.prompts
      .slice(0, COLLECTIVE_PROMPT_MAX)
      .map(({ text, weight }) => ({
        text,
        weight: Math.max(0, weight) * amount,
      }))
      .filter((p) => p.weight > 0)
    if (scaled.length === 0) return
    this.dispatch(intent.deck, { type: 'set_style', prompts: scaled })
  }
}

function isBridgeIntent(value: unknown): value is BridgeIntent {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  if (v.type !== 'set_style') return false
  if (v.deck !== 'a' && v.deck !== 'b') return false
  if (!Array.isArray(v.prompts)) return false
  return v.prompts.every(
    (p) =>
      p &&
      typeof p === 'object' &&
      typeof (p as Record<string, unknown>).text === 'string' &&
      typeof (p as Record<string, unknown>).weight === 'number',
  )
}
