// Plain JS on purpose: the kernel lives in public/ (the worklet imports
// it as a sibling module), outside the TypeScript project's include.

import { describe, expect, it } from 'vitest'

import {
  createCrusherState,
  crushBlock,
} from '../../public/crusher-kernel.js'

function stereo(samples) {
  return [Float32Array.from(samples), Float32Array.from(samples)]
}

function emptyLike(input) {
  return input.map((channel) => new Float32Array(channel.length))
}

describe('crushBlock', () => {
  it('passes audio through within one 16-bit step at the transparent settings', () => {
    const input = stereo([0.123456, -0.654321, 0.9])
    const output = emptyLike(input)
    crushBlock(input, output, 16, 1, createCrusherState())
    for (let channel = 0; channel < 2; channel++) {
      for (let i = 0; i < 3; i++) {
        expect(Math.abs(output[channel][i] - input[channel][i])).toBeLessThanOrEqual(
          1 / 32768,
        )
      }
    }
  })

  it('quantises to coarse levels at low bit depth', () => {
    const input = stereo([0.1, 0.4, 0.6, -0.9])
    const output = emptyLike(input)
    crushBlock(input, output, 2, 1, createCrusherState())
    // 2 bits → multiples of 1/2.
    expect(Array.from(output[0])).toEqual([0, 0.5, 0.5, -1])
  })

  it('holds each captured sample for `reduction` frames', () => {
    const input = stereo([0, 0.25, 0.5, 0.75, 1, 1, 1, 1])
    const output = emptyLike(input)
    crushBlock(input, output, 16, 4, createCrusherState())
    expect(output[0][0]).toBeCloseTo(0, 4)
    expect(output[0][3]).toBeCloseTo(0, 4) // still holding frame 0
    expect(output[0][4]).toBeCloseTo(1, 4) // recaptured at frame 4
    expect(output[0][7]).toBeCloseTo(1, 4)
  })

  it('carries the hold across blocks through the shared state', () => {
    const state = createCrusherState()
    const first = stereo([0.5, 0.5])
    const firstOut = emptyLike(first)
    crushBlock(first, firstOut, 16, 3, state)

    const second = stereo([-1, -1])
    const secondOut = emptyLike(second)
    crushBlock(second, secondOut, 16, 3, state)
    // Frame 3 of the stream is the first of the second block: still held.
    expect(secondOut[0][0]).toBeCloseTo(0.5, 4)
    expect(secondOut[0][1]).toBeCloseTo(-1, 4) // recapture at stream frame 3
  })

  it('mirrors a mono input onto both output channels', () => {
    const input = [Float32Array.from([0.5, -0.5])]
    const output = [new Float32Array(2), new Float32Array(2)]
    crushBlock(input, output, 16, 1, createCrusherState())
    expect(Array.from(output[0])).toEqual(Array.from(output[1]))
    expect(output[1][0]).toBeCloseTo(0.5, 4)
  })
})
