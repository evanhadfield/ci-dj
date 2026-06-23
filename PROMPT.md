You are working in a fork of SlipMate (Tauri + Rust audio engine + Python
Magenta/SA3 sidecars + React frontend). Phases 0 and 1 of the
collective-intelligence layer are already on `main` — see
`docs/collective/PLAN.md` (the authoritative spec) and
`docs/collective/README.md` (what landed in Phases 0/1 and how to
verify it). Read the plan in full before touching anything; pay
attention to §1 (the three signals), §3 (v1 control path — ADR-0020
MCP is still Proposed, not built), §5 (aggregation pipeline, order
matters), §6 (social-choice policy — the Phase 3 driver), and §7
(UX).

Execute PHASE 2 only, then stop.

What you inherit from Phase 1 (don't re-implement; do extend):

- **aggregator/** is the full reactive backbone:
  - `signals/`: seed vibe catalog, per-user taste EWMA, capped
    contribution, shrunk centroid, slew-limit, approval temperature,
    `RoomSignalsState` + `tick()` pipeline.
  - `ws/server.ts`: `/ws/phone`, `/ws/host`, `/ws/bridge` (the last
    loopback-only by default; `AGGREGATOR_BRIDGE_TOKEN` opens it past
    loopback).
  - `control/transport.ts`: `WorkerWsTransport` is a fan-out publisher;
    `McpTransport` is still a loud stub.
  - One auto-created "active" room (`POST /api/rooms`,
    `GET /api/rooms/active` both return it).
  - `RoomSignalsState.stubs()` exposes `suggestions`, `clusters`,
    `moderationQueue` as empty arrays — the seams Phase 2/3 fill.
- **crowd-web/** is a Vite + TypeScript PWA with the join flow,
  onboarding overlay (free-text seed + pick-3), and the Now screen
  (like/dislike, temperature gauge, "the room is shifting…"
  indicator). The Vibes and Room tabs are placeholders in
  `src/main.ts` — Phase 2 swaps the Vibes placeholder for the card
  stack.
- **host-screen/** renders the QR + code, the live approval-temperature
  trace, and a single-organism vibe map (support sizes only; clusters
  land in Phase 3).
- **frontend/** opens the bridge WS in `collective/useBridge.ts` and
  applies the influence macro in `collective/bridge.ts`. The
  `InfluencePanel` shows the room code, bridge status, and live crowd
  target. The bridge architecture decision was: the frontend is the
  bridge client (not a new auth'd loopback endpoint in Rust). Lock /
  amount=0 / aggregator-down all drop crowd influence to 0
  immediately, with the deck unaffected.
- **backend/** keeps Phase 0's `/api/embed` (text + audio → 768-dim,
  gated by `COLLECTIVE_ENABLED`). Phase 2 finally uses it (semantic
  dedupe of suggested vibes).

Hard rules (still apply):

- Everything new lives behind `COLLECTIVE_ENABLED` /
  `VITE_COLLECTIVE_ENABLED`; with them off, SlipMate must behave
  exactly as before.
- Do NOT edit the Rust audio engine internals, change the deck worker
  wire protocol, break any existing test, or remove any DJ control.
  Ask before any of these.
- Match house style per CLAUDE.md (frontend: single quotes, no
  semicolons, no formatter; type-check with
  `npx tsc -p tsconfig.app.json --noEmit` from frontend/). Backend:
  `ruff format` + `ruff check` clean.
- `just check` must still pass when Phase 2 is done; aggregator's own
  tests (`cd aggregator && npm test`) and `crowd-web`'s typecheck
  (`cd crowd-web && npx tsc --noEmit`) must pass too. If `just check`
  still doesn't wire in those, say so explicitly in the deliverable.
- The Phase 1 README documents one pre-existing brittle bit: the
  frontend vitest suite is broken on `main` by a jsdom/CJS-vs-ESM
  regression (`html-encoding-sniffer@6.0.0` require'ing the now-ESM
  `@exodus/bytes`). It pre-dates Phase 1 and isn't blocking the
  aggregator/crowd-web/host-screen pipeline. Phase 2 should bump
  jsdom (or pin a compatible html-encoding-sniffer) so the frontend
  test pool starts again — fix it before you grow the test surface
  for the new Vibes screen.

Phase 2 deliverables (PLAN.md §10):

- **crowd-web Vibes screen**: a coverage-balanced card stack (least-
  shown vibes first, lightly randomised), three actions per card —
  swipe right / **Agree**, swipe up or tap / **Pass**, swipe left /
  **Disagree** — with buttons mirroring the swipes (accessibility:
  swipes are never the only path). Gentle progress sense ("rated 6 —
  keep going?"), never a hard quota. **Suggest a vibe** text field,
  char-limited; on submit "added — others can vote on it soon";
  server-side semantic dedupe (see below); per-person submit
  rate-limit.
- **aggregator**: `OpinionMatrix` (sparse `userId × vibeId` votes in
  {+1, 0, −1}); a real `VibePrompt` pool with `decay` + `satisfied`-
  retire (PLAN.md §4); Wilson/Bayesian support scoring on the prompts;
  server-side **semantic dedupe** of suggestions via the backend
  `/api/embed` (a submission whose embedding is within ε of an
  existing prompt collapses into it — return the existing card so the
  phone can say "people are already vibing on that"). DJ
  approve/veto lane real; moderation classifier stub.
- **host-screen**: top-K vibes laid out on the opinion map sized by
  support. (Clusters still land in Phase 3 — keep `single-organism`
  mode active.)
- **Stubs present but minimal**: clustering, social-choice policy
  (`pr`/`maximin`), outlier down-weighting, real moderation
  classifier. Leave clear file-level seams in the aggregator and
  host-screen so Phase 3 can land in those files.

Checkpoint (PLAN.md §10): a suggestion can be submitted, semantically
deduped against the existing pool, rated by several devices, gain
support, influence the blend, and auto-retire when stale or satisfied.

When done, output exactly:
✅ Phase 2 — <what landed>, <what is stub>, <how to verify>
and stop for review. Do not start Phase 3.
