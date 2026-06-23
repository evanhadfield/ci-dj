/** Per-room device storage — persists the session token and the user's
 * onboarding state so a reconnect resumes mid-set (PLAN.md §7a step 5,
 * §7d "reconnect after sleep: silent resume"). */

const KEY_PREFIX = 'slipmate.collective.'

export type Stored = {
  sessionToken?: string
  seeded?: boolean
}

function key(code: string): string {
  return `${KEY_PREFIX}${code.toUpperCase()}`
}

export function loadStored(code: string): Stored {
  try {
    const raw = localStorage.getItem(key(code))
    if (!raw) return {}
    const parsed = JSON.parse(raw) as Stored
    return typeof parsed === 'object' && parsed ? parsed : {}
  } catch {
    return {}
  }
}

export function saveStored(code: string, value: Stored): void {
  try {
    const merged = { ...loadStored(code), ...value }
    localStorage.setItem(key(code), JSON.stringify(merged))
  } catch {
    // Storage may be disabled (private mode / quota). The pipeline
    // still works without resume — we just re-onboard the user.
  }
}
