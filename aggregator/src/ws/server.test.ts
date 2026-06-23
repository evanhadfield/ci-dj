/** End-to-end WS loop: a phone joins, seeds, taps; a bridge client sees
 * a `set_style` land within a tick. The §9 fail-safe — closing the
 * bridge socket while the pipeline runs — does NOT take the aggregator
 * down. */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { AddressInfo } from 'node:net'
import { WebSocket } from 'ws'

import { RoomStore } from '../rooms/rooms.js'
import { DeviceIdentity } from '../identity/provider.js'
import { attachWsServer } from './server.js'

async function listening(server: Server): Promise<number> {
  await new Promise<void>((res) => server.listen(0, '127.0.0.1', () => res()))
  return (server.address() as AddressInfo).port
}

/** Buffer every message on a WebSocket so `waitMessage` can poll without
 * losing frames that arrive between calls. The test attaches one
 * permanent listener at construction; `waitMessage` resolves from the
 * buffer or waits for the next push. */
class MessageBuffer {
  private readonly received: Record<string, unknown>[] = []
  private readonly waiters: ((msg: Record<string, unknown>) => boolean)[] = []
  private readonly waiterResolvers: ((msg: Record<string, unknown>) => void)[] = []

  constructor(ws: WebSocket) {
    ws.on('message', (raw) => {
      try {
        const parsed = JSON.parse(raw.toString()) as Record<string, unknown>
        for (let i = this.waiters.length - 1; i >= 0; i--) {
          if (this.waiters[i]!(parsed)) {
            this.waiterResolvers[i]!(parsed)
            this.waiters.splice(i, 1)
            this.waiterResolvers.splice(i, 1)
            return
          }
        }
        this.received.push(parsed)
      } catch {
        // Drop non-JSON frames.
      }
    })
  }

  wait(
    predicate: (msg: Record<string, unknown>) => boolean,
    timeoutMs = 4_000,
  ): Promise<Record<string, unknown>> {
    const existing = this.received.findIndex((m) => predicate(m))
    if (existing >= 0) return Promise.resolve(this.received.splice(existing, 1)[0]!)
    return new Promise((res, rej) => {
      const idx = this.waiters.length
      const timer = setTimeout(() => {
        this.waiters.splice(idx, 1)
        this.waiterResolvers.splice(idx, 1)
        rej(new Error('timed out waiting for message'))
      }, timeoutMs)
      this.waiters.push(predicate)
      this.waiterResolvers.push((msg) => {
        clearTimeout(timer)
        res(msg)
      })
    })
  }
}

async function setup(): Promise<{
  port: number
  server: Server
  rooms: RoomStore
  close: () => Promise<void>
  code: string
}> {
  const rooms = new RoomStore()
  const identity = new DeviceIdentity()
  const server = createServer()
  const port = await listening(server)
  const ws = attachWsServer(server, {
    rooms,
    identity,
    baseUrl: () => `http://127.0.0.1:${port}`,
    bridge: { token: undefined }, // loopback-only
  })
  const room = await rooms.ensureActive(`http://127.0.0.1:${port}`)
  return {
    port,
    server,
    rooms,
    code: room.code,
    close: async () => {
      await ws.close()
      await new Promise<void>((res) => server.close(() => res()))
    },
  }
}

function openClient(port: number, role: string, code: string): WebSocket {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${role}?code=${code}`)
  // Swallow socket-level errors here so a server-side `destroy()` (e.g.
  // unknown-room upgrade rejection) doesn't propagate as an
  // uncaughtException to the test runner. We assert behaviour through
  // `readyState` / `close` events instead.
  ws.on('error', () => {})
  return ws
}

describe('attachWsServer', () => {
  it('routes a phone tap through the pipeline to the bridge as set_style', async () => {
    const ctx = await setup()
    try {
      const bridge = openClient(ctx.port, '/ws/bridge', ctx.code)
      const bridgeBuf = new MessageBuffer(bridge)
      await new Promise<void>((res) => bridge.once('open', () => res()))
      await bridgeBuf.wait((m) => m.type === 'hello')

      const phone = openClient(ctx.port, '/ws/phone', ctx.code)
      const phoneBuf = new MessageBuffer(phone)
      await new Promise<void>((res) => phone.once('open', () => res()))
      phone.send(JSON.stringify({ type: 'hello' }))
      const welcome = await phoneBuf.wait((m) => m.type === 'welcome')
      assert.ok(welcome.sessionToken)

      phone.send(JSON.stringify({ type: 'seed', picks: ['hard-techno'] }))
      phone.send(JSON.stringify({ type: 'react', sign: 1 }))

      const intent = await bridgeBuf.wait(
        (m) => m.type === 'set_style' && Array.isArray(m.prompts),
      )
      const prompts = intent.prompts as { text: string; weight: number }[]
      assert.ok(prompts.length > 0)
      // The seeded picks should pull the blend off uniform; the top
      // prompt should mention "techno" since that's where mass landed.
      assert.ok(prompts[0]!.text.includes('techno'))

      phone.close()
      bridge.close()
    } finally {
      await ctx.close()
    }
  })

  it('rejects an unknown room on every WS upgrade', async () => {
    const ctx = await setup()
    try {
      const phone = openClient(ctx.port, '/ws/phone', 'XXXX')
      await new Promise<void>((res) => phone.once('close', () => res()))
      assert.equal(phone.readyState, WebSocket.CLOSED)
    } finally {
      await ctx.close()
    }
  })

  it('accepts a phone-side suggest and acks with created or deduped', async () => {
    const ctx = await setup()
    try {
      const phone = openClient(ctx.port, '/ws/phone', ctx.code)
      const phoneBuf = new MessageBuffer(phone)
      await new Promise<void>((res) => phone.once('open', () => res()))
      phone.send(JSON.stringify({ type: 'hello' }))
      await phoneBuf.wait((m) => m.type === 'welcome')

      phone.send(JSON.stringify({ type: 'suggest', text: 'wonky bass · tape saturation' }))
      const ack = await phoneBuf.wait((m) => m.type === 'suggest_ack')
      assert.equal(ack.result, 'created')
      assert.ok(ack.card)

      // Re-submitting the exact text dedupes against the previous prompt.
      phone.send(JSON.stringify({ type: 'suggest', text: 'wonky bass · tape saturation' }))
      const ack2 = await phoneBuf.wait((m) => m.type === 'suggest_ack' && m !== ack)
      assert.equal(ack2.result, 'deduped')

      phone.close()
    } finally {
      await ctx.close()
    }
  })

  it('deals card-stack cards and accepts votes on them', async () => {
    const ctx = await setup()
    try {
      const phone = openClient(ctx.port, '/ws/phone', ctx.code)
      const phoneBuf = new MessageBuffer(phone)
      await new Promise<void>((res) => phone.once('open', () => res()))
      phone.send(JSON.stringify({ type: 'hello' }))
      await phoneBuf.wait((m) => m.type === 'welcome')

      phone.send(JSON.stringify({ type: 'request_cards', limit: 3 }))
      const cards = await phoneBuf.wait((m) => m.type === 'cards')
      const arr = cards.cards as { id: string; label: string }[]
      assert.equal(arr.length, 3)

      // A vote should land without an error reply.
      phone.send(JSON.stringify({ type: 'vote', promptId: arr[0]!.id, vote: 1 }))
      // The next 'now' or 'cards' frame proves the loop didn't error.
      await phoneBuf.wait((m) => m.type === 'now' || m.type === 'cards', 2_000)
      phone.close()
    } finally {
      await ctx.close()
    }
  })

  it('mirrors host signals to /ws/peek subscribers (Phase 3 Room tab)', async () => {
    const ctx = await setup()
    try {
      const peek = openClient(ctx.port, '/ws/peek', ctx.code)
      const peekBuf = new MessageBuffer(peek)
      await new Promise<void>((res) => peek.once('open', () => res()))
      const first = await peekBuf.wait((m) => m.type === 'peek')
      assert.ok(Array.isArray(first.vibeSupport))
      assert.ok(Array.isArray(first.clusters))
      assert.ok(first.policy)
      peek.close()
    } finally {
      await ctx.close()
    }
  })

  it('accepts a policy_select message from the bridge and stores the choice', async () => {
    const ctx = await setup()
    try {
      const bridge = openClient(ctx.port, '/ws/bridge', ctx.code)
      const bridgeBuf = new MessageBuffer(bridge)
      await new Promise<void>((res) => bridge.once('open', () => res()))
      await bridgeBuf.wait((m) => m.type === 'hello')
      bridge.send(JSON.stringify({ type: 'policy_select', choice: 'maximin' }))
      // Drive a tick by reacting through a phone, then read the peek
      // to confirm the policy field now carries `maximin`.
      const phone = openClient(ctx.port, '/ws/phone', ctx.code)
      const phoneBuf = new MessageBuffer(phone)
      await new Promise<void>((res) => phone.once('open', () => res()))
      phone.send(JSON.stringify({ type: 'hello' }))
      await phoneBuf.wait((m) => m.type === 'welcome')
      const peek = openClient(ctx.port, '/ws/peek', ctx.code)
      const peekBuf = new MessageBuffer(peek)
      await new Promise<void>((res) => peek.once('open', () => res()))
      const update = await peekBuf.wait(
        (m) => m.type === 'peek' && (m.policy as { choice: string }).choice === 'maximin',
        4_000,
      )
      assert.ok(update)
      phone.close()
      peek.close()
      bridge.close()
    } finally {
      await ctx.close()
    }
  })

  it('keeps the aggregator alive when a bridge subscriber drops mid-tick (§9)', async () => {
    const ctx = await setup()
    try {
      const bridge = openClient(ctx.port, '/ws/bridge', ctx.code)
      await new Promise<void>((res) => bridge.once('open', () => res()))
      bridge.close()
      // Drive a few ticks worth of events through; nothing should throw
      // or close the HTTP server.
      const phone = openClient(ctx.port, '/ws/phone', ctx.code)
      const phoneBuf = new MessageBuffer(phone)
      await new Promise<void>((res) => phone.once('open', () => res()))
      phone.send(JSON.stringify({ type: 'hello' }))
      await phoneBuf.wait((m) => m.type === 'welcome')
      phone.send(JSON.stringify({ type: 'react', sign: 1 }))
      await phoneBuf.wait((m) => m.type === 'now')
      phone.close()
    } finally {
      await ctx.close()
    }
  })
})
