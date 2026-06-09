import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'

import type { DeckId } from './audio/engine'
import { Deck } from './deck/Deck'
import type { RamInfo } from './deck/deckState'
import { Mixer } from './mixer/Mixer'

// Above this share of total RAM, the combined model selection gets a
// warning banner — a guardrail, not enforcement (see backend estimates).
const RAM_COMFORT_FRACTION = 0.6

function App() {
  const { t } = useTranslation()
  const [crossfade, setCrossfade] = useState(0.5)
  const [deckModels, setDeckModels] = useState<Record<DeckId, string | null>>({
    a: null,
    b: null,
  })
  const [ramInfo, setRamInfo] = useState<RamInfo | null>(null)

  const handleModelChange = useCallback(
    (deckId: DeckId, model: string | null, info: RamInfo | null) => {
      setDeckModels((previous) =>
        previous[deckId] === model ? previous : { ...previous, [deckId]: model },
      )
      if (info) setRamInfo((previous) => previous ?? info)
    },
    [],
  )

  const ramWarning = combinedRamWarning(deckModels, ramInfo)

  return (
    <main className="app">
      <h1 className="app__title">{t('app.title')}</h1>
      {ramWarning && (
        <p className="app__warning" role="status">
          {t('app.ramWarning', ramWarning)}
        </p>
      )}
      <div className="app__decks">
        <Deck id="a" onModelChange={handleModelChange} />
        <Deck id="b" onModelChange={handleModelChange} />
      </div>
      <Mixer crossfade={crossfade} onCrossfadeChange={setCrossfade} />
    </main>
  )
}

function combinedRamWarning(
  deckModels: Record<DeckId, string | null>,
  ramInfo: RamInfo | null,
): { combined: string; total: string } | null {
  if (!ramInfo || !deckModels.a || !deckModels.b) return null
  const combined =
    (ramInfo.estimateGbByModel[deckModels.a] ?? 0) +
    (ramInfo.estimateGbByModel[deckModels.b] ?? 0)
  if (combined <= ramInfo.totalGb * RAM_COMFORT_FRACTION) return null
  return { combined: combined.toFixed(0), total: ramInfo.totalGb.toFixed(0) }
}

export default App
