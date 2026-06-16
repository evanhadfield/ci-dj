/** Deck-to-deck style sampling (M15, ADR-0011): capture the tail of
 * what a deck just played and register it as a style embedding on the
 * OTHER deck's worker. The upload returns once the embed command is
 * queued — the worker's FIFO command queue guarantees any set_style
 * referencing the id runs after the embed, so the pad target can be
 * added the moment the POST resolves. */

import { getApiBaseUrl } from './nativeEngine'

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
  // NOTE: in the native shell this hits the generation-only server, which does
  // NOT host the deck workers — native style sampling needs the embed routed to
  // the sidecar (a documented follow-up). The base is empty on the web/dev path.
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
