# DDJ-400 MIDI map — reference for the controller registry (issue #30)

The Pioneer DDJ-400 is the FLX4's predecessor and the second controller on the
driver registry (`frontend/src/control/registry.ts`). It is deliberately a
*near-identical* device: it shares the FLX4's Pioneer 2-deck byte scheme, so it
proves the registry abstraction while isolating registry bugs from byte-map
bugs. The driver (`control/ddj400.ts`) therefore **reuses the FLX4 translator
and LED scheme** — the only device-specific difference that matters for binding
is the position-sync SysEx.

Source: the [Mixxx DDJ-400 mapping](https://github.com/mixxxdj/mixxx/blob/main/res/controllers/Pioneer-DDJ-400-script.js)
and [`Pioneer-DDJ-400.midi.xml`](https://github.com/mixxxdj/mixxx/blob/main/res/controllers/Pioneer-DDJ-400.midi.xml),
cross-referenced against the FLX4 map ([`docs/midi-ddj-flx4.md`](midi-ddj-flx4.md)),
which was itself derived from the DDJ-400 family chart. The in-app MIDI monitor
remains the verification tool against the physical device/firmware
([`docs/ddj-400-hardware-checklist.md`](ddj-400-hardware-checklist.md)).

Conventions (identical to the FLX4): deck 1 on MIDI channel 0 (`0x90`/`0xB0`),
deck 2 on channel 1 (`0x91`/`0xB1`), mixer on channel 6 (`0xB6`), pads on
channels 7/9 (`0x97`/`0x99`, shift layer `0x98`/`0x9A`). Buttons are Note On,
velocity `0x7F` on press / `0x00` on release. Faders/knobs are 14-bit: MSB on
the listed CC, LSB on CC+`0x20`. Pads/buttons light by the Pioneer echo
(status/note back, velocity `0x7F` on / `0x00` off).

## Position sync — the one device-specific byte string

Knobs and faders are silent until moved. The DDJ-400 has **its own** position
query (the FLX4's is FLX4-specific):

```
F0 00 40 05 00 00 02 06 00 03 01 F7
```

Verbatim from the Mixxx DDJ-400 script's `init` (`midi.sendSysexMsg([...], 12)`;
doubles as the keep-alive). The link sends it on every device bind when SysEx is
granted; without the grant (or on a controller with no query) the sync is
skipped, not the connection.

## Confirmed shared with the FLX4 (from the Mixxx DDJ-400 script)

| Control | Message | → App intent |
| ------- | ------- | ------------ |
| PLAY/PAUSE deck 1 / 2 | `0x90`/`0x91` note `0x0B` | toggle play/stop |
| CUE (transport) deck 1 / 2 | `0x90`/`0x91` note `0x0C` | deck prep |
| Pads, deck 1 / 2 | `0x97`/`0x99` (shift `0x98`/`0x9A`) | pad banks (HOT CUE / PAD FX / SAMPLER), as the FLX4 |

The remaining controls — channel fader (`0x13`), crossfader (`0xB6` `0x1F`),
EQ hi/mid/low (`0x07`/`0x0B`/`0x0F`), tempo (`0x00`), headphone CUE (note
`0x54`), browse rotary/LOAD, jog wheels, and the loop section — follow the same
Pioneer CC/note numbers the FLX4 map documents and are driven by the shared
translator. They are **sourced from the Mixxx mapping, not yet measured on the
device** — the monitor is the arbiter (the checklist).

## Known gaps to confirm on hardware

- **LED feedback** uses the Pioneer echo (reused from the FLX4). If the DDJ-400
  lights any pad/button differently, capture it on the monitor and either add a
  DDJ-400-specific `ControllerLeds` to the driver or record the divergence here
  as a documented gap (issue #30 acceptance allows the latter).
- **Pad bank note bases** beyond HOT CUE/PAD FX/SAMPLER are interpolated from the
  Pioneer `0x10`-per-bank scheme; confirm before relying on them.
- Any control that does **not** match the FLX4 bytes belongs in a DDJ-400
  branch of the translator (a follow-up), not a silent assumption.
