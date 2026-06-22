/** DJ influence macro + crowd pad target (Phase 0 UI surface; docs/collective/PLAN.md §2).
 *
 * Inert by design: when the feature flag is off this renders nothing,
 * and when it is on the controls move but no signal is sent and no
 * audio is touched. Phase 1 wires the knob into the bridge and the
 * crowd target onto the deck's XY pad. */

import { useTranslation } from 'react-i18next'

import { Button } from '../ui/Button'
import { Knob } from '../ui/Knob'
import { Panel } from '../ui/Panel'
import { Stat } from '../ui/Stat'
import type { CrowdInfluence } from './influence'
import { isCollectiveEnabled } from './flag'

type InfluencePanelProps = {
  influence: CrowdInfluence
  onChange: (next: CrowdInfluence) => void
}

export function InfluencePanel({ influence, onChange }: InfluencePanelProps) {
  const { t } = useTranslation()
  if (!isCollectiveEnabled()) return null
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
      <Stat
        label={t('collective.influence.crowdTarget')}
        value={t('collective.influence.crowdTargetIdle')}
      />
    </Panel>
  )
}
