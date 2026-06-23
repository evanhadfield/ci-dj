You are working in a fork of SlipMate (Tauri + Rust audio engine + Python
Magenta/SA3 sidecars + React frontend). Phases 0, 1, and 2 of the
collective-intelligence layer are already on `main` — see
`docs/collective/PLAN.md` (the authoritative spec) and
`docs/collective/README.md` (what landed in Phases 0/1/2 and the exact
runbook to verify it). Read the plan in full before touching anything;
pay attention to §1 (the three signals), §4 (data model — Phase 2
already lit up `VibePrompt` + `OpinionMatrix`), §5 (aggregation
pipeline, order matters), §5.5–6 (clustering threshold + social-choice
policy — the Phase 3 driver), and §7c (host-screen vibe map, where
Phase 3 layers cluster sentiment on top of the support-sized circles).

Execute PHASE 3 only, then stop.

What you inherit from Phase 2 (don't re-implement; do extend):

- **aggregator/** is now the full reactive + proactive backbone:
  - `signals/`: Phase 1 reactive pieces (`vibes.ts`, `taste.ts`,
    `pipeline.ts`, `temperature.ts`) plus Phase 2's prompt pool
    (`prompts.ts` — `VibePromptPool` with `{id, text, embedding(768),
    support, lastVoteTs, satisfied, approved}`, semantic dedupe,
    decay, satisfied-retire), opinion matrix (`opinion-matrix.ts` —
    sparse user × prompt votes in {+1, 0, -1} with Wilson-lower-bound
    scoring), embed client (`embed.ts` — `HttpEmbedClient` against the
    backend `/api/embed`), and the Phase 3 seams (`clusters.ts` —
    `clusterStub()` returns no clusters and the `centroid` policy;
    `moderation.ts` — `autoApproveClassifier` lets every suggestion
    through).
  - `signals/room-state.ts`: `RoomSignalsState` owns the pool +
    matrix; `seat`, `applySeed` (which now also casts +1 votes on the
    picked prompts), `ingestReaction`, `suggest`, `castVote`,
    `dealCards`, `tick` (which runs the prompt-pool sweep). Snapshot
    surfaces `applied`, `target`, `crowdRaw`, `effectiveParticipants`,
    `temperature`, `participantCount`, `vibeSupport` (Phase 2 Wilson
    support, NOT Phase 1 liked-mass), and `activePrompts`.
  - `ws/server.ts`: `/ws/phone` handles `hello`, `seed`, `react`,
    `suggest`, `vote`, `request_cards`; `/ws/host` pushes `signals`
    with per-prompt Wilson support and labels resolved through the
    pool; `/ws/bridge` is loopback-only unless
    `AGGREGATOR_BRIDGE_TOKEN` is set.
  - `signals/messages.ts`: wire shapes for `suggest`, `vote`,
    `request_cards`, `cards`, `suggest_ack`. Phase 3 must extend
    `HostServerMessage.signals.vibeSupport` (or a sibling field) with
    per-vibe cluster sentiment shapes.
- **crowd-web/** is a Vite + TypeScript PWA. Three tabs in
  `src/main.ts`: **Now** (real — Phase 1), **Vibes** (real — Phase 2
  card stack with swipe + button parity, "rated N — keep going?"
  progress, Suggest a Vibe form mapped to the aggregator's `suggest`),
  **Room** (still a placeholder — Phase 3 lights up the host peek).
  Onboarding `pendingSeedText` drains into the suggest path on first
  connect; the matching pill copy is at `crowd-web/src/strings.ts` →
  `vibes.suggestAddedCreated` ("added — others can vote on it soon").
- **host-screen/** renders the QR + code, the live approval-
  temperature trace, and a single-organism vibe map (circles sized by
  Phase 2's `VibePrompt.support` — labels now come from the prompt
  pool, so user-suggested vibes render with their own text). Cluster
  sentiment is the Phase 3 layer.
- **frontend/** opens the bridge WS in `collective/useBridge.ts` and
  applies the influence macro in `collective/bridge.ts`. The
  `InfluencePanel` shows the room code, bridge status, and live crowd
  target. Architectural decision (don't revisit unless asked): the
  frontend acts as the bridge client; lock / amount=0 / aggregator-down
  all drop crowd influence to 0 immediately, with the deck unaffected.
- **backend/** keeps `/api/embed` (text + audio → 768-dim, gated by
  `COLLECTIVE_ENABLED`). The aggregator hits it for semantic dedupe;
  Phase 3 can hit it again for the PCA layout on the host-screen.

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
  (`CrateBrowser`, `DeckColumn`) and are *not* Phase-2's fault — leave
  them as-is unless they regress further.

Phase 3 deliverables (PLAN.md §10):

- **aggregator clustering** (`signals/clusters.ts`): PCA + K-means on
  the `OpinionMatrix.rows()` (mean-centered, unseen treated as
  neutral, no imputation in v1). Gated on
  `clusters.CLUSTER_MIN_N = 18` active voters; below the threshold,
  the fallback is the current shrunk centroid. Land the same
  `clusterStub` shape — `clusters: OpinionCluster[]`, `policy:
  PolicyChoice` — so the room state and the WS server don't shift.
- **social-choice policy** (PLAN.md §6): compute `centroid`, `pr`
  (size-weighted rotation through cluster preferences), and `maximin`
  (bridge — maximise the minimum cluster's satisfaction); `auto` =
  centroid under `CLUSTER_MIN_N`, `pr` over. DJ-selectable through a
  new control in the `InfluencePanel`. Log all three internally so
  they're A/B-comparable.
- **manifold-outlier down-weighting** (PLAN.md §5 deferred ledger):
  compute the per-user distance from the manifold and surface it; do
  not yet drive aggregation (it's logged, not weighted). Phase 4 wires
  it into the cap.
- **host-screen cluster fan-out** (`host-screen/main.js` +
  `aggregator/src/signals/messages.ts`): per-vibe cluster sentiment as
  split rings / mini-bars on the existing support-sized circles. Stay
  with single circles below the threshold (current behaviour).
- **crowd-web Room tab**: phone-sized read-only host peek (the live
  temperature trace + a simplified vibe map). The wire shape lives on
  `HostServerMessage`; subscribe from the phone WS or add a
  `/ws/peek` if the host channel is too chatty.
- Stubs to leave for Phase 4: `CaptivePortalIdentity` (LAN), real
  moderation classifier (`moderation.ts`), persistence + restart
  story.

Checkpoint (PLAN.md §10): with ≥ N simulated participants in 2–3
distinct opinion groups, clusters appear as per-vibe sentiment on the
host map; the `pr` policy visibly rotates the featured vibe through
the groups; switching to `maximin` changes behaviour; below `N` the
single-organism centroid is back. The DJ selector flips between
policies live without restyle interruption.

When done, output exactly:
✅ Phase 3 — <what landed>, <what is stub>, <how to verify>
and stop for review. Do not start Phase 4.
