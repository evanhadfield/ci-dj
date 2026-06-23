/** The Vibes screen (PLAN.md §7b.2): a Pol.is-style card stack.
 *
 * Each card carries one vibe-prompt; the user agrees / passes /
 * disagrees, either by swipe or by button (swipes are never the only
 * path — PLAN.md §7b accessibility). A gentle "rated 6 — keep going?"
 * line gives a progress sense without imposing a quota. The Suggest a
 * Vibe form posts a `suggest` message; the aggregator answers with
 * `suggest_ack` carrying either the new card or the deduped one.
 *
 * Server-driven coverage is the aggregator's job (`dealCards` runs
 * least-shown-first). This module only renders the top card, holds the
 * local queue, and re-requests when it runs low. */

import { STRINGS, interpolate } from './strings.ts'
import type { VibeCard } from './types.ts'

/** Threshold (in CSS pixels) above which a swipe commits an action.
 * Smaller than the §7b "≥44 px tap target" so a thumb-flick lands
 * before the gesture leaves the card. */
const SWIPE_COMMIT_PX = 80

/** When the local card queue drops below this many cards, request more
 * from the server. The aggregator deals a default-size batch (~12). */
const PREFETCH_THRESHOLD = 3

export type VibesScreenHandlers = {
  /** Cast a vote on a prompt and slide the next card in. Phase 2 only
   * has +1 / 0 / -1; Phase 3 may reshape this for confidence levels. */
  onVote: (promptId: string, vote: 1 | 0 | -1) => void
  /** Ask the server to suggest a new vibe-prompt. The screen waits for
   * a `suggest_ack` to show the user the result. */
  onSuggest: (text: string) => void
  /** Ask the server to deal more cards. Called automatically when the
   * local queue drops below `PREFETCH_THRESHOLD`. */
  onRequestCards: () => void
}

type SuggestState = 'idle' | 'pending' | 'created' | 'deduped' | 'rate-limited' | 'invalid' | 'network-error'

export class VibesScreen {
  private readonly root: HTMLElement
  private readonly cardArea: HTMLElement
  private readonly progressEl: HTMLElement
  private readonly emptyEl: HTMLElement
  private readonly suggestInput: HTMLInputElement
  private readonly suggestButton: HTMLButtonElement
  private readonly suggestStatusEl: HTMLElement
  private readonly handlers: VibesScreenHandlers
  private queue: VibeCard[] = []
  /** Prompt IDs the user has already voted on this session. The
   * aggregator filters its deal by the same set, but the local cache
   * keeps the user from briefly seeing a card they just voted on. */
  private readonly voted = new Set<string>()
  /** Number of votes this user has cast this session — drives the
   * "rated N — keep going?" copy. */
  private votesCast = 0
  /** Cards we've explicitly requested from the server but haven't
   * received yet — guards against a re-prefetch storm. */
  private requestInFlight = false
  private suggestState: SuggestState = 'idle'

  constructor(handlers: VibesScreenHandlers) {
    this.handlers = handlers
    this.root = document.createElement('section')
    this.root.className = 'vibes'
    this.root.setAttribute('aria-labelledby', 'vibes-eyebrow')

    const heading = document.createElement('div')
    heading.className = 'vibes__heading'
    const eyebrow = document.createElement('p')
    eyebrow.className = 'eyebrow'
    eyebrow.id = 'vibes-eyebrow'
    eyebrow.textContent = STRINGS.vibes.eyebrow
    this.progressEl = document.createElement('p')
    this.progressEl.className = 'vibes__progress'
    this.progressEl.setAttribute('role', 'status')
    this.progressEl.setAttribute('aria-live', 'polite')
    heading.append(eyebrow, this.progressEl)
    this.root.append(heading)

    this.cardArea = document.createElement('div')
    this.cardArea.className = 'vibes__stack'
    this.root.append(this.cardArea)

    this.emptyEl = document.createElement('p')
    this.emptyEl.className = 'vibes__empty'
    this.emptyEl.textContent = STRINGS.vibes.empty
    this.emptyEl.hidden = true
    this.root.append(this.emptyEl)

    const suggest = document.createElement('form')
    suggest.className = 'vibes__suggest'
    suggest.addEventListener('submit', (event) => {
      event.preventDefault()
      this.submitSuggestion()
    })
    const suggestEyebrow = document.createElement('label')
    suggestEyebrow.className = 'eyebrow'
    suggestEyebrow.htmlFor = 'vibes-suggest-input'
    suggestEyebrow.textContent = STRINGS.vibes.suggestEyebrow
    suggest.append(suggestEyebrow)

    const row = document.createElement('div')
    row.className = 'vibes__suggest-row'
    this.suggestInput = document.createElement('input')
    this.suggestInput.id = 'vibes-suggest-input'
    this.suggestInput.className = 'vibes__suggest-input'
    this.suggestInput.type = 'text'
    this.suggestInput.maxLength = 80
    this.suggestInput.autocomplete = 'off'
    this.suggestInput.placeholder = STRINGS.vibes.suggestPlaceholder
    this.suggestInput.addEventListener('input', () => {
      this.updateSuggestButton()
      if (this.suggestState !== 'pending') {
        this.setSuggestState('idle')
      }
    })
    this.suggestButton = document.createElement('button')
    this.suggestButton.type = 'submit'
    this.suggestButton.className = 'vibes__suggest-btn'
    this.suggestButton.textContent = STRINGS.vibes.suggestSubmit
    this.suggestButton.disabled = true
    row.append(this.suggestInput, this.suggestButton)
    suggest.append(row)

    this.suggestStatusEl = document.createElement('p')
    this.suggestStatusEl.className = 'vibes__suggest-status'
    this.suggestStatusEl.setAttribute('role', 'status')
    this.suggestStatusEl.setAttribute('aria-live', 'polite')
    suggest.append(this.suggestStatusEl)

    this.root.append(suggest)

    this.renderProgress()
    this.renderTopCard()
  }

  element(): HTMLElement {
    return this.root
  }

  /** Append more cards to the local queue, filtering out anything we've
   * already voted on this session (server already filters, but a stale
   * deal can cross with a fresh vote). */
  appendCards(cards: VibeCard[]): void {
    this.requestInFlight = false
    for (const card of cards) {
      if (this.voted.has(card.id)) continue
      if (this.queue.some((c) => c.id === card.id)) continue
      this.queue.push(card)
    }
    this.renderTopCard()
  }

  /** Server ack for a suggestion the user submitted. */
  acknowledgeSuggest(result: 'created' | 'deduped' | 'rate-limited' | 'invalid', card?: VibeCard): void {
    if (result === 'created' && card) {
      this.queue.unshift(card)
      this.suggestInput.value = ''
      this.setSuggestState('created')
    } else if (result === 'deduped' && card) {
      // Front the deduped card so the user can vote on the existing
      // version they didn't realise was already in the pool.
      if (!this.voted.has(card.id) && !this.queue.some((c) => c.id === card.id)) {
        this.queue.unshift(card)
      }
      this.suggestInput.value = ''
      this.setSuggestState('deduped')
    } else if (result === 'rate-limited') {
      this.setSuggestState('rate-limited')
    } else {
      this.setSuggestState('invalid')
    }
    this.updateSuggestButton()
    this.renderTopCard()
  }

  /** Network-level failure of an in-flight suggestion (the WS dropped). */
  failSuggest(): void {
    if (this.suggestState !== 'pending') return
    this.setSuggestState('network-error')
    this.updateSuggestButton()
  }

  destroy(): void {
    this.root.remove()
  }

  private renderTopCard(): void {
    this.cardArea.replaceChildren()
    this.emptyEl.hidden = this.queue.length !== 0
    const top = this.queue[0]
    if (!top) {
      if (this.shouldPrefetch()) this.requestMore()
      this.renderProgress()
      return
    }
    const card = this.buildCard(top)
    this.cardArea.append(card)
    if (this.shouldPrefetch()) this.requestMore()
    this.renderProgress()
  }

  private buildCard(card: VibeCard): HTMLElement {
    const wrapper = document.createElement('article')
    wrapper.className = 'vibes__card'
    wrapper.dataset.id = card.id
    wrapper.setAttribute('aria-label', card.label)

    const label = document.createElement('h2')
    label.className = 'vibes__card-label'
    label.textContent = card.label
    wrapper.append(label)

    const count = document.createElement('p')
    count.className = 'vibes__card-count'
    count.textContent = card.voteCount > 0 ? `${card.voteCount} votes so far` : 'first to weigh in'
    wrapper.append(count)

    const actions = document.createElement('div')
    actions.className = 'vibes__actions'
    const disagree = makeActionButton(
      'disagree',
      STRINGS.vibes.disagreeEmoji,
      STRINGS.vibes.disagree,
      () => this.commitVote(card.id, -1),
    )
    const pass = makeActionButton(
      'pass',
      STRINGS.vibes.passEmoji,
      STRINGS.vibes.pass,
      () => this.commitVote(card.id, 0),
    )
    const agree = makeActionButton(
      'agree',
      STRINGS.vibes.agreeEmoji,
      STRINGS.vibes.agree,
      () => this.commitVote(card.id, 1),
    )
    actions.append(disagree, pass, agree)
    wrapper.append(actions)

    this.attachSwipeHandlers(wrapper, card.id)
    return wrapper
  }

  private attachSwipeHandlers(card: HTMLElement, promptId: string): void {
    let startX = 0
    let startY = 0
    let dragging = false

    const start = (event: PointerEvent): void => {
      if (event.button !== 0 && event.pointerType !== 'touch') return
      // A pointerdown on a button inside the card must not steal the
      // pointer — otherwise the card's setPointerCapture eats the
      // click before it reaches the action handler.
      const target = event.target
      if (target instanceof HTMLElement && target.closest('button')) return
      dragging = true
      startX = event.clientX
      startY = event.clientY
      card.setPointerCapture(event.pointerId)
    }
    const move = (event: PointerEvent): void => {
      if (!dragging) return
      const dx = event.clientX - startX
      const dy = event.clientY - startY
      card.style.transform = `translate(${dx}px, ${dy}px) rotate(${dx * 0.06}deg)`
      card.style.opacity = String(Math.max(0.3, 1 - Math.abs(dx) / 320))
    }
    const end = (event: PointerEvent): void => {
      if (!dragging) return
      dragging = false
      card.releasePointerCapture(event.pointerId)
      const dx = event.clientX - startX
      const dy = event.clientY - startY
      card.style.transform = ''
      card.style.opacity = ''
      if (dx > SWIPE_COMMIT_PX) this.commitVote(promptId, 1)
      else if (dx < -SWIPE_COMMIT_PX) this.commitVote(promptId, -1)
      else if (dy < -SWIPE_COMMIT_PX) this.commitVote(promptId, 0)
    }

    card.addEventListener('pointerdown', start)
    card.addEventListener('pointermove', move)
    card.addEventListener('pointerup', end)
    card.addEventListener('pointercancel', end)
  }

  private commitVote(promptId: string, vote: 1 | 0 | -1): void {
    // Guard against double-submission (a quick tap mid-swipe).
    if (this.voted.has(promptId)) return
    if (this.queue[0]?.id !== promptId) return
    this.voted.add(promptId)
    this.votesCast++
    this.queue.shift()
    this.handlers.onVote(promptId, vote)
    this.renderTopCard()
  }

  private renderProgress(): void {
    if (this.queue.length === 0 && this.votesCast === 0) {
      this.progressEl.textContent = ''
      return
    }
    this.progressEl.textContent =
      this.votesCast === 0
        ? STRINGS.vibes.progressFirst
        : interpolate(STRINGS.vibes.progress, { n: this.votesCast })
  }

  private shouldPrefetch(): boolean {
    return !this.requestInFlight && this.queue.length <= PREFETCH_THRESHOLD
  }

  private requestMore(): void {
    this.requestInFlight = true
    this.handlers.onRequestCards()
  }

  private submitSuggestion(): void {
    const value = this.suggestInput.value.trim()
    if (!value) return
    if (this.suggestState === 'pending') return
    this.setSuggestState('pending')
    this.updateSuggestButton()
    this.handlers.onSuggest(value)
  }

  private setSuggestState(state: SuggestState): void {
    this.suggestState = state
    const status = (() => {
      switch (state) {
        case 'created':
          return STRINGS.vibes.suggestAddedCreated
        case 'deduped':
          return STRINGS.vibes.suggestAddedDeduped
        case 'rate-limited':
          return STRINGS.vibes.suggestRateLimited
        case 'invalid':
          return STRINGS.vibes.suggestInvalid
        case 'network-error':
          return STRINGS.vibes.suggestNetwork
        case 'pending':
          return ''
        default:
          return ''
      }
    })()
    this.suggestStatusEl.textContent = status
  }

  private updateSuggestButton(): void {
    const value = this.suggestInput.value.trim()
    this.suggestButton.disabled = value.length === 0 || this.suggestState === 'pending'
  }
}

function makeActionButton(
  kind: 'agree' | 'pass' | 'disagree',
  glyph: string,
  ariaLabel: string,
  onClick: () => void,
): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = `vibes__action vibes__action--${kind}`
  button.textContent = glyph
  // Glyph is decorative; screen-readers + assistive tech read the label.
  button.setAttribute('aria-label', ariaLabel)
  button.addEventListener('click', onClick)
  return button
}
