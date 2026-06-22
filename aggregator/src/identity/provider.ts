/** IdentityProvider — issue and verify opaque user ids
 * (Phase 0 seam; docs/collective/PLAN.md §8).
 *
 * Aggregation only ever sees `userId` — never the cookie, fingerprint,
 * portal MAC, or NFC tag underneath. The provider is pluggable so the
 * anti-sybil floor can rise (DeviceIdentity → CaptivePortalIdentity →
 * rotating QR / wristband) without churning the pipeline. */

import { randomBytes, createHmac } from 'node:crypto'

export type IssuedIdentity = {
  /** Opaque per-room user id, all the aggregator ever sees. */
  userId: string
  /** Token the device echoes back on every request, so a reconnect
   * resumes the same `userId` and taste profile for the session. */
  sessionToken: string
}

export type IdentityProvider = {
  /** Issue a fresh identity for a phone joining `roomCode`. */
  issue: (input: { roomCode: string; fingerprint?: string }) => IssuedIdentity
  /** Verify an echoed token and return its `userId`, or `null` when
   * the token is missing, malformed, or tied to a different room. */
  verify: (input: { roomCode: string; sessionToken: string }) => string | null
}

/** v1: a signed session token plus a light fingerprint (§8).
 *
 * Token format: `<userId>.<roomCode>.<hmac>`, where the HMAC is a
 * truncated SHA-256 of `<userId>.<roomCode>` keyed by `secret`. The
 * `userId` itself is random — the token does NOT encode the fingerprint,
 * so even a leaked token can't be correlated back to a device beyond
 * the room it was issued in.
 *
 * Adequate for good-faith crowds (§8 v1 note). The captive-portal
 * version (v2) and rotating QR / NFC wristband (deferred) replace this
 * by implementing the same `IdentityProvider` interface. */
export class DeviceIdentity implements IdentityProvider {
  constructor(private readonly secret: Buffer = randomBytes(32)) {}

  issue({ roomCode }: { roomCode: string; fingerprint?: string }): IssuedIdentity {
    const userId = randomBytes(12).toString('base64url')
    const sessionToken = `${userId}.${roomCode}.${this.sign(userId, roomCode)}`
    return { userId, sessionToken }
  }

  verify({
    roomCode,
    sessionToken,
  }: {
    roomCode: string
    sessionToken: string
  }): string | null {
    const parts = sessionToken.split('.')
    if (parts.length !== 3) return null
    const [userId, tokenRoom, mac] = parts
    if (!userId || !tokenRoom || !mac) return null
    if (tokenRoom !== roomCode) return null
    const expected = this.sign(userId, roomCode)
    if (!timingSafeEqual(mac, expected)) return null
    return userId
  }

  private sign(userId: string, roomCode: string): string {
    return createHmac('sha256', this.secret)
      .update(`${userId}.${roomCode}`)
      .digest('base64url')
      .slice(0, 22)
  }
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}
