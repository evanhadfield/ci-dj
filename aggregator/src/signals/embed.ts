/** Client for the backend `/api/embed` endpoint (PLAN.md §2).
 *
 * Phase 2 uses this for semantic dedupe of user-suggested vibes: the
 * suggested text is embedded into MusicCoCa's 768-dim space, then
 * cosine-similarity-matched against the existing prompt pool. The
 * backend is loopback-bound (controller.py); the aggregator and the
 * backend run side-by-side in dev, so HTTP fetch is plenty.
 *
 * The endpoint is gated behind `COLLECTIVE_ENABLED` on the backend.
 * When unreachable (the backend is down, or the flag is off), we
 * gracefully degrade: dedupe is skipped and the prompt joins the pool
 * without an embedding. Phase 3's PCA layout pays for the embedding
 * absence then; Phase 2's "people are already vibing on that" UX just
 * stops firing for the affected card. */

export const EMBED_DIM = 768

export type EmbedClient = {
  /** Embed text → 768-dim vector. Returns `null` when the backend is
   * unreachable or gated off; callers should treat `null` as "no
   * dedupe available" rather than failing the suggestion. */
  embedText: (text: string) => Promise<Float32Array | null>
}

export type EmbedClientOptions = {
  /** Backend base URL, defaults to the loopback controller port. */
  baseUrl?: string
  /** Per-call timeout. The backend's first call pays the MusicCoCa
   * load (~seconds); after that it's sub-second. */
  timeoutMs?: number
  /** Optional override for tests; defaults to global `fetch`. */
  fetchImpl?: typeof fetch
}

export class HttpEmbedClient implements EmbedClient {
  private readonly baseUrl: string
  private readonly timeoutMs: number
  private readonly fetchImpl: typeof fetch

  constructor(options: EmbedClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? 'http://127.0.0.1:8000').replace(/\/$/, '')
    this.timeoutMs = options.timeoutMs ?? 10_000
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  async embedText(text: string): Promise<Float32Array | null> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/api/embed`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
        signal: controller.signal,
      })
      if (!response.ok) return null
      const parsed = (await response.json()) as { vector?: unknown; dim?: unknown }
      if (parsed.dim !== EMBED_DIM) return null
      if (!Array.isArray(parsed.vector)) return null
      const vector = new Float32Array(EMBED_DIM)
      for (let i = 0; i < EMBED_DIM; i++) {
        const v = parsed.vector[i]
        if (typeof v !== 'number' || !Number.isFinite(v)) return null
        vector[i] = v
      }
      return vector
    } catch {
      return null
    } finally {
      clearTimeout(timer)
    }
  }
}

/** Cosine similarity between two equal-length f32 vectors. Returns 0
 * when either side has zero magnitude — caller treats that as "no
 * dedupe possible". */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0
  let dot = 0
  let aMag = 0
  let bMag = 0
  for (let i = 0; i < a.length; i++) {
    const av = a[i] ?? 0
    const bv = b[i] ?? 0
    dot += av * bv
    aMag += av * av
    bMag += bv * bv
  }
  if (aMag === 0 || bMag === 0) return 0
  return dot / (Math.sqrt(aMag) * Math.sqrt(bMag))
}
