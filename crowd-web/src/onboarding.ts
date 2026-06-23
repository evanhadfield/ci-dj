/** Onboarding overlay (PLAN.md §7b): one-line free-text seed +
 * tap-3-vibes pick. Submitting casts 3 first votes and dismisses the
 * overlay. Skip is always present. */

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

  const seedInput = document.createElement('input')
  seedInput.id = 'onboarding-seed'
  seedInput.className = 'onboarding__input'
  seedInput.type = 'text'
  seedInput.placeholder = STRINGS.onboarding.seedPlaceholder
  seedInput.autocomplete = 'off'
  seedInput.maxLength = 80
  seedInput.addEventListener('input', () => {
    if (seedInput.value.length > 0) {
      chipSelected = null
      renderChips()
    }
    renderFooter()
  })
  seedInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      if (!submitBtn.disabled) submitBtn.click()
    }
  })
  inner.append(seedInput)

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
        if (chipSelected) seedInput.value = ''
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
  /** True iff the user has given us any first-touch signal at all. Per
   * PLAN.md §7b the free-text, the opt-out chips, and the pick-3 are
   * each independently valid — submit must accept whichever the user
   * actually chose. */
  function hasAnySignal(): boolean {
    return picks.size === 3 || seedInput.value.trim().length > 0 || chipSelected !== null
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
    const seedText = seedInput.value.trim() || chipSelected || ''
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
