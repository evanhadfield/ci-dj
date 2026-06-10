// M9 spike: can one AudioContext drive the FLX4's 4 USB output channels
// (1/2 master RCA, 3/4 phones) via setSinkId + a channel merger? Measures
// the API against the physical device; findings recorded in ADR-0006.
//
// Run: node scripts/spike_cue_routing.mjs [--headed]
// Needs the backend running (just run) for an origin to hold permissions.

import { chromium } from 'playwright'

const headed = process.argv.includes('--headed')

const browser = await chromium.launch({ headless: !headed })
try {
  const context = await browser.newContext()
  // A microphone grant unlocks device labels/ids in enumerateDevices.
  await context.grantPermissions(['microphone'], {
    origin: 'http://127.0.0.1:8000',
  })
  const page = await context.newPage()
  page.on('crash', () => console.log(JSON.stringify({ crashed: true })))
  await page.goto('http://127.0.0.1:8000/')
  const result = await page.evaluate(async () => {
    const report = {}
    try {
      const devices = await navigator.mediaDevices.enumerateDevices()
      report.outputs = devices
        .filter((device) => device.kind === 'audiooutput')
        .map((device) => ({
          label: device.label,
          hasId: Boolean(device.deviceId),
        }))
      const flx4 = devices.find(
        (device) =>
          device.kind === 'audiooutput' && device.label.includes('DDJ-FLX4'),
      )
      report.flx4Found = Boolean(flx4)
      const ctx = new AudioContext({ sampleRate: 48000 })
      report.maxChannelsDefault = ctx.destination.maxChannelCount
      if (flx4) {
        await ctx.setSinkId(flx4.deviceId)
        report.sinkSet = true
        report.maxChannelsFlx4 = ctx.destination.maxChannelCount

        // Plan B (the likely winner): cue bus → MediaStreamDestination →
        // <audio> element pinned to a second sink. Master keeps the
        // context's sink; the element carries the phones feed.
        await ctx.setSinkId('')
        const streamOut = ctx.createMediaStreamDestination()
        const osc2 = ctx.createOscillator()
        osc2.frequency.value = 330
        const gain2 = ctx.createGain()
        gain2.gain.value = 0.05
        osc2.connect(gain2)
        gain2.connect(streamOut)
        const element = new Audio()
        element.srcObject = streamOut.stream
        try {
          await element.setSinkId(flx4.deviceId)
          report.elementSinkSet = true
        } catch (error) {
          report.elementSinkError = `${error.name}: ${error.message}`
        }
        osc2.start()
        await ctx.resume()
        try {
          await element.play()
          report.elementPlaying = !element.paused
        } catch (error) {
          report.elementPlayError = `${error.name}: ${error.message}`
        }
        await new Promise((resolve) => setTimeout(resolve, 1500))
        osc2.stop()
        element.pause()

        if (ctx.destination.maxChannelCount >= 4) {
          ctx.destination.channelCount = 4
          ctx.destination.channelCountMode = 'explicit'
          ctx.destination.channelInterpretation = 'discrete'
          const merger = ctx.createChannelMerger(4)
          merger.connect(ctx.destination)
          // Quiet tone on the phones pair only (USB channels 3/4).
          const osc = ctx.createOscillator()
          osc.frequency.value = 440
          const gain = ctx.createGain()
          gain.gain.value = 0.05
          osc.connect(gain)
          gain.connect(merger, 0, 2)
          gain.connect(merger, 0, 3)
          osc.start()
          await ctx.resume()
          report.contextState = ctx.state
          await new Promise((resolve) => setTimeout(resolve, 1500))
          osc.stop()
          report.tonePlayed = true
        }
      }
      await ctx.close()
    } catch (error) {
      report.error = `${error.name}: ${error.message}`
    }
    return report
  })
  console.log(JSON.stringify(result, null, 2))
} finally {
  await browser.close()
}
