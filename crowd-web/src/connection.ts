/** WebSocket client to the aggregator phone endpoint. Reconnects
 * silently on transient drops (PLAN.md §7d "reconnect after sleep");
 * surfaces aggregator-unreachable as an inline state, not an error
 * (§7d "the DJ's driving solo right now"). */

import type { PhoneClientMessage, PhoneServerMessage } from './types.ts'

const RECONNECT_INITIAL_MS = 1_000
const RECONNECT_MAX_MS = 8_000

export type ConnectionState =
  | { kind: 'connecting' }
  | { kind: 'open' }
  | { kind: 'offline' }

export type ConnectionEvents = {
  onState: (state: ConnectionState) => void
  onMessage: (message: PhoneServerMessage) => void
}

export class PhoneConnection {
  private ws: WebSocket | null = null
  private reconnectMs = RECONNECT_INITIAL_MS
  private reconnectTimer: number | null = null
  private closed = false

  constructor(
    private readonly url: string,
    private readonly events: ConnectionEvents,
  ) {}

  start(): void {
    this.closed = false
    this.openSocket()
  }

  stop(): void {
    this.closed = true
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.ws?.close()
    this.ws = null
  }

  send(message: PhoneClientMessage): void {
    const ws = this.ws
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    ws.send(JSON.stringify(message))
  }

  private openSocket(): void {
    this.events.onState({ kind: 'connecting' })
    let ws: WebSocket
    try {
      ws = new WebSocket(this.url)
    } catch {
      this.scheduleReconnect()
      return
    }
    this.ws = ws
    ws.addEventListener('open', () => {
      this.reconnectMs = RECONNECT_INITIAL_MS
      this.events.onState({ kind: 'open' })
    })
    ws.addEventListener('message', (event) => {
      try {
        const parsed = JSON.parse(String(event.data)) as PhoneServerMessage
        this.events.onMessage(parsed)
      } catch {
        // Malformed frames are dropped; the aggregator never sends them.
      }
    })
    ws.addEventListener('close', () => {
      this.ws = null
      this.events.onState({ kind: 'offline' })
      this.scheduleReconnect()
    })
    ws.addEventListener('error', () => {
      // The close handler will run; let it own the retry.
    })
  }

  private scheduleReconnect(): void {
    if (this.closed) return
    if (this.reconnectTimer !== null) return
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null
      this.openSocket()
    }, this.reconnectMs)
    this.reconnectMs = Math.min(this.reconnectMs * 2, RECONNECT_MAX_MS)
  }
}
