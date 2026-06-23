You are working in a fork of SlipMate (Tauri + Rust audio engine + Python
Magenta/SA3 sidecars + React frontend). Phase 0 of the collective-intelligence
layer is already committed on `main` — see `docs/collective/PLAN.md` (the
authoritative spec) and `docs/collective/README.md` (what landed in Phase 0
and how to verify it). Read the plan in full before touching anything; pay
attention to §1 (the three signals), §3 (v1 control path — ADR-0020 MCP is
still Proposed, not built), §5 (aggregation pipeline, order matters), and §7
(UX).

Execute PHASE 1 only, then stop.

What you inherit from Phase 0 (don't re-implement; do extend):
- Backend `/api/embed` returns a 768-dim vector for text or stereo-f32 audio,
  gated by `COLLECTIVE_ENABLED=1`. Worker command is `embed_query`, response
  on `embed_queue`. See `backend/slipmate/{controller,worker,engine}.py`.
- Frontend feature flag `VITE_COLLECTIVE_ENABLED` + inert influence-macro
  state and panel under `frontend/src/collective/`. With the flag off the UI
  is unchanged.
- `aggregator/` (Node + TS): room store with 4-char unambiguous codes + QR,
  `ControlTransport` interface (`WorkerWsTransport` real-but-idle,
  `McpTransport` stub), `IdentityProvider` (`DeviceIdentity` real with
  HMAC-signed session tokens). Tests run with `npm test`.
- `crowd-web/` + `host-screen/`: static SPAs served by the aggregator; QR
  scan lands a phone on `/c/{code}` (empty room, no signals yet).

Hard rules (still apply):
- Everything new lives behind `COLLECTIVE_ENABLED` / `VITE_COLLECTIVE_ENABLED`;
  with them off, SlipMate must behave exactly as before.
- Do NOT edit the Rust audio engine internals, change the deck worker wire
  protocol, break any existing test, or remove any DJ control. Ask before any
  of these.
- Match house style per CLAUDE.md (frontend: single quotes, no semicolons, no
  formatter; type-check with `npx tsc -p tsconfig.app.json --noEmit` from
  frontend/). Backend: `ruff format` + `ruff check` clean.
- `just check` must still pass when Phase 1 is done; the aggregator's own
  tests (`cd aggregator && npm test`) must pass too. If `just check` doesn't
  yet wire in the aggregator and you keep its tests green out-of-band, say
  so explicitly in the deliverable.

Phase 1 deliverables (PLAN.md §10):

- **crowd-web**: real join flow + onboarding overlay (one-line free-text +
  pick-3 seed cards) + the **Now** screen (like/dislike buttons, ambient
  approval-temperature gauge, "the room is shifting…" indicator). PWA, dark,
  one-handed, ≥44px targets. Phase 1 introduces a TypeScript + bundler stack
  (Vite is the obvious match — keep it minimal).
- **aggregator**: ingest reactions → per-user taste EWMA → capped contribution
  → single shrunk centroid → slew-limit → influence gate → bridge
  `set_style`. Reactions deduped by `userId` (DeviceIdentity already issues
  these). Bridge uses the existing `WorkerWsTransport` seam — wire it to the
  Tauri-IPC deck command channel that the frontend already uses
  (`frontend/src/deck/nativeDeck.ts` is the existing path; the bridge needs
  to reach the same `deck_set_style` command, almost certainly by talking to
  the local SlipMate process over a small auth'd loopback endpoint exposed
  by the Rust shell or by the frontend acting as the bridge client — decide
  and document the choice). The DJ influence macro must scale crowd
  contribution; locking it must drop crowd influence to 0 immediately.
- **host-screen**: real approval-temperature trace (the live EWMA
  net-approval line + threshold; a celebratory motion state above threshold)
  + vibe opinion map rendered in **single-organism mode** (support sizes
  only, no clusters yet — clusters are Phase 3).
- **Stubs present but minimal**: Vibes/Pol.is card stack, suggestions,
  clustering, policy (`pr`/`maximin`), outlier down-weighting, moderation.
  Leave clear file-level seams so Phase 2/3 can land in those files.

Checkpoint (PLAN.md §10): a phone taps → pad's crowd dot moves → deck
restyles within the model's latency → DJ override works (the human gesture
is always authoritative) → killing the aggregator drops influence to 0 with
the deck unaffected (the "absence degrades, never crashes" fail-safe in §9).

When done, output exactly:
✅ Phase 1 — <what landed>, <what is stub>, <how to verify>
and stop for review. Do not start Phase 2.
