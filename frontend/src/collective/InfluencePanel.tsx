/** DJ influence macro + crowd pad target (Phase 1 surface; docs/collective/PLAN.md §2, §7c).
 *
 * Phase 1 wires the macro into the bridge: amount scales every prompt
 * weight the aggregator pushes, lock drops crowd influence to 0
 * immediately (`bridge.ts`). The panel also surfaces the bridge status
 * and the active room code so the DJ has one place to read the live
 * connection + the join code (the host-screen renders the QR for the
 * room, but the panel is what the DJ glances at). */

import { useTranslation } from 'react-i18next'

import { Button } from '../ui/Button'
import { Knob } from '../ui/Knob'
import { Panel } from '../ui/Panel'
import { Stat } from '../ui/Stat'
import type { CrowdInfluence, PolicyChoice } from './influence'
import { isCollectiveEnabled } from './flag'
import type { BridgeStatus } from './useBridge'

const POLICY_CHOICES: readonly PolicyChoice[] = ['auto', 'pr', 'maximin']

type InfluencePanelProps = {
  influence: CrowdInfluence
  onChange: (next: CrowdInfluence) => void
  status: BridgeStatus
}

export function InfluencePanel({ influence, onChange, status }: InfluencePanelProps) {
  const { t } = useTranslation()
  if (!isCollectiveEnabled()) return null
  const liveTarget = status.intent?.prompts ?? []
  const targetSummary = liveTarget.length
    ? liveTarget
        .slice(0, 3)
        .map(({ text, weight }) =>
          t('collective.influence.crowdTargetItem', {
            percent: Math.round(weight * 100),
            text,
          }),
        )
        .join(' · ')
    : t('collective.influence.crowdTargetIdle')
  return (
    <Panel
      className="collective-influence"
      label={t('collective.influence.title')}
      aria-label={t('collective.influence.title')}
    >
      <Knob
        label={t('collective.influence.amount')}
        value={influence.amount}
        resetValue={0}
        onChange={(amount) => onChange({ ...influence, amount })}
      />
      <Button
        lit={influence.locked}
        aria-pressed={influence.locked}
        onClick={() => onChange({ ...influence, locked: !influence.locked })}
      >
        {t('collective.influence.lock')}
      </Button>
      <div
        className="collective-influence__policy"
        role="radiogroup"
        aria-label={t('collective.influence.policy')}
      >
        <span className="collective-influence__policy-label">
          {t('collective.influence.policy')}
        </span>
        {POLICY_CHOICES.map((choice) => (
          <Button
            key={choice}
            role="radio"
            aria-checked={influence.policy === choice}
            lit={influence.policy === choice}
            onClick={() => {
              onChange({ ...influence, policy: choice })
              status.selectPolicy(choice)
            }}
          >
            {t(`collective.influence.policyChoice.${choice}`)}
          </Button>
        ))}
      </div>
      <Stat
        label={t('collective.influence.crowdTarget')}
        value={targetSummary}
      />
      <Stat
        label={t('collective.influence.room')}
        value={status.room ? status.room.code : t('collective.influence.roomConnecting')}
      />
      <Stat
        label={t('collective.influence.bridge')}
        value={t(`collective.influence.bridgeState.${status.bridge.kind}`)}
        tone={status.bridge.kind === 'offline' ? 'danger' : 'default'}
      />
    </Panel>
  )
}
