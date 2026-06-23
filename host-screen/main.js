/** host-screen entry (Phase 1; docs/collective/PLAN.md §7c).
 *
 * 1. POST /api/rooms (idempotent in Phase 1) → paint the QR + 4-char
 *    code + join URL.
 * 2. Open /ws/host?code=… for live signals.
 * 3. Render the approval-temperature trace (a sliding canvas line)
 *    and the single-organism vibe map (circles sized by support).
 *
 * Phase 3 layers cluster sentiment on the same vibes; the seam is the
 * `signals.vibeSupport` payload, which Phase 3 will expand to carry
 * per-vibe cluster mass. */

const CELEBRATE_THRESHOLD = 0.4
const TRACE_WINDOW_SECONDS = 90
const TRACE_PUSH_INTERVAL_MS = 200

const refs = {
  qr: document.getElementById('qr'),
  code: document.getElementById('code'),
  url: document.getElementById('url'),
  nowLabel: document.getElementById('nowLabel'),
  participants: document.getElementById('participants'),
  trace: document.getElementById('trace'),
  celebrate: document.getElementById('celebrate'),
  vibes: document.getElementById('vibes'),
}

const tracePoints = []
let lastSignals = null

async function createRoom() {
  const response = await fetch('/api/rooms', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  })
  if (!response.ok) throw new Error(`aggregator: ${response.status}`)
  return response.json()
}

function paintRoom({ code, joinUrl, qrSvg }) {
  if (refs.qr) refs.qr.innerHTML = qrSvg
  if (refs.code) refs.code.textContent = code.split('').join(' ')
  if (refs.url) refs.url.textContent = joinUrl
  return code
}

function openSignals(code) {
  const url = new URL('/ws/host', window.location.href)
  url.protocol = url.protocol.replace(/^http/, 'ws')
  url.searchParams.set('code', code)
  const socket = new WebSocket(url.toString())
  socket.addEventListener('message', (event) => {
    let parsed
    try {
      parsed = JSON.parse(event.data)
    } catch {
      return
    }
    if (parsed.type === 'signals') applySignals(parsed)
  })
  socket.addEventListener('close', () => {
    setTimeout(() => openSignals(code), 1_500)
  })
}

function applySignals(signals) {
  lastSignals = signals
  if (refs.nowLabel) {
    refs.nowLabel.textContent = signals.label || '— no signals yet'
  }
  if (refs.participants) {
    refs.participants.textContent = participantsLine(signals)
  }
  if (refs.celebrate) {
    refs.celebrate.classList.toggle(
      'host__celebrate--on',
      signals.temperature >= CELEBRATE_THRESHOLD,
    )
  }
  paintVibes(signals.vibeSupport)
}

function participantsLine(signals) {
  if (!signals.participantCount) return ''
  const plural = signals.participantCount === 1 ? 'person' : 'people'
  return `${signals.participantCount} ${plural} here · ${signals.effectiveParticipants.toFixed(1)} effective`
}

function paintVibes(vibeSupport) {
  if (!refs.vibes) return
  const top = vibeSupport.slice(0, 9)
  const maxSupport = top.reduce((m, v) => Math.max(m, v.support), 0)
  refs.vibes.replaceChildren()
  for (const vibe of top) {
    const node = document.createElement('div')
    node.className = 'host__vibe'
    const circle = document.createElement('div')
    circle.className = 'host__vibe-circle'
    const size = supportSize(vibe.support, maxSupport)
    circle.style.width = `${size}px`
    circle.style.height = `${size}px`
    circle.style.opacity = String(maxSupport > 0 ? 0.35 + 0.65 * (vibe.support / maxSupport) : 0.35)
    const label = document.createElement('span')
    label.className = 'host__vibe-label'
    label.textContent = vibe.label
    node.append(circle, label)
    refs.vibes.append(node)
  }
}

function supportSize(support, maxSupport) {
  const MIN = 24
  const MAX = 110
  if (maxSupport <= 0) return MIN
  const t = Math.min(1, Math.max(0, support / maxSupport))
  return MIN + (MAX - MIN) * t
}

function paintTrace() {
  const canvas = refs.trace
  if (!canvas) return
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const dpr = window.devicePixelRatio || 1
  const cssWidth = canvas.clientWidth
  const cssHeight = canvas.clientHeight
  if (canvas.width !== cssWidth * dpr || canvas.height !== cssHeight * dpr) {
    canvas.width = cssWidth * dpr
    canvas.height = cssHeight * dpr
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, cssWidth, cssHeight)

  // Center / threshold guides.
  ctx.strokeStyle = 'rgba(255,255,255,0.06)'
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(0, cssHeight / 2)
  ctx.lineTo(cssWidth, cssHeight / 2)
  ctx.stroke()
  ctx.strokeStyle = 'rgba(182,240,107,0.25)'
  ctx.beginPath()
  const thresholdY = (1 - (CELEBRATE_THRESHOLD + 1) / 2) * cssHeight
  ctx.moveTo(0, thresholdY)
  ctx.lineTo(cssWidth, thresholdY)
  ctx.stroke()

  if (tracePoints.length < 2) return
  const firstTs = tracePoints[0].ts
  const lastTs = tracePoints[tracePoints.length - 1].ts
  const span = Math.max(1_000, lastTs - firstTs)
  const xForTs = (ts) => ((ts - firstTs) / span) * cssWidth
  const yForValue = (value) => (1 - (value + 1) / 2) * cssHeight

  ctx.strokeStyle = '#b6f06b'
  ctx.lineWidth = 2
  ctx.beginPath()
  for (let i = 0; i < tracePoints.length; i++) {
    const x = xForTs(tracePoints[i].ts)
    const y = yForValue(tracePoints[i].value)
    if (i === 0) ctx.moveTo(x, y)
    else ctx.lineTo(x, y)
  }
  ctx.stroke()
}

function tracePush() {
  if (lastSignals) {
    tracePoints.push({ ts: Date.now(), value: lastSignals.temperature })
    const cutoff = Date.now() - TRACE_WINDOW_SECONDS * 1_000
    while (tracePoints.length > 1 && tracePoints[0].ts < cutoff) tracePoints.shift()
  }
  paintTrace()
}

createRoom()
  .then(paintRoom)
  .then((code) => {
    openSignals(code)
    setInterval(tracePush, TRACE_PUSH_INTERVAL_MS)
    window.addEventListener('resize', paintTrace)
  })
  .catch((error) => {
    if (refs.code) refs.code.textContent = '— —'
    if (refs.url) refs.url.textContent = `Aggregator unreachable: ${error.message}`
  })
