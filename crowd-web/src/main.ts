/** crowd-web entry (Phase 1).
 *
 * Reads the room code from `/c/{code}`, joins via WebSocket, runs the
 * onboarding overlay on first visit, and mounts the Now screen.
 *
 * The Vibes (Pol.is card stack) and Room (host peek) tabs are stubbed
 * here as "coming soon" placeholders so the seam is visible — Phase 2
 * lights up Vibes, Phase 3 lights up clusters that the Room peek
 * surfaces. */

import { PhoneConnection, type ConnectionState } from './connection.ts'
import { mountOnboarding } from './onboarding.ts'
import { NowScreen } from './now.ts'
import { loadStored, saveStored } from './storage.ts'
import { STRINGS } from './strings.ts'
import type { PhoneServerMessage, VibePrompt } from './types.ts'

const rootEl = document.getElementById('app')
if (!rootEl) throw new Error('missing #app root')

const code = readCode()
const stored = loadStored(code)

renderShell(code)

const banner = document.querySelector<HTMLElement>('.status-banner')
const body = document.querySelector<HTMLElement>('.app__body')
if (!banner || !body) throw new Error('shell did not mount')

setBanner(banner, STRINGS.joining, null)

let vibes: VibePrompt[] = []
let userId: string | null = null
let seeded = stored.seeded ?? false
let pendingSeed: string[] | null = null

const nowScreen = new NowScreen({
  onLike: () => {
    connection.send({ type: 'react', sign: 1 })
  },
  onDislike: () => {
    connection.send({ type: 'react', sign: -1 })
  },
})
body.append(nowScreen.element())

// The Vibes/Room tabs are wired but show "coming soon" placeholders.
// Phase 2/3 replace these with the card stack and the room peek.
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
    body.append(makePlaceholder(STRINGS.vibes.comingSoon))
  } else {
    body.append(makePlaceholder(STRINGS.room.comingSoon))
  }
}

function makePlaceholder(text: string): HTMLElement {
  const placeholder = document.createElement('section')
  placeholder.className = 'placeholder'
  placeholder.textContent = text
  return placeholder
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
    // Re-emit hello on every (re)connection so the aggregator resumes
    // the same userId (PLAN.md §7a step 5).
    connection.send({ type: 'hello', sessionToken: loadStored(code).sessionToken })
    return
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
    saveStored(code, { sessionToken: message.sessionToken, seeded: seeded || message.seeded })
    vibes = message.vibes
    if (banner) clearBanner(banner)
    if (!seeded && !message.seeded) startOnboarding()
    else seeded = true
    if (pendingSeed && pendingSeed.length > 0) {
      connection.send({ type: 'seed', picks: pendingSeed })
      pendingSeed = null
    }
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
}

function startOnboarding(): void {
  mountOnboarding(rootEl!, {
    vibes,
    onSubmit: ({ picks }) => {
      seeded = true
      saveStored(code, { seeded: true })
      if (userId) connection.send({ type: 'seed', picks })
      else pendingSeed = picks
    },
    onSkip: () => {
      seeded = true
      saveStored(code, { seeded: true })
    },
  })
}

const wsBase = window.location.origin.replace(/^http/, 'ws')
const connection = new PhoneConnection(`${wsBase}/ws/phone?code=${encodeURIComponent(code)}`, {
  onState: handleConnectionState,
  onMessage: handleMessage,
})

connection.start()
