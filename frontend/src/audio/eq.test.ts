import { describe, expect, it } from 'vitest'

import { eqValueToDb } from './eq'

describe('eqValueToDb', () => {
  it('is flat at centre', () => {
    expect(eqValueToDb(0.5)).toBe(0)
  })

  it('boosts to +6dB at the top', () => {
    expect(eqValueToDb(1)).toBe(6)
    expect(eqValueToDb(0.75)).toBeCloseTo(3)
  })

  it('cuts to a -40dB kill at the bottom', () => {
    expect(eqValueToDb(0)).toBe(-40)
    expect(eqValueToDb(0.25)).toBeCloseTo(-20)
  })

  it('clamps out-of-range values', () => {
    expect(eqValueToDb(-1)).toBe(-40)
    expect(eqValueToDb(2)).toBe(6)
  })
})
