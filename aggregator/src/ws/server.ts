/** WebSocket server for phone / host / bridge clients (Phase 1).
 *
 * One process holds one `RoomBundle` per room — the signals state, the
 * bridge transport (a `WorkerWsTransport` fan-out), the tick interval,
 * and the connected sockets. Sockets stream changes; the tick loop
 * drives the aggregation pipeline (PLAN.md §5) and pushes set_style
 * intents through the transport. */

import type { IncomingMessage } from 'node:http'
import type { Server } from 'node:http'
import type { Socket } from 'node:net'
import { WebSocketServer, WebSocket } from 'ws'

import { describeBlend } from '../signals/label.js'
import { topKEntries } from '../signals/blend.js'
import { cosineDistance } from '../signals/blend.js'
import {
  RoomSignalsState,
  TICK_INTERVAL_MS,
  ONBOARDING_CARD_LIMIT,
} from '../signals/room-state.js'
import type {
  BridgeServerMessage,
  HostServerMessage,
  PhoneClientMessage,
  PhoneServerMessage,
  VibeCard,
} from '../signals/messages.js'
import { WorkerWsTransport } from '../control/transport.js'
import type { IdentityProvider } from '../identity/provider.js'
import type { RoomStore, CreateRoomResult } from '../rooms/rooms.js'
import type { EmbedClient } from '../signals/embed.js'

/** Which bridge deck a crowd target lands on (PLAN.md §3: the crowd
 * renders as one more pad target). Phase 1 wires only deck A; the
 * frontend bridge listens for both so deck B is a Phase 2 toggle away. */
export const BRIDGE_DECK = 'a' as const

export type BridgeAuth = {
  /** Optional shared token (`AGGREGATOR_BRIDGE_TOKEN`); when set the
   * bridge upgrade must present it. With it unset, bridge upgrades
   * are accepted only from loopback. */
  token?: string
}

/** Per-room runtime: the signals state, the transport, and the
 * sockets currently attached. */
class RoomBundle {
  readonly signals: RoomSignalsState
  readonly transport = new WorkerWsTransport()
  private interval: NodeJS.Timeout | null = null
  private previousAppliedForShift: Map<string, number>

  constructor(
    readonly code: string,
    readonly result: CreateRoomResult,
    options: { embedClient?: EmbedClient } = {},
  ) {
    this.signals = new RoomSignalsState(undefined, { embedClient: options.embedClient })
    this.previousAppliedForShift = new Map(this.signals.snapshot().applied)
  }

  start(): void {
    if (this.interval) return
    this.interval = setInterval(() => {
      const before = this.previousAppliedForShift
      const snapshot = this.signals.tick()
      const moved = cosineDistance(before, snapshot.applied)
      this.previousAppliedForShift = new Map(snapshot.applied)
      const prompts = topKEntries(snapshot.applied)
        .map(({ id, weight }) => {
          // Phase 2: resolve via the prompt pool, not the seed catalog,
          // so user-submitted vibes like `bluegrass` reach the deck
          // worker as `set_style` prompts when they're picked.
          const text = this.signals.promptText(id)
          return text ? { text, weight } : null
        })
        .filter((p): p is { text: string; weight: number } => p !== null)
      void this.transport.setStyle({
        deck: BRIDGE_DECK,
        prompts,
        slewStepCos: moved,
      })
    }, TICK_INTERVAL_MS)
    this.interval.unref?.()
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval)
      this.interval = null
    }
  }

  /** Returns true while the applied blend has moved noticeably since
   * the last tick — drives the "the room is shifting…" copy (§7b). */
  isShifting(applied: ReadonlyMap<string, number>): boolean {
    return cosineDistance(this.previousAppliedForShift, applied) > 0.02
  }
}

export type AttachOptions = {
  rooms: RoomStore
  identity: IdentityProvider
  baseUrl: () => string
  bridge: BridgeAuth
  /** Phase 2 semantic dedupe — when present, suggestions are embedded
   * via the backend's `/api/embed` endpoint and matched cosine-wise
   * against the existing pool. When absent, suggestions still land
   * (the pool just can't dedupe by similarity). */
  embedClient?: EmbedClient
}

/** Stand a WebSocketServer up on the given HTTP server. Returns a
 * `start` you can call once the room is ready and a `close` for
 * shutdown / tests. */
export function attachWsServer(
  http: Server,
  options: AttachOptions,
): {
  close: () => Promise<void>
  bundleFor: (code: string) => Promise<RoomBundle>
} {
  const wss = new WebSocketServer({ noServer: true })
  const bundles = new Map<string, RoomBundle>()

  async function ensureBundle(code: string): Promise<RoomBundle> {
    const existing = bundles.get(code)
    if (existing) return existing
    const room = options.rooms.get(code)
    if (!room) throw new Error(`unknown room ${code}`)
    // The bundle keeps the room's `joinUrl`/`qrSvg` for the host welcome
    // (it'd otherwise have to re-render the QR every tick); fetching
    // them through `ensureActive` re-uses the active-room idempotency.
    const result = await options.rooms.ensureActive(options.baseUrl())
    const bundle = new RoomBundle(code, result, { embedClient: options.embedClient })
    bundle.start()
    bundles.set(code, bundle)
    return bundle
  }

  http.on('upgrade', (req: IncomingMessage, socket: Socket, head: Buffer) => {
    if (!req.url) return socket.destroy()
    const url = new URL(req.url, 'http://localhost')
    const role = url.pathname
    const code = url.searchParams.get('code')

    const accept = (handler: (ws: WebSocket) => void) => {
      wss.handleUpgrade(req, socket, head, (ws) => handler(ws))
    }

    if (role === '/ws/phone') {
      if (!code || !options.rooms.get(code)) return socket.destroy()
      accept((ws) => handlePhone(ws, code, options, ensureBundle))
      return
    }
    if (role === '/ws/host') {
      if (!code || !options.rooms.get(code)) return socket.destroy()
      accept((ws) => handleHost(ws, code, ensureBundle))
      return
    }
    if (role === '/ws/bridge') {
      if (!code || !options.rooms.get(code)) return socket.destroy()
      if (!authorizeBridge(req, options.bridge)) return socket.destroy()
      accept((ws) => handleBridge(ws, code, ensureBundle))
      return
    }
    socket.destroy()
  })

  return {
    bundleFor: (code) => ensureBundle(code),
    close: async () => {
      for (const bundle of bundles.values()) bundle.stop()
      bundles.clear()
      // `wss.close()` stops accepting new upgrades but does not
      // terminate existing connections — without this loop a lingering
      // phone socket keeps the event loop alive and a test runner
      // hangs at shutdown. `terminate` is the abrupt close (no graceful
      // 1000 handshake), which is what we want on shutdown.
      for (const client of wss.clients) client.terminate()
      await new Promise<void>((res) => wss.close(() => res()))
    },
  }
}

function authorizeBridge(req: IncomingMessage, auth: BridgeAuth): boolean {
  if (auth.token) {
    const url = new URL(req.url ?? '', 'http://localhost')
    const presented = url.searchParams.get('token') ?? req.headers['x-bridge-token']
    return typeof presented === 'string' && timingSafeStringEqual(presented, auth.token)
  }
  // No token configured → loopback-only. Anything else is rejected; the
  // §9 fail-safe in the frontend will then drop influence to 0.
  const remote = req.socket.remoteAddress ?? ''
  return remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1'
}

function timingSafeStringEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

function send(ws: WebSocket, message: unknown): void {
  if (ws.readyState !== WebSocket.OPEN) return
  ws.send(JSON.stringify(message))
}

async function handlePhone(
  ws: WebSocket,
  code: string,
  options: AttachOptions,
  ensureBundle: (code: string) => Promise<RoomBundle>,
): Promise<void> {
  const bundle = await ensureBundle(code)
  let userId: string | null = null
  let unsubscribe: (() => void) | null = null

  function pushNow(): void {
    const snapshot = bundle.signals.snapshot()
    const label = describeBlend(snapshot.applied) || ''
    const shifting = bundle.isShifting(snapshot.applied)
    const message: PhoneServerMessage = {
      type: 'now',
      label,
      temperature: snapshot.temperature.value,
      shifting,
      participantCount: snapshot.participantCount,
    }
    send(ws, message)
  }

  ws.on('message', (raw) => {
    let parsed: PhoneClientMessage
    try {
      parsed = JSON.parse(raw.toString()) as PhoneClientMessage
    } catch {
      send(ws, { type: 'error', message: 'invalid json' } satisfies PhoneServerMessage)
      return
    }
    if (parsed.type === 'hello') {
      const existing = parsed.sessionToken
        ? options.identity.verify({ roomCode: code, sessionToken: parsed.sessionToken })
        : null
      let sessionToken: string
      if (existing) {
        userId = existing
        sessionToken = parsed.sessionToken ?? ''
      } else {
        const issued = options.identity.issue({ roomCode: code })
        userId = issued.userId
        sessionToken = issued.sessionToken
      }
      bundle.signals.seat(userId)
      // Phase 2: the welcome's `vibes` are dealt from the unified
      // prompt pool through the same Thompson sampler that feeds the
      // Vibes-tab card stack — so a user-suggested vibe surfaces in
      // the next joiner's onboarding picker, not only on the Vibes
      // tab. Returning users (existing identity) still get a fresh
      // deal — their per-user `dealtBy` set survives, so they won't
      // see prompts they've already voted on.
      const vibes = bundle.signals.dealCards(userId, ONBOARDING_CARD_LIMIT, {
        markDealt: false,
      })
      send(ws, {
        type: 'welcome',
        userId,
        sessionToken,
        vibes,
        seeded: Boolean(existing),
      } satisfies PhoneServerMessage)
      unsubscribe?.()
      unsubscribe = bundle.signals.subscribe(() => pushNow())
      pushNow()
      return
    }
    if (!userId) {
      send(ws, { type: 'error', message: 'send hello first' } satisfies PhoneServerMessage)
      return
    }
    if (parsed.type === 'seed') {
      if (!Array.isArray(parsed.picks)) return
      const picks = parsed.picks
        .filter((p): p is string => typeof p === 'string')
        .slice(0, 3)
      bundle.signals.applySeed(userId, picks)
      pushNow()
      return
    }
    if (parsed.type === 'react') {
      const sign = parsed.sign === 1 || parsed.sign === -1 ? parsed.sign : null
      if (sign === null) return
      bundle.signals.ingestReaction(userId, sign)
      pushNow()
      return
    }
    if (parsed.type === 'suggest') {
      if (typeof parsed.text !== 'string') return
      void (async () => {
        const result = await bundle.signals.suggest({ userId: userId!, text: parsed.text })
        if (result.kind === 'invalid' || result.kind === 'rate-limited') {
          send(ws, {
            type: 'suggest_ack',
            result: result.kind,
          } satisfies PhoneServerMessage)
          return
        }
        const prompt = result.prompt
        const card: VibeCard = {
          id: prompt.id,
          label: prompt.label,
          voteCount: 0,
        }
        send(ws, {
          type: 'suggest_ack',
          result: result.kind,
          card,
        } satisfies PhoneServerMessage)
      })()
      return
    }
    if (parsed.type === 'vote') {
      const vote = parsed.vote === 1 || parsed.vote === 0 || parsed.vote === -1 ? parsed.vote : null
      if (vote === null || typeof parsed.promptId !== 'string') return
      bundle.signals.castVote(userId, parsed.promptId, vote)
      return
    }
    if (parsed.type === 'request_cards') {
      const limit = typeof parsed.limit === 'number' ? Math.max(1, Math.min(50, parsed.limit)) : undefined
      const cards = bundle.signals.dealCards(userId, limit)
      send(ws, { type: 'cards', cards } satisfies PhoneServerMessage)
      return
    }
  })

  ws.on('close', () => {
    unsubscribe?.()
    // Phase 1 keeps the taste profile around so a reconnect resumes
    // mid-set (PLAN.md §7a step 5). Phase 4+ retires inactive users.
  })
}

async function handleHost(
  ws: WebSocket,
  code: string,
  ensureBundle: (code: string) => Promise<RoomBundle>,
): Promise<void> {
  const bundle = await ensureBundle(code)
  send(ws, {
    type: 'room',
    code: bundle.code,
    joinUrl: bundle.result.joinUrl,
    qrSvg: bundle.result.qrSvg,
  } satisfies HostServerMessage)

  function pushSignals(): void {
    const snapshot = bundle.signals.snapshot()
    const label = describeBlend(snapshot.applied) || ''
    const shifting = bundle.isShifting(snapshot.applied)
    // Phase 2: source the labels from the prompt pool so user-suggested
    // prompts surface with their own text. The host-screen renders these
    // as circles sized by `support` (the Wilson lower bound), still in
    // single-organism mode — clusters land in Phase 3.
    const promptLabels = new Map(snapshot.activePrompts.map((p) => [p.id, p.label]))
    const vibeSupport = [...snapshot.vibeSupport.entries()]
      .map(([id, support]) => ({
        id,
        label: promptLabels.get(id) ?? id,
        support,
      }))
      .sort((a, b) => b.support - a.support)
    const message: HostServerMessage = {
      type: 'signals',
      label,
      temperature: snapshot.temperature.value,
      shifting,
      participantCount: snapshot.participantCount,
      effectiveParticipants: snapshot.effectiveParticipants,
      vibeSupport,
    }
    send(ws, message)
  }
  pushSignals()
  const unsubscribe = bundle.signals.subscribe(() => pushSignals())
  ws.on('close', () => unsubscribe())
}

async function handleBridge(
  ws: WebSocket,
  code: string,
  ensureBundle: (code: string) => Promise<RoomBundle>,
): Promise<void> {
  const bundle = await ensureBundle(code)
  send(ws, { type: 'hello', deck: BRIDGE_DECK } satisfies BridgeServerMessage)
  const off = bundle.transport.subscribe((intent) => {
    send(ws, {
      type: 'set_style',
      deck: intent.deck,
      prompts: intent.prompts,
      slewStepCos: intent.slewStepCos,
    } satisfies BridgeServerMessage)
  })
  ws.on('close', () => off())
}

