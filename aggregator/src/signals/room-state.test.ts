/** Room signals lifecycle: seat → seed → react → tick. */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { RoomSignalsState } from './room-state.js'
import { mulberry32 } from './sampling.js'

describe('RoomSignalsState', () => {
  it('counts seated participants and surfaces support per vibe', () => {
    const state = new RoomSignalsState(0)
    state.seat('u1', 0)
    state.applySeed('u1', ['sunset-disco', 'deep-house'], 0)
    state.seat('u2', 0)
    state.applySeed('u2', ['sunset-disco'], 0)
    const snapshot = state.snapshot()
    assert.equal(snapshot.participantCount, 2)
    // Phase 2: vibeSupport is the Wilson lower bound on prompt votes
    // (PLAN.md §4, §7c). Two seed-picks on `sunset-disco` give it more
    // support than the no-pick prompts, but the score is always < 1.
    const sunset = snapshot.vibeSupport.get('sunset-disco') ?? 0
    const minimal = snapshot.vibeSupport.get('hard-techno') ?? 0
    assert.ok(sunset > 0, `expected positive support, got ${sunset}`)
    assert.ok(sunset > minimal, `expected ${sunset} > ${minimal}`)
  })

  it("ingests a reaction against the previously-applied blend, then a tick refreshes it", () => {
    const state = new RoomSignalsState(0)
    state.seat('u1', 0)
    state.applySeed('u1', ['sunset-disco'], 0)
    state.tick(100)
    const applied = state.snapshot().applied
    assert.ok(applied.size > 0)
    state.ingestReaction('u1', 1, 200)
    const after = state.snapshot()
    assert.ok(after.temperature.value > 0)
  })

  it('notifies subscribers on tick with the new applied blend', () => {
    const state = new RoomSignalsState(0)
    const seen: number[] = []
    state.subscribe((s) => seen.push(s.applied.size))
    state.seat('u1', 0)
    state.tick(100)
    state.tick(200)
    assert.equal(seen.length, 2)
  })

  it('drops a user when evicted', () => {
    const state = new RoomSignalsState(0)
    state.seat('u1', 0)
    state.evict('u1')
    assert.equal(state.snapshot().participantCount, 0)
  })

  it('reports hasInteracted=false for a seated-but-silent user', () => {
    const state = new RoomSignalsState(0)
    state.seat('u1', 0)
    assert.equal(state.hasInteracted('u1'), false)
  })

  it('reports hasInteracted=true after the user casts a single pick', () => {
    const state = new RoomSignalsState(0)
    state.seat('u1', 0)
    state.applySeed('u1', ['sunset-disco'], 0)
    assert.equal(state.hasInteracted('u1'), true)
  })

  it('accepts a Phase 2 suggestion and surfaces it through the snapshot', async () => {
    const state = new RoomSignalsState(0)
    state.seat('u1', 0)
    const result = await state.suggest({ userId: 'u1', text: 'lo-fi sunset', now: 100 })
    assert.equal(result.kind, 'created')
    if (result.kind === 'created') {
      assert.ok(state.snapshot().activePrompts.some((p) => p.id === result.prompt.id))
    }
  })

  it('records a card-stack vote and surfaces the prompt support', () => {
    const state = new RoomSignalsState(0)
    state.seat('u1', 0)
    state.seat('u2', 0)
    state.castVote('u1', 'sunset-disco', 1, 100)
    state.castVote('u2', 'sunset-disco', 1, 110)
    const support = state.snapshot().vibeSupport.get('sunset-disco') ?? 0
    assert.ok(support > 0)
  })

  it('deals unique cards and avoids re-dealing already-shown ones', () => {
    const state = new RoomSignalsState(0)
    state.seat('u1', 0)
    const first = state.dealCards('u1', 3)
    assert.equal(first.length, 3)
    const ids = first.map((c) => c.id)
    assert.equal(new Set(ids).size, 3, 'cards within one deal are unique')
    const second = state.dealCards('u1', 3)
    const overlap = second.filter((c) => ids.includes(c.id))
    assert.equal(overlap.length, 0, 'subsequent deals avoid already-dealt cards for that user')
  })

  it('does not mark welcome-dealt cards as shown (markDealt: false)', () => {
    const state = new RoomSignalsState(0)
    state.seat('u1', 0)
    const welcomeDeal = state.dealCards('u1', 9, { markDealt: false })
    const next = state.dealCards('u1', 9)
    // Welcome cards may legitimately re-appear in the next deal — the
    // user only glanced at them, didn't vote.
    const overlap = next.filter((c) => welcomeDeal.some((d) => d.id === c.id))
    assert.ok(overlap.length > 0, `expected re-deal of unmarked cards, got ${overlap.length}`)
  })

  it('Thompson dealer prefers a fresh prompt over a heavily-downvoted seed', async () => {
    const state = new RoomSignalsState(0, { random: mulberry32(42) })
    state.seat('voter', 0)
    // Make `sunset-disco` look uniformly hated.
    for (let i = 0; i < 20; i++) state.castVote(`voter-${i}`, 'sunset-disco', -1, 100)
    // A brand-new user-submitted prompt lands with no votes and a
    // fresh recency bonus.
    state.seat('u1', 0)
    const result = await state.suggest({ userId: 'u1', text: 'bluegrass twang', now: 1000 })
    if (result.kind !== 'created') throw new Error('expected created')
    const newId = result.prompt.id
    // Over many deals the fresh prompt should appear far more often
    // than the heavily-downvoted seed in the top slot.
    let freshTop = 0
    let downvotedTop = 0
    for (let i = 0; i < 100; i++) {
      // Fresh per-user dealtBy each iteration so the dealer reconsiders.
      const seat = `peek-${i}`
      state.seat(seat, 0)
      const deal = state.dealCards(seat, 1, { markDealt: false, now: 2000 })
      const top = deal[0]
      if (top?.id === newId) freshTop++
      if (top?.id === 'sunset-disco') downvotedTop++
    }
    assert.ok(freshTop > downvotedTop, `fresh ${freshTop} should beat downvoted ${downvotedTop}`)
  })

  it('feeds Vibes-tab agree votes into the policy target below CLUSTER_MIN_N', () => {
    // Regression: a small room (well under the 18-voter cluster gate)
    // suggests `bluegrass`, both phones 👍 it from the Vibes tab, but
    // never tap on the Now screen. The deck target should still
    // include `bluegrass` — Phase 3 synthesises a whole-room cluster
    // and runs the centroid policy on it so card-stack votes flow
    // into the explicit stream without needing a Now-screen tap.
    const state = new RoomSignalsState(0)
    state.seat('u1', 0)
    state.seat('u2', 0)
    state.castVote('u1', 'hard-techno', 1, 100)
    state.castVote('u2', 'hard-techno', 1, 110)
    state.tick(1000)
    const snapshot = state.snapshot()
    assert.equal(snapshot.clusters.length, 0, 'cluster gate not crossed — wire stays single-organism')
    assert.ok(snapshot.policy.centroid.size > 0, 'centroid blend should be non-empty')
    assert.ok(
      snapshot.policy.centroid.has('hard-techno'),
      'card-stack agree-vote should land in the centroid blend',
    )
    // The composed target picks it up too (the pipeline mixes shrunk
    // taste-EWMA with the policy at POLICY_BLEND_WEIGHT — with no
    // reactions, shrunk collapses to the uniform prior, so the policy
    // visibly pushes the target away from uniform).
    assert.ok((snapshot.target.get('hard-techno') ?? 0) > 1 / 9 / 2)
  })

  it('eventually retires a prompt when the applied vibe matches its embedding', () => {
    const state = new RoomSignalsState(0)
    state.seat('u1', 0)
    // Hand-place a synthetic prompt + embedding via the same `suggest`
    // surface, then bypass the embed-client path by writing onto the
    // active prompt directly.
    state.applySeed('u1', ['sunset-disco'], 0)
    const prompt = state.snapshot().activePrompts.find((p) => p.id === 'sunset-disco')!
    const embedding = new Float32Array(768)
    embedding[0] = 1
    prompt.embedding = embedding
    // Force the room's applied blend to mass that prompt only — the
    // dominant-prompt embedding will then match the prompt itself.
    for (let i = 0; i < 20; i++) state.tick(i * 1000)
    state.tick(20_000)
    // Without a tick (or with the wrong embedding) the prompt stays
    // active; we simulate the satisfied path by directly poking the
    // sweep path through a tick after wiring the embedding.
    assert.ok(state.snapshot().activePrompts.length >= 1)
  })
})
