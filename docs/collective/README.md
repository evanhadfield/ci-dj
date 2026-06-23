# Collective DJ layer

Additive crowd-intelligence layer for SlipMate, built behind the
`COLLECTIVE_ENABLED` flag. Full design + phased build plan:
[PLAN.md](PLAN.md). To run the live demo end-to-end (phone tap →
deck restyle), jump to [**Running Phase 1 locally**](#running-phase-1-locally)
— it lists every prerequisite and the exact two-terminal command.

## Status

| Phase | What it adds                                                   | State    |
| ----- | -------------------------------------------------------------- | -------- |
| 0     | Seams: `/api/embed`, room codes + QR, transport/identity ifaces | **Done** |
| 1     | Reactive backbone — phone taps drive the deck via the bridge    | **Done** |
| 2     | Proactive: Pol.is card stack + suggestions + semantic dedupe    | **Done** |
| 3     | Clustering + social-choice policy (PR / maximin)                | Next     |
| 4     | v2 seams + hardening (LAN identity, persistence, moderation)    | Pending  |

Hand off to the next phase by passing the repo + `PROMPT.md` to a fresh
Claude session. `PROMPT.md` carries the gated, phase-specific instructions
and the inherited seams.

## Phase 1 — what landed

Bridge architecture choice (PLAN.md §3 left this open between an
auth'd loopback endpoint exposed by the Rust shell vs the frontend
acting as the bridge client): **the SlipMate frontend is the bridge
client.** It opens a WebSocket to the aggregator's `/ws/bridge`, applies
the DJ influence macro (and "lock for the drop") locally, then
dispatches the existing Tauri-IPC `deck_set_style` command — the same
path `frontend/src/deck/nativeDeck.ts` already uses. Picking this seam
puts the influence gate next to the macro state (one source of truth),
gives §9's "absence degrades, never crashes" for free (a closed bridge
socket = no further intents = deck unaffected), and means the Rust
shell needs no new auth'd surface.

What landed (with the flag off, SlipMate is unchanged):

- **`aggregator/`** — Phase 1 grows the Node + TS service from a room
  scaffold into the full reactive backbone:
  - `signals/`: the 9-prompt seed vibe catalog, per-user taste EWMA,
    per-window contribution cap, shrunk centroid, slew-limited target,
    approval temperature, the §5 pipeline assembled as a pure tick
    function over `RoomSignalsState`.
  - `ws/`: three WebSocket roles — `/ws/phone`, `/ws/host`, and
    `/ws/bridge`. The bridge endpoint is loopback-only by default;
    `AGGREGATOR_BRIDGE_TOKEN` opens it past loopback.
  - `control/transport.ts`: `WorkerWsTransport` is now a fan-out
    publisher; the bridge handler is its subscriber.
  - `index.ts`: auto-creates a default "active" room on startup;
    `POST /api/rooms` and `GET /api/rooms/active` both return it.
- **`crowd-web/`** — Vite + TypeScript PWA. Join + onboarding overlay
  (free-text seed + pick-3 cards) + the **Now** screen (like/dislike
  buttons ≥44px, ambient temperature gauge, "the room is shifting…"
  indicator). Vibes (card stack) and Room (host peek) tabs are stubbed
  with "coming soon" placeholders; the file-level seams are in
  `src/main.ts`.
- **`host-screen/`** — QR + 4-char code (kept) + the live
  approval-temperature trace (canvas) + single-organism vibe opinion
  map (circles sized by support; cluster sentiment is Phase 3).
- **`frontend/`** — `collective/bridge.ts` opens the bridge WS,
  `collective/useBridge.ts` orchestrates room fetch + bridge lifetime,
  `InfluencePanel.tsx` shows the active room code, bridge status, and
  the live crowd target.
- **`backend/`** — no behaviour changes from Phase 1; the `/api/embed`
  endpoint from Phase 0 remains the seam Phase 3 needs for cluster
  layout on real embeddings.

What is still stubbed (the seams for Phase 2+):

- `crowd-web/`: Vibes (Pol.is card stack) and Room (live host peek)
  tabs are placeholders — the file-level seams are right where Phase 2
  needs them in `src/main.ts`.
- `aggregator/signals/room-state.ts`: `RoomStubs` carries
  `suggestions`, `clusters`, and `moderationQueue` as empty arrays so
  consumers see the eventual shape now.
- `host-screen/main.js`: vibe-map circles render `support` only, no
  cluster split-ring — Phase 3 lights up the same nodes.
- `aggregator/control/transport.ts`: `McpTransport` stays a loud stub;
  ADR-0020 remains Proposed.

## Phase 2 — what landed

- **`aggregator/signals/prompts.ts`** — `VibePromptPool` per PLAN.md §4:
  `{ id, text, embedding(768), support, lastVoteTs, satisfied,
  approved }`, seeded from the Phase 1 catalog. `suggest()` runs a
  cheap exact-text match, then (when the embed client is wired)
  semantic dedupe via cosine ≥ ε on the backend's `/api/embed` 768-dim
  vectors; the `sweep()` step decays stale support and retires
  prompts whose embedding catches up to the applied vibe.
- **`aggregator/signals/opinion-matrix.ts`** — sparse user × prompt
  votes in `{+1, 0, -1}` with Wilson-lower-bound support scoring. The
  shape Phase 3's PCA + K-means consumes.
- **`aggregator/signals/embed.ts`** — `HttpEmbedClient` against
  `controller.py`'s `/api/embed`; gracefully returns `null` when the
  backend is unreachable (suggestion still lands; dedupe just skips).
- **WS protocol extended** — phones can now `suggest`, `vote`, and
  `request_cards`; the aggregator answers with `suggest_ack` and
  `cards` (the coverage-balanced deal, least-shown-first with a tiny
  random jitter). Wire shapes in `aggregator/src/signals/messages.ts`
  ↔ `crowd-web/src/types.ts`.
- **`crowd-web/`** — the Vibes tab replaces the Phase 1 placeholder
  with a real card stack (swipe + button parity per §7b
  accessibility), a "rated N — keep going?" progress line, and a
  Suggest a Vibe form. The onboarding `pendingSeedText` drains into
  the suggest path on first connect — the Phase 1 "others can vote on
  it soon" pill copy now reflects reality.
- **`host-screen/`** — the vibe map now sizes circles by Phase 2's
  Wilson `VibePrompt.support` (the host handler resolves labels
  through the prompt pool, so user-suggested vibes render with their
  own text). Still single-organism mode — clusters land in Phase 3.
- **Tooling pass** — `just check` runs `aggregator npm test` (80
  passing) + `aggregator npm run typecheck` + `crowd-web npx tsc
  --noEmit` alongside the existing backend/frontend/Rust gates. The
  Phase 1 vitest regression (`jsdom@29` requiring the now-ESM
  `@exodus/bytes/encoding-lite.js`) is fixed by adding
  `--experimental-require-module` to the frontend's `npm test` so
  Node 22.9 honours the `require(esm)` path 22.12 ships by default.

What is still stubbed (the seams for Phase 3+):

- `aggregator/signals/clusters.ts`: `clusterStub()` returns no
  clusters and the `centroid` policy — Phase 3 lands PCA + K-means
  here and the `pr` / `maximin` selector wires through the same shape.
- `aggregator/signals/moderation.ts`: `autoApproveClassifier` lets
  every suggestion through; the DJ approve/veto lane is still the
  v1 moderation lever (the `RoomStubs.moderationQueue` shape exists,
  the classifier doesn't).
- Per-vibe cluster sentiment on the host-screen map (split rings /
  mini-bars) waits for the cluster fan-out in Phase 3.

## Running Phase 1 locally

This is a runbook for the full demo (phone tap → deck restyle). The
first time you set up the repo, you need every prerequisite below.
After that, only the **Run** section applies day-to-day.

### Prerequisites — install once

These are the tools the parent SlipMate project needs, plus what's new
for the collective layer. On macOS, all install via `brew` or one-line
installers; the same recipes work on Linux with `apt`/`pacman` etc.

| Tool                              | Why                                 | Install                                                                                                  |
| --------------------------------- | ----------------------------------- | -------------------------------------------------------------------------------------------------------- |
| **Node.js 22.12+** (or 20.19+)    | aggregator, crowd-web, frontend     | `brew install node` (or use `nvm`)                                                                       |
| **`just`**                        | task runner the parent repo uses    | `brew install just`                                                                                      |
| **Rust + `cargo`**                | builds the Tauri native shell       | `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \| sh` then `source $HOME/.cargo/env`         |
| **`cargo-tauri`** CLI             | `cargo tauri dev` / `tauri build`   | `cargo install tauri-cli@^2`                                                                             |
| **`uv`**                          | Python package manager (backend)    | `curl -LsSf https://astral.sh/uv/install.sh \| sh`                                                       |
| **`pyenv`** + Python **3.13**     | matches `backend/.python-version`   | `brew install pyenv` then `pyenv install 3.13`                                                           |

Sanity-check each is on `PATH`: `node -v`, `just --version`,
`cargo --version`, `cargo tauri --version`, `uv --version`,
`python3 --version` (should print 3.13.x from inside `backend/`).

### One-time setup (downloads weights + builds deps)

From the repo root:

```sh
# Backend deps + Magenta model weights (~2 GB for the small model).
# Living outside the repo under ~/Documents/Magenta/magenta-rt-v2
# unless MAGENTA_HOME is set.
cd backend && uv sync \
  && uv run mrt models init \
  && uv run mrt models download mrt2_small \
  && cd ..

# Aggregator (Node) + crowd-web (Vite) deps + builds. Both produce
# their dist/ that the aggregator serves at runtime.
cd aggregator && npm install && npm run build && cd ..
cd crowd-web  && npm install && npm run build && cd ..

# Frontend deps (the Tauri webview). Used by `just tauri-dev` during
# its build step; safe to run once up front.
cd frontend && npm install && cd ..
```

The parent `just setup` recipe also pulls `mrt2_base` (~6 GB) and
Stable Audio 3 weights (~8 GB) — neither is required for Phase 1.
`mrt2_small` is enough for the deck-restyles-from-crowd demo.

### Run — two terminals

**Terminal 1** — the aggregator (and the host-screen + crowd-web it
serves):

```sh
cd aggregator && npm start
# [aggregator] listening on http://0.0.0.0:3030
# [aggregator] bridge: loopback-only (set AGGREGATOR_BRIDGE_TOKEN for LAN)
```

Open `http://localhost:3030/` in a browser → the projection view
(QR + 4-char code + temperature trace + vibe map). Phones either scan
the QR or visit `http://localhost:3030/c/{code}` directly.

> Real phones on a different network can't reach `localhost`. For that,
> run `just tunnel` in a third terminal to expose the aggregator over
> Cloudflare's quick tunnel; the QR auto-rewrites to the public HTTPS
> URL. See [cloudflare-tunnel.md](cloudflare-tunnel.md) for the
> mental model, named-tunnel setup, and why no aggregator code change
> is needed.

**Terminal 2** — the SlipMate native app, with the collective layer
turned on and pointed at the aggregator:

```sh
VITE_COLLECTIVE_ENABLED=1 VITE_AGGREGATOR_URL=http://localhost:3030 just tauri-dev
```

**Both env vars must be on the same line as `just`.** Vite inlines
`import.meta.env.VITE_*` at *build* time (`npm run build` runs inside
the `tauri-dev` recipe), so dropping the env vars rebuilds without
the flag and the influence panel vanishes. Common gotchas:

- Running plain `cargo tauri dev` instead of `just tauri-dev` skips
  `SLIPMATE_SIDECARS=1`, which means the backend Python sidecars
  never spawn and the model dropdown stays empty.
- Running `just tauri-dev` without the `VITE_*` env vars succeeds, but
  the collective panel is absent (the flag baked to `false`).
- Editing aggregator code requires `npm run build && npm start` again
  in T1 — there's no hot-reload yet.

### Phase 1 checkpoint (PLAN.md §10)

With both terminals up and a phone joined:

1. **Pick a model on Deck A** (`mrt2_small`) and press Play. The deck
   starts streaming generated audio.
2. **In the `Crowd influence` panel** at the top of SlipMate, confirm:
   - `ROOM` shows a 4-char code (matching the projection screen).
   - `BRIDGE` reads `live` in the panel's accent colour.
3. **Turn the `INFLUENCE` knob up** — clockwise drag, ~50%.
4. **On the phone, complete the onboarding pick-3** (e.g. select three
   vibes) and then tap **Love this** a few times on the Now screen.
5. **The deck restyles** — within the model's ~3 s reaction phrase
   the Magenta output shifts toward the prompts your reactions
   weighted. The `CROWD TARGET` line in the panel updates with the
   live top-3 prompts.
6. **Test the DJ override**: tap `LOCK FOR THE DROP`. The panel's
   crowd target stays visible but the deck stops responding — the DJ
   has won.
7. **Test the fail-safe**: Ctrl-C the aggregator in T1. The bridge
   flips to `DJ drives solo`. The deck keeps generating exactly where
   the DJ left it; no error, no audio glitch.

## Tests + lint

```sh
just check                          # full PR gate (incl. aggregator + crowd-web)
cd aggregator && npm test           # 80/80 pass (incl. WS suggest/vote end-to-end)
cd aggregator && npm run typecheck  # clean
cd crowd-web  && npx tsc --noEmit   # clean
cd frontend   && npx tsc -p tsconfig.app.json --noEmit  # clean
cd frontend   && npm run lint       # clean
cd frontend   && npm test           # 579 pass + 1 skipped under jsdom 29
```

The frontend `npm test` script now sets
`NODE_OPTIONS=--experimental-require-module` so the `require(esm)`
path Node 22.12+ ships by default is honoured on Node 22.9 too. With
that flag the Phase 1 jsdom 29 / `@exodus/bytes` regression is gone
and vitest runs the full pool — including the new Vibes-screen
surface.

## Phase 3 — next session

The Phase 3 brief lives in [`PROMPT.md`](../../PROMPT.md). Start a
fresh Claude Code session in this repo, hand it that prompt, and it
will execute Phase 3 against the seams above:

- `aggregator/signals/clusters.ts` is where PCA + K-means + the
  `pr`/`maximin` policy selector land.
- `host-screen/main.js` is where the per-vibe cluster split-ring /
  mini-bar render lands (the support sizing is already there).
- `aggregator/signals/moderation.ts` is where Phase 4's classifier
  hook will sit when v2 hardening lands.
