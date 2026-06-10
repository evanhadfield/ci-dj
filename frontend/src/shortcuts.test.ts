import { beforeEach, describe, expect, it } from 'vitest'

import { handleShortcutKey } from './shortcuts'

function pressOn(target: EventTarget, key: string, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent('keydown', { key, cancelable: true, ...init })
  Object.defineProperty(event, 'target', { value: target })
  handleShortcutKey(event)
  return event
}

describe('handleShortcutKey', () => {
  let promptA: HTMLInputElement
  let crossfade: HTMLInputElement

  beforeEach(() => {
    document.body.innerHTML = ''
    promptA = document.createElement('input')
    promptA.setAttribute('data-shortcut', 'deck-a-prompt')
    crossfade = document.createElement('input')
    crossfade.setAttribute('data-shortcut', 'crossfade')
    document.body.append(promptA, crossfade)
  })

  it('focuses the mapped control', () => {
    pressOn(document.body, 'a')
    expect(document.activeElement).toBe(promptA)
    pressOn(document.body, 'x')
    expect(document.activeElement).toBe(crossfade)
  })

  it('never steals focus while typing in an input', () => {
    crossfade.focus()
    pressOn(crossfade, 'a')
    expect(document.activeElement).toBe(crossfade)
  })

  it('ignores chords with modifier keys', () => {
    pressOn(document.body, 'a', { metaKey: true })
    expect(document.activeElement).not.toBe(promptA)
  })

  it('leaves unmapped keys alone', () => {
    const event = pressOn(document.body, 'q')
    expect(event.defaultPrevented).toBe(false)
  })
})
