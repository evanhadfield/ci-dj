/** Collective-intelligence layer feature flag (Phase 0/1).
 *
 * Reads `VITE_COLLECTIVE_ENABLED` at build time. Off by default — the rest
 * of the collective code gates on `isCollectiveEnabled()` so SlipMate behaves
 * exactly as before until the operator opts in (docs/collective/PLAN.md §10
 * hard rule). Build-time, not runtime, because Vite inlines `import.meta.env`. */

export function isCollectiveEnabled(): boolean {
  return import.meta.env.VITE_COLLECTIVE_ENABLED === '1'
}

/** Aggregator base URL the bridge dials (Phase 1). Defaults to
 * loopback:3030 so a local `npm start` from `aggregator/` Just Works.
 * Override with `VITE_AGGREGATOR_URL` for LAN / staged deployments. */
export function aggregatorUrl(): string {
  return import.meta.env.VITE_AGGREGATOR_URL ?? 'http://localhost:3030'
}

/** Optional shared token the aggregator demands on `/ws/bridge` upgrades
 * when binding past loopback (`AGGREGATOR_BRIDGE_TOKEN` on the
 * aggregator side, `VITE_AGGREGATOR_BRIDGE_TOKEN` here). */
export function bridgeToken(): string | undefined {
  return import.meta.env.VITE_AGGREGATOR_BRIDGE_TOKEN || undefined
}
