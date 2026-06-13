# 0016. Beat loops: length-scaling over the M21 loop region

- **Status:** Proposed
- **Date:** 2026-06-13
- **Deciders:** Daniel Peter

## Context

M21 (ADR-0015) put the track loop on the buffer source's native
`loop`/`loopStart`/`loopEnd`, with pure region math (`quantisedLoop`,
`planLoopSet`, `foldIntoLoop`) and a manual IN→OUT gesture. M23 adds
the working DJ's loop: a one-press **beat loop** (default 4 beats) and
**halve / double** of an active loop's length.

Forces in tension:

- The loop engine already exists. `setTrackLoop(start, end)` runs
  `planLoopSet` in the channel, which returns refuse/restart/reanchor/
  park/apply; the seam, the fold, and the rate/pause re-anchor are all
  M21's. M23 should be a *control layer* over that, not a second loop
  mechanism.
- Halve/double can either **re-quantise** (snap the moved end back onto
  the grid each time) or **pure-scale** (multiply the length). For a
  loop that began beat-aligned these agree — until the length stops
  being a clean multiple of the beat, where re-quantising drags the end
  off the fraction the DJ just made (4→2→1→½ beats is exact under
  scaling; re-snapping ½ a beat lands on a whole one).
- A beat loop is *defined* in beats, so creating one needs a confident
  grid. But scaling an existing region's *length* is arithmetic — it
  needs no grid at all. The two operations do not share a grid
  requirement.
- The FLX4 "4 BEAT/EXIT" is a **single button**: it sets a 4-beat loop
  when none runs and releases the loop when one does — a toggle. The
  on-screen surface already carries M21's dedicated EXIT button and has
  room for a separate set button.
- `planLoopSet` was written for a freshly-set loop. A resize feeds it a
  region derived from the *current* loop, with the playhead possibly
  now outside it (halving past the playhead). The design must confirm
  that path, not assume it.
- The M14 consumer rule, still standing: show nothing rather than a
  wrong number — a gridless track must still loop, just without
  claiming beats.

## Decision

We will build beat loops and halve/double as a **control layer over the
M21 region**: each computes a new region with a pure function and goes
through the existing `setTrackLoop` → `planLoopSet` path. The engine
gains no new loop mechanism.

- `beatLoopRegion(position, beats, grid, duration)` snaps the start to
  the grid, sets `end = start + beats · (60/bpm)`, clamps to the track
  end, and **returns null without a confident grid** (a beat loop is
  grid-defined — inert, not wrong, on a gridless track) or below the
  honest minimum.
- `resizeLoop(loop, factor, duration)` anchors on the IN (start fixed),
  sets `end = start + (end − start) · factor`, and refuses below
  `MIN_TRACK_LOOP_SECONDS` (the halve floor) or past `duration` (the
  double ceiling). It is **pure length-scaling, not a re-snap**: a
  beat-aligned loop stays on the grid under ×½/×2 by construction, and
  re-quantising would only corrupt a clean fraction. Halve/double
  therefore require **no grid** and scale any active loop, including a
  free IN→OUT one.

The set/resize **asymmetry is deliberate**: a beat loop can only be
*created* where the beats are known (a grid), but once a region exists,
scaling its length is honest arithmetic that needs no lattice.

The **"4 BEAT/EXIT" toggle lives in dispatch, not in the deck control**.
`beatLoop(beats)` is set-only (it clears any armed `pendingLoopIn` and
sets a fresh region), which the on-screen button uses — the screen
keeps its dedicated EXIT button, so no control changes meaning under
the hand. The FLX4 button maps to `track_beat_loop{4}`, and
`applyAppIntent` exits when a loop is active and sets one otherwise,
**reusing `loopExit()`** so there is exactly one exit path.

Reusing `setTrackLoop` for resize is sound because `planLoopSet`'s
**restart branch already covers shrink-past-playhead**. `setTrackLoop`
reads the position folded through the *old* loop — a no-op while the
playhead sits inside the still-installed old region, which is always
true for an active loop — so it sees the audible position; if that is
at or past the new end, `planLoopSet` returns `restart` at the folded
offset and the source re-fires inside the tightened region.

## Consequences

- Easier: M23 is two pure functions and three thin deck controls; the
  seam, the fold, and the re-anchor are M21's, untouched.
- Easier: a beat-aligned loop stays beat-aligned through any run of
  halve/double — powers of two of a whole-beat length never drift.
- Harder, accepted: a halve below the playhead re-fires the source — an
  audible JS restart, not the native sample-accurate wrap a steady loop
  enjoys. That is musically what a halve is (a deliberate re-trigger);
  the device checklist confirms it lands clean.
- Accepted: the halve floor reuses `MIN_TRACK_LOOP_SECONDS` for every
  loop, gridded or not — stretching that constant's "only bites without
  a grid" origin into the absolute shortest honest loop for any path
  (its comment is generalised to say so).
- Accepted: the on-screen 4-beat button (set-only) and the FLX4 button
  (toggle) differ — the screen has a separate EXIT, the single hardware
  button does not.
- The beat-count label shows clean fractions (½, ¼) only with a
  confident grid and a clean fraction; a free or odd-length loop still
  claims no count (the honesty rule).

## Alternatives considered

- **Re-quantise the end on halve/double** — rejected: corrupts clean
  sub-beat fractions and fights the length the DJ just set; pure scaling
  keeps alignment by construction.
- **A second engine loop path for resize** — rejected: `planLoopSet`
  already covers the playhead-outside case, so a parallel path would
  only duplicate the re-anchor logic ADR-0015 centralised.
- **`beatLoop` toggles in the deck control (one path for both
  surfaces)** — rejected: it makes the on-screen button set-or-exit
  under the hand, beside a dedicated EXIT; the toggle is a single-button
  hardware affordance, so it belongs in dispatch.
- **Grid-required halve/double** — rejected: scaling a length is honest
  arithmetic; refusing to resize a free loop adds a restriction with no
  fidelity reason.
