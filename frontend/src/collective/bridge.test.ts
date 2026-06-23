/** Bridge gate behaviour: the DJ influence macro scales crowd
 * contribution; lock and amount=0 drop influence to 0 immediately
 * (PLAN.md §9 fail-safe; PROMPT.md Phase 1). */

import { describe, expect, it, vi } from 'vitest'

import { CollectiveBridge } from './bridge'
import type { CrowdInfluence } from './influence'

function makeBridge(influence: CrowdInfluence) {
  const dispatch = vi.fn()
  const influenceRef = { current: influence }
  const bridge = new CollectiveBridge({
    aggregatorUrl: 'http://aggregator.test',
    roomCode: 'AB12',
    influenceRef,
    dispatch,
  })
  return { bridge, dispatch, influenceRef }
}

describe('CollectiveBridge gate', () => {
  it('drops to no-op when the macro is locked', () => {
    const { bridge, dispatch } = makeBridge({ amount: 1, locked: true })
    bridge.applyIntent({
      deck: 'a',
      prompts: [{ text: 'warm disco funk', weight: 1 }],
    })
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('drops to no-op when amount is 0', () => {
    const { bridge, dispatch } = makeBridge({ amount: 0, locked: false })
    bridge.applyIntent({
      deck: 'a',
      prompts: [{ text: 'warm disco funk', weight: 1 }],
    })
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('scales each prompt by the macro amount', () => {
    const { bridge, dispatch } = makeBridge({ amount: 0.5, locked: false })
    bridge.applyIntent({
      deck: 'a',
      prompts: [
        { text: 'warm disco funk', weight: 0.6 },
        { text: 'hard techno', weight: 0.4 },
      ],
    })
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(dispatch).toHaveBeenCalledWith('a', {
      type: 'set_style',
      prompts: [
        { text: 'warm disco funk', weight: 0.3 },
        { text: 'hard techno', weight: 0.2 },
      ],
    })
  })

  it('rereads influence on each intent (lock takes effect immediately)', () => {
    const { bridge, dispatch, influenceRef } = makeBridge({ amount: 0.8, locked: false })
    bridge.applyIntent({
      deck: 'a',
      prompts: [{ text: 'x', weight: 1 }],
    })
    expect(dispatch).toHaveBeenCalledTimes(1)
    influenceRef.current = { amount: 0.8, locked: true }
    bridge.applyIntent({
      deck: 'a',
      prompts: [{ text: 'x', weight: 1 }],
    })
    expect(dispatch).toHaveBeenCalledTimes(1)
  })

  it('caps the prompt count at COLLECTIVE_PROMPT_MAX', () => {
    const { bridge, dispatch } = makeBridge({ amount: 1, locked: false })
    const big = Array.from({ length: 20 }, (_, i) => ({ text: `p${i}`, weight: 1 / 20 }))
    bridge.applyIntent({ deck: 'a', prompts: big })
    expect(dispatch).toHaveBeenCalledTimes(1)
    const sent = dispatch.mock.calls[0]![1] as { prompts: { text: string }[] }
    expect(sent.prompts.length).toBe(8)
  })

  it('reports incoming intents to onIntent regardless of gate state', () => {
    const dispatch = vi.fn()
    const onIntent = vi.fn()
    const bridge = new CollectiveBridge({
      aggregatorUrl: 'http://x',
      roomCode: 'AB12',
      influenceRef: { current: { amount: 0, locked: true } },
      dispatch,
      onIntent,
    })
    bridge.applyIntent({ deck: 'a', prompts: [{ text: 'x', weight: 1 }] })
    expect(onIntent).toHaveBeenCalledTimes(1)
    expect(dispatch).not.toHaveBeenCalled()
  })
})
