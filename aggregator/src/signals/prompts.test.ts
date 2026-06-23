/** VibePromptPool: seed, suggest, semantic dedupe, decay, satisfied-retire. */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  VibePromptPool,
  DEDUPE_COSINE_THRESHOLD,
  SATISFIED_COSINE_THRESHOLD,
  SUGGEST_MAX_LENGTH,
  SUGGEST_PER_USER_PER_WINDOW,
  SUGGEST_WINDOW_MS,
} from './prompts.js'
import { EMBED_DIM } from './embed.js'
import { SEED_VIBES } from './vibes.js'

function unitVector(seed: number): Float32Array {
  // Cheap deterministic PRNG (Mulberry32) — gives genuinely orthogonal
  // vectors across different seeds, unlike a plain `Math.sin(seed + i)`
  // pattern which stays nearly constant across `i` for small steps.
  let state = (seed * 0x9e3779b9) >>> 0
  const v = new Float32Array(EMBED_DIM)
  for (let i = 0; i < EMBED_DIM; i++) {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    v[i] = (((t ^ (t >>> 14)) >>> 0) / 0x1_0000_0000) * 2 - 1
  }
  let mag = 0
  for (let i = 0; i < EMBED_DIM; i++) mag += v[i]! * v[i]!
  mag = Math.sqrt(mag)
  for (let i = 0; i < EMBED_DIM; i++) v[i] = v[i]! / mag
  return v
}

describe('VibePromptPool', () => {
  it('loads the seed catalog on construction', () => {
    const pool = new VibePromptPool(0)
    const all = pool.all()
    assert.equal(all.length, SEED_VIBES.length)
    for (const seed of SEED_VIBES) {
      const prompt = pool.get(seed.id)
      assert.ok(prompt)
      assert.equal(prompt!.text, seed.text)
      assert.equal(prompt!.satisfied, false)
      assert.equal(prompt!.approved, true)
    }
  })

  it('adds a new prompt when nothing is similar', async () => {
    const pool = new VibePromptPool(0)
    const result = await pool.suggest({
      userId: 'u1',
      text: 'wonky bass · tape saturation',
      now: 100,
    })
    assert.equal(result.kind, 'created')
    assert.equal(pool.all().length, SEED_VIBES.length + 1)
  })

  it('semantic-dedupes a suggestion against an existing embedded prompt', async () => {
    const pool = new VibePromptPool(0)
    const seedEmbedding = unitVector(1)
    const seedId = SEED_VIBES[0]!.id
    // Wire an embedding onto a seed prompt so the dedupe path can match.
    const seed = pool.get(seedId)!
    seed.embedding = seedEmbedding
    const result = await pool.suggest({
      userId: 'u1',
      text: 'something slightly off the seed',
      embed: async () => seedEmbedding,
      now: 100,
    })
    assert.equal(result.kind, 'deduped')
    if (result.kind === 'deduped') assert.equal(result.prompt.id, seedId)
  })

  it('does not dedupe when the cosine is below the threshold', async () => {
    const pool = new VibePromptPool(0)
    const seed = pool.get(SEED_VIBES[0]!.id)!
    seed.embedding = unitVector(1)
    const result = await pool.suggest({
      userId: 'u1',
      text: 'totally unrelated vibe',
      embed: async () => unitVector(7),
      now: 100,
    })
    assert.equal(result.kind, 'created')
  })

  it('exact-text-dedupes without embedding round-trip', async () => {
    const pool = new VibePromptPool(0)
    const seed = SEED_VIBES[0]!
    const result = await pool.suggest({
      userId: 'u1',
      text: seed.text,
      embed: async () => {
        throw new Error('should not call embed for exact-text match')
      },
      now: 100,
    })
    assert.equal(result.kind, 'deduped')
    if (result.kind === 'deduped') assert.equal(result.prompt.id, seed.id)
  })

  it('rejects empty or too-long suggestions', async () => {
    const pool = new VibePromptPool(0)
    const empty = await pool.suggest({ userId: 'u1', text: '', now: 100 })
    assert.equal(empty.kind, 'invalid')
    const longText = 'x'.repeat(SUGGEST_MAX_LENGTH + 1)
    const tooLong = await pool.suggest({ userId: 'u1', text: longText, now: 100 })
    assert.equal(tooLong.kind, 'invalid')
  })

  it('rate-limits per user within the window', async () => {
    const pool = new VibePromptPool(0)
    let now = 100
    for (let i = 0; i < SUGGEST_PER_USER_PER_WINDOW; i++) {
      const result = await pool.suggest({ userId: 'u1', text: `unique vibe ${i}`, now })
      assert.notEqual(result.kind, 'rate-limited')
      now += 100
    }
    const blocked = await pool.suggest({ userId: 'u1', text: 'one more vibe', now })
    assert.equal(blocked.kind, 'rate-limited')
    const later = await pool.suggest({
      userId: 'u1',
      text: 'after the window',
      now: now + SUGGEST_WINDOW_MS + 1,
    })
    assert.notEqual(later.kind, 'rate-limited')
  })

  it('decays support and retires satisfied prompts on sweep', () => {
    const pool = new VibePromptPool(0)
    const seed = pool.get(SEED_VIBES[0]!.id)!
    seed.embedding = unitVector(1)
    seed.support = 1
    seed.lastVoteTs = 0
    // Half-life decay: after one half-life, support should halve.
    const HALFLIFE = 20 * 60_000
    pool.sweep({ now: HALFLIFE })
    assert.ok(Math.abs(seed.support - 0.5) < 0.01)
    // An applied embedding within ε flips satisfied=true.
    const result = pool.sweep({ appliedEmbedding: unitVector(1), now: HALFLIFE + 1 })
    assert.deepEqual(result.retired, [seed.id])
    assert.equal(seed.satisfied, true)
    assert.equal(
      pool.active().some((p) => p.id === seed.id),
      false,
      'retired prompts are not active',
    )
  })

  it('keeps a prompt active while embedded but dissimilar from the applied vibe', () => {
    const pool = new VibePromptPool(0)
    const seed = pool.get(SEED_VIBES[0]!.id)!
    seed.embedding = unitVector(1)
    seed.support = 1
    pool.sweep({ appliedEmbedding: unitVector(99), now: 1000 })
    assert.equal(seed.satisfied, false)
    assert.ok(pool.active().some((p) => p.id === seed.id))
  })

  it('exposes constants the wire format consumers depend on', () => {
    assert.ok(DEDUPE_COSINE_THRESHOLD > SATISFIED_COSINE_THRESHOLD)
  })
})
