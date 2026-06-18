import { describe, expect, it } from 'vitest'

import { ddj400Driver, DDJ400_STATUS_QUERY } from './ddj400'
import { FLX4_STATUS_QUERY } from './flx4'

const PRESS = 0x7f

/** The DDJ-400 shares the FLX4's Pioneer byte scheme, so these assert the
 * representative controls the issue calls out (transport, faders/EQ/
 * crossfader, pads, jog/loops, cue) translate to the same intents — proving
 * the driver is wired up — plus the one thing that genuinely differs: its own
 * position-sync SysEx. Exhaustive byte coverage lives in flx4.test.ts. */
describe('ddj400Driver', () => {
  it('binds on the DDJ-400 name and carries its own position-sync SysEx', () => {
    expect(ddj400Driver.nameFragment).toBe('DDJ-400')
    expect(ddj400Driver.initSysex).toEqual(DDJ400_STATUS_QUERY)
    // The query is the DDJ-400's, not the FLX4's — the per-driver SysEx is
    // exactly what binding the right controller depends on.
    expect(ddj400Driver.initSysex).not.toEqual(FLX4_STATUS_QUERY)
  })

  it.each([
    [0x90, 'a'],
    [0x91, 'b'],
  ] as const)('PLAY/PAUSE on %s toggles deck %s', (status, deck) => {
    const translate = ddj400Driver.createTranslator()
    expect(translate([status, 0x0b, PRESS])).toEqual({
      kind: 'play_toggle',
      deck,
    })
  })

  it('translates the mixer, EQ, transport, pads, jog, and loops', () => {
    const translate = ddj400Driver.createTranslator()
    // Channel fader (14-bit MSB) → deck volume.
    expect(translate([0xb0, 0x13, 0x40])).toMatchObject({
      kind: 'volume',
      deck: 'a',
    })
    // EQ high band.
    expect(translate([0xb1, 0x07, 0x40])).toMatchObject({
      kind: 'eq',
      deck: 'b',
      band: 'high',
    })
    // Crossfader on the mixer channel.
    expect(translate([0xb6, 0x1f, 0x40])).toMatchObject({ kind: 'crossfade' })
    // Headphone CUE.
    expect(translate([0x90, 0x54, PRESS])).toEqual({
      kind: 'cue_toggle',
      deck: 'a',
    })
    // HOT CUE pad.
    expect(translate([0x97, 0x00, PRESS])).toEqual({
      kind: 'hot_cue_pad',
      deck: 'a',
      index: 0,
    })
    // Jog tick (relative, +1 CW).
    expect(translate([0xb0, 0x21, 0x41])).toEqual({
      kind: 'track_seek',
      deck: 'a',
      steps: 1,
      shifted: false,
    })
    // LOOP IN.
    expect(translate([0x90, 0x10, PRESS])).toEqual({
      kind: 'track_loop_in',
      deck: 'a',
    })
  })

  it('lights LEDs with the Pioneer echo', () => {
    // Channel CUE on deck 1: status/note echoed back, velocity on.
    expect(ddj400Driver.leds.channelCue('a', true)).toEqual([[0x90, 0x54, 0x7f]])
    // Pads 1–2 of a deck's style targets lit, the rest dark.
    const pads = ddj400Driver.leds.styleTargetPads('a', 2)
    expect(pads[0]).toEqual([0x97, 0, 0x7f])
    expect(pads[1]).toEqual([0x97, 1, 0x7f])
    expect(pads.slice(2).every((message) => message[2] === 0x00)).toBe(true)
  })
})
