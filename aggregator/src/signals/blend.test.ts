/** Blend arithmetic — uniform / sum / lerp / cosine / topK. */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  cosineDistance,
  lerpBlend,
  singletonBlend,
  sumBlends,
  topKEntries,
  uniformBlend,
} from './blend.js'
import { SEED_VIBES } from './vibes.js'

describe('uniformBlend', () => {
  it('produces a normalised weight over every seed vibe', () => {
    const blend = uniformBlend()
    assert.equal(blend.size, SEED_VIBES.length)
    let sum = 0
    for (const value of blend.values()) sum += value
    assert.ok(Math.abs(sum - 1) < 1e-9)
  })
})

describe('sumBlends', () => {
  it('falls back to uniform when no contributions land', () => {
    const blend = sumBlends([])
    assert.equal(blend.size, SEED_VIBES.length)
  })

  it('normalises a single singleton contribution to weight 1 on that id', () => {
    const blend = sumBlends([singletonBlend('sunset-disco', 2)])
    assert.equal(blend.get('sunset-disco'), 1)
  })

  it('mixes two singletons in proportion to their input weight', () => {
    const blend = sumBlends([
      singletonBlend('sunset-disco', 3),
      singletonBlend('hard-techno', 1),
    ])
    assert.equal(blend.get('sunset-disco'), 0.75)
    assert.equal(blend.get('hard-techno'), 0.25)
  })
})

describe('lerpBlend', () => {
  it('returns endpoints at t=0 and t=1 (with both sides normalised)', () => {
    const a = singletonBlend('sunset-disco', 1)
    const b = singletonBlend('hard-techno', 1)
    assert.equal(lerpBlend(a, b, 0).get('sunset-disco'), 1)
    assert.equal(lerpBlend(a, b, 1).get('hard-techno'), 1)
  })

  it('weights the midpoint equally between disjoint singletons', () => {
    const mid = lerpBlend(
      singletonBlend('sunset-disco', 1),
      singletonBlend('hard-techno', 1),
      0.5,
    )
    assert.equal(mid.get('sunset-disco'), 0.5)
    assert.equal(mid.get('hard-techno'), 0.5)
  })
})

describe('cosineDistance', () => {
  it('is 0 for identical blends and 1 for orthogonal ones', () => {
    const a = singletonBlend('sunset-disco', 1)
    const b = singletonBlend('hard-techno', 1)
    assert.ok(cosineDistance(a, a) < 1e-9)
    assert.ok(Math.abs(cosineDistance(a, b) - 1) < 1e-9)
  })
})

describe('topKEntries', () => {
  it('orders by descending weight and renormalises the slice', () => {
    const entries = topKEntries(
      sumBlends([
        singletonBlend('sunset-disco', 5),
        singletonBlend('hard-techno', 1),
        singletonBlend('ambient', 0.5),
      ]),
      2,
    )
    assert.equal(entries.length, 2)
    assert.equal(entries[0]?.id, 'sunset-disco')
    assert.equal(entries[1]?.id, 'hard-techno')
    const sum = entries.reduce((s, e) => s + e.weight, 0)
    assert.ok(Math.abs(sum - 1) < 1e-9)
  })
})
