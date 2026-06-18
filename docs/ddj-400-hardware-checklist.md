# DDJ-400 hardware checklist — controller registry (issue #30)

Manual verification of the DDJ-400 as the second controller on the driver
registry. Hardware cannot be e2e-automated (ADR-0005): the registry, the driver,
and the ControlBus wiring are unit-tested; this checklist covers the last hop —
real DDJ-400 firmware bytes through a real browser permission into real audio —
and confirms the byte map the driver assumes by reusing the FLX4 translator
([`midi-ddj-400.md`](midi-ddj-400.md)).

## Setup

- [ ] Pioneer DDJ-400 connected over USB and powered on.
- [ ] `just tauri-dev`, app open (Web MIDI runs through the native shell's
      tauri-plugin-midi shim).
- [ ] Both decks connected with a model loaded; give each deck two or more
      style targets — the pads and CFX knob act on targets.

## Connect + firmware verification (the byte map the driver assumes)

- [ ] Click **Connect MIDI** → allow MIDI → the LED turns green and the device
      name (`DDJ-400…`) appears. (Binding proves `nameFragment: 'DDJ-400'`.)
- [ ] Move any knob: raw hex ticks through the statusbar monitor, and the knob's
      current position syncs on connect (proves the DDJ-400 position-sync SysEx
      `F0 00 40 05 00 00 02 06 00 03 01 F7`).
- [ ] Spot-check the bytes against [`midi-ddj-400.md`](midi-ddj-400.md) — the
      monitor is the arbiter, charts drift:
  - PLAY/PAUSE deck 1 → `90 0B 7F` (release `90 0B 00`); deck 2 → `91 0B …`
  - Channel fader 1 → `B0 13 ..` + `B0 33 ..` (MSB+LSB)
  - Crossfader → `B6 1F ..` + `B6 3F ..`
  - EQ HI/MID/LOW deck 1 → `B0 07/0B/0F ..`
  - Pad 1, HOT CUE, deck 1 → `97 00 7F`; deck 2 pads → `99 ..`
  - Headphone CUE deck 1 → `90 54 7F`

  **If any byte differs from the FLX4 scheme, stop:** record the actual bytes in
  `midi-ddj-400.md` and add a DDJ-400 branch to the translator (`control/ddj400.ts`)
  — the driver must follow the device, never assume.

## Transport / mixer / pads (same intents as the FLX4)

- [ ] PLAY/PAUSE on hardware deck 1/2 starts/stops decks A/B.
- [ ] Channel faders, EQ HI/MID/LOW, and the crossfader ride their controls
      smoothly (14-bit — no stepping); on-screen controls follow live.
- [ ] HOT CUE pads snap the style cursor (realtime) / set+jump hot cues
      (playback); SAMPLER pads drive freeze loops; PAD FX pads select Color FX.
- [ ] Jog wheels seek/nudge a playback deck; LOOP IN/OUT and 4 BEAT/EXIT behave
      as on the FLX4.
- [ ] Headphone CUE toggles channel PFL; the HEADPHONES MIX knob blends cue↔master.

## LED feedback

- [ ] Pad LEDs light for style targets / filled loop slots / the active Color FX
      / filled hot cues, and the channel + transport CUE buttons light, exactly
      as on the FLX4 (the Pioneer echo).
- [ ] **If any LED behaves differently**, capture it on the monitor and either
      give the DDJ-400 its own `ControllerLeds`, or record it as a documented gap
      in `midi-ddj-400.md` (acceptance allows the documented-gap route).

## Two controllers at once (the registry's selection behaviour)

- [ ] With the DDJ-400 alone connected, no controller picker shows; the status
      reads `DDJ-400…`.
- [ ] With both a DDJ-FLX4 and a DDJ-400 connected, the picker appears; the
      first-by-registry-order (FLX4) binds by default; choosing the DDJ-400 in
      the picker re-binds onto it (status name follows) and a knob move on the
      DDJ-400 now drives the app.

## Hot-plug

- [ ] Unplug: status flips to "No supported controller found" (or to the other
      connected controller, if one remains).
- [ ] Replug: it reconnects by itself (no Connect click); pad LEDs restored.

When every box ticks, the DDJ-400 is a verified second controller and the
registry's first-match/selection behaviour is confirmed on real hardware.
