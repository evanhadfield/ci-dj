/** The Now screen (PLAN.md §7b.1): current vibe label + temperature
 * gauge + big like/dislike buttons + "the room is shifting…" indicator. */

import { STRINGS, interpolate } from './strings.ts'

export type NowState = {
  label: string
  /** EWMA temperature in `[-1, +1]`. */
  temperature: number
  shifting: boolean
  participants: number
}

export type NowHandlers = {
  onLike: () => void
  onDislike: () => void
}

const FLASH_MS = 700

export class NowScreen {
  private readonly root: HTMLElement
  private readonly labelEl: HTMLElement
  private readonly shiftingEl: HTMLElement
  private readonly gaugeFill: HTMLElement
  private readonly likeBtn: HTMLButtonElement
  private readonly dislikeBtn: HTMLButtonElement
  private readonly participantsEl: HTMLElement
  private flashTimers: number[] = []

  constructor(handlers: NowHandlers) {
    this.root = document.createElement('section')
    this.root.className = 'now'
    this.root.setAttribute('aria-labelledby', 'now-label')

    const heading = document.createElement('div')
    heading.className = 'now__heading'
    const eyebrow = document.createElement('p')
    eyebrow.className = 'eyebrow'
    eyebrow.textContent = STRINGS.now.eyebrow
    this.labelEl = document.createElement('h2')
    this.labelEl.className = 'now__label'
    this.labelEl.id = 'now-label'
    this.labelEl.textContent = STRINGS.now.waiting
    this.shiftingEl = document.createElement('p')
    this.shiftingEl.className = 'now__shifting'
    this.shiftingEl.setAttribute('role', 'status')
    this.shiftingEl.setAttribute('aria-live', 'polite')
    this.shiftingEl.textContent = STRINGS.now.shifting
    heading.append(eyebrow, this.labelEl, this.shiftingEl)
    this.root.append(heading)

    const gauge = document.createElement('div')
    gauge.className = 'now__gauge'
    const gaugeTrack = document.createElement('div')
    gaugeTrack.className = 'now__gauge-track'
    gaugeTrack.setAttribute('role', 'progressbar')
    gaugeTrack.setAttribute('aria-valuemin', '-1')
    gaugeTrack.setAttribute('aria-valuemax', '1')
    gaugeTrack.setAttribute('aria-valuenow', '0')
    this.gaugeFill = document.createElement('div')
    this.gaugeFill.className = 'now__gauge-fill'
    const gaugeCenter = document.createElement('div')
    gaugeCenter.className = 'now__gauge-center'
    gaugeTrack.append(this.gaugeFill, gaugeCenter)
    const gaugeCaption = document.createElement('div')
    gaugeCaption.className = 'now__gauge-caption'
    const captionLeft = document.createElement('span')
    captionLeft.textContent = '−'
    const captionRight = document.createElement('span')
    captionRight.textContent = '+'
    gaugeCaption.append(captionLeft, captionRight)
    gauge.append(gaugeTrack, gaugeCaption)
    this.root.append(gauge)

    const actions = document.createElement('div')
    actions.className = 'now__actions'
    this.dislikeBtn = makeReactionButton('dislike', STRINGS.now.dislike, handlers.onDislike, () =>
      this.flash(this.dislikeBtn),
    )
    this.likeBtn = makeReactionButton('like', STRINGS.now.like, handlers.onLike, () =>
      this.flash(this.likeBtn),
    )
    actions.append(this.likeBtn, this.dislikeBtn)
    this.root.append(actions)

    this.participantsEl = document.createElement('p')
    this.participantsEl.className = 'now__participants'
    this.participantsEl.textContent = ''
    this.root.append(this.participantsEl)
  }

  element(): HTMLElement {
    return this.root
  }

  update(state: NowState): void {
    this.labelEl.textContent = state.label || STRINGS.now.waiting
    this.shiftingEl.classList.toggle('now__shifting--on', state.shifting)
    const clamped = Math.max(-1, Math.min(1, state.temperature))
    if (clamped >= 0) {
      this.gaugeFill.style.left = '50%'
      this.gaugeFill.style.right = `${50 - clamped * 50}%`
    } else {
      this.gaugeFill.style.left = `${50 + clamped * 50}%`
      this.gaugeFill.style.right = '50%'
    }
    this.gaugeFill.parentElement?.setAttribute('aria-valuenow', clamped.toFixed(2))
    this.participantsEl.textContent =
      state.participants > 0
        ? interpolate(STRINGS.now.participants, { n: state.participants })
        : ''
  }

  private flash(button: HTMLButtonElement): void {
    button.classList.add('now__btn--just-tapped')
    const id = window.setTimeout(() => {
      button.classList.remove('now__btn--just-tapped')
    }, FLASH_MS)
    this.flashTimers.push(id)
  }

  destroy(): void {
    for (const id of this.flashTimers) clearTimeout(id)
    this.root.remove()
  }
}

function makeReactionButton(
  kind: 'like' | 'dislike',
  label: string,
  onTap: () => void,
  onFlash: () => void,
): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = `now__btn now__btn--${kind}`
  button.setAttribute('aria-label', label)
  const labelSpan = document.createElement('span')
  labelSpan.textContent = label
  const flashSpan = document.createElement('span')
  flashSpan.className = 'now__btn-flash'
  flashSpan.textContent = STRINGS.now.added
  button.append(labelSpan, flashSpan)
  button.addEventListener('click', () => {
    onTap()
    onFlash()
  })
  return button
}
