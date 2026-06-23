/** Approval temperature: bounded, decays toward zero, climbs with likes. */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  applyReactionToTemperature,
  decayedTemperature,
  emptyTemperature,
  TEMPERATURE_HALFLIFE_MS,
} from './temperature.js'

describe('applyReactionToTemperature', () => {
  it('climbs above zero on a like and stays in [-1, +1]', () => {
    let t = emptyTemperature(0)
    for (let i = 0; i < 1000; i++) {
      t = applyReactionToTemperature(t, 1, i * 10)
    }
    assert.ok(t.value > 0)
    assert.ok(t.value <= 1)
  })

  it('falls below zero on dislikes', () => {
    let t = emptyTemperature(0)
    for (let i = 0; i < 50; i++) {
      t = applyReactionToTemperature(t, -1, i * 10)
    }
    assert.ok(t.value < 0)
  })

  it('decays back toward zero after silence', () => {
    let t = applyReactionToTemperature(emptyTemperature(0), 1, 100)
    const hot = t.value
    t = decayedTemperature(t, 100 + 4 * TEMPERATURE_HALFLIFE_MS)
    assert.ok(Math.abs(t.value) < Math.abs(hot) / 8)
  })
})
