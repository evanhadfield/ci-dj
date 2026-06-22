# Collective DJ — design and build plan (fork of SlipMate)

A collective-intelligence layer for SlipMate: a crowd shapes the live vibe through
phone reactions and shared, Pol.is-style voting on vibe-prompts, while the DJ keeps
every existing control and an always-on override. This doc is the durable capture of
the design and the phased build plan for Claude Code. **Read this whole file before
writing code; execute one phase at a time and stop at each checkpoint.**

Place this at `docs/collective/PLAN.md` in the fork. Add a one-line pointer to it
from `CLAUDE.md`.

---

## 0. The load-bearing insight

SlipMate models a deck's style as a list of 1–8 weighted text prompts blended in
MusicCoCa's 768-dim embedding space (ADR-0004), and audio embeds into the *same*
space (ADR-0011). So **prompts, each person's taste, and the live audio are all
vectors in one space**, and "aggregate the crowd" is vector arithmetic — weighted
centroids, cosine similarity, K-means/PCA — not a bespoke recommender.

The crowd is a **peer controller** in the sense of ADR-0020 (UI / MIDI / MCP agent as
symmetric controllers over one store). It emits a `set_style` intent like any other
controller; the DJ's controls always win (last-write-wins / explicit override).

> Reality check: ADR-0020 (Rust single-store + native MCP server) is **Proposed, not
> built**. Do not assume the MCP server exists. See §3 for the v1 control path.

---

## 1. The three signals (keep them distinct — this is the core of the UX)

1. **Reactive** — one tap, like/dislike the *currently playing* sound. Ambient,
   unlimited interaction, capped weight. ~90% of all participation. Feeds the
   continuous steering pull (the "taste field") and the approval temperature.
2. **Proactive (Pol.is-style, opt-in)** — rate *proposed* vibe-prompts as a card
   stack (agree / pass / disagree), served coverage-balanced, with "suggest your
   own." Produces the sparse person×vibe opinion matrix that clustering runs on.
3. **Onboarding seed (~10 s)** — optional one-line "what do you want to hear?" with
   opt-out chips, then "tap 3 vibes you're into" from N coverage-balanced cards.
   Seeds a taste vector + casts 3 first votes. (This is the only place "pick 3"
   lives — not an allocate-tokens-over-everything screen.)

There is **no quadratic/budget voting in v1.** Per-person capping + coverage-balanced
serving give most of the gaming-resistance without any math on screen. (QV is a
deferred refinement, §11.)

---

## 2. New components (all additive; the audio engine is untouched)

- **`crowd-web/`** — a phone web app (PWA, no install) served to the venue. The three
  signals above + a peek at the room view. Full spec in §7.
- **`host-screen/`** — the projection view the room sees: the vibe opinion map, the
  temperature trace, now-playing, and the join QR/code. Full spec in §7c.
- **`aggregator/`** — service holding reaction events, taste vectors, the vibe-prompt
  pool + opinion matrix, the clustering layer, and the policy producing the crowd's
  target blend. Emits a weighted prompt list + influence-ready signal + the data the
  two views render from.
- **`bridge`** — thin control path from aggregator into deck steering (§3), carrying
  `set_style`, gated by the DJ influence macro and slew-limited.
- **`/api/embed`** — new endpoint on the existing FastAPI controller:
  `text -> 768-dim` and `audio -> 768-dim`, reusing the worker's MusicCoCa encoder.
  Needed for taste vectors, semantic dedupe of suggestions, vibe-map layout, clustering.
- **DJ influence macro + crowd target** — one new control in the existing UI/pad:
  `0` = ignore crowd, `1` = crowd drives. Mechanically the weight of the crowd's
  target as one more pad target, plus the slew rate. Plus a "lock for the drop /
  release to crowd" toggle and a moderation veto/approve lane.

Suggested stack: TypeScript end to end. `crowd-web` and `host-screen` are static SPAs
+ a WebSocket to `aggregator`. Keep `aggregator` restartable; in-memory state is
acceptable in v1 (see §9 fail-safe).

---

## 3. Control path into SlipMate

**v1 (build this):** the bridge applies the crowd's target via the **same command
channel the frontend already uses to send `set_style`** (the deck worker WebSocket):
aggregator computes target → bridge applies influence + slew → sends
`set_style {prompts:[{text,weight}…]}`. The crowd target renders as one more pad
target so the human sees and can override it. Races resolve last-write-wins; the
human gesture is authoritative.

**Target end-state (capture, don't build):** when ADR-0020 lands, the bridge proxies
through the native MCP server to the Rust store instead of the worker WS. Leave a
`ControlTransport` interface: `WorkerWsTransport` (v1 real) + `McpTransport` (stub).

---

## 4. Data model

- `ReactionEvent { userId, vibeVec | vibeRef (768-dim), sign:+1|-1, ts }` — `vibeRef`
  resolves to the embedding of what played at `ts` (prefer master-audio embedding via
  the ADR-0011 path; active-blend embedding is an acceptable cheaper proxy).
- `TasteVector(user)` — recency-weighted (EWMA) liked-centroid and disliked-centroid.
- `VibePrompt { id, text, embedding(768), support, lastVoteTs, satisfied:bool }` — a
  shared suggestion / "statement." `satisfied` flips when the current vibe is within
  ε of `embedding`.
- `OpinionMatrix` — sparse `user × VibePrompt` votes in {+1, 0(pass), −1}. The Pol.is
  object; PCA + K-means run on this (mean-centered, unseen treated as neutral; no
  imputation in v1).
- `Identity` — opaque `userId` from an `IdentityProvider` (§8).

---

## 5. Aggregation pipeline (order matters)

1. **Ingest** reactions + card votes (deduped by `userId`).
2. **Per-user taste update** — EWMA of liked/disliked centroids from reactions.
3. **Per-user contribution, capped** — at most one bounded unit per window regardless
   of tap count (anti-spam / anti-loud-user).
4. **Shrinkage** — `target = w·crowd + (1−w)·prior`, `w = n_eff/(n_eff+k)`; prior is
   the DJ baseline / current vibe. Authority scales with agreement-mass, not headcount.
5. **Cluster (adaptive)** — if active participants ≥ `CLUSTER_MIN_N` (default 18):
   PCA + K-means on the `OpinionMatrix` to find opinion groups; else single shrunk
   centroid (no clustering).
6. **Policy** (§6) — clusters → target blend.
7. **Compose streams** — blend the taste-field target (implicit, continuous) with the
   top-supported vibe-prompts (explicit). Suggestions inject vocabulary the audio
   can't imply; the taste field steers within it.
8. **Slew-limit** — move the applied blend toward the target by at most a bounded
   cosine step per tick. Matches the model's ~3 s reaction latency; turns attacks into
   slow, vetoable drift.
9. **Influence gate** — scale by the DJ macro, merge with the DJ's own targets, send
   via the bridge.

Run the loop at the music's natural reaction time (~a musical phrase), not faster.
Tap window / EWMA constant default 10–20 s.

---

## 6. Social-choice policy (minority protection + anti-blandness)

Plain centroid aggregation is majoritarian by construction (a bimodal and a unimodal
crowd with the same mean give the same blend), so a persistent minority is averaged
away. The cluster policies fix this:

- **`centroid`** — size-weighted mean. The **sub-threshold fallback** (< `CLUSTER_MIN_N`).
- **`pr` (proportional time-sharing)** — **driving default above threshold.** Rotate
  the featured blend toward each cluster's preferred vibes in turn, weighted by cluster
  size. Each group gets its moment over the set; the rotation is also the cure for
  tyranny-of-the-mean (a purely reactive loop stagnates at a comfortable attractor —
  this rotation drive keeps a satisfied room moving toward *represented* factions,
  not random exploration).
- **`maximin` (bridging)** — **DJ toggle.** Maximize the minimum cluster's satisfaction
  — the vibe everyone can tolerate. Consensus-leaning, can be bland; good for warm-up /
  all-hands moments.

DJ surface: a `centroid (auto) · time-share · bridge` selector; `auto` uses the
adaptive rule (centroid under threshold, `pr` over). Compute all three internally and
log them so they're A/B-comparable.

---

## 7. UX — phone web app (`crowd-web/`)

Design principles, non-negotiable: glanceable and ambient; never nags; **no login**;
mobile-first and one-handed; large tap targets (≥ 44px); high contrast for a dark
venue; minimal text entry (taps/swipes); every action shows a visible collective
effect so it feels meaningful; latency-honest (never fake instant — show "the room is
shifting…"). PWA, responsive, works on LAN or internet.

### 7a. Join flow

1. The host/projection screen shows a **QR code**, a **4-character room code**, and a
   short **URL** (e.g. `vibe.party/AB12`, or a LAN IP in v2). The QR encodes the join
   URL with the room code embedded.
2. Phone scans → opens the PWA in-browser → lands directly in the room. No install,
   no account.
3. **Fallback:** at the URL, a single field to type the 4-char code (uppercase,
   ambiguous chars like 0/O/1/I excluded from the alphabet).
4. On first load the aggregator issues a device identity (signed cookie + light
   fingerprint, §8) and the onboarding seed (signal #3) runs as a dismissible overlay.
5. Reconnect: returning devices resume the same `userId` and taste profile for the
   session.

QR generation: aggregator creates a room → returns `{code, joinUrl}`; the QR is
rendered from `joinUrl` client-side on the host screen (e.g. a `qrcode` lib). Rooms
are ephemeral; closing the set retires the room.

### 7b. Screens (single-page, three sections + onboarding overlay)

**Onboarding overlay (first join only, skippable):**
- Title: "Help steer the music." One-line free-text: *"What do you want to hear?"*
  with opt-out chips: `Surprise me` · `I'm open` · `Not sure`. Submitting text creates
  a deduped vibe-prompt and seeds the taste vector.
- Then: *"Tap 3 vibes you're into"* over N (default 9) coverage-balanced cards. Tapping
  3 casts 3 first votes and dismisses the overlay. A `Skip` link is always present.

**1. Now (home / default).** What people see almost always.
- Current vibe label (short, human; e.g. "sunset disco · warm · mid-tempo").
- A compact approval-temperature gauge (the EWMA net-approval, −1…+1) so the
  individual sees the room's mood.
- Two large bipolar buttons: **Like** / **Dislike** the current sound. Tapping gives
  instant feedback — the button pulses, microcopy "added to the room," the gauge
  nudges. Unlimited taps; no hard block, but a subtle cooldown animation discourages
  mashing (capping is server-side regardless).
- A one-line "the room is shifting…" indicator when the blend is mid-slew, so the
  seconds of model latency read as intentional, not broken.

**2. Vibes (rate — the Pol.is stack, opt-in).**
- A card stack, one vibe-prompt per card. Actions: swipe right / **Agree**, swipe up
  or tap / **Pass**, swipe left / **Disagree**. Buttons mirror the swipes (swipes are
  never the only path — accessibility).
- Cards are served **coverage-balanced**: least-shown vibe-prompts first, lightly
  randomized, so the opinion matrix fills evenly across the crowd.
- Gentle progress sense ("rated 6 — keep going?"), never a hard quota.
- **Suggest a vibe:** short text field (char-limited). On submit: "added — others can
  vote on it soon." Server-side semantic dedupe; if it collapses into an existing
  prompt, say "people are already vibing on that" and show that card. Per-person
  submit rate-limit.

**3. Room (legibility peek, optional).** A phone-sized read-only version of the host
screen: the temperature trace + a simplified vibe opinion map. Most people watch this
on the projection; the phone peek is for the curious.

### 7c. Host / projection screen (`host-screen/`)

The room-facing display. Large, legible from across a venue.
- **Vibe opinion map (the centerpiece).** The top K vibe-prompts laid out in 2D by
  *embedding similarity* (MDS/PCA on the vibe embeddings, so similar vibes sit near
  each other — the same spatial logic as the DJ pad). Each vibe node: label, size =
  total support, and a small split ring / mini-bars showing how each opinion **cluster**
  feels about it (read "majority loves it, faction B is cold"). A focus marker = the
  current sound's position, with a dashed tether to the DJ anchor showing the crowd's
  pull. Below `CLUSTER_MIN_N`: no cluster coloring, just support sizes (single-organism
  mode). The people-clusters are computed under the hood from the opinion matrix; they
  surface here as per-vibe sentiment, **not** as a separate people-dot-cloud.
- **Approval temperature trace** — the live EWMA net-approval line with a threshold;
  above threshold triggers celebratory motion graphics.
- **Now-playing** label + **join QR/code**.

### 7d. Edge / failure states (spec these explicitly — easy to forget)

- No vibes yet to rate: "Be the first — suggest a vibe."
- Aggregator unreachable: "The DJ's driving solo right now" + reactions disabled
  gracefully; the app never errors out.
- Opted-out user: neutral profile, no nagging, can still react on Now.
- Reconnect after sleep: silent resume, no re-onboarding.
- Reduced-motion / prefers-reduced-motion respected for all animations.

---

## 8. Identity (anti-sybil foundation)

`IdentityProvider` interface, pluggable; aggregation only ever sees `userId`.
- **v1: `DeviceIdentity`** — signed session token + light fingerprint; dedupe on it.
  Adequate for good-faith crowds.
- **v2: `CaptivePortalIdentity`** — must be on the venue LAN (the stronger version;
  also removes the internet dependency).
- **Deferred seams:** `RotatingQrIdentity` (re-scan a stage QR rotating every few
  minutes), `NfcWristbandIdentity` (gate-issued tap).

---

## 9. Ops / festival

- `aggregator` + `crowd-web` + `host-screen` run as one deployment; v1 over internet,
  v2 reachable on venue LAN with phones joining via QR.
- **Fail-safe (match SlipMate's "absence degrades, never crashes"):** if the aggregator
  is unreachable, the DJ influence signal is treated as 0 and the human keeps full
  manual control. The deck never blocks on the crowd.
- **Moderation:** the only free-text surface is suggestions → classifier (stub in v1)
  + a DJ approve/veto lane (real). Reactions and card votes need no moderation.
- Hardware/integration behavior that can't be unit-tested gets a `docs/` checklist,
  per repo convention.

---

## 10. Build phases (execute in order; stop at each checkpoint)

**Global rules for every phase**
- Allowed: add new dirs/services, add `/api/embed`, add the influence macro + crowd
  pad target, add the bridge, add feature flags.
- Forbidden without asking: editing the Rust audio engine internals, changing the deck
  worker wire protocol, breaking any existing test, removing any DJ control.
- After each phase output: `✅ <phase> — <landed>, <stubbed>, <how to verify>`.
- Everything behind `COLLECTIVE_ENABLED`; with it off, SlipMate is unchanged.
- Match house style per CLAUDE.md (frontend: single quotes, no semicolons, no
  formatter; type-check `npx tsc -p tsconfig.app.json --noEmit` from `frontend/`).

**Phase 0 — Fork prep & seams (no behavior).**
- Add `/api/embed` (text + audio → 768-dim) reusing the worker encoder.
- Scaffold `crowd-web/`, `host-screen/`, `aggregator/`; define `ControlTransport`
  (`WorkerWsTransport` real-but-idle, `McpTransport` stub) and `IdentityProvider`
  (`DeviceIdentity` real).
- Add the inert DJ influence macro + crowd pad target to the existing UI.
- Add room creation + QR/code join scaffolding (no signals yet).
- Checkpoint: existing `just check` passes unchanged; embed returns vectors; a phone
  can scan the QR and land in an empty room; influence control present and inert.

**Phase 1 — Reactive backbone (the loop closes).**
- crowd-web: join flow + onboarding overlay (free-text + pick-3 seed) + the **Now**
  screen (like/dislike + temperature gauge + shifting indicator).
- aggregator: ingest reactions → taste EWMA → capped contribution → single shrunk
  centroid → slew-limit → influence gate → bridge `set_style`. Device identity real.
- host-screen: real approval-temperature trace; vibe opinion map rendered in
  single-organism mode (support sizes, no clusters yet).
- Stubs present but minimal: the Vibes/Pol.is stack, suggestions, clustering, policy,
  outlier down-weighting, moderation.
- Checkpoint: a phone taps → pad's crowd dot moves → deck restyles within the model's
  latency → DJ override works → killing the aggregator drops influence to 0 with the
  deck unaffected.

**Phase 2 — Proactive stream (Pol.is rating + suggestions).**
- crowd-web **Vibes** screen: coverage-balanced card stack (agree/pass/disagree, swipe
  + button), suggest-a-vibe with server-side semantic dedupe + submit rate-limit.
- aggregator: `OpinionMatrix`, vibe-prompt pool with decay + satisfied-retire, support
  scoring (Wilson/Bayesian). DJ veto lane real; moderation classifier stub.
- host-screen: top-K vibes on the opinion map sized by support.
- Checkpoint: a suggestion can be submitted, deduped, rated by several devices, gain
  support, influence the blend, and auto-retire when stale or satisfied.

**Phase 3 — Clustering & policy (the CIP core).**
- aggregator: PCA + K-means on `OpinionMatrix`, gated on `CLUSTER_MIN_N`; compute
  `centroid` / `pr` / `maximin`; **`auto` = centroid under threshold, `pr` over**;
  `maximin` selectable. Manifold-outlier distance computed + logged (not yet driving).
- host-screen: per-vibe cluster sentiment (split ring / bars) on the opinion map.
- Checkpoint: with ≥ N simulated participants in 2–3 groups, clusters appear as per-
  vibe sentiment; `pr` visibly rotates the vibe across groups; switching to `maximin`
  changes behavior; below N it falls back to the single centroid.

**Phase 4 — v2 seams & hardening.**
- `CaptivePortalIdentity` (LAN) end to end; persistence + restart story; moderation
  classifier; ops + hardware checklist.
- Checkpoint: a LAN-joined, presence-bound session works end to end.

---

## 11. Deferred-but-captured ledger (nothing here is forgotten)

- Full ADR-0020 store inversion + native MCP transport for the crowd controller.
- Quadratic / budget voting for explicit *intensity* (only if simple-tap + cap proves
  insufficient).
- Matrix completion / imputation on the opinion matrix (only if cluster quality demands).
- Coordinated-brigade detection beyond logging (down-weight on manifold outlier).
- `RotatingQrIdentity` / `NfcWristbandIdentity` as the sybil floor above LAN.
- On-device taste computation for privacy (send aggregate-ready contribution, not
  per-person history) — matches SlipMate's "session-only by design" ethos.
- Participation-bias handling (tappers ≠ dancers) — a conscious policy choice.
- The exact onboarding / card-rating flow is the active-iteration zone; v1 builds the
  Pol.is stack above, expect to tune it from live use.