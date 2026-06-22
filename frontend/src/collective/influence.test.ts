import { describe, expect, it, vi, afterEach } from 'vitest'

import { INITIAL_INFLUENCE, isInfluenceActive } from './influence'
import * as flag from './flag'

describe('collective influence', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('starts at zero amount, unlocked', () => {
    expect(INITIAL_INFLUENCE.amount).toBe(0)
    expect(INITIAL_INFLUENCE.locked).toBe(false)
  })

  it('is inert when the feature flag is off, even if amount is 1', () => {
    vi.spyOn(flag, 'isCollectiveEnabled').mockReturnValue(false)
    expect(isInfluenceActive({ amount: 1, locked: false })).toBe(false)
  })

  it('is inert when locked, regardless of amount', () => {
    vi.spyOn(flag, 'isCollectiveEnabled').mockReturnValue(true)
    expect(isInfluenceActive({ amount: 0.8, locked: true })).toBe(false)
  })

  it('is active only with flag on, unlocked, and amount > 0', () => {
    vi.spyOn(flag, 'isCollectiveEnabled').mockReturnValue(true)
    expect(isInfluenceActive({ amount: 0.5, locked: false })).toBe(true)
    expect(isInfluenceActive({ amount: 0, locked: false })).toBe(false)
  })
})
