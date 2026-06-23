/** Phase 3 clustering + social-choice policy on the OpinionMatrix
 * (PLAN.md §5.5, §6, §10 Phase 3).
 *
 * Two halves live here. **Cluster discovery**: mean-center the sparse
 * `user × prompt` matrix (unseen entries → 0; no imputation), run a
 * small power-iteration PCA to get the dominant subspace, then
 * K-means in PCA space to discover opinion groups. Gated on
 * `CLUSTER_MIN_N`; below the threshold we return no clusters and the
 * pipeline falls back to its existing centroid (the single-organism
 * mode the room has been in since Phase 1). **Policy**: from the
 * discovered clusters compute the three blends from PLAN.md §6 —
 * `centroid` (size-weighted mean), `pr` (size-weighted rotation
 * through cluster preferences), `maximin` (the bridge — the blend
 * that maximises the minimum cluster's satisfaction). `auto` picks
 * `centroid` under the threshold, `pr` over. All three are computed
 * every tick so they're A/B-comparable in the log.
 *
 * No tensors, no external deps: the matrix this runs on is small
 * (handfuls of voters × dozens of prompts), so a hand-rolled power
 * iteration on `Float64Array`s is faster and easier to reason about
 * than pulling in a linear-algebra library. */

import type { OpinionMatrix } from './opinion-matrix.js'
import type { VibePromptId } from './prompts.js'
import { mulberry32, type RandomFn } from './sampling.js'

/** §5.5: below this active-participant count, cluster analysis is
 * disabled and the pipeline falls back to a single shrunk centroid. */
export const CLUSTER_MIN_N = 18

/** Default number of opinion groups K-means looks for. Two is the
 * smallest interesting K (PLAN.md §6 "a persistent minority is
 * averaged away" — splitting on the first PCA axis is what catches
 * that). Three lets a centrist faction emerge separately from the
 * majoritarian split. */
export const DEFAULT_K = 2

/** Number of PCA dimensions K-means runs in. Two is enough for the
 * §7c host-screen layout and for separating the kind of bimodal
 * splits the v1 policy handles; higher dimensions add noise without
 * changing the cluster assignments much for this matrix size. */
export const DEFAULT_PCA_DIMS = 2

/** Max iterations for both the power-iteration PCA and K-means. The
 * matrix is small enough that both converge in single-digit iters in
 * practice; the cap is a safety belt against pathological inputs. */
const POWER_ITERATIONS = 50
const KMEANS_ITERATIONS = 50

/** Convergence epsilon for both inner loops — when the eigenvector
 * dot-product change drops below this, or the K-means assignment
 * change is zero, we're done. */
const CONVERGENCE_EPS = 1e-6

/** Bound on the per-cluster mean we trust: a cluster with one or two
 * voters can produce a wild centroid that visually overpowers the
 * majority on the host-screen. Phase 4 may tune this; for v1 a
 * cluster needs at least two members to influence the policy
 * outputs (it still surfaces on the wire for transparency). */
export const POLICY_MIN_CLUSTER_SIZE = 2

/** Phase-3 social-choice policy selector (PLAN.md §6). */
export type PolicyChoice = 'centroid' | 'pr' | 'maximin' | 'auto'

export type ClusterId = string

/** A single opinion cluster discovered by PCA + K-means on the
 * OpinionMatrix. Sizes are voter counts; `meanVotes` is the cluster
 * centroid over prompts (mean of the raw `{-1, 0, +1}` votes — passes
 * count as zero, unseen prompts are dropped from the map). */
export type OpinionCluster = {
  id: ClusterId
  size: number
  /** Per-prompt mean opinion in `[-1, +1]`. Only prompts the cluster
   * has actually voted on appear here. */
  meanVotes: ReadonlyMap<VibePromptId, number>
  /** Member user ids — used for the manifold-outlier readout and the
   * host-screen cluster fan-out. Sorted for stable order across ticks
   * (the actual cluster id is the position in the cluster list). */
  members: readonly string[]
}

/** Per-prompt, per-cluster sentiment — the host-screen split ring
 * reads this off the room snapshot. `agree`/`disagree`/`pass` are
 * the raw counts inside this cluster; the renderer normalises them
 * into segment widths. */
export type ClusterMass = {
  clusterId: ClusterId
  agree: number
  disagree: number
  pass: number
}

export type ClusterResult = {
  clusters: readonly OpinionCluster[]
  /** Per-user cosine distance to the dominant PCA subspace
   * (manifold). Phase 4 will feed this into the per-user contribution
   * cap; Phase 3 logs it and surfaces it on the snapshot only. Empty
   * when below the `CLUSTER_MIN_N` gate (we don't have a manifold
   * yet). */
  outlierDistances: ReadonlyMap<string, number>
}

export type ClusterOptions = {
  /** Override the K-means / centroid-seed RNG. Tests pass a seeded
   * Mulberry32 for deterministic cluster assignments. */
  random?: RandomFn
  /** Override the number of opinion groups. Phase 3 defaults to 2;
   * tests with three synthetic groups bump this to 3. */
  k?: number
  /** Override the PCA-space dimensionality (default 2). */
  pcaDims?: number
  /** Override the active-voter floor. Tests sometimes need cluster
   * analysis to run with smaller crowds. */
  minActiveVoters?: number
}

/** Run PCA + K-means on the OpinionMatrix. Below the gate (default
 * `CLUSTER_MIN_N`) returns no clusters — the pipeline keeps its
 * existing centroid behaviour. */
export function clusterMatrix(
  matrix: OpinionMatrix,
  options: ClusterOptions = {},
): ClusterResult {
  const minActive = options.minActiveVoters ?? CLUSTER_MIN_N
  const random = options.random ?? Math.random
  const k = Math.max(1, options.k ?? DEFAULT_K)
  const pcaDims = Math.max(1, options.pcaDims ?? DEFAULT_PCA_DIMS)

  const rows = matrix.rows()
  // Active = has at least one vote (matrix.rows() returns every seated
  // user; we filter to actual voters here so the gate counts the §5.5
  // active-participant population, not "seated phones").
  const activeUsers: string[] = []
  for (const [userId, row] of rows) if (row.size > 0) activeUsers.push(userId)
  if (activeUsers.length < minActive || activeUsers.length < k) {
    return { clusters: [], outlierDistances: new Map() }
  }
  activeUsers.sort()

  // Build the dense matrix in (user, prompt) order. Unseen entries are
  // 0 (PLAN.md §4 "unseen treated as neutral; no imputation"). Pass
  // votes are 0 already, so the matrix carries `{-1, 0, +1}`.
  const prompts = collectPromptIds(rows, activeUsers)
  if (prompts.length === 0) {
    return { clusters: [], outlierDistances: new Map() }
  }
  const promptIndex = new Map(prompts.map((id, i) => [id, i] as const))
  const m = activeUsers.length
  const n = prompts.length
  const data = new Float64Array(m * n)
  for (let i = 0; i < m; i++) {
    const row = rows.get(activeUsers[i]!)
    if (!row) continue
    for (const [promptId, vote] of row) {
      const j = promptIndex.get(promptId)
      if (j === undefined) continue
      data[i * n + j] = vote
    }
  }
  // §5 PCA: mean-center on the prompt axis so the principal direction
  // captures variance in opinion, not in turnout.
  const means = new Float64Array(n)
  for (let j = 0; j < n; j++) {
    let s = 0
    for (let i = 0; i < m; i++) s += data[i * n + j]!
    means[j] = s / m
  }
  for (let i = 0; i < m; i++) {
    for (let j = 0; j < n; j++) {
      data[i * n + j] = data[i * n + j]! - means[j]!
    }
  }

  // Top-`pcaDims` principal axes via power iteration on the
  // covariance-implicit form (use `data` directly; deflate after each).
  const components: Float64Array[] = []
  for (let dim = 0; dim < pcaDims; dim++) {
    const v = topPrincipalAxis(data, m, n, random)
    if (!v) break
    components.push(v)
    deflate(data, m, n, v)
  }
  if (components.length === 0) {
    return { clusters: [], outlierDistances: new Map() }
  }

  // Project users into PCA space and run K-means on those coordinates.
  // (Rebuild the centered matrix because deflate mutated `data`.)
  const centered = new Float64Array(m * n)
  for (let i = 0; i < m; i++) {
    const row = rows.get(activeUsers[i]!)
    if (!row) continue
    for (let j = 0; j < n; j++) centered[i * n + j] = -means[j]!
    if (row) {
      for (const [promptId, vote] of row) {
        const j = promptIndex.get(promptId)
        if (j === undefined) continue
        centered[i * n + j] = vote - means[j]!
      }
    }
  }
  const coords = new Float64Array(m * components.length)
  for (let i = 0; i < m; i++) {
    for (let d = 0; d < components.length; d++) {
      let s = 0
      const v = components[d]!
      for (let j = 0; j < n; j++) s += centered[i * n + j]! * v[j]!
      coords[i * components.length + d] = s
    }
  }
  const assignments = kmeans(coords, m, components.length, k, random)

  // Build cluster centroids over the original prompt space — these
  // are what the policy reads. We use the raw votes (post-mean is
  // useful for direction; the policy wants direction-and-magnitude).
  const clusters = buildClusters(activeUsers, assignments, k, rows, prompts)

  // Manifold-outlier readout: cosine distance from each user's
  // centered row to its projection on the PCA subspace. Equivalently,
  // sqrt(1 - ‖proj‖² / ‖row‖²). A user perfectly inside the manifold
  // gets 0; a pure outlier gets 1.
  const outliers = computeOutlierDistances(centered, coords, m, n, components.length, activeUsers)

  return { clusters, outlierDistances: outliers }
}

function collectPromptIds(
  rows: ReadonlyMap<string, ReadonlyMap<VibePromptId, number>>,
  users: readonly string[],
): VibePromptId[] {
  const set = new Set<VibePromptId>()
  for (const user of users) {
    const row = rows.get(user)
    if (!row) continue
    for (const id of row.keys()) set.add(id)
  }
  return [...set].sort()
}

function topPrincipalAxis(
  data: Float64Array,
  m: number,
  n: number,
  random: RandomFn,
): Float64Array | null {
  if (m === 0 || n === 0) return null
  // Initialise from N(0, 1) (well, Mulberry32-uniform shifted, close
  // enough for power iteration), then normalise. A zero vector kills
  // the loop, so we re-roll if that happens.
  let v = new Float64Array(n)
  for (let attempt = 0; attempt < 4; attempt++) {
    for (let j = 0; j < n; j++) v[j] = random() - 0.5
    if (normalize(v) > 0) break
  }
  if (normalize(v) === 0) return null
  const tmp = new Float64Array(n)
  let prevDot = 0
  for (let iter = 0; iter < POWER_ITERATIONS; iter++) {
    // tmp = (Dᵀ D) v computed as D · (D v) without forming the
    // covariance matrix explicitly.
    const dv = new Float64Array(m)
    for (let i = 0; i < m; i++) {
      let s = 0
      for (let j = 0; j < n; j++) s += data[i * n + j]! * v[j]!
      dv[i] = s
    }
    tmp.fill(0)
    for (let i = 0; i < m; i++) {
      const row = dv[i]!
      if (row === 0) continue
      for (let j = 0; j < n; j++) tmp[j] = tmp[j]! + data[i * n + j]! * row
    }
    const norm = normalize(tmp)
    if (norm === 0) return null
    let dot = 0
    for (let j = 0; j < n; j++) dot += tmp[j]! * v[j]!
    v = new Float64Array(tmp)
    if (Math.abs(Math.abs(dot) - Math.abs(prevDot)) < CONVERGENCE_EPS) break
    prevDot = dot
  }
  return v
}

function deflate(data: Float64Array, m: number, n: number, v: Float64Array): void {
  // Deflate the data by removing its component along v: D' = D - (D v) vᵀ.
  for (let i = 0; i < m; i++) {
    let s = 0
    for (let j = 0; j < n; j++) s += data[i * n + j]! * v[j]!
    if (s === 0) continue
    for (let j = 0; j < n; j++) data[i * n + j] = data[i * n + j]! - s * v[j]!
  }
}

function normalize(v: Float64Array): number {
  let s = 0
  for (let i = 0; i < v.length; i++) s += v[i]! * v[i]!
  const n = Math.sqrt(s)
  if (n === 0) return 0
  for (let i = 0; i < v.length; i++) v[i] = v[i]! / n
  return n
}

function kmeans(
  coords: Float64Array,
  m: number,
  d: number,
  k: number,
  random: RandomFn,
): Int32Array {
  // k-means++ seed: first centroid random, each subsequent centroid
  // picked with probability proportional to squared distance to the
  // closest existing centroid. Better than plain random and worth the
  // few extra lines — keeps small bimodal datasets from collapsing
  // both centroids into one mode.
  const centroids = new Float64Array(k * d)
  const firstIdx = Math.floor(random() * m)
  for (let dd = 0; dd < d; dd++) centroids[dd] = coords[firstIdx * d + dd]!
  for (let c = 1; c < k; c++) {
    const dists = new Float64Array(m)
    let total = 0
    for (let i = 0; i < m; i++) {
      let best = Infinity
      for (let cc = 0; cc < c; cc++) {
        let s = 0
        for (let dd = 0; dd < d; dd++) {
          const diff = coords[i * d + dd]! - centroids[cc * d + dd]!
          s += diff * diff
        }
        if (s < best) best = s
      }
      dists[i] = best
      total += best
    }
    if (total === 0) {
      // All points already coincide with chosen centroids — bail with
      // the next random pick.
      const idx = Math.floor(random() * m)
      for (let dd = 0; dd < d; dd++) centroids[c * d + dd] = coords[idx * d + dd]!
      continue
    }
    let r = random() * total
    let pick = 0
    for (let i = 0; i < m; i++) {
      r -= dists[i]!
      if (r <= 0) {
        pick = i
        break
      }
      pick = i
    }
    for (let dd = 0; dd < d; dd++) centroids[c * d + dd] = coords[pick * d + dd]!
  }

  const assignments = new Int32Array(m)
  for (let iter = 0; iter < KMEANS_ITERATIONS; iter++) {
    let changed = 0
    for (let i = 0; i < m; i++) {
      let bestC = 0
      let bestD = Infinity
      for (let c = 0; c < k; c++) {
        let s = 0
        for (let dd = 0; dd < d; dd++) {
          const diff = coords[i * d + dd]! - centroids[c * d + dd]!
          s += diff * diff
        }
        if (s < bestD) {
          bestD = s
          bestC = c
        }
      }
      if (assignments[i] !== bestC) {
        assignments[i] = bestC
        changed++
      }
    }
    if (changed === 0 && iter > 0) break
    const counts = new Int32Array(k)
    const nextCentroids = new Float64Array(k * d)
    for (let i = 0; i < m; i++) {
      const c = assignments[i]!
      counts[c] = counts[c]! + 1
      for (let dd = 0; dd < d; dd++) {
        nextCentroids[c * d + dd] = nextCentroids[c * d + dd]! + coords[i * d + dd]!
      }
    }
    for (let c = 0; c < k; c++) {
      if (counts[c]! === 0) {
        // Empty cluster: re-seed with a random point so we don't
        // collapse to fewer-than-k clusters silently.
        const idx = Math.floor(random() * m)
        for (let dd = 0; dd < d; dd++) nextCentroids[c * d + dd] = coords[idx * d + dd]!
      } else {
        for (let dd = 0; dd < d; dd++) {
          nextCentroids[c * d + dd] = nextCentroids[c * d + dd]! / counts[c]!
        }
      }
    }
    for (let i = 0; i < centroids.length; i++) centroids[i] = nextCentroids[i]!
  }
  return assignments
}

function buildClusters(
  users: readonly string[],
  assignments: Int32Array,
  k: number,
  rows: ReadonlyMap<string, ReadonlyMap<VibePromptId, number>>,
  prompts: readonly VibePromptId[],
): OpinionCluster[] {
  const groups: { members: string[]; sums: Map<VibePromptId, number>; counts: Map<VibePromptId, number> }[] = []
  for (let c = 0; c < k; c++) groups.push({ members: [], sums: new Map(), counts: new Map() })
  for (let i = 0; i < users.length; i++) {
    const c = assignments[i]!
    const group = groups[c]!
    const userId = users[i]!
    group.members.push(userId)
    const row = rows.get(userId)
    if (!row) continue
    for (const [promptId, vote] of row) {
      group.sums.set(promptId, (group.sums.get(promptId) ?? 0) + vote)
      group.counts.set(promptId, (group.counts.get(promptId) ?? 0) + 1)
    }
  }
  const out: OpinionCluster[] = []
  for (let c = 0; c < k; c++) {
    const group = groups[c]!
    const means = new Map<VibePromptId, number>()
    for (const promptId of prompts) {
      const count = group.counts.get(promptId) ?? 0
      if (count === 0) continue
      means.set(promptId, (group.sums.get(promptId) ?? 0) / count)
    }
    out.push({
      id: `c${c}`,
      size: group.members.length,
      meanVotes: means,
      members: group.members.sort(),
    })
  }
  // Sort clusters by size descending so cluster ids are stable in the
  // visible-on-host order (largest cluster is `c0` after sort). Ids are
  // re-assigned post-sort so the wire format reads naturally.
  out.sort((a, b) => b.size - a.size)
  return out.map((cluster, idx) => ({ ...cluster, id: `c${idx}` }))
}

function computeOutlierDistances(
  centered: Float64Array,
  coords: Float64Array,
  m: number,
  n: number,
  d: number,
  users: readonly string[],
): Map<string, number> {
  const out = new Map<string, number>()
  for (let i = 0; i < m; i++) {
    let rowMag = 0
    for (let j = 0; j < n; j++) rowMag += centered[i * n + j]! * centered[i * n + j]!
    if (rowMag === 0) {
      out.set(users[i]!, 0)
      continue
    }
    let projMag = 0
    for (let dd = 0; dd < d; dd++) {
      const v = coords[i * d + dd]!
      projMag += v * v
    }
    // Clamp under 1: numerical jitter can push `projMag/rowMag` to
    // 1 + ε for users that lie exactly on the manifold.
    const ratio = Math.min(1, projMag / rowMag)
    out.set(users[i]!, Math.sqrt(1 - ratio))
  }
  return out
}

/** Per-cluster, per-prompt vote tallies — the host-screen split ring
 * normalises these into segment widths. Returned even when the
 * pipeline is below `CLUSTER_MIN_N` (in which case the map is empty),
 * so the WS server can unconditionally include the field without a
 * Phase-2-style stub. */
export function clusterMass(
  clusters: readonly OpinionCluster[],
  matrix: OpinionMatrix,
  promptId: VibePromptId,
): ClusterMass[] {
  if (clusters.length === 0) return []
  const out: ClusterMass[] = []
  for (const cluster of clusters) {
    let agree = 0
    let disagree = 0
    let pass = 0
    const rows = matrix.rows()
    for (const userId of cluster.members) {
      const vote = rows.get(userId)?.get(promptId)
      if (vote === 1) agree++
      else if (vote === -1) disagree++
      else if (vote === 0) pass++
    }
    out.push({ clusterId: cluster.id, agree, disagree, pass })
  }
  return out
}

export type PolicyBlend = ReadonlyMap<VibePromptId, number>

export type PolicyOutputs = {
  centroid: PolicyBlend
  pr: PolicyBlend
  maximin: PolicyBlend
  /** The single resolved choice the pipeline should drive with this
   * tick. `'centroid'` below the gate; `'pr'` over it (the §6 `auto`
   * rule); explicit choices always pass through. */
  resolved: PolicyBlend
  choice: PolicyChoice
  appliedPolicy: 'centroid' | 'pr' | 'maximin'
}

export type PolicyOptions = {
  choice: PolicyChoice
  /** Used by `pr` to pick which cluster's preferences to spotlight on
   * this tick. The pipeline passes a monotonically-increasing tick
   * counter; rotation modulo a size-weighted schedule decides the
   * featured cluster. */
  rotationTick?: number
  /** Number of ticks in one rotation window (PLAN.md §6 — "rotation
   * window"). Default is 8 — at a 1.5 s tick that's ~12 s per cluster
   * featured: long enough to hear, short enough to feel a moving set. */
  rotationWindow?: number
  /** Number of prompts in each policy's output blend. Mirrors the deck
   * worker's 8-prompt ceiling so the bridge doesn't have to clip. */
  topK?: number
  /** Optional weights — Wilson supports from the prompt pool. Boosts
   * cluster preferences by the room-wide support so a cluster that
   * loves a prompt the room hasn't ratified yet doesn't single-
   * handedly drive the blend. Defaults to neutral (1.0 for every
   * prompt the policy sees). */
  promptWeights?: ReadonlyMap<VibePromptId, number>
}

const DEFAULT_ROTATION_WINDOW = 8
const DEFAULT_POLICY_TOPK = 8

/** Compute all three policies and resolve the chosen one. Pure. */
export function computePolicies(
  clusters: readonly OpinionCluster[],
  options: PolicyOptions,
): PolicyOutputs {
  const rotationWindow = Math.max(1, options.rotationWindow ?? DEFAULT_ROTATION_WINDOW)
  const topK = Math.max(1, options.topK ?? DEFAULT_POLICY_TOPK)
  const weights = options.promptWeights
  const effective = clusters.filter((c) => c.size >= POLICY_MIN_CLUSTER_SIZE)
  const centroid = centroidBlend(effective, weights, topK)
  const pr = prBlend(effective, options.rotationTick ?? 0, rotationWindow, weights, topK)
  const maximin = maximinBlend(effective, weights, topK)
  let appliedPolicy: 'centroid' | 'pr' | 'maximin' = 'centroid'
  if (options.choice === 'pr') appliedPolicy = 'pr'
  else if (options.choice === 'maximin') appliedPolicy = 'maximin'
  else if (options.choice === 'auto') appliedPolicy = effective.length >= 2 ? 'pr' : 'centroid'
  const resolved =
    appliedPolicy === 'pr' ? pr : appliedPolicy === 'maximin' ? maximin : centroid
  return { centroid, pr, maximin, resolved, choice: options.choice, appliedPolicy }
}

function centroidBlend(
  clusters: readonly OpinionCluster[],
  weights: ReadonlyMap<VibePromptId, number> | undefined,
  topK: number,
): PolicyBlend {
  // Size-weighted mean of cluster centroids — equivalent to the raw
  // crowd mean when clustering is off and the room is one cluster.
  const totals = new Map<VibePromptId, number>()
  const totalSize = clusters.reduce((s, c) => s + c.size, 0)
  if (totalSize === 0) return new Map()
  for (const cluster of clusters) {
    const weight = cluster.size / totalSize
    for (const [promptId, value] of cluster.meanVotes) {
      if (value <= 0) continue
      const supportBoost = weights?.get(promptId) ?? 1
      totals.set(promptId, (totals.get(promptId) ?? 0) + weight * value * supportBoost)
    }
  }
  return topKNormalized(totals, topK)
}

function prBlend(
  clusters: readonly OpinionCluster[],
  rotationTick: number,
  rotationWindow: number,
  weights: ReadonlyMap<VibePromptId, number> | undefined,
  topK: number,
): PolicyBlend {
  // Size-weighted rotation: build a schedule of length
  // `rotationWindow` slots, each filled with a cluster id, with slot
  // allocation proportional to cluster size. The current slot
  // (rotationTick % rotationWindow) picks the cluster whose
  // preferences drive this tick.
  if (clusters.length === 0) return new Map()
  if (clusters.length === 1) {
    return clusterPreferenceBlend(clusters[0]!, weights, topK)
  }
  const totalSize = clusters.reduce((s, c) => s + c.size, 0)
  if (totalSize === 0) return new Map()
  const schedule: number[] = []
  // Largest-remainder allocation across clusters so every cluster
  // with non-zero size gets at least one slot when its share fits.
  const targets = clusters.map((c, idx) => ({ idx, frac: (c.size / totalSize) * rotationWindow }))
  const floors = targets.map((t) => ({ ...t, floor: Math.floor(t.frac), rem: t.frac - Math.floor(t.frac) }))
  let assigned = 0
  for (const t of floors) {
    for (let i = 0; i < t.floor; i++) schedule.push(t.idx)
    assigned += t.floor
  }
  // Distribute remaining slots by largest remainder; ties broken by
  // cluster size (the larger cluster wins extra slots first).
  const leftovers = floors.sort((a, b) => {
    if (b.rem !== a.rem) return b.rem - a.rem
    return clusters[b.idx]!.size - clusters[a.idx]!.size
  })
  let cursor = 0
  while (assigned < rotationWindow) {
    schedule.push(leftovers[cursor % leftovers.length]!.idx)
    cursor++
    assigned++
  }
  // Stabilise the schedule order so two adjacent slots aren't the
  // same cluster more than necessary (round-robin spread). A naive
  // sort would clump; this interleaves by cluster index instead.
  schedule.sort((a, b) => a - b)
  const interleaved: number[] = []
  // Bucket by cluster id, then round-robin through the buckets.
  const buckets = new Map<number, number[]>()
  for (const idx of schedule) {
    const list = buckets.get(idx) ?? []
    list.push(idx)
    buckets.set(idx, list)
  }
  while (interleaved.length < schedule.length) {
    for (const list of buckets.values()) {
      const pick = list.pop()
      if (pick !== undefined) interleaved.push(pick)
    }
  }
  const slot = ((rotationTick % rotationWindow) + rotationWindow) % rotationWindow
  const featuredIdx = interleaved[slot] ?? interleaved[0]!
  const featured = clusters[featuredIdx]!
  return clusterPreferenceBlend(featured, weights, topK)
}

function clusterPreferenceBlend(
  cluster: OpinionCluster,
  weights: ReadonlyMap<VibePromptId, number> | undefined,
  topK: number,
): PolicyBlend {
  const totals = new Map<VibePromptId, number>()
  for (const [promptId, value] of cluster.meanVotes) {
    if (value <= 0) continue
    const boost = weights?.get(promptId) ?? 1
    totals.set(promptId, value * boost)
  }
  return topKNormalized(totals, topK)
}

function maximinBlend(
  clusters: readonly OpinionCluster[],
  weights: ReadonlyMap<VibePromptId, number> | undefined,
  topK: number,
): PolicyBlend {
  // For each candidate prompt, the cluster-min of `meanVotes` says how
  // tolerated it is by the least-happy faction. We score every prompt
  // by that min (lifted by support weight) and pick the top-K. A
  // prompt nobody in the room hates rises naturally.
  if (clusters.length === 0) return new Map()
  const candidates = new Set<VibePromptId>()
  for (const cluster of clusters) for (const id of cluster.meanVotes.keys()) candidates.add(id)
  const totals = new Map<VibePromptId, number>()
  for (const promptId of candidates) {
    let minVote = Infinity
    let totalCovered = 0
    for (const cluster of clusters) {
      const vote = cluster.meanVotes.get(promptId)
      if (vote === undefined) continue
      totalCovered++
      if (vote < minVote) minVote = vote
    }
    // Require every effective cluster to have weighed in. Skipping
    // partially-rated prompts is the right call here: the maximin
    // policy is supposed to be the bridge — a prompt one cluster has
    // never seen isn't a bridge candidate.
    if (totalCovered < clusters.length) continue
    if (minVote <= 0) continue
    const supportBoost = weights?.get(promptId) ?? 1
    totals.set(promptId, minVote * supportBoost)
  }
  return topKNormalized(totals, topK)
}

function topKNormalized(
  totals: ReadonlyMap<VibePromptId, number>,
  k: number,
): PolicyBlend {
  if (totals.size === 0) return new Map()
  const sorted = [...totals.entries()]
    .filter(([, w]) => w > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, k)
  let sum = 0
  for (const [, w] of sorted) sum += w
  if (sum === 0) return new Map()
  return new Map(sorted.map(([id, w]) => [id, w / sum] as const))
}

/** Backwards-compatible Phase 2 entry point. Lets older imports keep
 * working until the WS server's signal handler is migrated over.
 * Returns the same shape but with the real clustering attempted; the
 * sub-threshold and empty cases keep matching the Phase 2 stub. */
export function clusterStub(matrix: OpinionMatrix): {
  clusters: readonly OpinionCluster[]
  policy: PolicyChoice
} {
  const { clusters } = clusterMatrix(matrix)
  return { clusters, policy: 'auto' }
}
