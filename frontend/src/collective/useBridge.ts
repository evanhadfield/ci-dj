/** Bridge orchestrator (Phase 1): with the collective flag on, fetch
 * the active room from the aggregator, open the bridge WebSocket, and
 * keep it alive for the lifetime of the component.
 *
 * The hook surfaces three things back to the UI:
 *   - the room code + join URL + QR (the influence panel shows the
 *     join code so the DJ can project it without a separate
 *     host-screen process);
 *   - the bridge connection state (so the panel can dim "crowd target"
 *     when the aggregator is unreachable — the §9 fail-safe);
 *   - the last crowd target the aggregator pushed (the panel renders
 *     it as a label even when the macro is at 0). */

import { useEffect, useRef, useState } from 'react'

import { aggregatorUrl, bridgeToken, isCollectiveEnabled } from './flag'
import { CollectiveBridge, type BridgeIntent, type BridgeState } from './bridge'
import type { CrowdInfluence, PolicyChoice } from './influence'

export type RoomInfo = {
  code: string
  joinUrl: string
  qrSvg: string
}

export type BridgeStatus = {
  room: RoomInfo | null
  bridge: BridgeState
  intent: BridgeIntent | null
  /** Phase 3 §6: ask the aggregator to switch policies. No-op when the
   * bridge socket is closed; the next reconnect re-pushes whichever
   * value the influence state currently holds. */
  selectPolicy: (choice: PolicyChoice) => void
}

const NOOP_POLICY = () => {}

const INITIAL_STATUS: BridgeStatus = {
  room: null,
  bridge: { kind: 'idle' },
  intent: null,
  selectPolicy: NOOP_POLICY,
}

export function useCollectiveBridge(influence: CrowdInfluence): BridgeStatus {
  const influenceRef = useRef(influence)
  const bridgeRef = useRef<CollectiveBridge | null>(null)
  // The bridge's gate (bridge.ts) reads `influenceRef.current` whenever
  // an intent arrives. Writing the ref in an effect (not in render)
  // satisfies React's "no side-effects in render" rule; the effect runs
  // after each commit so the ref always trails the latest influence by
  // one tick at most — fine for a control whose UX latency is already
  // dominated by the model's ~3s reaction phrase (PLAN.md §5).
  useEffect(() => {
    influenceRef.current = influence
  }, [influence])
  // Phase 3 §6: keep the aggregator's stored policy choice in sync
  // with the panel's. A click on InfluencePanel sends `policy_select`
  // immediately, but if the bridge socket was briefly closed at click
  // time the message silently drops. This effect re-sends whenever
  // `influence.policy` changes; the bridge itself also re-sends on
  // every `open`, so the two paths together close any window where
  // the panel and server could disagree.
  useEffect(() => {
    bridgeRef.current?.selectPolicy(influence.policy)
  }, [influence.policy])
  const [status, setStatus] = useState<BridgeStatus>(INITIAL_STATUS)

  useEffect(() => {
    if (!isCollectiveEnabled()) return
    let cancelled = false
    const url = aggregatorUrl()

    fetch(`${url.replace(/\/$/, '')}/api/rooms/active`)
      .then((res) => {
        if (!res.ok) throw new Error(`aggregator: ${res.status}`)
        return res.json() as Promise<RoomInfo>
      })
      .then((room) => {
        if (cancelled) return
        const bridge = new CollectiveBridge({
          aggregatorUrl: url,
          roomCode: room.code,
          token: bridgeToken(),
          influenceRef,
          onState: (state) => setStatus((s) => ({ ...s, bridge: state })),
          onIntent: (intent) => setStatus((s) => ({ ...s, intent })),
        })
        bridgeRef.current = bridge
        const selectPolicy: BridgeStatus['selectPolicy'] = (choice) => bridge.selectPolicy(choice)
        setStatus((s) => ({ ...s, room, selectPolicy }))
        bridge.start()
      })
      .catch(() => {
        if (cancelled) return
        // Aggregator unreachable: the panel surfaces this as "offline"
        // and the deck stays exactly where the DJ left it (§9).
        setStatus((s) => ({ ...s, bridge: { kind: 'offline' } }))
      })

    return () => {
      cancelled = true
      bridgeRef.current?.stop()
      bridgeRef.current = null
    }
  }, [])

  return status
}
