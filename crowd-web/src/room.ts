/** The Room screen (PLAN.md §7b.3): phone-sized read-only host peek.
 *
 * A simplified version of `host-screen/main.js`: the temperature
 * trace + a top-K vibe map with per-vibe cluster sentiment. The data
 * comes from `/ws/peek`, a throttled mirror of the host channel that
 * scales to many subscribers per room (the host channel is sized for
 * one consumer). When the peek socket is closed the screen falls
 * back to a "tuning in…" line and keeps the last known signals
 * visible so the user doesn't see a flash of empty state during
 * reconnects. */

import { STRINGS } from './strings.ts'
import type { PeekServerMessage } from './types.ts'

/** Mirrors `aggregator/signals/clusters.ts#CLUSTER_MIN_N`. Below
 * this we render single-organism circles; over it we layer per-vibe
 * cluster sentiment. */
const CLUSTER_MIN_N = 18

/** Cluster palette — keyed by index after the aggregator sorts by
 * size descending (`c0` is the largest). First colour matches the
 * accent so single-cluster rooms look the same as the legacy
 * single-organism view. */
const CLUSTER_COLORS = ['#b6f06b', '#f3c46b', '#6bb6f0', '#f06bb6', '#a06bf0']

/** Window of seconds the trace canvas shows. Mirrors the host screen. */
const TRACE_WINDOW_SECONDS = 90
/** How often the trace pushes a point. Same cadence as the host. */
const TRACE_PUSH_INTERVAL_MS = 200
/** Above this temperature the trace flips into the "celebrate" tint. */
const CELEBRATE_THRESHOLD = 0.4

export class RoomScreen {
  private readonly root: HTMLElement
  private readonly statusEl: HTMLElement
  private readonly modeEl: HTMLElement
  private readonly traceCanvas: HTMLCanvasElement
  private readonly vibesEl: HTMLElement
  private readonly hintEl: HTMLElement
  private readonly traceFrame: number
  private tracePoints: { ts: number; value: number }[] = []
  private lastPeek: PeekServerMessage | null = null
  private status: 'connecting' | 'open' | 'offline' = 'connecting'

  constructor() {
    this.root = document.createElement('section')
    this.root.className = 'room'

    const heading = document.createElement('div')
    heading.className = 'room__heading'
    const eyebrow = document.createElement('p')
    eyebrow.className = 'eyebrow'
    eyebrow.textContent = STRINGS.room.eyebrow
    this.statusEl = document.createElement('p')
    this.statusEl.className = 'room__status'
    this.statusEl.setAttribute('role', 'status')
    this.statusEl.setAttribute('aria-live', 'polite')
    this.statusEl.textContent = STRINGS.room.waiting
    this.modeEl = document.createElement('p')
    this.modeEl.className = 'room__mode muted'
    heading.append(eyebrow, this.statusEl, this.modeEl)
    this.root.append(heading)

    const traceWrap = document.createElement('div')
    traceWrap.className = 'room__trace'
    this.traceCanvas = document.createElement('canvas')
    this.traceCanvas.className = 'room__trace-canvas'
    this.traceCanvas.width = 400
    this.traceCanvas.height = 80
    traceWrap.append(this.traceCanvas)
    this.root.append(traceWrap)

    this.vibesEl = document.createElement('div')
    this.vibesEl.className = 'room__vibes'
    this.root.append(this.vibesEl)

    this.hintEl = document.createElement('p')
    this.hintEl.className = 'room__hint muted'
    this.hintEl.textContent = STRINGS.room.emptyMap
    this.root.append(this.hintEl)

    this.traceFrame = window.setInterval(() => this.paintTrace(), TRACE_PUSH_INTERVAL_MS)
  }

  element(): HTMLElement {
    return this.root
  }

  apply(peek: PeekServerMessage): void {
    this.lastPeek = peek
    this.status = 'open'
    this.tracePoints.push({ ts: Date.now(), value: peek.temperature })
    const cutoff = Date.now() - TRACE_WINDOW_SECONDS * 1_000
    while (this.tracePoints.length > 1 && this.tracePoints[0]!.ts < cutoff) {
      this.tracePoints.shift()
    }
    this.renderStatus()
    this.renderVibes()
  }

  setStatus(status: 'connecting' | 'open' | 'offline'): void {
    this.status = status
    this.renderStatus()
  }

  destroy(): void {
    clearInterval(this.traceFrame)
    this.root.remove()
  }

  private renderStatus(): void {
    if (this.status === 'offline') {
      this.statusEl.textContent = STRINGS.room.offline
    } else if (!this.lastPeek) {
      this.statusEl.textContent = STRINGS.room.waiting
    } else {
      this.statusEl.textContent = this.lastPeek.label || STRINGS.room.waiting
    }
    if (this.lastPeek) {
      this.modeEl.textContent =
        this.lastPeek.activeVoters >= CLUSTER_MIN_N && this.lastPeek.clusters.length > 0
          ? STRINGS.room.multiCluster
          : STRINGS.room.singleOrganism
    } else {
      this.modeEl.textContent = ''
    }
  }

  private renderVibes(): void {
    const peek = this.lastPeek
    if (!peek) return
    const top = peek.vibeSupport.slice(0, 6)
    if (top.length === 0) {
      this.vibesEl.replaceChildren()
      this.hintEl.textContent = STRINGS.room.emptyMap
      return
    }
    this.hintEl.textContent = ''
    const maxSupport = top.reduce((m, v) => Math.max(m, v.support), 0)
    const clusterIds = peek.clusters.map((c) => c.id)
    this.vibesEl.replaceChildren()
    for (const vibe of top) {
      const node = document.createElement('div')
      node.className = 'room__vibe'
      const size = supportSize(vibe.support, maxSupport)
      const intensity = maxSupport > 0 ? 0.45 + 0.55 * (vibe.support / maxSupport) : 0.45
      const circle = renderVibeRing(vibe, clusterIds, size, intensity)
      const label = document.createElement('span')
      label.className = 'room__vibe-label'
      label.textContent = vibe.label
      node.append(circle, label)
      this.vibesEl.append(node)
    }
  }

  private paintTrace(): void {
    const ctx = this.traceCanvas.getContext('2d')
    if (!ctx) return
    const dpr = window.devicePixelRatio || 1
    const cssWidth = this.traceCanvas.clientWidth
    const cssHeight = this.traceCanvas.clientHeight
    if (
      this.traceCanvas.width !== cssWidth * dpr ||
      this.traceCanvas.height !== cssHeight * dpr
    ) {
      this.traceCanvas.width = cssWidth * dpr
      this.traceCanvas.height = cssHeight * dpr
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, cssWidth, cssHeight)
    ctx.strokeStyle = 'rgba(255,255,255,0.06)'
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(0, cssHeight / 2)
    ctx.lineTo(cssWidth, cssHeight / 2)
    ctx.stroke()
    if (this.tracePoints.length < 2) return
    const firstTs = this.tracePoints[0]!.ts
    const lastTs = this.tracePoints[this.tracePoints.length - 1]!.ts
    const span = Math.max(1_000, lastTs - firstTs)
    const xForTs = (ts: number): number => ((ts - firstTs) / span) * cssWidth
    const yForValue = (value: number): number => (1 - (value + 1) / 2) * cssHeight
    const peakTemperature = this.tracePoints[this.tracePoints.length - 1]!.value
    ctx.strokeStyle =
      peakTemperature >= CELEBRATE_THRESHOLD ? '#b6f06b' : 'rgba(182,240,107,0.55)'
    ctx.lineWidth = 2
    ctx.beginPath()
    for (let i = 0; i < this.tracePoints.length; i++) {
      const point = this.tracePoints[i]!
      const x = xForTs(point.ts)
      const y = yForValue(point.value)
      if (i === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    }
    ctx.stroke()
  }
}

function supportSize(support: number, maxSupport: number): number {
  const MIN = 24
  const MAX = 72
  if (maxSupport <= 0) return MIN
  const t = Math.min(1, Math.max(0, support / maxSupport))
  return MIN + (MAX - MIN) * t
}

function renderVibeRing(
  vibe: { clusterMass: { clusterId: string; agree: number; disagree: number; pass: number }[] },
  clusterIds: readonly string[],
  size: number,
  intensity: number,
): HTMLElement {
  const wrap = document.createElement('div')
  wrap.className = 'room__vibe-circle-wrap'
  wrap.style.width = `${size}px`
  wrap.style.height = `${size}px`
  const masses = vibe.clusterMass ?? []
  if (masses.length === 0 || clusterIds.length === 0) {
    const circle = document.createElement('div')
    circle.className = 'room__vibe-circle'
    circle.style.opacity = String(intensity)
    wrap.append(circle)
    return wrap
  }
  const ns = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(ns, 'svg')
  svg.setAttribute('viewBox', '0 0 100 100')
  svg.classList.add('room__vibe-ring')
  svg.style.opacity = String(intensity)
  const segments = clusterIds.map((id, i) => {
    const found = masses.find((m) => m.clusterId === id)
    return {
      agree: found?.agree ?? 0,
      disagree: found?.disagree ?? 0,
      pass: found?.pass ?? 0,
      color: CLUSTER_COLORS[i % CLUSTER_COLORS.length] ?? CLUSTER_COLORS[0]!,
    }
  })
  const radius = 40
  const stroke = 8
  const stub = 0.05
  const totalAgree = segments.reduce((s, seg) => s + seg.agree, 0)
  const circumference = 2 * Math.PI * radius
  let offset = -Math.PI / 2
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
    arc.setAttribute('transform', `rotate(${(offset / Math.PI) * 180} 50 50)`)
    const dashLength = (angle / (2 * Math.PI)) * circumference
    arc.setAttribute('stroke-dasharray', `${dashLength} ${circumference}`)
    arc.setAttribute('stroke-opacity', String(1 - 0.6 * negativity))
    svg.append(arc)
    offset += angle
  }
  wrap.append(svg)
  return wrap
}
