import { useEffect, useState } from 'react'

const POLL_MS = 100

type PhaseMeterProps = {
  label: string
  /** Offset in beats, [-0.5, 0.5), or null when either side's clock
   * is unconfident — the meter goes dark rather than guessing
   * (ADR-0014). Polled, the LevelMeter pattern. */
  getOffset: () => number | null
}

/** Beat-phase meter (M20): the needle sits centre when the decks'
 * beats coincide, drifts right when the track runs late. */
export function PhaseMeter({ label, getOffset }: PhaseMeterProps) {
  const [offset, setOffset] = useState<number | null>(null)
  useEffect(() => {
    const timer = setInterval(() => setOffset(getOffset()), POLL_MS)
    return () => clearInterval(timer)
  }, [getOffset])

  return (
    <div
      className={`ui-phasemeter${offset === null ? ' ui-phasemeter--blank' : ''}`}
      role="img"
      aria-label={label}
    >
      <span className="ui-phasemeter__label">{label}</span>
      <div className="ui-phasemeter__track">
        <div className="ui-phasemeter__centre" />
        {offset !== null && (
          <div
            className="ui-phasemeter__needle"
            style={{ left: `${(offset + 0.5) * 100}%` }}
          />
        )}
      </div>
    </div>
  )
}
