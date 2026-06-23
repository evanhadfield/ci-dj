/** Embed client + cosine similarity smoke tests. */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { HttpEmbedClient, cosineSimilarity, EMBED_DIM } from './embed.js'

describe('cosineSimilarity', () => {
  it('returns 1 for identical vectors', () => {
    const a = new Float32Array([1, 2, 3])
    const b = new Float32Array([1, 2, 3])
    assert.ok(Math.abs(cosineSimilarity(a, b) - 1) < 1e-6)
  })

  it('returns 0 for orthogonal vectors', () => {
    const a = new Float32Array([1, 0])
    const b = new Float32Array([0, 1])
    assert.ok(Math.abs(cosineSimilarity(a, b)) < 1e-6)
  })

  it('returns 0 when either vector has zero magnitude', () => {
    const a = new Float32Array([0, 0, 0])
    const b = new Float32Array([1, 2, 3])
    assert.equal(cosineSimilarity(a, b), 0)
  })

  it('returns 0 for mismatched lengths', () => {
    const a = new Float32Array([1, 2])
    const b = new Float32Array([1, 2, 3])
    assert.equal(cosineSimilarity(a, b), 0)
  })
})

describe('HttpEmbedClient', () => {
  it('returns a Float32Array on a well-formed response', async () => {
    const vector = Array.from({ length: EMBED_DIM }, (_, i) => i * 0.001)
    const fakeFetch: typeof fetch = async () =>
      new Response(JSON.stringify({ vector, dim: EMBED_DIM }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    const client = new HttpEmbedClient({ fetchImpl: fakeFetch })
    const result = await client.embedText('warm disco funk')
    assert.ok(result)
    assert.equal(result!.length, EMBED_DIM)
    assert.ok(Math.abs(result![10]! - 0.01) < 1e-5)
  })

  it('returns null when the backend responds non-2xx (collective off)', async () => {
    const fakeFetch: typeof fetch = async () =>
      new Response(JSON.stringify({ detail: 'collective layer is off' }), { status: 503 })
    const client = new HttpEmbedClient({ fetchImpl: fakeFetch })
    const result = await client.embedText('warm disco funk')
    assert.equal(result, null)
  })

  it('returns null when fetch throws (backend unreachable)', async () => {
    const fakeFetch: typeof fetch = async () => {
      throw new Error('ECONNREFUSED')
    }
    const client = new HttpEmbedClient({ fetchImpl: fakeFetch })
    const result = await client.embedText('warm disco funk')
    assert.equal(result, null)
  })

  it('returns null on a wrong-shaped payload (defensive)', async () => {
    const fakeFetch: typeof fetch = async () =>
      new Response(JSON.stringify({ vector: [1, 2, 3], dim: 3 }), { status: 200 })
    const client = new HttpEmbedClient({ fetchImpl: fakeFetch })
    const result = await client.embedText('warm disco funk')
    assert.equal(result, null)
  })
})
