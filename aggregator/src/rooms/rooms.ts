/** Room creation + lookup (Phase 0; docs/collective/PLAN.md §7a).
 *
 * Rooms are ephemeral — in-memory, retired when the set closes (§9
 * v1 fail-safe note). The 4-char code uses an alphabet without 0/O/1/I
 * so a venue's hand-typed fallback path stays unambiguous in the dark. */

import { randomInt } from 'node:crypto'
import QRCode from 'qrcode'

/** Unambiguous in a dark venue: 0/O/1/I excluded (§7a step 3). */
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
export const ROOM_CODE_LENGTH = 4

export type Room = {
  code: string
  createdAt: number
  /** Active connections — Phase 0 tracks no per-user state, just the
   * count, so a host screen can show "5 phones connected". */
  participantCount: number
}

export type CreateRoomResult = {
  code: string
  joinUrl: string
  /** Inline SVG so the host screen can render the code without a
   * client-side QR dep — keeps host-screen a true static SPA (§7a). */
  qrSvg: string
}

export class RoomStore {
  private readonly rooms = new Map<string, Room>()

  /** Generate a fresh, unused room code. The retry loop is cheap at our
   * alphabet size — 32^4 ≈ 10^6 codes, collisions only matter at scale. */
  private newCode(): string {
    for (let attempt = 0; attempt < 10; attempt++) {
      let code = ''
      for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
        code += ROOM_CODE_ALPHABET[randomInt(0, ROOM_CODE_ALPHABET.length)]
      }
      if (!this.rooms.has(code)) return code
    }
    throw new Error('room code space exhausted (impossible at production scale)')
  }

  async create(joinBaseUrl: string): Promise<CreateRoomResult> {
    const code = this.newCode()
    const joinUrl = `${joinBaseUrl.replace(/\/$/, '')}/c/${code}`
    this.rooms.set(code, { code, createdAt: Date.now(), participantCount: 0 })
    const qrSvg = await QRCode.toString(joinUrl, { type: 'svg', margin: 1 })
    return { code, joinUrl, qrSvg }
  }

  /** Return the room or `null`. Codes are normalised (uppercase, alphabet
   * filter) so the fallback typed-code path tolerates user noise. */
  get(rawCode: string): Room | null {
    const code = rawCode.toUpperCase()
    if (code.length !== ROOM_CODE_LENGTH) return null
    for (const ch of code) {
      if (!ROOM_CODE_ALPHABET.includes(ch)) return null
    }
    return this.rooms.get(code) ?? null
  }

  retire(code: string): void {
    this.rooms.delete(code)
  }

  incrementParticipants(code: string, delta: number): void {
    const room = this.rooms.get(code)
    if (!room) return
    room.participantCount = Math.max(0, room.participantCount + delta)
  }
}
