# M9–M11 hardware checklist — headphone cue on the DDJ-FLX4

Manual verification of the M9 and M10 exit criteria. Audio routing and
hardware can't be e2e-heard (ADR-0005/0006): the graph math, mapping
table, and wiring are unit-tested; this covers real devices, real ears.

## Setup

- [ ] DDJ-FLX4 over USB; app open in Chromium; **Connect MIDI** green
      (see [`m7-hardware-checklist.md`](m7-hardware-checklist.md)).
- [ ] Speakers on the **system default output** (e.g. set the FLX4 as
      default so its MASTER RCA feeds them — the rekordbox-style setup).
- [ ] Headphones on a **second device**: the Mac's 3.5mm jack, Bluetooth,
      or the built-in speakers as a stand-in. Heads-up if you pick the
      FLX4 itself: Chromium only reaches its first stereo pair, so by
      default the cue surfaces on the MASTER RCA — not the phones jack —
      unless you remap the device's stereo channels to 3/4 in Audio MIDI
      Setup (Configure Speakers…), which is what makes the jack usable
      (ADR-0006).
- [ ] Both decks with 2+ style targets; deck A playing on the master.

## M9 — split cue from the UI

- [ ] In the mixer's **Phones** group, click **Find devices** → the
      one-off microphone permission prompt appears → the device list
      fills in. Pick the headphone device.
- [ ] Toggle channel B's **CUE** (button lights): deck B is audible in
      the headphones while the room keeps hearing only deck A.
- [ ] **Cue mix** knob: full left = cue only, full right = master only,
      centre = both — in the phones; the room feed never changes.
- [ ] Channel B's fader stays down throughout: the cue is pre-fader.
- [ ] Recording while cueing: the WAV contains the master only.
- [ ] Reload: cue mix and device come back; CUE toggles come back **off**
      (deliberate — a reload never blasts the phones).

## M10 — the same workflow from the FLX4

- [ ] Channel CUE button (under the channel fader area) toggles that
      deck's PFL; the button's LED and the on-screen button track it.
      Monitor shows `90 54 7F` / `91 54 7F`.
- [ ] HEADPHONES MIX knob rides the on-screen cue-mix knob smoothly
      (monitor: `B6 0C ..` + `B6 2C ..` pairs).
- [ ] Transport CUE on a **stopped** deck B: status shows
      "Primed — off air", the CUE LED lights, the buffer fills, the room
      hears nothing — but with channel B's PFL on, the phones hear it.
      Monitor: `90 0C 7F` / `91 0C 7F`.
- [ ] PLAY on the primed deck: it drops on air instantly with the audio
      that was auditioned (no flush, no restart); the CUE LED goes dark.
- [ ] Transport CUE on a **rolling** deck stops it immediately (flush).
- [ ] Hands-off cue pass: prime B with CUE, audition it via channel CUE
      + MIX knob, drop it with PLAY, swing the crossfader to B, stop A —
      mouse untouched, LEDs truthful throughout.

## M11 — the FLX4's own phones jack (backend cue sink)

Restart the backend first (`just run`) — the cue sink is new server
code. System default output = FLX4 (master on the RCA), headphones in
the **FLX4's jack**.

- [ ] **Find devices** again: the list now ends with
      "DDJ-FLX4 — phones jack". Pick it.
- [ ] With deck A on air and channel B cued: deck B in the FLX4's
      phones, the room (RCA) hears only deck A — one USB cable, no
      second audio device.
- [ ] Cue mix knob behaves exactly as on the browser-sink path.
- [ ] The latency of the jack feed is a beat-ish behind the room —
      expected (network + PortAudio hop, ADR-0007) and irrelevant for
      auditioning texture.
- [ ] Reload: the jack choice comes back and streams again after the
      first gesture (play/connect).
- [ ] Switch back to a Bluetooth/browser device: seamless, no backend
      restart needed.

When every box ticks, flip M9, M10, and M11 in [`ROADMAP.md`](ROADMAP.md)
to ✅ done.
