/** Per-user taste vector: seed picks land, reactions follow the active
 * blend, the per-window cap bounds magnitude, and cooldown drops mash. */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { singletonBlend, sumBlends } from './blend.js'
import {
  applyReaction,
  applySeedPicks,
  contribution,
  emptyTasteState,
  PER_USER_CAP_L1,
  TAP_COOLDOWN_MS,
} from './taste.js'

describe('applySeedPicks', () => {
  it('seeds the liked side from a fresh state', () => {
    const seeded = applySeedPicks(
      emptyTasteState(0),
      ['sunset-disco', 'deep-house'],
      0,
    )
    assert.equal(seeded.liked.get('sunset-disco'), 1)
    assert.equal(seeded.liked.get('deep-house'), 1)
  })

  it('ignores unknown ids without throwing', () => {
    const seeded = applySeedPicks(emptyTasteState(0), ['not-a-vibe'], 0)
    assert.equal(seeded.liked.size, 0)
  })
})

describe('applyReaction', () => {
  it('lands a +1 reaction on the active blend ids on the liked side', () => {
    const active = singletonBlend('sunset-disco', 1)
    const state = applyReaction(emptyTasteState(0), {
      sign: 1,
      activeBlend: active,
      ts: 1_000,
    })
    assert.ok((state.liked.get('sunset-disco') ?? 0) > 0)
    assert.equal(state.disliked.size, 0)
  })

  it('lands a -1 reaction on the disliked side', () => {
    const active = singletonBlend('hard-techno', 1)
    const state = applyReaction(emptyTasteState(0), {
      sign: -1,
      activeBlend: active,
      ts: 1_000,
    })
    assert.ok((state.disliked.get('hard-techno') ?? 0) > 0)
    assert.equal(state.liked.size, 0)
  })

  it('drops a tap inside the cooldown window', () => {
    const active = singletonBlend('sunset-disco', 1)
    const first = applyReaction(emptyTasteState(0), {
      sign: 1,
      activeBlend: active,
      ts: 1_000,
    })
    const firstMass = first.liked.get('sunset-disco') ?? 0
    const masher = applyReaction(first, {
      sign: 1,
      activeBlend: active,
      ts: 1_000 + TAP_COOLDOWN_MS - 1,
    })
    assert.equal(masher.liked.get('sunset-disco'), firstMass)
  })

  it('decays the liked mass over time', () => {
    const active = singletonBlend('sunset-disco', 1)
    const hot = applyReaction(emptyTasteState(0), {
      sign: 1,
      activeBlend: active,
      ts: 0,
    })
    const cool = applyReaction(hot, {
      sign: 1,
      activeBlend: singletonBlend('hard-techno', 1),
      ts: 60_000,
    })
    assert.ok((cool.liked.get('sunset-disco') ?? 0) < (hot.liked.get('sunset-disco') ?? 0))
  })
})

describe('contribution', () => {
  it('floors at zero per prompt (a strong dislike cancels a like)', () => {
    let state = emptyTasteState(0)
    state = applyReaction(state, {
      sign: 1,
      activeBlend: singletonBlend('sunset-disco', 1),
      ts: 0,
    })
    state = applyReaction(state, {
      sign: -1,
      activeBlend: singletonBlend('sunset-disco', 1),
      ts: TAP_COOLDOWN_MS + 1,
    })
    const c = contribution(state)
    assert.equal(c.get('sunset-disco') ?? 0, 0)
  })

  it('caps the L1 sum so heavy tappers never out-weight quiet ones', () => {
    let state = emptyTasteState(0)
    // Spam a hundred reactions across the cooldown so they all count.
    for (let i = 0; i < 100; i++) {
      state = applyReaction(state, {
        sign: 1,
        activeBlend: singletonBlend('sunset-disco', 1),
        ts: i * (TAP_COOLDOWN_MS + 1),
      })
    }
    const c = contribution(state)
    let sum = 0
    for (const value of c.values()) sum += value
    assert.ok(sum <= PER_USER_CAP_L1 + 1e-9, `sum ${sum} > cap`)
  })

  it('combines via sumBlends to yield a normalised crowd blend', () => {
    const stateA = applyReaction(emptyTasteState(0), {
      sign: 1,
      activeBlend: singletonBlend('sunset-disco', 1),
      ts: 0,
    })
    const stateB = applyReaction(emptyTasteState(0), {
      sign: 1,
      activeBlend: singletonBlend('hard-techno', 1),
      ts: 0,
    })
    const blend = sumBlends([contribution(stateA), contribution(stateB)])
    let sum = 0
    for (const value of blend.values()) sum += value
    assert.ok(Math.abs(sum - 1) < 1e-9)
  })
})
