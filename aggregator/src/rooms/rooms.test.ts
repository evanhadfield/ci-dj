/** Room store behaviour — codes are unambiguous, lookups are tolerant. */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH, RoomStore } from './rooms.js'

describe('RoomStore', () => {
  it('creates a 4-char code from the unambiguous alphabet', async () => {
    const store = new RoomStore()
    const { code, joinUrl, qrSvg } = await store.create('http://example.test')
    assert.equal(code.length, ROOM_CODE_LENGTH)
    for (const ch of code) {
      assert.ok(
        ROOM_CODE_ALPHABET.includes(ch),
        `unexpected char ${ch} in code ${code}`,
      )
    }
    assert.equal(joinUrl, `http://example.test/c/${code}`)
    assert.match(qrSvg, /<svg/)
  })

  it('looks up an existing room and normalises case', async () => {
    const store = new RoomStore()
    const { code } = await store.create('http://example.test')
    assert.ok(store.get(code))
    assert.ok(store.get(code.toLowerCase()))
  })

  it('rejects malformed codes (length, alphabet)', async () => {
    const store = new RoomStore()
    assert.equal(store.get(''), null)
    assert.equal(store.get('ABC'), null)
    assert.equal(store.get('ABCDE'), null)
    // 0/O/1/I are excluded — a code that contains one is impossible.
    assert.equal(store.get('A0B1'), null)
  })

  it('retires a room so its code 404s afterwards', async () => {
    const store = new RoomStore()
    const { code } = await store.create('http://example.test')
    store.retire(code)
    assert.equal(store.get(code), null)
  })
})
