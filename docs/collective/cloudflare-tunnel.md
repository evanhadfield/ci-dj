# Cloudflare Tunnel — getting phones onto the aggregator

The aggregator listens on `0.0.0.0:3030`. That's reachable from anywhere
on the DJ's LAN, but phones on cellular or a different network can't see
it, and iOS won't open a WebSocket from an HTTPS page to a plaintext
`ws://`. Cloudflare Tunnel solves both in one move: a single outbound
process on the DJ's laptop registers a public HTTPS hostname, and
phones hit that hostname from anywhere.

This is the **v1 path to phones-on-real-devices**, ahead of `PLAN.md`
§9's eventual venue-LAN/captive-portal story. It is purely additive — no
aggregator/crowd-web/host-screen code change is needed (see §"What
already works" below).

## Mental model

`cloudflared` opens an **outbound** HTTPS connection from the laptop to
Cloudflare's edge and keeps it open. When a phone hits the public URL,
Cloudflare receives the request at its edge, multiplexes it down the
existing outbound pipe, and `cloudflared` forwards it to
`http://localhost:3030` like a normal reverse proxy. The response
returns up the same pipe. The laptop never accepts an inbound
connection from the public internet, and never needs a port forwarded
on its router.

```
phone ── https ──► Cloudflare edge ── existing pipe ──► cloudflared ──► localhost:3030
                                                            (DJ laptop)
```

TLS terminates at the edge. The hop from the edge to `cloudflared` is
encrypted by Cloudflare; the hop from `cloudflared` to the local
aggregator is plain HTTP on loopback, which is fine — it never leaves
the laptop.

## Quick start (no Cloudflare account, throwaway URL)

For testing with a phone tonight:

```sh
brew install cloudflared       # one-time
cd aggregator && npm start     # terminal 1, as in collective/README.md
just tunnel                    # terminal 2 (or run cloudflared directly)
```

`just tunnel` runs `cloudflared tunnel --url http://localhost:3030`,
which prints a `https://<random-words>.trycloudflare.com` URL. The
aggregator's `joinBaseUrl` picks the public hostname out of
`X-Forwarded-Host`, so the QR on the host screen encodes
`https://<random>.trycloudflare.com/c/AB12` instead of localhost.
Phones scan it and join from any network.

Caveats of quick tunnels:

- The hostname rotates each restart — useless for flyers.
- Cloudflare reserves the right to rate-limit or kill quick tunnels;
  fine for testing, not for a real event.
- The tunnel dies when the laptop sleeps or `cloudflared` exits, taking
  the room with it. The aggregator's `RoomStore` is in-memory anyway,
  so this matches existing failure modes.

## Stable URL (named tunnel on a domain you own)

When you want `vibe.party/c/AB12` instead of a random URL:

**Browser, one time:**

1. Cloudflare account (free tier).
2. Add a domain on Cloudflare. Buying through Cloudflare Registrar is
   cleanest; pointing existing nameservers at Cloudflare works too but
   takes up to an hour to propagate.
3. Enable Cloudflare Zero Trust on the account (a.k.a. "Cloudflare
   One" — free for under 50 seats, and you're not using seats anyway
   since the public hostname is anonymous).
4. Zero Trust dashboard → Networks → Tunnels → Create a tunnel. Copy
   the connector token it gives you.
5. On the same tunnel, add a **Public Hostname**:
   `vibe.party` (or a subdomain) → `http://localhost:3030`.

**Laptop:**

```sh
cloudflared service install <token-from-step-4>
# or run interactively:
cloudflared tunnel run <tunnel-name>
```

The named tunnel auto-reconnects across reboots if installed as a
service. WebSockets are on by default; TLS mode should be set to
**Flexible** (edge HTTPS, origin HTTP) in the dashboard, since the
aggregator speaks plain HTTP on loopback.

## What already works (no code change needed)

The pieces below are already tunnel-ready. Future changes that touch
them should keep these properties intact:

- `aggregator/src/index.ts` `joinBaseUrl()` reads `X-Forwarded-Host`
  and `X-Forwarded-Proto`, so the QR URL on the host screen reflects
  whatever hostname Cloudflare assigns.
- The aggregator's CORS headers are `*`, so the SlipMate Tauri webview
  (origin `tauri://localhost`) can still call the public aggregator.
- `crowd-web/src/main.ts` derives its WebSocket URL from
  `window.location.origin` via `replace(/^http/, 'ws')` — `https`
  becomes `wss` automatically over a tunnel.
- `host-screen/main.js` does the same protocol swap on
  `window.location.href` for `/ws/host`.
- Identity is a signed token kept in `localStorage` and echoed on the
  WS hello — no cookies, so no `Secure` / `SameSite` issues at all.
- The bridge from the SlipMate frontend goes to
  `http://localhost:3030/ws/bridge` from the DJ's own laptop, not via
  the tunnel — the tunnel only carries inbound phone traffic.

## What this costs

Cloudflare Tunnel is free at the volume this app generates:

- Phone reaction traffic is JSON WebSocket frames under 200 B each.
  A packed room (~500 phones tapping 10×/min) is well under 1 MB/min.
- The crowd-web SPA bundle is small and browser-cached after the
  first load.
- No audio crosses the tunnel — audio mixing happens locally in the
  Rust engine.

Cloudflare's free-tier AUP discourages using their CDN as the primary
host for large media files; we don't, so we're inside the spirit of
the free tier.

## When this stops being the right answer

Move off the tunnel-on-laptop topology when any of these become true:

- The aggregator needs to stay up across DJ laptop reboots.
- The crowd is large enough that you want a load test before trusting
  it (run `wscat` against the tunnel with a few hundred fake clients
  first).
- `PLAN.md` Phase 4 lands and the captive-portal LAN identity becomes
  the real-event story.

At that point the aggregator moves to a single-VM host (Fly.io /
Render / Railway) and the tunnel is replaced — or kept only to expose
the DJ's `/api/embed` worker back to the cloud aggregator. The
deployment doc for that lives one layer beyond this file.
