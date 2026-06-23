/** PCA + K-means clustering on OpinionMatrix.rows() (PLAN.md §5.5, §6). */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { OpinionMatrix } from './opinion-matrix.js'
import {
  CLUSTER_MIN_N,
  clusterMass,
  clusterMatrix,
  computePolicies,
  POLICY_MIN_CLUSTER_SIZE,
} from './clusters.js'
import { mulberry32 } from './sampling.js'

const PROMPTS = ['p-disco', 'p-techno', 'p-ambient', 'p-acid', 'p-house'] as const

function planted(matrix: OpinionMatrix, group: 'a' | 'b', userId: string, now: number): void {
  // Two synthetic opinion groups that vote opposite on the first two
  // prompts and agree on the third (the bridge candidate for maximin).
  if (group === 'a') {
    matrix.vote(userId, 'p-disco', 1, now)
    matrix.vote(userId, 'p-techno', -1, now)
    matrix.vote(userId, 'p-ambient', 1, now)
  } else {
    matrix.vote(userId, 'p-disco', -1, now)
    matrix.vote(userId, 'p-techno', 1, now)
    matrix.vote(userId, 'p-ambient', 1, now)
  }
}

describe('clusterMatrix', () => {
  it('returns no clusters below CLUSTER_MIN_N', () => {
    const matrix = new OpinionMatrix()
    for (let i = 0; i < CLUSTER_MIN_N - 1; i++) {
      planted(matrix, i % 2 === 0 ? 'a' : 'b', `u${i}`, 0)
    }
    const { clusters } = clusterMatrix(matrix, { random: mulberry32(1) })
    assert.equal(clusters.length, 0)
  })

  it('recovers two planted groups when over the gate', () => {
    const matrix = new OpinionMatrix()
    for (let i = 0; i < 20; i++) planted(matrix, 'a', `a${i}`, 0)
    for (let i = 0; i < 20; i++) planted(matrix, 'b', `b${i}`, 0)
    const { clusters } = clusterMatrix(matrix, { random: mulberry32(7), k: 2 })
    assert.equal(clusters.length, 2)
    // Each planted group should land mostly in one cluster — perfect
    // separation is overconstrained (K-means seeds can swap labels),
    // so we check majority assignment instead.
    const sizes = clusters.map((c) => c.size)
    assert.equal(sizes.reduce((s, n) => s + n, 0), 40)
    for (const cluster of clusters) {
      const fromA = cluster.members.filter((id) => id.startsWith('a')).length
      const fromB = cluster.members.filter((id) => id.startsWith('b')).length
      const dominant = Math.max(fromA, fromB)
      const minority = Math.min(fromA, fromB)
      assert.ok(dominant > minority, `cluster ${cluster.id} mixes ${fromA}/${fromB}`)
    }
  })

  it('falls back below the gate even with valid input', () => {
    const matrix = new OpinionMatrix()
    planted(matrix, 'a', 'a1', 0)
    planted(matrix, 'b', 'b1', 0)
    const { clusters } = clusterMatrix(matrix, { random: mulberry32(1) })
    assert.equal(clusters.length, 0)
  })

  it('lowering minActiveVoters lets a small bimodal test cluster anyway', () => {
    const matrix = new OpinionMatrix()
    for (let i = 0; i < 4; i++) planted(matrix, 'a', `a${i}`, 0)
    for (let i = 0; i < 4; i++) planted(matrix, 'b', `b${i}`, 0)
    const { clusters } = clusterMatrix(matrix, {
      random: mulberry32(3),
      minActiveVoters: 6,
    })
    assert.ok(clusters.length === 2)
  })

  it('reports manifold-outlier distances for every active voter', () => {
    const matrix = new OpinionMatrix()
    for (let i = 0; i < 20; i++) planted(matrix, 'a', `a${i}`, 0)
    for (let i = 0; i < 20; i++) planted(matrix, 'b', `b${i}`, 0)
    const { outlierDistances } = clusterMatrix(matrix, { random: mulberry32(2) })
    assert.equal(outlierDistances.size, 40)
    for (const d of outlierDistances.values()) {
      assert.ok(d >= 0 && d <= 1, `outlier distance ${d} out of range`)
    }
  })

  it('largest cluster sorts to c0', () => {
    const matrix = new OpinionMatrix()
    for (let i = 0; i < 20; i++) planted(matrix, 'a', `a${i}`, 0)
    for (let i = 0; i < 10; i++) planted(matrix, 'b', `b${i}`, 0)
    const { clusters } = clusterMatrix(matrix, { random: mulberry32(4), k: 2 })
    assert.equal(clusters[0]!.id, 'c0')
    assert.ok(clusters[0]!.size >= clusters[1]!.size)
  })
})

describe('clusterMass', () => {
  it('tallies per-cluster votes on a specific prompt', () => {
    const matrix = new OpinionMatrix()
    for (let i = 0; i < 20; i++) planted(matrix, 'a', `a${i}`, 0)
    for (let i = 0; i < 20; i++) planted(matrix, 'b', `b${i}`, 0)
    const { clusters } = clusterMatrix(matrix, { random: mulberry32(8), k: 2 })
    const mass = clusterMass(clusters, matrix, 'p-disco')
    assert.equal(mass.length, 2)
    const total = mass.reduce((s, m) => s + m.agree + m.disagree + m.pass, 0)
    assert.equal(total, 40)
  })

  it('returns empty when clustering produced no groups', () => {
    const matrix = new OpinionMatrix()
    matrix.vote('only', 'p-disco', 1, 0)
    const mass = clusterMass([], matrix, 'p-disco')
    assert.deepEqual(mass, [])
  })
})

describe('computePolicies', () => {
  it('auto picks pr above the gate (multiple effective clusters)', () => {
    const matrix = new OpinionMatrix()
    for (let i = 0; i < 20; i++) planted(matrix, 'a', `a${i}`, 0)
    for (let i = 0; i < 20; i++) planted(matrix, 'b', `b${i}`, 0)
    const { clusters } = clusterMatrix(matrix, { random: mulberry32(5), k: 2 })
    const out = computePolicies(clusters, { choice: 'auto' })
    assert.equal(out.appliedPolicy, 'pr')
    assert.equal(out.choice, 'auto')
  })

  it('auto falls back to centroid with only one effective cluster', () => {
    // Pad the room with one giant cluster; the other has < POLICY_MIN_CLUSTER_SIZE.
    const matrix = new OpinionMatrix()
    for (let i = 0; i < 20; i++) planted(matrix, 'a', `a${i}`, 0)
    planted(matrix, 'b', 'lonely', 0)
    const { clusters } = clusterMatrix(matrix, { random: mulberry32(6), k: 2 })
    const out = computePolicies(clusters, { choice: 'auto' })
    // Either we'll have a single effective cluster (after the size
    // filter) or zero. Either way `auto` should land on `centroid`.
    assert.ok(['centroid'].includes(out.appliedPolicy))
  })

  it('pr rotates the featured cluster across rotation slots', () => {
    const matrix = new OpinionMatrix()
    for (let i = 0; i < 20; i++) planted(matrix, 'a', `a${i}`, 0)
    for (let i = 0; i < 20; i++) planted(matrix, 'b', `b${i}`, 0)
    const { clusters } = clusterMatrix(matrix, { random: mulberry32(9), k: 2 })
    const blends = []
    for (let t = 0; t < 8; t++) {
      const out = computePolicies(clusters, { choice: 'pr', rotationTick: t, rotationWindow: 8 })
      blends.push([...out.pr.keys()].sort().join(','))
    }
    const distinct = new Set(blends)
    assert.ok(distinct.size >= 2, `pr should rotate; got ${[...distinct].join(' | ')}`)
  })

  it('maximin prefers the prompt every cluster tolerates', () => {
    const matrix = new OpinionMatrix()
    for (let i = 0; i < 20; i++) planted(matrix, 'a', `a${i}`, 0)
    for (let i = 0; i < 20; i++) planted(matrix, 'b', `b${i}`, 0)
    const { clusters } = clusterMatrix(matrix, { random: mulberry32(10), k: 2 })
    const out = computePolicies(clusters, { choice: 'maximin' })
    // p-ambient is the only prompt both groups agree on.
    assert.ok(out.maximin.has('p-ambient'))
    const ambientWeight = out.maximin.get('p-ambient') ?? 0
    for (const id of out.maximin.keys()) {
      if (id === 'p-ambient') continue
      assert.ok(
        (out.maximin.get(id) ?? 0) <= ambientWeight,
        `expected ambient ${ambientWeight} ≥ ${id}: ${out.maximin.get(id)}`,
      )
    }
  })

  it('centroid is size-weighted across clusters', () => {
    const matrix = new OpinionMatrix()
    for (let i = 0; i < 25; i++) planted(matrix, 'a', `a${i}`, 0)
    for (let i = 0; i < 5; i++) planted(matrix, 'b', `b${i}`, 0)
    const { clusters } = clusterMatrix(matrix, { random: mulberry32(11), k: 2 })
    const out = computePolicies(clusters, { choice: 'centroid' })
    // Cluster A's preferred prompt (p-disco) should dominate the
    // size-weighted centroid over cluster B's (p-techno).
    const disco = out.centroid.get('p-disco') ?? 0
    const techno = out.centroid.get('p-techno') ?? 0
    assert.ok(disco > techno, `expected disco ${disco} > techno ${techno}`)
  })

  it('explicit choice overrides auto', () => {
    const matrix = new OpinionMatrix()
    for (let i = 0; i < 20; i++) planted(matrix, 'a', `a${i}`, 0)
    for (let i = 0; i < 20; i++) planted(matrix, 'b', `b${i}`, 0)
    const { clusters } = clusterMatrix(matrix, { random: mulberry32(12), k: 2 })
    const out = computePolicies(clusters, { choice: 'maximin' })
    assert.equal(out.appliedPolicy, 'maximin')
    assert.equal(out.choice, 'maximin')
  })

  it('returns empty blends when there are no effective clusters', () => {
    const out = computePolicies([], { choice: 'auto' })
    assert.equal(out.centroid.size, 0)
    assert.equal(out.pr.size, 0)
    assert.equal(out.maximin.size, 0)
    assert.equal(out.appliedPolicy, 'centroid')
  })

  it(`filters clusters below POLICY_MIN_CLUSTER_SIZE (=${POLICY_MIN_CLUSTER_SIZE})`, () => {
    const matrix = new OpinionMatrix()
    for (let i = 0; i < 20; i++) planted(matrix, 'a', `a${i}`, 0)
    // A single lone voter shouldn't influence policy at all.
    planted(matrix, 'b', 'lone', 0)
    const { clusters } = clusterMatrix(matrix, { random: mulberry32(13), k: 2 })
    const out = computePolicies(clusters, { choice: 'centroid' })
    // The lone cluster's preferred prompt (p-techno) should not
    // dominate cluster A's (p-disco) in the centroid.
    const disco = out.centroid.get('p-disco') ?? 0
    const techno = out.centroid.get('p-techno') ?? 0
    assert.ok(disco > techno || techno === 0)
  })
})
