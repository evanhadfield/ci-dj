/** Pipeline ordering and the §5 properties:
 *   - sub-quorum: shrinkage keeps the applied blend near the baseline.
 *   - quorum: the centroid moves toward the visible majority.
 *   - slew: a single tick can't jump from baseline to extreme. */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { cosineDistance, singletonBlend, uniformBlend } from './blend.js'
import { tick, MAX_SLEW_STEP_COS } from './pipeline.js'
import { applyReaction, emptyTasteState, TAP_COOLDOWN_MS } from './taste.js'

function userWithLikes(ids: readonly string[]): import('./taste.js').TasteState {
  let state = emptyTasteState(0)
  let ts = 1_000
  for (const id of ids) {
    state = applyReaction(state, {
      sign: 1,
      activeBlend: singletonBlend(id, 1),
      ts,
    })
    ts += TAP_COOLDOWN_MS + 1
  }
  return state
}

describe('pipeline.tick', () => {
  it('returns the baseline when nobody has reacted (§5.4 prior wins)', () => {
    const result = tick({
      tastes: new Map(),
      previousApplied: uniformBlend(),
    })
    assert.ok(cosineDistance(result.target, uniformBlend()) < 1e-9)
  })

  it('moves the target toward the visible majority once the crowd has mass', () => {
    const tastes = new Map()
    for (let i = 0; i < 12; i++) {
      tastes.set(`u${i}`, userWithLikes(['sunset-disco']))
    }
    const result = tick({
      tastes,
      previousApplied: uniformBlend(),
    })
    const sunsetWeight = result.target.get('sunset-disco') ?? 0
    const uniformWeight = (uniformBlend().get('sunset-disco') ?? 0)
    assert.ok(
      sunsetWeight > uniformWeight,
      `expected sunset weight ${sunsetWeight} > uniform ${uniformWeight}`,
    )
  })

  it('caps the applied step by MAX_SLEW_STEP_COS (§5.8)', () => {
    const tastes = new Map()
    for (let i = 0; i < 200; i++) {
      tastes.set(`u${i}`, userWithLikes(['hard-techno']))
    }
    const previous = uniformBlend()
    const result = tick({ tastes, previousApplied: previous })
    const moved = cosineDistance(previous, result.applied)
    assert.ok(
      moved <= MAX_SLEW_STEP_COS + 1e-9,
      `applied jumped by ${moved}, cap is ${MAX_SLEW_STEP_COS}`,
    )
  })

  it('moves smaller distances without clamping', () => {
    const tastes = new Map([['u1', userWithLikes(['sunset-disco'])]])
    const result = tick({ tastes, previousApplied: uniformBlend() })
    // With a single user we're shrinkage-dominated; the target is barely
    // off baseline so the slew step is the natural one.
    assert.ok(cosineDistance(uniformBlend(), result.applied) < MAX_SLEW_STEP_COS)
  })
})
