/** crowd-web entry.
 *
 * Reads the room code from `/c/{code}`, joins via WebSocket, runs the
 * onboarding overlay on first visit, and mounts the three tabs:
 *
 *   - Now (Phase 1): like / dislike, temperature gauge, shifting tag.
 *   - Vibes (Phase 2): Pol.is-style card stack + suggest a vibe.
 *   - Room (Phase 3): host peek; still a "coming soon" placeholder.
 *
 * On first WS join post-onboarding, any `pendingSeedText` recorded by
 * Phase 1's onboarding (the free-text seed) is drained into the real
 * suggestion pool via the Phase 2 `suggest` path, so the promise the
 * onboarding pill made ("added — others can vote on it soon") now
 * actually lands. */

import { PhoneConnection, type ConnectionState } from './connection.ts'
import { mountOnboarding } from './onboarding.ts'
import { NowScreen } from './now.ts'
import { VibesScreen } from './vibes.ts'
import { RoomScreen } from './room.ts'
import { loadStored, saveStored } from './storage.ts'
import { STRINGS } from './strings.ts'
import type { PeekServerMessage, PhoneServerMessage, VibeCard } from './types.ts'

const rootEl = document.getElementById('app')
if (!rootEl) throw new Error('missing #app root')

const code = readCode()
const stored = loadStored(code)

renderShell(code)

const banner = document.querySelector<HTMLElement>('.status-banner')
const body = document.querySelector<HTMLElement>('.app__body')
if (!banner || !body) throw new Error('shell did not mount')

setBanner(banner, STRINGS.joining, null)

let vibes: VibeCard[] = []
let userId: string | null = null
let seeded = stored.seeded ?? false
let pendingSeed: string[] | null = null
let pendingSeedText: string | null = stored.pendingSeedText ?? null
/** Live `suggest` calls that came out of the pending-seed-text drain,
 * not user-facing — the next `suggest_ack` belongs to the Vibes screen
 * only if it was user-initiated. */
const silentSuggestQueue: string[] = []

// The connection is declared up here, ahead of the screens, because the
// VibesScreen constructor prefetches the first card deal synchronously
// (via its onRequestCards handler). With `connection` declared further
// down the file, that handler would hit the temporal-dead-zone and
// throw, leaving the page wedged on "Joining the room…".
const wsBase = window.location.origin.replace(/^http/, 'ws')
const connection = new PhoneConnection(`${wsBase}/ws/phone?code=${encodeURIComponent(code)}`, {
  onState: handleConnectionState,
  onMessage: handleMessage,
})

const nowScreen = new NowScreen({
  onLike: () => {
    connection.send({ type: 'react', sign: 1 })
  },
  onDislike: () => {
    connection.send({ type: 'react', sign: -1 })
  },
})

const vibesScreen = new VibesScreen({
  onVote: (promptId, vote) => {
    connection.send({ type: 'vote', promptId, vote })
  },
  onSuggest: (text) => {
    connection.send({ type: 'suggest', text })
  },
  onRequestCards: () => {
    connection.send({ type: 'request_cards' })
  },
})

const roomScreen = new RoomScreen()
const peek = createPeekSocket(`${wsBase}/ws/peek?code=${encodeURIComponent(code)}`, {
  onOpen: () => roomScreen.setStatus('open'),
  onClose: () => roomScreen.setStatus('offline'),
  onMessage: (message) => {
    if (message.type === 'peek') roomScreen.apply(message)
  },
})
peek.start()

body.append(nowScreen.element())

let activeTab: 'now' | 'vibes' | 'room' = 'now'
mountTabs()

function readCode(): string {
  const match = window.location.pathname.match(/^\/c\/([^/]+)/)
  return match ? decodeURIComponent(match[1] || '').toUpperCase() : ''
}

function renderShell(roomCode: string): void {
  rootEl!.innerHTML = ''
  const app = document.createElement('div')
  app.className = 'app'

  const title = document.createElement('header')
  title.className = 'app__title'
  const room = document.createElement('p')
  room.className = 'app__title-room'
  room.innerHTML = `Room <code>${roomCode || '?'}</code>`
  title.append(room)
  app.append(title)

  const tabs = document.createElement('nav')
  tabs.className = 'app__tabs'
  tabs.setAttribute('role', 'tablist')
  for (const id of ['now', 'vibes', 'room'] as const) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'app__tab'
    button.dataset.tab = id
    button.setAttribute('role', 'tab')
    button.setAttribute('aria-pressed', String(id === 'now'))
    button.textContent =
      id === 'now' ? 'Now' : id === 'vibes' ? STRINGS.vibes.tab : STRINGS.room.tab
    tabs.append(button)
  }
  app.append(tabs)

  const statusBanner = document.createElement('aside')
  statusBanner.className = 'status-banner'
  statusBanner.setAttribute('role', 'status')
  statusBanner.setAttribute('aria-live', 'polite')
  const title2 = document.createElement('p')
  title2.className = 'status-banner__title'
  const hint = document.createElement('p')
  hint.className = 'status-banner__hint'
  statusBanner.append(title2, hint)
  app.append(statusBanner)

  const body = document.createElement('main')
  body.className = 'app__body'
  app.append(body)

  rootEl!.append(app)
}

function mountTabs(): void {
  const tabsEl = document.querySelector('.app__tabs')
  if (!tabsEl) return
  tabsEl.addEventListener('click', (event) => {
    const target = event.target
    if (!(target instanceof HTMLElement)) return
    const tab = target.dataset.tab
    if (tab !== 'now' && tab !== 'vibes' && tab !== 'room') return
    setActiveTab(tab)
  })
}

function setActiveTab(tab: 'now' | 'vibes' | 'room'): void {
  if (tab === activeTab) return
  activeTab = tab
  for (const button of document.querySelectorAll<HTMLElement>('.app__tab')) {
    button.setAttribute('aria-pressed', String(button.dataset.tab === tab))
  }
  if (!body) return
  body.innerHTML = ''
  if (tab === 'now') {
    body.append(nowScreen.element())
  } else if (tab === 'vibes') {
    body.append(vibesScreen.element())
    // First visit to the tab requests an initial deal so the stack
    // doesn't render empty.
    if (userId) connection.send({ type: 'request_cards' })
  } else {
    body.append(roomScreen.element())
  }
}

type PeekHandlers = {
  onOpen: () => void
  onClose: () => void
  onMessage: (message: PeekServerMessage) => void
}

/** Minimal peek socket: silent reconnect, surfaces open/offline to the
 * Room screen so it can swap status copy. We don't need the full
 * PhoneConnection — there's no client→server side on /ws/peek. */
function createPeekSocket(url: string, handlers: PeekHandlers): { start: () => void } {
  const RECONNECT_INITIAL_MS = 1_000
  const RECONNECT_MAX_MS = 8_000
  let ws: WebSocket | null = null
  let reconnectMs = RECONNECT_INITIAL_MS
  let reconnectTimer: number | null = null
  let closed = false
  const open = (): void => {
    if (closed) return
    try {
      ws = new WebSocket(url)
    } catch {
      scheduleReconnect()
      return
    }
    ws.addEventListener('open', () => {
      reconnectMs = RECONNECT_INITIAL_MS
      handlers.onOpen()
    })
    ws.addEventListener('message', (event) => {
      try {
        const parsed = JSON.parse(String(event.data)) as PeekServerMessage
        handlers.onMessage(parsed)
      } catch {
        // Malformed frame; drop silently — the aggregator never sends one.
      }
    })
    ws.addEventListener('close', () => {
      ws = null
      handlers.onClose()
      scheduleReconnect()
    })
    ws.addEventListener('error', () => {
      // close handler will own the retry path.
    })
  }
  const scheduleReconnect = (): void => {
    if (closed || reconnectTimer !== null) return
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = null
      open()
    }, reconnectMs)
    reconnectMs = Math.min(reconnectMs * 2, RECONNECT_MAX_MS)
  }
  return { start: () => open() }
}

function setBanner(element: HTMLElement, title: string, hint: string | null): void {
  const titleEl = element.querySelector('.status-banner__title')
  const hintEl = element.querySelector('.status-banner__hint')
  if (titleEl) titleEl.textContent = title
  if (hintEl) hintEl.textContent = hint ?? ''
  element.style.display = title ? '' : 'none'
}

function clearBanner(element: HTMLElement): void {
  element.style.display = 'none'
}

function handleConnectionState(state: ConnectionState): void {
  if (state.kind === 'open') {
    connection.send({ type: 'hello', sessionToken: loadStored(code).sessionToken })
    return
  }
  if (state.kind === 'offline') {
    vibesScreen.failSuggest()
  }
  if (!banner) return
  if (state.kind === 'connecting') {
    setBanner(banner, STRINGS.joining, null)
  } else if (state.kind === 'offline') {
    setBanner(banner, STRINGS.joinError, STRINGS.joinErrorHint)
  }
}

function handleMessage(message: PhoneServerMessage): void {
  if (message.type === 'welcome') {
    userId = message.userId
    // `seeded` is a client-owned flag: only flip it true after the
    // user actually completes or skips onboarding. The server's
    // `message.seeded` is informational (it reports real interaction,
    // not "we recognise this device") — but if the client cleared
    // localStorage we still want the onboarding picker to re-appear,
    // so we don't OR the server's claim into our state.
    saveStored(code, { sessionToken: message.sessionToken })
    vibes = message.vibes
    if (banner) clearBanner(banner)
    if (!seeded) startOnboarding()
    if (pendingSeed && pendingSeed.length > 0) {
      connection.send({ type: 'seed', picks: pendingSeed })
      pendingSeed = null
    }
    drainPendingSeedText()
    return
  }
  if (message.type === 'now') {
    nowScreen.update({
      label: message.label,
      temperature: message.temperature,
      shifting: message.shifting,
      participants: message.participantCount,
    })
    return
  }
  if (message.type === 'cards') {
    vibesScreen.appendCards(message.cards)
    return
  }
  if (message.type === 'suggest_ack') {
    // Drain-of-pendingSeedText calls are silent — the onboarding pill
    // already showed the same promise; we just don't want the Vibes
    // screen's status line to flash for them.
    if (silentSuggestQueue.length > 0) {
      silentSuggestQueue.shift()
      return
    }
    vibesScreen.acknowledgeSuggest(message.result, message.card)
    return
  }
}

function drainPendingSeedText(): void {
  if (!pendingSeedText) return
  const text = pendingSeedText
  pendingSeedText = null
  saveStored(code, { pendingSeedText: undefined })
  silentSuggestQueue.push(text)
  connection.send({ type: 'suggest', text })
}

function startOnboarding(): void {
  mountOnboarding(rootEl!, {
    vibes,
    onSubmit: ({ picks, seedText }) => {
      seeded = true
      saveStored(code, { seeded: true })
      if (picks.length === 0 && !seedText) return
      if (userId && picks.length > 0) connection.send({ type: 'seed', picks })
      else if (picks.length > 0) pendingSeed = picks
      if (seedText) {
        if (userId) {
          silentSuggestQueue.push(seedText)
          connection.send({ type: 'suggest', text: seedText })
        } else {
          // Connection hasn't completed yet — remember the text so the
          // welcome handler drains it. saveStored() guards against a
          // tab close in between.
          pendingSeedText = seedText
          saveStored(code, { pendingSeedText: seedText })
        }
      }
    },
    onSkip: () => {
      seeded = true
      saveStored(code, { seeded: true })
    },
  })
}

connection.start()
