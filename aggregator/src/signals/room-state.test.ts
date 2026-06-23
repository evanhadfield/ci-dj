/** Room signals lifecycle: seat → seed → react → tick. */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { RoomSignalsState } from './room-state.js'

describe('RoomSignalsState', () => {
  it('counts seated participants and surfaces support per vibe', () => {
    const state = new RoomSignalsState(0)
    state.seat('u1', 0)
    state.applySeed('u1', ['sunset-disco', 'deep-house'], 0)
    state.seat('u2', 0)
    state.applySeed('u2', ['sunset-disco'], 0)
    const snapshot = state.snapshot()
    assert.equal(snapshot.participantCount, 2)
    assert.ok((snapshot.vibeSupport.get('sunset-disco') ?? 0) >= 2)
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
})
