/** Collective DJ aggregator entry (Phase 1).
 *
 * HTTP surface:
 *   - POST /api/rooms            → create or return the active room
 *   - GET  /api/rooms/active     → idempotent active-room lookup
 *   - GET  /c/{code}             → crowd-web SPA
 *   - GET  /                     → host-screen SPA
 *   - GET  /healthz              → liveness probe
 *
 * WebSocket surface (attached to the same HTTP server):
 *   - /ws/phone?code=…   phone PWA
 *   - /ws/host?code=…    projection view
 *   - /ws/bridge?code=…  SlipMate frontend; bound to loopback or token
 *
 * Phase 1 auto-creates the active room on first request — the host
 * screen and the frontend bridge both reach for the same room without
 * a coordinator (PLAN.md §10 Phase 1 checkpoint).
 *
 * Running: `npm run dev` (tsx watch) or `npm run build && npm start`. */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { join, dirname, resolve, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'

import { RoomStore } from './rooms/rooms.js'
import { DeviceIdentity } from './identity/provider.js'
import { attachWsServer } from './ws/server.js'
import { HttpEmbedClient } from './signals/embed.js'

const PORT = Number(process.env.AGGREGATOR_PORT ?? 3030)
const HOST = process.env.AGGREGATOR_HOST ?? '0.0.0.0'
const BRIDGE_TOKEN = process.env.AGGREGATOR_BRIDGE_TOKEN
const EMBED_BASE_URL = process.env.AGGREGATOR_EMBED_URL ?? 'http://127.0.0.1:8000'

const HERE = dirname(fileURLToPath(import.meta.url))
// crowd-web is a Vite app from Phase 1 on, so prefer the built `dist/`;
// host-screen is still vanilla so it serves directly. Falling back to
// the source dir lets `npm run dev` work before `npm run build` in
// crowd-web has been invoked.
const CROWD_WEB_DIST = resolve(HERE, '..', '..', 'crowd-web', 'dist')
const CROWD_WEB_SRC = resolve(HERE, '..', '..', 'crowd-web')
const HOST_SCREEN_DIR = resolve(HERE, '..', '..', 'host-screen')

let crowdWebRoot: string | null = null
async function resolveCrowdWebRoot(): Promise<string> {
  if (crowdWebRoot) return crowdWebRoot
  try {
    await stat(join(CROWD_WEB_DIST, 'index.html'))
    crowdWebRoot = CROWD_WEB_DIST
  } catch {
    crowdWebRoot = CROWD_WEB_SRC
  }
  return crowdWebRoot
}

const rooms = new RoomStore()
const identity = new DeviceIdentity()

function joinBaseUrl(req: IncomingMessage): string {
  const forwardedHost = req.headers['x-forwarded-host']
  const host = (Array.isArray(forwardedHost) ? forwardedHost[0] : forwardedHost) ?? req.headers.host
  const proto =
    (req.headers['x-forwarded-proto'] as string | undefined) ??
    ('encrypted' in req.socket && req.socket.encrypted ? 'https' : 'http')
  return `${proto}://${host ?? `localhost:${PORT}`}`
}

async function serveFile(res: ServerResponse, baseDir: string, relPath: string): Promise<void> {
  const target = normalize(join(baseDir, relPath))
  if (!target.startsWith(baseDir)) {
    res.writeHead(403).end('forbidden')
    return
  }
  try {
    const body = await readFile(target)
    res.writeHead(200, { 'content-type': mimeFor(target), 'cache-control': 'no-store' })
    res.end(body)
  } catch {
    res.writeHead(404).end('not found')
  }
}

function mimeFor(path: string): string {
  if (path.endsWith('.html')) return 'text/html; charset=utf-8'
  if (path.endsWith('.js')) return 'application/javascript; charset=utf-8'
  if (path.endsWith('.css')) return 'text/css; charset=utf-8'
  if (path.endsWith('.svg')) return 'image/svg+xml'
  if (path.endsWith('.json')) return 'application/json; charset=utf-8'
  return 'application/octet-stream'
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolveBody, rejectBody) => {
    let buf = ''
    req.setEncoding('utf-8')
    req.on('data', (chunk) => {
      buf += chunk
      if (buf.length > 16_384) {
        rejectBody(new Error('body too large'))
        req.destroy()
      }
    })
    req.on('end', () => {
      if (!buf) return resolveBody(null)
      try {
        resolveBody(JSON.parse(buf))
      } catch {
        rejectBody(new Error('invalid JSON'))
      }
    })
    req.on('error', rejectBody)
  })
}

/** The aggregator is reached by the SlipMate webview (Tauri origin
 * `tauri://localhost` on macOS) and by host-screen / crowd-web served
 * from the aggregator itself. The webview's `fetch` would otherwise be
 * blocked by CORS — without these the bridge stays at "DJ drives solo".
 * Mirrors `backend/slipmate/controller.py`. */
const CORS_HEADERS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type, x-bridge-token',
}

const server = createServer(async (req, res) => {
  if (!req.url || !req.method) {
    res.writeHead(400).end()
    return
  }
  const url = new URL(req.url, 'http://localhost')

  // Pre-flight: every API endpoint accepts an OPTIONS probe.
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS_HEADERS).end()
    return
  }
  for (const [k, v] of Object.entries(CORS_HEADERS)) res.setHeader(k, v)

  if (req.method === 'GET' && url.pathname === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true }))
    return
  }

  // POST /api/rooms (legacy, host-screen scaffold) and GET /api/rooms/active
  // both return the active room. Phase 1 collapses room creation onto
  // the single active room so the bridge and the host land on the same
  // code without coordination.
  if (
    (req.method === 'POST' && url.pathname === '/api/rooms') ||
    (req.method === 'GET' && url.pathname === '/api/rooms/active')
  ) {
    if (req.method === 'POST') {
      try {
        await readJson(req)
      } catch {
        res.writeHead(400).end('invalid body')
        return
      }
    }
    const room = await rooms.ensureActive(joinBaseUrl(req))
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(room))
    return
  }

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    await serveFile(res, HOST_SCREEN_DIR, 'index.html')
    return
  }
  if (req.method === 'GET' && url.pathname.startsWith('/host/')) {
    await serveFile(res, HOST_SCREEN_DIR, url.pathname.slice('/host/'.length))
    return
  }

  if (req.method === 'GET' && url.pathname.startsWith('/c/')) {
    const code = url.pathname.slice('/c/'.length)
    const room = rooms.get(code)
    if (!room) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('room not found')
      return
    }
    const root = await resolveCrowdWebRoot()
    await serveFile(res, root, 'index.html')
    return
  }
  if (req.method === 'GET' && url.pathname.startsWith('/crowd/')) {
    const root = await resolveCrowdWebRoot()
    await serveFile(res, root, url.pathname.slice('/crowd/'.length))
    return
  }

  res.writeHead(404).end('not found')
})

const ws = attachWsServer(server, {
  rooms,
  identity,
  baseUrl: () => `http://${HOST}:${PORT}`,
  bridge: { token: BRIDGE_TOKEN },
  embedClient: new HttpEmbedClient({ baseUrl: EMBED_BASE_URL }),
})

server.listen(PORT, HOST, () => {
  console.log(`[aggregator] listening on http://${HOST}:${PORT}`)
  if (!BRIDGE_TOKEN) {
    console.log('[aggregator] bridge: loopback-only (set AGGREGATOR_BRIDGE_TOKEN for LAN)')
  }
})

const shutdown = async () => {
  await ws.close()
  server.close()
}
process.on('SIGINT', () => void shutdown())
process.on('SIGTERM', () => void shutdown())
