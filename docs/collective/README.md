# Collective DJ layer

Additive crowd-intelligence layer for SlipMate, built behind the
`COLLECTIVE_ENABLED` flag. Full design + phased build plan: [PLAN.md](PLAN.md).

## Phase 0 scaffold

What landed (no behaviour change with the flag off):

- **`backend/`** — `/api/embed` (text + audio → 768-dim) gated by the
  `COLLECTIVE_ENABLED` env var, reusing the render worker's MusicCoCa encoder
  (deck wire protocol untouched).
- **`frontend/`** — `src/collective/`: feature flag + inert influence-macro
  state and panel, rendered only when `VITE_COLLECTIVE_ENABLED=1`.
- **`aggregator/`** — Node + TypeScript service. Phase 0 carries room
  creation (`POST /api/rooms`), 4-char code join (`GET /c/{code}`), the
  `ControlTransport` interface (`WorkerWsTransport` real-but-idle,
  `McpTransport` stub) and `IdentityProvider` (`DeviceIdentity` real).
- **`crowd-web/`** — static phone landing for `/c/{code}` (Phase 1 adds the
  Now / Vibes / Room screens).
- **`host-screen/`** — static projection view; renders the QR + 4-char code
  served by the aggregator.

## Verifying Phase 0 locally

```sh
# 1. Backend embed endpoint (collective layer)
COLLECTIVE_ENABLED=1 uv --project backend run slipmate &
curl -s -X POST http://127.0.0.1:8000/api/embed \
  -H content-type:application/json \
  -d '{"text":"warm disco funk"}' | jq '.dim'   # → 768

# 2. Frontend: existing SlipMate is unchanged with the flag off.
#    With it on, the influence panel renders above the booth (inert).
VITE_COLLECTIVE_ENABLED=1 just tauri-dev

# 3. Aggregator + room join (a phone on the same LAN lands in an empty room)
cd aggregator && npm install && npm run build && npm start
# open http://<host>:3030 on the projection screen
# scan the QR with a phone → lands on /c/{code} (the empty room landing)
```

`just check` is unchanged by Phase 0 (only existing stacks are gated by the
PR check). The aggregator's own test suite (`npm test` inside `aggregator/`)
will be folded into `just check` in Phase 1, when the aggregator gains
behaviour worth gating PRs on.
