/** Transport seam contract: the WS transport is real-but-idle, the MCP
 * transport is a loud stub. */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { WorkerWsTransport, McpTransport } from './transport.js'

describe('WorkerWsTransport (Phase 0: real-but-idle)', () => {
  it('reports healthy so the bridge can exercise its full pipeline', async () => {
    const transport = new WorkerWsTransport()
    assert.equal(await transport.isHealthy(), true)
  })

  it('accepts a setStyle without throwing — Phase 1 wires the dispatch', async () => {
    const transport = new WorkerWsTransport()
    await transport.setStyle({
      deck: 'a',
      prompts: [{ text: 'warm disco funk', weight: 1 }],
    })
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
