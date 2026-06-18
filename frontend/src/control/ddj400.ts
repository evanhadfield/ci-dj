/** Pioneer DDJ-400 → ControlIntent (docs/midi-ddj-400.md, issue #30). The
 * DDJ-400 is the FLX4's predecessor and shares the same Pioneer 2-deck byte
 * scheme — deck 1 on `0x90`/`0xB0`, deck 2 on `0x91`/`0xB1`, mixer on `0xB6`,
 * pads on `0x97`/`0x99` (shift layer `0x98`/`0x9A`), PLAY `0x0B`, CUE `0x0C`,
 * pads/buttons lit by the Pioneer echo. The FLX4 map was itself derived from
 * the DDJ-400 family chart (docs/midi-ddj-flx4.md), so this driver reuses the
 * FLX4 translator and LED scheme: any divergence is a byte-map gap to confirm
 * on the device (the hardware checklist), not registry behaviour. Choosing a
 * near-identical second controller is deliberate — it isolates registry bugs
 * from byte-map bugs (issue #30).
 *
 * The one device-specific difference that matters for binding is the
 * position-sync SysEx: the DDJ-400 has its own (the FLX4's is FLX4-specific). */

import { createFlx4Translator, flx4Leds, isPadModeSwitch } from './flx4'
import type { ControllerDriver } from './driver'

/** Makes the DDJ-400 dump every analog control's current position on connect,
 * the same role as the FLX4's query but its own bytes. Verbatim from the
 * Mixxx DDJ-400 script's `init` (`midi.sendSysexMsg([...], 12)`); doubles as
 * the controller's keep-alive. */
export const DDJ400_STATUS_QUERY = [
  0xf0, 0x00, 0x40, 0x05, 0x00, 0x00, 0x02, 0x06, 0x00, 0x03, 0x01, 0xf7,
]

export const ddj400Driver: ControllerDriver = {
  id: 'ddj400',
  label: 'Pioneer DDJ-400',
  nameFragment: 'DDJ-400',
  initSysex: DDJ400_STATUS_QUERY,
  createTranslator: createFlx4Translator,
  isPadModeSwitch,
  leds: flx4Leds,
}
