/** Deck-to-deck style sampling (M15, ADR-0011): capture the tail of
 * what a deck just played and register it as a style embedding on the
 * OTHER deck's worker. The upload returns once the embed command is
 * queued — the worker's FIFO command queue guarantees any set_style
 * referencing the id runs after the embed, so the pad target can be
 * added the moment the POST resolves. */

import { getApiBaseUrl, isTauri } from './nativeEngine'

const DECK_INDEX: Record<string, number> = { a: 0, b: 1 }

/** The `withGlobalTauri` core invoke, for the binary embed payload. */
function tauriInvoke(cmd: string, payload: Uint8Array): Promise<unknown> {
  const core = (globalThis as { __TAURI__?: { core?: { invoke: (c: string, a?: unknown) => Promise<unknown> } } })
    .__TAURI__?.core
  return core ? core.invoke(cmd, payload) : Promise.reject(new Error('Tauri IPC unavailable'))
}

/** What "the sound of this deck, right now" means: the last N seconds
 * of played audio (the spike judged 10 s by ear, ADR-0011). */
export const STYLE_SAMPLE_SECONDS = 10
/** Mirrors the backend floor: less audio embeds poorly and is refused
 * before it leaves the browser. */
export const MIN_STYLE_SAMPLE_SECONDS = 3

/** Planar capture channels → the interleaved wire format. */
export function interleaveChannels(
  left: Float32Array,
  right: Float32Array,
): Float32Array<ArrayBuffer> {
  const frames = Math.min(left.length, right.length)
  const out = new Float32Array(frames * 2)
  for (let i = 0; i < frames; i++) {
    out[2 * i] = left[i]
    out[2 * i + 1] = right[i]
  }
  return out
}

/** Register captured PCM under `sampleId` on the target deck's worker.
 * Resolves when the embed is queued; rejects with the server's reason
 * (unknown deck, model loading, malformed body). */
export async function uploadStyleSample(
  deckId: string,
  sampleId: string,
  samples: Float32Array<ArrayBuffer>,
): Promise<void> {
  // Native shell: the generation server has no deck workers, so route the embed
  // to the target deck's sidecar over IPC. Frame [u32 LE deck][u32 LE id length]
  // [id utf-8][interleaved f32 LE PCM] as a single binary payload.
  if (isTauri()) {
    const idBytes = new TextEncoder().encode(sampleId)
    const pcm = new Uint8Array(samples.buffer)
    const payload = new Uint8Array(8 + idBytes.length + pcm.byteLength)
    const view = new DataView(payload.buffer)
    view.setUint32(0, DECK_INDEX[deckId] ?? 0, true)
    view.setUint32(4, idBytes.length, true)
    payload.set(idBytes, 8)
    payload.set(pcm, 8 + idBytes.length)
    await tauriInvoke('deck_embed_sample', payload)
    return
  }

  const apiBase = await getApiBaseUrl()
  const response = await fetch(
    `${apiBase}/api/deck/${deckId}/style-sample?id=${encodeURIComponent(sampleId)}`,
    { method: 'POST', body: samples.buffer },
  )
  if (!response.ok) {
    let detail = `HTTP ${response.status}`
    try {
      const body = (await response.json()) as { detail?: string }
      if (body.detail) detail = body.detail
    } catch {
      // Non-JSON error body; the status code is the message.
    }
    throw new Error(detail)
  }
}
