You are working in a fork of SlipMate (Tauri + Rust audio engine + Python
Magenta/SA3 sidecars + React frontend). Phases 0 and 1 of the
collective-intelligence layer are already on `main` — see
`docs/collective/PLAN.md` (the authoritative spec) and
`docs/collective/README.md` (what landed in Phases 0/1 and the exact
runbook to verify it). Read the plan in full before touching anything;
pay attention to §1 (the three signals), §3 (v1 control path — ADR-0020
MCP is still Proposed, not built), §4 (data model — `VibePrompt`,
`OpinionMatrix`), §5 (aggregation pipeline, order matters), §6 (social-
choice policy — the Phase 3 driver), and §7 (UX, especially §7b "Vibes"
and §7c host-screen vibe map).

Execute PHASE 2 only, then stop.

What you inherit from Phase 1 (don't re-implement; do extend):

- **aggregator/** is the full reactive backbone:
  - `signals/`: seed vibe catalog (`vibes.ts`), per-user taste EWMA
    (`taste.ts`), capped contribution, shrunk centroid + slew-limit
    (`pipeline.ts`), approval temperature (`temperature.ts`),
    `RoomSignalsState` + `tick()` pipeline (`room-state.ts`).
  - `ws/server.ts`: `/ws/phone`, `/ws/host`, `/ws/bridge` (the bridge
    is loopback-only unless `AGGREGATOR_BRIDGE_TOKEN` is set).
  - `control/transport.ts`: `WorkerWsTransport` is a fan-out publisher
    that the bridge handler subscribes to; `McpTransport` is still a
    loud stub (ADR-0020 remains Proposed).
  - `signals/messages.ts`: the wire shapes for all three roles. Phase 2
    must extend `PhoneClientMessage` with the suggest + vote messages
    (and `PhoneServerMessage` with the card-stack payload).
  - One auto-created "active" room (`POST /api/rooms` and
    `GET /api/rooms/active` are idempotent on it).
  - `RoomSignalsState.stubs()` already exposes `suggestions`,
    `clusters`, `moderationQueue` as empty arrays — Phase 2 fills the
    first; Phase 3 the second.
  - The HTTP server CORS-allows `*` so the Tauri webview can fetch.
- **crowd-web/** is a Vite + TypeScript PWA. Three tabs in
  `src/main.ts`: **Now** (real — like/dislike, temperature gauge, "the
  room is shifting…"), **Vibes** (placeholder — `makePlaceholder(STRINGS.vibes.comingSoon)`),
  **Room** (placeholder). The onboarding overlay (`src/onboarding.ts`)
  produces an `OnboardingResult` with `picks` and `seedText`; Phase 1
  stores `seedText` in localStorage as `Stored.pendingSeedText`
  (see `src/storage.ts`) because the suggestion pool isn't on the
  server yet. Phase 2 must drain that key into the real pool on first
  WebSocket join (see `seedNote` copy work below).
- **host-screen/** renders the QR + code, the live approval-
  temperature trace, and a single-organism vibe map (support sizes
  only; cluster sentiment is Phase 3).
- **frontend/** opens the bridge WS in `collective/useBridge.ts` and
  applies the influence macro in `collective/bridge.ts`. The
  `InfluencePanel` shows the room code, bridge status, and live crowd
  target. Architectural decision (don't revisit unless asked): the
  frontend acts as the bridge client; lock / amount=0 / aggregator-down
  all drop crowd influence to 0 immediately, with the deck unaffected.
- **backend/** keeps Phase 0's `/api/embed` (text + audio → 768-dim,
  gated by `COLLECTIVE_ENABLED`). Phase 2 finally uses it from the
  aggregator (semantic dedupe of suggestions).

Hard rules (still apply):

- Everything new lives behind `COLLECTIVE_ENABLED` /
  `VITE_COLLECTIVE_ENABLED`; with them off, SlipMate must behave
  exactly as before.
- Do NOT edit the Rust audio engine internals, change the deck worker
  wire protocol, break any existing test, or remove any DJ control.
  Ask before any of these.
- Match house style per CLAUDE.md (frontend: single quotes, no
  semicolons, no formatter; type-check with
  `npx tsc -p tsconfig.app.json --noEmit` from `frontend/`). Backend:
  `ruff format` + `ruff check` clean. `crowd-web/` follows the same
  TS conventions; typecheck with `npx tsc --noEmit` from `crowd-web/`.
- `just check` must still pass when Phase 2 is done. Aggregator's own
  tests (`cd aggregator && npm test`) and `crowd-web`'s typecheck
  (`cd crowd-web && npx tsc --noEmit`) must pass too. The Phase 1
  README flagged that `just check` does not yet wire these in — wire
  them in as part of Phase 2's tooling pass, OR document explicitly
  in the deliverable that they stay out-of-band.
- The frontend vitest suite is broken on `main` by a jsdom 29 / CJS-
  ESM regression (`html-encoding-sniffer@6.0.0` require'ing the now-
  ESM `@exodus/bytes`). It pre-dates Phase 1 and isn't blocking the
  aggregator/crowd-web/host-screen pipeline. **Fix this first** — bump
  jsdom (or pin a compatible html-encoding-sniffer) so the frontend
  test pool starts again — before you grow the test surface for the
  new Vibes screen and the new server-driven suggestion flow.

Phase 2 deliverables (PLAN.md §10):

- **crowd-web Vibes screen** (replaces the `STRINGS.vibes.comingSoon`
  placeholder in `src/main.ts`): a coverage-balanced card stack
  (least-shown vibes first, lightly randomised), three actions per
  card — swipe right / **Agree**, swipe up or tap / **Pass**, swipe
  left / **Disagree** — with buttons mirroring the swipes (accessibility:
  swipes are never the only path). Gentle progress sense ("rated 6 —
  keep going?"), never a hard quota. **Suggest a vibe** text field,
  char-limited; on submit show "added — others can vote on it soon";
  server-side semantic dedupe (see below); per-person submit rate-
  limit. The Room tab can stay a placeholder for Phase 2.
- **Onboarding follow-up**: drain `Stored.pendingSeedText` from
  localStorage on the first WebSocket connection after Phase 2 ships,
  feeding the saved free-text into the real suggestion pool through
  the same submit path the Vibes screen uses. **Remove the Phase 1
  copy** at `crowd-web/src/strings.ts` → `onboarding.seedNote`
  (currently "Saved — Phase 2 will share suggestions with the room.
  For now it shapes your taste.") and replace it with the same "added
  — others can vote on it soon" the Vibes suggest field shows, since
  that promise is now real.
- **aggregator**:
  - `VibePrompt` becomes a real type per PLAN.md §4:
    `{ id, text, embedding(768), support, lastVoteTs, satisfied:bool }`.
    Persist in memory; the seed catalog is the initial set.
  - `OpinionMatrix`: sparse `userId × vibePromptId` votes in
    {+1, 0(pass), −1}, mean-centered, no imputation in v1.
  - Wilson / Bayesian support scoring on the prompts.
  - **Semantic dedupe** of suggestions via the backend `/api/embed`:
    POST the suggestion text → 768-dim vector → if cosine ≥ ε to an
    existing prompt's embedding, collapse into it and return the
    existing card (the phone says "people are already vibing on
    that"); else add a new prompt to the pool.
  - **Decay + satisfied-retire** of prompts per PLAN.md §4: stale
    prompts decay; a prompt within ε of the current applied vibe
    flips `satisfied=true` and retires from the active pool (the
    audio said it; no need to keep voting).
  - DJ approve/veto lane wired through the existing
    `RoomStubs.moderationQueue` shape; a real moderation classifier
    stays a stub (slot it where Phase 4 will plug in).
- **host-screen**: top-K vibes laid out on the opinion map sized by
  support (the current single-organism circles, but now driven by the
  Phase 2 `VibePrompt.support` instead of Phase 1's "liked mass per
  seed id"). Stay in single-organism mode — clusters land in Phase 3.
- **Stubs present but minimal**: clustering (PCA + K-means hook),
  social-choice policy (`pr`/`maximin`), outlier down-weighting, real
  moderation classifier. Leave clear file-level seams in the
  aggregator and host-screen so Phase 3 can land in those files.

Checkpoint (PLAN.md §10): a suggestion can be submitted from one
phone, semantically deduped against the existing pool, rated by
several phones, gain support, influence the blend, and auto-retire
when stale or satisfied. The new suggestion should also be visible to
other phones (the user-experience gap that motivated this phase).

When done, output exactly:
✅ Phase 2 — <what landed>, <what is stub>, <how to verify>
and stop for review. Do not start Phase 3.
