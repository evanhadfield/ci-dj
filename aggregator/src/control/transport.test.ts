/** Transport seam contract: the WS transport is real-but-idle, the MCP
 * transport is a loud stub. */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { WorkerWsTransport, McpTransport } from './transport.js'

describe('WorkerWsTransport (Phase 1: fan-out publisher)', () => {
  it('reports unhealthy when no bridge subscriber is connected (§9 fail-safe)', async () => {
    const transport = new WorkerWsTransport()
    assert.equal(await transport.isHealthy(), false)
  })

  it('reports healthy once a subscriber registers', async () => {
    const transport = new WorkerWsTransport()
    transport.subscribe(() => {})
    assert.equal(await transport.isHealthy(), true)
  })

  it('fans setStyle out to every subscriber', async () => {
    const transport = new WorkerWsTransport()
    const seen: string[] = []
    transport.subscribe((intent) => seen.push(`A:${intent.prompts[0]?.text}`))
    transport.subscribe((intent) => seen.push(`B:${intent.prompts[0]?.text}`))
    await transport.setStyle({
      deck: 'a',
      prompts: [{ text: 'warm disco funk', weight: 1 }],
    })
    assert.deepEqual(seen.sort(), ['A:warm disco funk', 'B:warm disco funk'])
  })

  it("isolates a throwing subscriber from the rest of the fan-out", async () => {
    const transport = new WorkerWsTransport()
    let delivered = false
    transport.subscribe(() => {
      throw new Error('boom')
    })
    transport.subscribe(() => {
      delivered = true
    })
    await transport.setStyle({ deck: 'a', prompts: [{ text: 'x', weight: 1 }] })
    assert.equal(delivered, true)
  })

  it('unsubscribe stops further delivery', async () => {
    const transport = new WorkerWsTransport()
    let calls = 0
    const off = transport.subscribe(() => calls++)
    await transport.setStyle({ deck: 'a', prompts: [{ text: 'x', weight: 1 }] })
    off()
    await transport.setStyle({ deck: 'a', prompts: [{ text: 'y', weight: 1 }] })
    assert.equal(calls, 1)
    assert.equal(transport.hasSubscribers(), false)
  })
})

describe('McpTransport (Phase 0: loud stub)', () => {
  it('throws on setStyle so a misconfigured bridge fails loudly', async () => {
    const transport = new McpTransport()
    await assert.rejects(
      () => transport.setStyle({ deck: 'a', prompts: [{ text: 'x', weight: 1 }] }),
      /stub|ADR-0020/,
    )
  })

  it('reports unhealthy so the bridge stays on the WS transport', async () => {
    const transport = new McpTransport()
    assert.equal(await transport.isHealthy(), false)
  })
})
