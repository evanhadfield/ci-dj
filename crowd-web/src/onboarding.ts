/** Onboarding overlay (PLAN.md §7b): one-line free-text seed +
 * tap-3-vibes pick. Submitting casts 3 first votes and dismisses the
 * overlay. Skip is always present.
 *
 * UX shape: the free-text and the pick-3 cards are *independent* first-
 * touches, not sequential. Enter inside the seed field captures the
 * typed text into a visible "saved" pill (the user gets the receipt
 * they want without the overlay closing); the cards remain available
 * after that, so the same flow yields text-only, picks-only, or both.
 *
 * Phase 1 caveat: PLAN.md §7b promises the free-text becomes a deduped
 * vibe-prompt visible to other phones — but the semantic dedupe lives
 * on `/api/embed` and the shared vibe-prompt pool is the Phase 2 Vibes
 * screen (PROMPT.md). Phase 1 stores the text client-side via
 * `seedText` so Phase 2 can promote it; the pill copy says so. */

import { STRINGS } from './strings.ts'
import type { VibePrompt } from './types.ts'

export type OnboardingResult = {
  picks: string[]
  /** Free-text seed or chip selection (PLAN.md §7b). Phase 1 stores
   * this client-side only; Phase 2 sends it to /api/embed for semantic
   * dedupe and adds it to the vibe-prompt pool. */
  seedText: string
}

export type OnboardingOptions = {
  vibes: VibePrompt[]
  onSubmit: (result: OnboardingResult) => void
  onSkip: () => void
}

/** Mount the onboarding overlay; returns a `dismiss` for the caller to
 * tear it down (also called automatically on submit/skip). */
export function mountOnboarding(
  parent: HTMLElement,
  options: OnboardingOptions,
): { dismiss: () => void } {
  const overlay = document.createElement('div')
  overlay.className = 'onboarding'
  overlay.setAttribute('role', 'dialog')
  overlay.setAttribute('aria-modal', 'true')
  overlay.setAttribute('aria-label', STRINGS.onboarding.title)

  const picks = new Set<string>()
  let chipSelected: string | null = null
  /** The free-text after the user explicitly accepts it (Enter / Save).
   * Until accepted the input value is provisional and doesn't count
   * toward the submission. */
  let confirmedText: string | null = null

  const inner = document.createElement('div')
  inner.className = 'onboarding__inner'
  overlay.append(inner)

  const heading = document.createElement('h1')
  heading.className = 'onboarding__title'
  heading.textContent = STRINGS.onboarding.title
  inner.append(heading)

  const seedLabel = document.createElement('label')
  seedLabel.className = 'onboarding__field-label'
  seedLabel.textContent = STRINGS.onboarding.seedLabel
  seedLabel.htmlFor = 'onboarding-seed'
  inner.append(seedLabel)

  const seedRow = document.createElement('div')
  seedRow.className = 'onboarding__seed-row'
  inner.append(seedRow)

  const seedInput = document.createElement('input')
  seedInput.id = 'onboarding-seed'
  seedInput.className = 'onboarding__input'
  seedInput.type = 'text'
  seedInput.placeholder = STRINGS.onboarding.seedPlaceholder
  seedInput.autocomplete = 'off'
  seedInput.maxLength = 80
  seedRow.append(seedInput)

  const seedSave = document.createElement('button')
  seedSave.type = 'button'
  seedSave.className = 'onboarding__seed-save'
  seedSave.textContent = STRINGS.onboarding.seedConfirm
  seedSave.disabled = true
  seedRow.append(seedSave)

  /** The pill that confirms the typed text has been captured. Empty
   * until the user hits Enter / Save, then carries an Edit + Remove. */
  const seedPill = document.createElement('div')
  seedPill.className = 'onboarding__seed-pill'
  seedPill.hidden = true
  inner.append(seedPill)

  function confirmSeedText(): void {
    const value = seedInput.value.trim()
    if (!value) return
    confirmedText = value
    chipSelected = null
    seedInput.value = ''
    renderSeedPill()
    renderChips()
    renderFooter()
  }

  function clearSeedText(): void {
    confirmedText = null
    renderSeedPill()
    renderFooter()
  }

  function renderSeedPill(): void {
    seedPill.replaceChildren()
    if (!confirmedText) {
      seedPill.hidden = true
      return
    }
    seedPill.hidden = false
    const label = document.createElement('span')
    label.className = 'onboarding__seed-pill-label'
    label.textContent = confirmedText
    seedPill.append(label)
    const note = document.createElement('span')
    note.className = 'onboarding__seed-pill-note'
    note.textContent = STRINGS.onboarding.seedNote
    seedPill.append(note)
    const actions = document.createElement('div')
    actions.className = 'onboarding__seed-pill-actions'
    const editBtn = document.createElement('button')
    editBtn.type = 'button'
    editBtn.className = 'onboarding__seed-pill-action'
    editBtn.textContent = STRINGS.onboarding.seedEdit
    editBtn.addEventListener('click', () => {
      seedInput.value = confirmedText ?? ''
      confirmedText = null
      renderSeedPill()
      renderFooter()
      // Move the cursor to the end of the field for editing.
      requestAnimationFrame(() => {
        seedInput.focus()
        const len = seedInput.value.length
        seedInput.setSelectionRange(len, len)
      })
    })
    const removeBtn = document.createElement('button')
    removeBtn.type = 'button'
    removeBtn.className = 'onboarding__seed-pill-action'
    removeBtn.textContent = STRINGS.onboarding.seedRemove
    removeBtn.addEventListener('click', clearSeedText)
    actions.append(editBtn, removeBtn)
    seedPill.append(actions)
  }

  seedInput.addEventListener('input', () => {
    if (seedInput.value.length > 0) {
      chipSelected = null
      renderChips()
    }
    seedSave.disabled = seedInput.value.trim().length === 0
    renderFooter()
  })
  seedInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      confirmSeedText()
    }
  })
  seedSave.addEventListener('click', confirmSeedText)

  const chipsRow = document.createElement('div')
  chipsRow.className = 'onboarding__chips'
  function renderChips() {
    chipsRow.replaceChildren()
    for (const chip of STRINGS.onboarding.chips) {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = `onboarding__chip${chip === chipSelected ? ' onboarding__chip--on' : ''}`
      button.textContent = chip
      button.addEventListener('click', () => {
        chipSelected = chipSelected === chip ? null : chip
        if (chipSelected) {
          seedInput.value = ''
          seedSave.disabled = true
          // A chip choice is the "opt-out" path — silently clears any
          // confirmed text so we don't keep two contradictory seeds.
          confirmedText = null
          renderSeedPill()
        }
        renderChips()
        renderFooter()
      })
      chipsRow.append(button)
    }
  }
  renderChips()
  inner.append(chipsRow)

  const pickPrompt = document.createElement('p')
  pickPrompt.className = 'eyebrow'
  pickPrompt.textContent = STRINGS.onboarding.pickPrompt
  pickPrompt.style.marginTop = '0.5rem'
  inner.append(pickPrompt)

  const cards = document.createElement('div')
  cards.className = 'onboarding__cards'
  function renderCards() {
    cards.replaceChildren()
    for (const vibe of options.vibes) {
      const button = document.createElement('button')
      button.type = 'button'
      const selectedIndex = [...picks].indexOf(vibe.id)
      button.className = `onboarding__card${selectedIndex >= 0 ? ' onboarding__card--on' : ''}`
      button.setAttribute('aria-pressed', String(selectedIndex >= 0))
      const label = document.createElement('span')
      label.textContent = vibe.label
      button.append(label)
      if (selectedIndex >= 0) {
        const index = document.createElement('span')
        index.className = 'onboarding__card-index'
        index.textContent = String(selectedIndex + 1)
        button.append(index)
      }
      button.addEventListener('click', () => {
        if (picks.has(vibe.id)) picks.delete(vibe.id)
        else if (picks.size < 3) picks.add(vibe.id)
        renderCards()
        renderFooter()
      })
      cards.append(button)
    }
  }
  renderCards()
  inner.append(cards)

  const footer = document.createElement('div')
  footer.className = 'onboarding__footer'
  inner.append(footer)
  const submitBtn = document.createElement('button')
  submitBtn.type = 'button'
  submitBtn.className = 'onboarding__submit'
  /** True iff the user has given us any first-touch signal at all.
   * Confirmed text, chip, or three picks all count — the form accepts
   * whichever path the user actually completed. */
  function hasAnySignal(): boolean {
    return picks.size === 3 || confirmedText !== null || chipSelected !== null
  }
  function renderFooter() {
    footer.replaceChildren()
    const enabled = hasAnySignal()
    submitBtn.textContent = enabled
      ? STRINGS.onboarding.submit
      : STRINGS.onboarding.submitEmpty
    submitBtn.disabled = !enabled
    footer.append(submitBtn)
    const skipBtn = document.createElement('button')
    skipBtn.type = 'button'
    skipBtn.className = 'onboarding__skip'
    skipBtn.textContent = STRINGS.onboarding.skip
    skipBtn.addEventListener('click', () => {
      dismiss()
      options.onSkip()
    })
    footer.append(skipBtn)
  }
  submitBtn.addEventListener('click', () => {
    if (submitBtn.disabled) return
    const seedText = confirmedText ?? chipSelected ?? ''
    dismiss()
    options.onSubmit({ picks: [...picks], seedText })
  })
  renderFooter()

  parent.append(overlay)

  function dismiss(): void {
    overlay.remove()
  }

  // Focus the seed input so a keyboard pops up on phones immediately —
  // the user can dismiss it with a tap if they prefer to start with cards.
  queueMicrotask(() => seedInput.focus())

  return { dismiss }
}
