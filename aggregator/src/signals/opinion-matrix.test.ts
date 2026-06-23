/** OpinionMatrix: votes land, summaries update, Wilson lower bound. */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { OpinionMatrix, wilsonScore } from './opinion-matrix.js'

describe('wilsonScore', () => {
  it('returns 0 for no votes', () => {
    assert.equal(wilsonScore(0, 0), 0)
  })

  it('returns 0 for pure disagree', () => {
    assert.equal(wilsonScore(0, 5), 0)
  })

  it('climbs toward 1 with more agree votes', () => {
    const low = wilsonScore(3, 3)
    const high = wilsonScore(30, 30)
    assert.ok(high > low)
    assert.ok(high < 1)
  })

  it('penalises low sample sizes vs. naive rate', () => {
    const score = wilsonScore(1, 1)
    assert.ok(score < 0.5, `Wilson score ${score} should be less than naive rate 1.0`)
  })
})

describe('OpinionMatrix', () => {
  it('records a vote and updates the summary', () => {
    const m = new OpinionMatrix()
    m.vote('u1', 'p1', 1, 100)
    const summary = m.summary('p1')
    assert.equal(summary.agree, 1)
    assert.equal(summary.disagree, 0)
    assert.equal(summary.pass, 0)
    assert.ok(summary.support > 0)
  })

  it('overwrites an existing vote on the same (user, prompt)', () => {
    const m = new OpinionMatrix()
    m.vote('u1', 'p1', 1, 100)
    m.vote('u1', 'p1', -1, 200)
    const summary = m.summary('p1')
    assert.equal(summary.agree, 0)
    assert.equal(summary.disagree, 1)
  })

  it('counts passes in the summary but as half-agree in the support', () => {
    const m = new OpinionMatrix()
    m.vote('u1', 'p1', 0, 100)
    m.vote('u2', 'p1', 0, 110)
    const summary = m.summary('p1')
    assert.equal(summary.pass, 2)
    assert.ok(summary.support > 0)
  })

  it('forgets every vote when a user is evicted', () => {
    const m = new OpinionMatrix()
    m.vote('u1', 'p1', 1, 100)
    m.vote('u1', 'p2', -1, 100)
    m.forgetUser('u1')
    assert.equal(m.summary('p1').agree, 0)
    assert.equal(m.summary('p2').disagree, 0)
    assert.equal(m.activeVoters(), 0)
  })

  it('counts only voters with at least one vote', () => {
    const m = new OpinionMatrix()
    m.vote('u1', 'p1', 1, 100)
    m.vote('u2', 'p1', -1, 100)
    assert.equal(m.activeVoters(), 2)
  })

  it('exposes rows for the Phase 3 PCA seam', () => {
    const m = new OpinionMatrix()
    m.vote('u1', 'p1', 1, 100)
    m.vote('u1', 'p2', -1, 100)
    const rows = m.rows()
    assert.equal(rows.size, 1)
    assert.equal(rows.get('u1')!.size, 2)
  })
})
