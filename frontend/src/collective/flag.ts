/** Collective-intelligence layer feature flag (Phase 0).
 *
 * Reads `VITE_COLLECTIVE_ENABLED` at build time. Off by default — the rest
 * of the collective code gates on `isCollectiveEnabled()` so SlipMate behaves
 * exactly as before until the operator opts in (docs/collective/PLAN.md §10
 * hard rule). Build-time, not runtime, because Vite inlines `import.meta.env`. */

export function isCollectiveEnabled(): boolean {
  return import.meta.env.VITE_COLLECTIVE_ENABLED === '1'
}
