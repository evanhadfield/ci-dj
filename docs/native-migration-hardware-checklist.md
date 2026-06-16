# Native migration — hardware & integration checklist

Behaviour the automated suite (cargo / vitest / pytest) cannot reach: the live
Tauri webview, real audio devices, the FLX4, the model sidecars, and packaging.
Per [`CLAUDE.md`](../CLAUDE.md), a human ticks these before the work is "done".

Run the native stack with `just tauri-dev-native` (Tauri app + sidecars; needs
`just setup` for backend deps + model weights).

## Part 2 — MIDI (`tauri-plugin-midi`)

- [ ] FLX4 plugged in: the app sees it within ~1 s (the plugin's 1 s poll).
- [ ] Moving a knob/fader sends CC that reaches the mixer (input path).
- [ ] On connect the position-query SysEx fires and the controls sync.
- [ ] Pad LEDs light (output path) — feedback from the app reaches the hardware.
- [ ] Unplug + replug mid-set recovers without a permission prompt.

## Part 3 — UI ↔ engine over IPC

- [ ] Channel meters, master meter, and limiter-GR readout move with audio.
- [ ] EQ kills, volume, crossfade, and the six Color FX audibly match the Web
      Audio build (the parity oracle: same gestures, `just dev-frontend`).
- [ ] Trim (gain staging) and the on-air gate behave: off-air mutes the master
      feed but the channel meter stays live.
- [ ] Selecting / clearing an effect (FX-none) engages / removes it.
- [ ] Load a track: waveform overview renders, transport (play/pause/seek), the
      varispeed tempo, and a track loop work; the playhead is exact.
- [ ] Freeze pads, generated pads (one-shots + loops), and style-sample capture.
- [ ] Known gaps (documented stubs, not bugs): synced dub echo (`setBeatPeriod`),
      jog-wheel phase nudge, master recording — all show their stub behaviour
      (recording surfaces a handled error).

## Part 4 — Inference sidecars

- [ ] `SLIPMATE_SIDECARS=1`: each deck spawns `python -m slipmate.sidecar`; the
      Rust log shows the loopback port and the sidecar connecting.
- [ ] Audio generates: PCM streams sidecar → engine → speakers, no underruns
      (watch `engine_snapshot` deck-ring fill / underruns).
- [ ] Deck control reaches the worker: play/stop, set-prompt, set-style change
      the output within a few seconds.
- [ ] `sidecar://status` events surface in the webview (ready / chunk / errors).
- [ ] Killing a sidecar process emits `worker_died`; the deck goes silent without
      crashing the app. (In-process auto-restart / model-switch is a follow-up.)
- [ ] Quitting the app cleanly kills the sidecar processes (no orphans).

## Part 5 — Native cue routing

The engine derives a headphone-cue feed (PFL bus blended with master per the cue
mix) and the device routes it to channels 3/4 on a ≥4-channel output (the FLX4).
Replaces the second-sink cue (ADR-0006) and the backend `sounddevice` sink
(ADR-0007). (`sounddevice` + `cue.py` + `/ws/cue` are retired at cutover, part 7,
with the browser path that still depends on them.)

- [ ] FLX4 selected as the output: master plays on the main out (channels 1/2)
      and the cue plays on the phones jack (channels 3/4).
- [ ] Cue a deck (PFL): it is audible in the phones even when crossfaded fully
      out of the master.
- [ ] The cue-mix knob blends cue ↔ master in the phones (0 = cue, 1 = master).
- [ ] On a plain stereo output device the master is unaffected and the cue is
      simply absent (no crash, no glitch).
- [ ] Booth output (a third pair mirroring the master) — follow-up, not yet
      wired.
