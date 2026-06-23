# Collective DJ layer

Additive crowd-intelligence layer for SlipMate, built behind the
`COLLECTIVE_ENABLED` flag. Full design + phased build plan: [PLAN.md](PLAN.md).

## Status

| Phase | What it adds                                                   | State    |
| ----- | -------------------------------------------------------------- | -------- |
| 0     | Seams: `/api/embed`, room codes + QR, transport/identity ifaces | **Done** |
| 1     | Reactive backbone — phone taps drive the deck via the bridge    | **Done** |
| 2     | Proactive: Pol.is card stack + suggestions                      | Next     |
| 3     | Clustering + social-choice policy (PR / maximin)                | Pending  |
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

## Verifying Phase 1 locally

```sh
# 1. Backend (Phase 0 surface still works — unchanged in Phase 1)
COLLECTIVE_ENABLED=1 uv --project backend run slipmate &
curl -s -X POST http://127.0.0.1:8000/api/embed \
  -H content-type:application/json \
  -d '{"text":"warm disco funk"}' | jq '.dim'   # → 768

# 2. Aggregator + crowd-web (one terminal each)
cd crowd-web && npm install && npm run build && cd -
cd aggregator && npm install && npm run build && npm start &

# Open http://localhost:3030/ on the projection screen — QR + code.
# Scan with a phone → /c/{code} → onboarding overlay + Now screen.

# 3. Frontend: bridge wires the influence macro to the live decks
VITE_COLLECTIVE_ENABLED=1 \
VITE_AGGREGATOR_URL=http://localhost:3030 \
just tauri-dev
# The Crowd Influence panel above the booth shows the active room
# code, the bridge status ("live" / "DJ drives solo"), and the live
# crowd target. Turn the influence knob up → crowd taps move deck A.
```

Phase 1 checkpoint (PLAN.md §10): a phone tap → pad's crowd dot moves
→ deck restyles within the model's latency → the DJ override (lock or
zero the macro) wins → killing the aggregator drops influence to 0 with
the deck unaffected.

## Tests + lint

```sh
cd aggregator && npm test          # 46/46 pass (incl. WS end-to-end)
cd aggregator && npm run typecheck # clean
cd crowd-web  && npx tsc --noEmit  # clean
cd frontend   && npx tsc -p tsconfig.app.json --noEmit  # clean
cd frontend   && npm run lint      # clean
```

`just check` is not yet wired to the aggregator's `npm test` (the
Phase 0 README flagged this). Phase 2's tooling pass should fold it in
along with `crowd-web`'s typecheck. The Phase 1 aggregator + bridge
test suites pass standalone and are documented above.

**Pre-existing**: `cd frontend && npm test` is broken on `main`
independently of this work — `jsdom@29.1.1` pulls
`html-encoding-sniffer@6.0.0` which `require()`s the now-ESM
`@exodus/bytes/encoding-lite.js`. Running the new `bridge.test.ts`
with `--environment=node` (it doesn't need jsdom) sidesteps it:
`npm test -- --environment=node src/collective/bridge.test.ts` → 6/6.
Phase 2 should bump jsdom or pin a compatible
`html-encoding-sniffer`.

## Phase 2 — next session

The Phase 2 brief lives in [`PROMPT.md`](../../PROMPT.md). Start a
fresh Claude Code session in this repo, hand it that prompt, and it
will execute Phase 2 against the seams above (the Pol.is card stack,
suggestions, semantic dedupe through `/api/embed`, host-screen top-K
vibe map).
