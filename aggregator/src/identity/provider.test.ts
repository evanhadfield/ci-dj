/** DeviceIdentity round-trip: a freshly issued token verifies; a
 * tampered token, a wrong room, and a malformed token all reject. */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { DeviceIdentity } from './provider.js'

describe('DeviceIdentity', () => {
  it('verifies a token it just issued', () => {
    const identity = new DeviceIdentity()
    const { userId, sessionToken } = identity.issue({ roomCode: 'AB23' })
    assert.equal(identity.verify({ roomCode: 'AB23', sessionToken }), userId)
  })

  it('rejects the same token at a different room', () => {
    const identity = new DeviceIdentity()
    const { sessionToken } = identity.issue({ roomCode: 'AB23' })
    assert.equal(identity.verify({ roomCode: 'XY99', sessionToken }), null)
  })

  it('rejects a token with a tampered HMAC', () => {
    const identity = new DeviceIdentity()
    const { sessionToken } = identity.issue({ roomCode: 'AB23' })
    const tampered = sessionToken.slice(0, -1) + (sessionToken.endsWith('A') ? 'B' : 'A')
    assert.equal(identity.verify({ roomCode: 'AB23', sessionToken: tampered }), null)
  })

  it('rejects a malformed token', () => {
    const identity = new DeviceIdentity()
    assert.equal(identity.verify({ roomCode: 'AB23', sessionToken: 'gibberish' }), null)
    assert.equal(identity.verify({ roomCode: 'AB23', sessionToken: '' }), null)
  })
})
