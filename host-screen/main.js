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
/** Mirrors `aggregator/signals/clusters.ts#CLUSTER_MIN_N`. The host-
 * screen falls back to single-organism (no split-rings) below this. */
const CLUSTER_MIN_N = 18
/** Cluster palette — keyed by index after the aggregator sorts by
 * size descending (`c0` is always the largest). The first colour is
 * the existing accent so the single-organism look is preserved when
 * only one cluster is effective. */
const CLUSTER_COLORS = ['#b6f06b', '#f3c46b', '#6bb6f0', '#f06bb6', '#a06bf0']

const refs = {
  qr: document.getElementById('qr'),
  code: document.getElementById('code'),
  url: document.getElementById('url'),
  nowLabel: document.getElementById('nowLabel'),
  participants: document.getElementById('participants'),
  trace: document.getElementById('trace'),
  celebrate: document.getElementById('celebrate'),
  vibes: document.getElementById('vibes'),
  policyLabel: document.getElementById('policyLabel'),
  vibemapHint: document.getElementById('vibemapHint'),
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
  paintPolicy(signals)
  paintVibes(signals)
}

function paintPolicy(signals) {
  if (refs.vibemapHint) {
    const voters = signals.activeVoters ?? 0
    if (voters < CLUSTER_MIN_N) {
      refs.vibemapHint.textContent = `Single-organism view — clusters appear above ${CLUSTER_MIN_N} voters (${voters} so far).`
    } else if (!signals.clusters || signals.clusters.length === 0) {
      refs.vibemapHint.textContent = 'Single-organism view — the room votes as one cluster right now.'
    } else {
      const legend = signals.clusters
        .map((c, i) => {
          const color = CLUSTER_COLORS[i % CLUSTER_COLORS.length]
          return `<span class="host__cluster-chip" style="--chip:${color}">${c.id}: ${c.size}</span>`
        })
        .join('')
      refs.vibemapHint.innerHTML = `Split-ring view · ${legend}`
    }
  }
  if (refs.policyLabel && signals.policy) {
    const choice = signals.policy.choice
    const applied = signals.policy.appliedPolicy
    refs.policyLabel.textContent =
      choice === 'auto' && applied !== 'centroid'
        ? `policy: auto → ${applied}`
        : `policy: ${applied}`
  }
}

function participantsLine(signals) {
  if (!signals.participantCount) return ''
  const plural = signals.participantCount === 1 ? 'person' : 'people'
  return `${signals.participantCount} ${plural} here · ${signals.effectiveParticipants.toFixed(1)} effective`
}

function paintVibes(signals) {
  if (!refs.vibes) return
  const top = signals.vibeSupport.slice(0, 9)
  const maxSupport = top.reduce((m, v) => Math.max(m, v.support), 0)
  const clusterIds = (signals.clusters ?? []).map((c) => c.id)
  refs.vibes.replaceChildren()
  for (const vibe of top) {
    const node = document.createElement('div')
    node.className = 'host__vibe'
    const size = supportSize(vibe.support, maxSupport)
    const intensity = maxSupport > 0 ? 0.35 + 0.65 * (vibe.support / maxSupport) : 0.35
    const ring = renderVibeRing(vibe, clusterIds, size, intensity)
    const label = document.createElement('span')
    label.className = 'host__vibe-label'
    label.textContent = vibe.label
    node.append(ring, label)
    refs.vibes.append(node)
  }
}

/** Render one vibe circle. When cluster sentiment is present we draw
 * an SVG ring split into per-cluster segments (segment width = cluster
 * agreement mass on this prompt, capped so a tiny cluster doesn't
 * eat the whole ring). When clusters are absent we fall back to the
 * Phase 2 single-circle look. */
function renderVibeRing(vibe, clusterIds, size, intensity) {
  const wrap = document.createElement('div')
  wrap.className = 'host__vibe-circle-wrap'
  wrap.style.width = `${size}px`
  wrap.style.height = `${size}px`
  const masses = vibe.clusterMass ?? []
  if (masses.length === 0 || clusterIds.length === 0) {
    // Single-organism mode (Phase 2 visual).
    const circle = document.createElement('div')
    circle.className = 'host__vibe-circle'
    circle.style.opacity = String(intensity)
    wrap.append(circle)
    return wrap
  }
  const ns = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(ns, 'svg')
  svg.setAttribute('viewBox', '0 0 100 100')
  svg.classList.add('host__vibe-ring')
  svg.style.opacity = String(intensity)
  // Total agree mass across all clusters; segments are sized by
  // per-cluster agree count. A cluster with zero agreement still gets
  // a thin stub so the host can see the cluster exists and disagrees.
  const segments = clusterIds.map((id, i) => {
    const found = masses.find((m) => m.clusterId === id)
    return {
      clusterId: id,
      agree: found?.agree ?? 0,
      disagree: found?.disagree ?? 0,
      pass: found?.pass ?? 0,
      color: CLUSTER_COLORS[i % CLUSTER_COLORS.length],
    }
  })
  const stub = 0.05
  const totalAgree = segments.reduce((s, seg) => s + seg.agree, 0)
  const radius = 40
  const stroke = 8
  const circumference = 2 * Math.PI * radius
  let offset = -Math.PI / 2
  // Background ring (the room as one organism — the silhouette of the
  // total agreement on this vibe).
  const bg = document.createElementNS(ns, 'circle')
  bg.setAttribute('cx', '50')
  bg.setAttribute('cy', '50')
  bg.setAttribute('r', String(radius))
  bg.setAttribute('fill', 'none')
  bg.setAttribute('stroke', 'rgba(255,255,255,0.06)')
  bg.setAttribute('stroke-width', String(stroke))
  svg.append(bg)
  for (const seg of segments) {
    const shareOfAgree = totalAgree > 0 ? seg.agree / totalAgree : 1 / segments.length
    const span = Math.max(stub, shareOfAgree)
    const angle = span * 2 * Math.PI
    const fade = seg.disagree + seg.pass + seg.agree
    const negativity = fade > 0 ? seg.disagree / fade : 0
    const arc = document.createElementNS(ns, 'circle')
    arc.setAttribute('cx', '50')
    arc.setAttribute('cy', '50')
    arc.setAttribute('r', String(radius))
    arc.setAttribute('fill', 'none')
    arc.setAttribute('stroke', seg.color)
    arc.setAttribute('stroke-width', String(stroke))
    arc.setAttribute('stroke-linecap', 'butt')
    arc.setAttribute(
      'transform',
      `rotate(${(offset / Math.PI) * 180} 50 50)`,
    )
    const dashLength = (angle / (2 * Math.PI)) * circumference
    arc.setAttribute('stroke-dasharray', `${dashLength} ${circumference}`)
    arc.setAttribute('stroke-opacity', String(1 - 0.6 * negativity))
    svg.append(arc)
    offset += angle
  }
  wrap.append(svg)
  return wrap
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
