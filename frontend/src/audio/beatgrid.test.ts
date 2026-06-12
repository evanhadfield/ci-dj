import { describe, expect, it } from 'vitest'

import { trackBeatgrid } from './beatgrid'
import { clickTrack, noiseSource } from '../test/clickTrack'

const SAMPLE_RATE = 48_000

function deinterleave(samples: Float32Array): [Float32Array, Float32Array] {
  const frames = samples.length / 2
  const left = new Float32Array(frames)
  const right = new Float32Array(frames)
  for (let i = 0; i < frames; i++) {
    left[i] = samples[2 * i]
    right[i] = samples[2 * i + 1]
  }
  return [left, right]
}

/** Prepend stereo silence so the first beat lands at a known offset. */
function withLeadIn(
  samples: Float32Array,
  seconds: number,
): [Float32Array, Float32Array] {
  const [left, right] = deinterleave(samples)
  const lead = Math.round(seconds * SAMPLE_RATE)
  const paddedLeft = new Float32Array(lead + left.length)
  const paddedRight = new Float32Array(lead + right.length)
  paddedLeft.set(left, lead)
  paddedRight.set(right, lead)
  return [paddedLeft, paddedRight]
}

describe('trackBeatgrid', () => {
  it('finds the tempo and phase of a steady click track', () => {
    const [left, right] = deinterleave(clickTrack(128, 30, SAMPLE_RATE))
    const grid = trackBeatgrid(left, right, SAMPLE_RATE)
    expect(grid).not.toBeNull()
    // Refined well past the estimator's ±2% — under half a percent.
    expect(Math.abs(grid!.bpm - 128)).toBeLessThanOrEqual(128 * 0.005)
    // Beat 0 is at t=0; the grid may report it anywhere on the lattice.
    const period = 60 / grid!.bpm
    const phase = (grid!.firstBeatSeconds / period) % 1
    expect(Math.min(phase, 1 - phase)).toBeLessThanOrEqual(0.06)
  })

  it('places the first beat at a lead-in offset', () => {
    const [left, right] = withLeadIn(clickTrack(120, 30, SAMPLE_RATE), 0.25)
    const grid = trackBeatgrid(left, right, SAMPLE_RATE)
    expect(grid).not.toBeNull()
    const period = 60 / grid!.bpm
    // 0.25s into a 0.5s period = half a period off the lattice.
    const expected = (0.25 % period) / period
    const phase = (grid!.firstBeatSeconds / period) % 1
    expect(circularGap(phase, expected)).toBeLessThanOrEqual(0.06)
  })

  it('refines a tempo that sits off the estimator lag grid', () => {
    const [left, right] = deinterleave(clickTrack(127.3, 40, SAMPLE_RATE))
    const grid = trackBeatgrid(left, right, SAMPLE_RATE)
    expect(grid).not.toBeNull()
    expect(Math.abs(grid!.bpm - 127.3)).toBeLessThanOrEqual(127.3 * 0.005)
  })

  it('refuses beatless material', () => {
    const noise = noiseSource(7)
    const frames = SAMPLE_RATE * 20
    const left = new Float32Array(frames)
    const right = new Float32Array(frames)
    for (let i = 0; i < frames; i++) {
      left[i] = noise() * 0.3
      right[i] = noise() * 0.3
    }
    expect(trackBeatgrid(left, right, SAMPLE_RATE)).toBeNull()
  })

  it('refuses a track whose tempo drifts — no grid beats a wrong grid', () => {
    // Two steady halves at different tempi: each folds tightly on its
    // own, but they cannot share one constant grid.
    const firstHalf = clickTrack(120, 20, SAMPLE_RATE)
    const secondHalf = clickTrack(126, 20, SAMPLE_RATE, 2)
    const joined = new Float32Array(firstHalf.length + secondHalf.length)
    joined.set(firstHalf)
    joined.set(secondHalf, firstHalf.length)
    const [left, right] = deinterleave(joined)
    expect(trackBeatgrid(left, right, SAMPLE_RATE)).toBeNull()
  })
})

function circularGap(a: number, b: number): number {
  const diff = Math.abs(a - b) % 1
  return Math.min(diff, 1 - diff)
}
