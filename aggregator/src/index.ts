/** Collective DJ aggregator — Phase 0 scaffold.
 *
 * Stands up the seams the rest of the layer will plug into:
 *   - POST /api/rooms       → {code, joinUrl, qrSvg}
 *   - GET  /c/{code}        → serves crowd-web (the phone PWA)
 *   - GET  /                → serves host-screen (the projection view)
 *   - GET  /healthz         → liveness probe
 *
 * No signals, no clustering, no bridge yet — those land in Phases 1–3
 * (docs/collective/PLAN.md §10). The `ControlTransport` /
 * `IdentityProvider` modules are imported so a build catches their
 * stubs drifting out of shape.
 *
 * Running: `npm run dev` (tsx watch) or `npm run build && npm start`. */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { join, dirname, resolve, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'

import { RoomStore } from './rooms/rooms.js'
import { DeviceIdentity } from './identity/provider.js'
import { WorkerWsTransport, McpTransport } from './control/transport.js'

const PORT = Number(process.env.AGGREGATOR_PORT ?? 3030)
const HOST = process.env.AGGREGATOR_HOST ?? '0.0.0.0'

const HERE = dirname(fileURLToPath(import.meta.url))
// crowd-web/ and host-screen/ are sibling workspaces — see the repo
// root tree in docs/collective/PLAN.md §2.
const CROWD_WEB_DIR = resolve(HERE, '..', '..', 'crowd-web')
const HOST_SCREEN_DIR = resolve(HERE, '..', '..', 'host-screen')

const rooms = new RoomStore()
// Identity + transports are wired so Phase 1 can plug them in without
// touching the server. Phase 0 holds them at module scope; nothing
// reads them yet.
const _identity = new DeviceIdentity()
const _workerTransport = new WorkerWsTransport()
const _mcpTransport = new McpTransport()
void _identity
void _workerTransport
void _mcpTransport

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

const server = createServer(async (req, res) => {
  if (!req.url || !req.method) {
    res.writeHead(400).end()
    return
  }
  const url = new URL(req.url, 'http://localhost')

  if (req.method === 'GET' && url.pathname === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true }))
    return
  }

  if (req.method === 'POST' && url.pathname === '/api/rooms') {
    try {
      await readJson(req)
    } catch {
      res.writeHead(400).end('invalid body')
      return
    }
    const room = await rooms.create(joinBaseUrl(req))
    res.writeHead(201, { 'content-type': 'application/json' })
    res.end(JSON.stringify(room))
    return
  }

  // Host screen lives at the root.
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    await serveFile(res, HOST_SCREEN_DIR, 'index.html')
    return
  }
  if (req.method === 'GET' && url.pathname.startsWith('/host/')) {
    await serveFile(res, HOST_SCREEN_DIR, url.pathname.slice('/host/'.length))
    return
  }

  // Phone PWA at /c/{code}; the index reads the code from `location.pathname`.
  if (req.method === 'GET' && url.pathname.startsWith('/c/')) {
    const code = url.pathname.slice('/c/'.length)
    const room = rooms.get(code)
    if (!room) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('room not found')
      return
    }
    await serveFile(res, CROWD_WEB_DIR, 'index.html')
    return
  }
  if (req.method === 'GET' && url.pathname.startsWith('/crowd/')) {
    await serveFile(res, CROWD_WEB_DIR, url.pathname.slice('/crowd/'.length))
    return
  }

  res.writeHead(404).end('not found')
})

server.listen(PORT, HOST, () => {
  console.log(`[aggregator] listening on http://${HOST}:${PORT}`)
})
