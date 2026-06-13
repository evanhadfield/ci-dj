# M23 hardware checklist — beat loops, halve and double

Manual verification of the M23 exit criteria with the device and ears.
The measurable half is `verify_m23.mjs` (in `just verify-ui`): the
4-beat loop folding, the readout following halve→2 and double→4, the
clean release. This covers the FLX4 bytes no script can confirm
(ADR-0016) — the loop-section buttons were never mapped on hardware
before, so the monitor is the arbiter here.

## Setup

- [ ] FLX4 connected (green LED), a composed techno track loaded on
      deck B and playing, the beat view showing (any layout but Off) so
      the loop wash and its entry/exit caps are visible, red beat ticks
      on the close-up (a grid).

## Beat loop (the 4 BEAT button)

- [ ] The **4 BEAT/EXIT** button (note `0x4D`, measured) drops a loop on
      the spot: the region wash appears on the close-up (and shades on
      the overview), the readout says **4-beat loop**, and the seam is
      **seamless by ear** — no click, the kick stays in time across the
      wrap. (The on-screen **4 beats** button is the same action if you
      want to A/B it.)
- [ ] Pressing **4 BEAT/EXIT** again **releases** the loop — one button,
      set then exit (the toggle lives in dispatch, reusing EXIT). On this
      device "4 BEAT" and "EXIT" are the same byte `0x4D`.
- [ ] On the close-up, the **entry/exit caps** sit on beats and the
      wash spans exactly four — what you're looping on is unmistakable.

## Halve and double (CUE/LOOP CALL ◄ / ►)

- [ ] **CUE/LOOP CALL ◄** halves the active loop: the readout drops to
      **2-beat loop**, the region tightens on the beat, and the wrap
      stays in time. (Notes `0x51`/`0x53`, measured on the monitor.)
- [ ] **CUE/LOOP CALL ►** doubles it back to **4-beat loop**, and on to
      8 — the end moving on the beat, the IN holding.
- [ ] Halving so the loop's end falls **behind** the playhead re-fires
      the loop from its start (an audible re-trigger, not the silent
      native wrap — ADR-0016). Confirm it lands clean, not as a stutter.
- [ ] Halving to the floor refuses rather than buzzing; the readout
      shows fractions (**½-beat loop**, **¼-beat loop**) on the way down.

## Honest degrade and expected behaviours

- [ ] On an ambient (gridless) track: the **4 beats** control is
      **disabled** on screen and SHIFT + IN does nothing — a beat loop
      is grid-defined, inert rather than guessed (the M14 consumer
      rule). A free IN→OUT loop made by hand can still be halved and
      doubled (length-scaling needs no grid), but claims **no** beat
      count.
- [ ] **Any seek still exits the loop** (ADR-0015, unchanged): a
      hot-cue jump, an overview click, transport CUE, or a paused jog
      tick drops an active beat loop just as it drops a manual one.
- [ ] With SYNC engaged and a beat loop running, the phase meter stays
      steady — resizing must not break the beat clock.

When every box ticks, flip M23's status in [`ROADMAP.md`](ROADMAP.md)
to ✅ done and ADR-0016 to Accepted.
