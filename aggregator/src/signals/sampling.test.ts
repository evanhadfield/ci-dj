/** Thompson-sampling primitives: Beta sampler distribution, recency
 * bonus shape, and a smoke test that the dealer's stochastic ordering
 * actually prefers high-α prompts over high-β prompts. */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { sampleBeta, recencyBonus, FRESH_BOOST_MS, FRESH_BOOST_AMOUNT, mulberry32 } from './sampling.js'

function mean(samples: readonly number[]): number {
  let total = 0
  for (const x of samples) total += x
  return total / samples.length
}

describe('sampleBeta', () => {
  it('centers Beta(1, 1) on 0.5 (uniform prior)', () => {
    const rng = mulberry32(1)
    const samples = Array.from({ length: 1_000 }, () => sampleBeta(1, 1, rng))
    assert.ok(Math.abs(mean(samples) - 0.5) < 0.05)
  })

  it('centers Beta(10, 1) near 0.9 (mostly-agree posterior)', () => {
    const rng = mulberry32(2)
    const samples = Array.from({ length: 1_000 }, () => sampleBeta(10, 1, rng))
    assert.ok(mean(samples) > 0.85, `expected > 0.85, got ${mean(samples)}`)
  })

  it('centers Beta(1, 10) near 0.09 (mostly-disagree posterior)', () => {
    const rng = mulberry32(3)
    const samples = Array.from({ length: 1_000 }, () => sampleBeta(1, 10, rng))
    assert.ok(mean(samples) < 0.15, `expected < 0.15, got ${mean(samples)}`)
  })

  it('fresh prompt (Beta 1,1) beats incumbent (Beta 10,1) sometimes — exploration', () => {
    const rng = mulberry32(4)
    let freshWins = 0
    for (let i = 0; i < 1_000; i++) {
      if (sampleBeta(1, 1, rng) > sampleBeta(10, 1, rng)) freshWins++
    }
    // Without recency bonus, Beta(1,1) beats Beta(10,1) ~5–15% of the
    // time. Asserting a wide band so the test is robust under PRNG
    // drift; the point is "not zero, not certain".
    assert.ok(freshWins > 30 && freshWins < 250, `fresh wins ${freshWins} of 1000`)
  })
})

describe('recencyBonus', () => {
  it('is the full FRESH_BOOST_AMOUNT at age 0', () => {
    assert.equal(recencyBonus(0), FRESH_BOOST_AMOUNT)
  })

  it('is zero at and past FRESH_BOOST_MS', () => {
    assert.equal(recencyBonus(FRESH_BOOST_MS), 0)
    assert.equal(recencyBonus(FRESH_BOOST_MS + 1), 0)
  })

  it('halves the bonus at the half-life', () => {
    assert.ok(Math.abs(recencyBonus(FRESH_BOOST_MS / 2) - FRESH_BOOST_AMOUNT / 2) < 1e-6)
  })
})
