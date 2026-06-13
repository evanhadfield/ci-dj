// M23 exit-criteria verification (docs/ROADMAP.md, ADR-0016), the
// scripted half: a gridded techno track loads onto deck B playing; the
// 4-beat button drops a beat-locked loop the playhead audibly folds
// through; halve takes it to 2 beats and double back to 4 — on the
// beat, the readout following; EXIT releases it cleanly. The FLX4's
// 4 BEAT/EXIT and CUE/LOOP CALL bytes, the audible seam, and the
// gridless degrade live in docs/m23-hardware-checklist.md.
//
// Honest caveat: like verify_m20/m21, the grid is fitted to real
// generated material — a Magenta render that refuses a grid gets two
// more takes, and three refusals is the kill-criterion conversation.
//
// Run: node scripts/verify_m23.mjs (against a running backend)

import { chromium } from 'playwright'

const URL = 'http://127.0.0.1:8000/'

const browser = await chromium.launch({
  args: ['--autoplay-policy=no-user-gesture-required'],
})

try {
  const page = await browser.newPage()
  let lastGrid = null
  page.on('console', (msg) => {
    const text = msg.text()
    if (text.includes('[beatgrid] verdict')) {
      lastGrid = !text.includes('verdict b null')
    }
  })
  await page.goto(URL)
  const deckB = page.locator('section[aria-label="Deck b"]')
  const explorer = page.locator('section[aria-label="Media explorer"]')
  await deckB.getByText('Connected', { exact: true }).waitFor({ timeout: 10_000 })

  // ── Compose a gridded track onto deck B ──────────────────────────
  await explorer.getByRole('tab', { name: 'Generate' }).click()
  await explorer
    .getByLabel('Track prompt')
    .fill('rolling techno, four on the floor, 126 BPM')
  await explorer.getByLabel('Engine').selectOption('track')
  await explorer.getByLabel('Length').selectOption('120')
  let trackBpm = null
  for (let attempt = 1; attempt <= 3; attempt++) {
    await explorer.getByRole('button', { name: 'Compose' }).click()
    const trackName = `rolling techno, four on the floor, 126 BPM #${attempt}`
    const load = explorer.getByRole('button', {
      name: `Load ${trackName} to deck B`,
    })
    await load.waitFor({ timeout: 300_000 })
    lastGrid = null
    await load.click()
    await deckB.getByText(/^Track — /).waitFor({ timeout: 15_000 })
    const text = (
      await deckB
        .locator('.ui-stat', { hasText: 'BPM' })
        .locator('.ui-stat__value')
        .textContent()
    ).trim()
    if (lastGrid === true && text !== '—') {
      trackBpm = Number(text)
      console.log(`take ${attempt} gridded: ${trackBpm} BPM`)
      break
    }
    console.log(`take ${attempt} refused a grid — composing another`)
  }
  if (trackBpm === null) {
    throw new Error(
      'no take gridded in three composes — the kill-criterion conversation',
    )
  }
  await deckB.getByRole('button', { name: 'Play' }).click()
  await deckB.getByRole('button', { name: 'Stop', exact: true }).waitFor()

  const position = async () =>
    Number(
      await page.evaluate(() =>
        document
          .querySelector('section[aria-label="Deck b"] [role="slider"]')
          ?.getAttribute('aria-valuenow'),
      ),
    )
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const loopBeats = async () => {
    const label = await deckB.getByText(/-beat loop/).textContent()
    return Number(label.match(/^(\d+)/)[1])
  }

  // ── 4-beat button: one press drops a beat-locked loop ────────────
  await sleep(3_000)
  await deckB.getByRole('button', { name: '4 beats' }).click()
  await deckB.getByText('4-beat loop').waitFor({ timeout: 5_000 })
  if ((await loopBeats()) !== 4) {
    throw new Error(`4-beat button set a ${await loopBeats()}-beat loop`)
  }
  console.log(`4-beat loop set at ${trackBpm} BPM`)

  // The playhead must fold: across laps it wraps (decreases) and never
  // escapes the region's ceiling — the loop is real, not a marker.
  const loopSeconds = (4 * 60) / trackBpm
  const samples = []
  for (let i = 0; i < 12; i++) {
    samples.push(await position())
    await sleep((loopSeconds * 1000) / 4)
  }
  const ceiling = Math.max(...samples)
  let wraps = 0
  for (let i = 1; i < samples.length; i++) {
    if (samples[i] < samples[i - 1]) wraps++
  }
  if (wraps < 2) {
    throw new Error(
      `the playhead never folded (positions ${samples.join(', ')}) — that is not a loop`,
    )
  }
  console.log(`playhead folded ${wraps}× over three laps (loop ${loopSeconds.toFixed(1)}s)`)

  // ── Halve to 2 beats, double back to 4 — on the beat ─────────────
  await deckB.getByRole('button', { name: '½×' }).click()
  await deckB.getByText('2-beat loop').waitFor({ timeout: 5_000 })
  console.log(`halve: ${await loopBeats()}-beat loop`)

  await deckB.getByRole('button', { name: '2×' }).click()
  await deckB.getByText('4-beat loop').waitFor({ timeout: 5_000 })
  if ((await loopBeats()) !== 4) {
    throw new Error(`double did not return to 4 beats (${await loopBeats()})`)
  }
  console.log(`double: ${await loopBeats()}-beat loop`)

  // ── EXIT releases cleanly: the playhead escapes the old ceiling ──
  await deckB.getByRole('button', { name: 'Exit loop' }).click()
  await sleep(Math.min(loopSeconds * 1500, 8_000))
  const released = await position()
  if (released <= ceiling) {
    throw new Error(
      `after EXIT the playhead sits at ${released}s, still under the loop ceiling ${ceiling}s`,
    )
  }
  console.log(`exit released: playhead ran to ${released}s past ${ceiling}s`)

  await page.screenshot({ path: 'm23-verification.png' })
  console.log('VERDICT: PASS (screenshot: m23-verification.png)')
} catch (error) {
  console.error(`FAIL: ${error instanceof Error ? error.message : error}`)
  process.exitCode = 1
} finally {
  await browser.close()
}
