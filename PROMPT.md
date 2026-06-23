You are working in a fork of SlipMate (Tauri + Rust audio engine + Python
Magenta/SA3 sidecars + React frontend). Phases 0, 1, and 2 of the
collective-intelligence layer are already on `main` — see
`docs/collective/PLAN.md` (the authoritative spec) and
`docs/collective/README.md` (what landed in Phases 0/1/2 and the exact
runbook to verify it). Read the plan in full before touching anything;
pay attention to §1 (the three signals), §4 (data model — Phase 2 lit
up `VibePrompt` + `OpinionMatrix`), §5 (aggregation pipeline, order
matters), §5.5–6 (clustering threshold + social-choice policy — the
Phase 3 driver), and §7c (host-screen vibe map, where Phase 3 layers
cluster sentiment on top of the support-sized circles).

Execute PHASE 3 only, then stop.

What you inherit from Phase 2 (don't re-implement; do extend):

- **`aggregator/signals/prompts.ts`** — `VibePromptPool` per PLAN.md §4:
  `{ id, text, embedding(768), support, lastVoteTs, satisfied, approved }`,
  seeded from the Phase 1 catalog. `suggest()` runs exact-text dedupe
  then semantic dedupe via cosine ≥ ε on the backend `/api/embed`
  768-dim vectors (gracefully degrades when the backend is gated off).
  `sweep()` decays stale support and retires prompts whose embedding
  catches up to the applied vibe.
- **`aggregator/signals/opinion-matrix.ts`** — sparse user × prompt
  votes in `{+1, 0, -1}` with Wilson-lower-bound support scoring.
  `rows()` exposes mean-centered-ready data for Phase 3 PCA.
- **`aggregator/signals/sampling.ts`** — Thompson sampling on
  Beta(agree + 0.5·pass + 1, disagree + 0.5·pass + 1) + linear recency
  bonus, seedable RNG (Mulberry32 for tests). This is the dealer
  algorithm for the unified prompt pool.
- **`aggregator/signals/embed.ts`** — `HttpEmbedClient` against
  `controller.py`'s `/api/embed`; returns `null` when unreachable so
  the pool degrades to text-only dedupe.
- **`aggregator/signals/room-state.ts`** — `RoomSignalsState` owns the
  pool + matrix + Thompson dealer. Exposes `seat`, `applySeed` (which
  also casts +1 votes on the picks), `ingestReaction`, `suggest`,
  `castVote`, `dealCards` (with `markDealt` toggle), `promptText` (the
  pool's text resolver — replaces the Phase 1 `SEED_VIBE_BY_ID`
  lookup), `hasInteracted` (truthful "user has cast at least one
  pick/vote"). Snapshot surfaces `applied`, `target`, `crowdRaw`,
  `effectiveParticipants`, `temperature`, `participantCount`,
  `vibeSupport` (Phase 2 Wilson support, sourced from the pool), and
  `activePrompts`.
- **`aggregator/signals/clusters.ts`** — **Phase 3's primary
  workspace.** Currently `clusterStub(matrix)` returns
  `{ clusters: [], policy: 'centroid' }` and `CLUSTER_MIN_N = 18`.
  Replace the stub with a real PCA + K-means implementation; add the
  policy router (`centroid` / `pr` / `maximin` / `auto`).
- **`aggregator/signals/moderation.ts`** — `autoApproveClassifier`
  stub; leave for Phase 4.
- **`aggregator/ws/server.ts`** — `/ws/phone` handles `hello`, `seed`,
  `react`, `suggest`, `vote`, `request_cards`; `/ws/host` pushes
  `signals` with per-prompt Wilson support and pool-resolved labels;
  `/ws/bridge` is loopback-only unless `AGGREGATOR_BRIDGE_TOKEN` is
  set. The `welcome` handler now deals `ONBOARDING_CARD_LIMIT=9`
  cards from the unified pool (markDealt:false) instead of sending
  the static seed catalog — so a `bluegrass` suggestion surfaces in
  the next joiner's onboarding picker, not only on the Vibes tab.
- **`aggregator/signals/messages.ts`** — wire shapes for `welcome`
  (now carries `VibeCard[]`), `suggest`, `vote`, `request_cards`,
  `cards`, `suggest_ack`. Phase 3 must extend
  `HostServerMessage.signals` with per-vibe cluster sentiment
  (suggested shape: `vibeSupport[i].clusterMass: { clusterId,
  agree, disagree, pass }[]` so the host-screen split-ring renderer
  can pick it up). Below `CLUSTER_MIN_N` the field stays empty and
  the host stays in single-organism mode.
- **`crowd-web/`** — Vite + TypeScript PWA. Three tabs in
  `src/main.ts`: **Now** (real — Phase 1), **Vibes** (real — Phase 2
  card stack with swipe + button parity, emoji glyph labels with
  `aria-label` text, "rated N — keep going?" progress, Suggest a
  Vibe form draining the onboarding `pendingSeedText`), **Room**
  (still a placeholder — **Phase 3 lights it up**). Onboarding
  completion is client-owned via `Stored.seeded` in localStorage; the
  server's `welcome.seeded` reports real interaction (matrix row
  present) but never overwrites a falsy client flag.
- **`host-screen/`** — QR + code + live approval-temperature trace +
  single-organism vibe map (circles sized by Phase 2's
  `VibePrompt.support`, labels resolved through the pool). **Phase 3
  layers cluster sentiment** on these same circles.
- **`frontend/`** — opens the bridge WS in `collective/useBridge.ts`
  and applies the influence macro in `collective/bridge.ts`. The
  `InfluencePanel` shows the room code, bridge status, and live crowd
  target (which now includes user-submitted prompt text like
  `bluegrass` because the pool's `promptText` resolves them).
  Architectural decision (don't revisit unless asked): the frontend
  acts as the bridge client; lock / amount=0 / aggregator-down all
  drop crowd influence to 0 immediately, with the deck unaffected.
- **`backend/`** — keeps `/api/embed` (text + audio → 768-dim, gated
  by `COLLECTIVE_ENABLED`). Phase 3 can hit it again for the
  embedding-space layout on the host-screen map if you want
  similarity-based placement.

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
- `just check` already wires `aggregator npm test` + `aggregator
  npm run typecheck` + `crowd-web npx tsc --noEmit`. Keep them green.
- The frontend vitest pool runs under Node 22.9 via
  `NODE_OPTIONS=--experimental-require-module` (the package.json
  `test` script sets it). Two `frontend` tests are flaky on `main`
  (`CrateBrowser`, `DeckColumn`) and are *not* Phase-2's fault —
  leave them as-is unless they regress further.

Phase 3 deliverables (PLAN.md §10 + two pieces of Phase 2 polish):

- **Phase 2 polish — do these first (small, visible, unblocks
  testing):**
  - **Vibes-card button feedback.** Tapping 👍 / 🤷 / 👎 currently
    advances the queue but the buttons themselves give no press
    feedback. Mirror the Now-screen `flash` pattern from
    `crowd-web/src/now.ts` — add `vibes__action--just-tapped` CSS
    that pulses on commit, queue a `setTimeout` to remove it (200ms
    is plenty; the next card slides in faster than that).
  - **End-of-queue empty state.** When the user has voted on every
    card in the active pool, the screen currently loops on
    `request_cards` (server returns `[]`, client sees empty queue,
    `shouldPrefetch` is still true → infinite poll). Three coupled
    fixes: (a) `appendCards` should mark a "pool exhausted" flag
    when the response is empty so `shouldPrefetch` returns false
    until a new prompt arrives; (b) a new copy key
    `STRINGS.vibes.allRated` (suggested: "you've rated everything
    in the pool — suggest a new vibe to keep it moving") replaces
    the seed-catalog-empty copy when `votesCast > 0`; (c) when a
    fresh card arrives later (e.g. another phone suggests one and
    the dealer surfaces it), reset the flag and resume normal flow.

- **aggregator clustering** (`signals/clusters.ts`): PCA + K-means on
  `OpinionMatrix.rows()` (mean-centered, unseen treated as neutral,
  no imputation in v1). Gated on `CLUSTER_MIN_N = 18` active voters;
  below the threshold, the fallback is the current shrunk centroid
  (Phase 1/2 behaviour). Land the same shape — `clusters:
  OpinionCluster[]`, `policy: PolicyChoice` — so the room state and
  the WS server don't shift. The seed for K-means should be
  injectable (test determinism).

- **social-choice policy** (PLAN.md §6): compute `centroid`, `pr`
  (size-weighted rotation through cluster preferences over a
  configurable rotation window), and `maximin` (bridge — maximise
  the minimum cluster's satisfaction across the prompt pool); `auto`
  = `centroid` under `CLUSTER_MIN_N`, `pr` over. DJ-selectable
  through a new control in `frontend/src/collective/InfluencePanel.tsx`
  (radio group beside the influence knob). Log all three internally
  on every tick so they're A/B-comparable in the aggregator output.

- **manifold-outlier down-weighting** (PLAN.md §5 deferred ledger,
  PROMPT.md says "logged, not yet driving"): for each user, compute
  the cosine distance between their opinion-matrix row (mean-
  centered) and the manifold (the dominant PCA subspace). Surface
  the value on the room snapshot for the host-screen + analytics;
  do NOT yet wire it into the per-user contribution cap. Phase 4
  closes that loop.

- **host-screen cluster fan-out** (`host-screen/main.js` +
  `aggregator/src/signals/messages.ts`): on each circle, render a
  split ring / mini-bar showing how each opinion cluster feels about
  that prompt. Stay with the single-organism circles below the
  threshold (current behaviour). Layout can still be support-sized
  (Phase 2) or upgrade to embedding-similarity MDS/PCA if you want
  the PLAN.md §7c "similar vibes sit near each other" placement.

- **crowd-web Room tab**: phone-sized read-only host peek (live
  temperature trace + simplified vibe map showing top-K vibes with
  cluster sentiment). The data wire is on `HostServerMessage` — the
  cleanest path is a `/ws/peek` mirror (host messages without the
  QR/code, throttled). Don't reuse `/ws/host` directly — the host
  channel is sized for one consumer per room.

- **InfluencePanel policy selector** in
  `frontend/src/collective/InfluencePanel.tsx`: `centroid (auto) ·
  time-share · bridge` radio (PLAN.md §6). Sends the selection to
  the aggregator over the bridge socket — extend `BridgeServerMessage`
  with a `policy_select` direction (frontend → aggregator) and add a
  matching handler.

- **Stubs to leave for Phase 4**: `CaptivePortalIdentity` (LAN), real
  moderation classifier (`signals/moderation.ts` — the
  `autoApproveClassifier` becomes the fallback when the real one
  isn't configured), persistence + restart story, the outlier
  down-weighting actually driving the cap.

Checkpoint (PLAN.md §10): with ≥ N simulated participants in 2–3
distinct opinion groups, clusters appear as per-vibe sentiment on
the host map; the `pr` policy visibly rotates the featured vibe
through the groups over the rotation window; switching to `maximin`
changes behaviour toward the consensus vibe; below `N` the single-
organism centroid is back. The DJ selector flips between policies
live without restyle interruption. The Phase 2 Vibes-screen polish
(button press feedback + end-of-queue empty state) is verifiable by
hand on a single phone.

When done, output exactly:
✅ Phase 3 — <what landed>, <what is stub>, <how to verify>
and stop for review. Do not start Phase 4.
