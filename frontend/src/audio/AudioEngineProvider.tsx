import { useState, type ReactNode } from 'react'

import { createAudioEngine, type AudioEngine } from './engine'
import { AudioEngineContext } from './engineContext'
import { createNativeEngine, isTauri } from './nativeEngine'

export function AudioEngineProvider({
  engine,
  children,
}: {
  engine?: AudioEngine
  children: ReactNode
}) {
  // In the native shell the Rust engine drives audio over IPC (ADR-0017/0018);
  // in a plain browser (dev / tests) the Web Audio engine stays the audio path
  // and the parity oracle. An explicitly injected engine always wins (tests).
  const [defaultEngine] = useState(
    () => engine ?? (isTauri() ? createNativeEngine() : createAudioEngine()),
  )
  return (
    <AudioEngineContext.Provider value={engine ?? defaultEngine}>
      {children}
    </AudioEngineContext.Provider>
  )
}
