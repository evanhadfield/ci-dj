// Quantise-and-hold kernel for the bit-crusher worklet (M12): pure and
// free of audio-thread globals so the maths is unit-testable. `state`
// carries the hold counter and held samples across process() blocks.

export function createCrusherState() {
  return { counter: 0, held: [0, 0] };
}

export function crushBlock(input, output, bits, reduction, state) {
  const levels = Math.pow(2, bits - 1);
  const frames = output[0].length;
  for (let i = 0; i < frames; i++) {
    if (state.counter === 0) {
      for (let ch = 0; ch < output.length; ch++) {
        const sample = (input[ch] ?? input[0])[i];
        state.held[ch] = Math.round(sample * levels) / levels;
      }
    }
    state.counter = (state.counter + 1) % reduction;
    for (let ch = 0; ch < output.length; ch++) {
      output[ch][i] = state.held[ch];
    }
  }
}
