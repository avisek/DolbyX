import { Index, createEffect, on, onCleanup, type Component } from 'solid-js'
import { rawToDisplay } from '../lib/units'
import { selectedProfile } from '../store/state'
import { visFrame } from '../store/vis'
import './Visualizer.css'

/** The vis arrays' dB coding: raw i16 1/16 dB (ADR-0005). */
const VIS_FRAC_BITS = 4

/**
 * What streamed silence produces — every column's from-mount floor,
 * held until the first `vis` event (data, not appearance: the floor's
 * *look* is the skin's).
 */
const FLOOR = { '--exc': '-12', '--gain': '0' }

/**
 * The live band count — the resolved `vcnb` state param, reactive. The
 * event arrays stay fixed 20-slot; the component reads the first
 * `vcnb` slots.
 */
const bandCount = () => selectedProfile()?.params['vcnb']?.[0] ?? 0

/** Resolved `ven`, mirrored as `visualizer--off` — never a data gate. */
const visEnabled = () => (selectedProfile()?.params['ven']?.[0] ?? 0) !== 0

/**
 * The original DDP's visualizer (ADR-0008), a pure render of the
 * latest `vis` frame — no ballistics, no idle concept, no timers: the
 * engine's excitation data is already ballistic, and processed silence
 * walks the display to the floor by itself. Markup per the skin
 * contract (ADR-0011): one `vis-column` per live band publishing
 * `--exc` (`vcbe[c]`) / `--gain` (`vcbg[c]`) as continuous dB floats;
 * quantization, colors, and every off-look live in skin CSS. Slice 17
 * (#25) appends the `eq-*` siblings.
 */
const Visualizer: Component = () => {
  let columns!: HTMLDivElement
  let frameRequest: number | undefined

  /** Paints the latest frame onto the live columns. */
  const paint = () => {
    frameRequest = undefined
    const frame = visFrame()
    if (!frame) return
    for (let band = 0; band < columns.children.length; band += 1) {
      const column = columns.children[band]
      if (!(column instanceof HTMLElement)) continue
      const exc = frame.vcbe[band]
      const gain = frame.vcbg[band]
      if (exc !== undefined) {
        column.style.setProperty(
          '--exc',
          String(rawToDisplay(exc, VIS_FRAC_BITS)),
        )
      }
      if (gain !== undefined) {
        column.style.setProperty(
          '--gain',
          String(rawToDisplay(gain, VIS_FRAC_BITS)),
        )
      }
    }
  }

  // Coalesce to display frames: several events per frame schedule one
  // rAF, and `paint` reads the signal then — the last event wins.
  // `defer` keeps a pre-mount frame from repainting a fresh mount.
  createEffect(
    on(
      visFrame,
      () => {
        frameRequest ??= requestAnimationFrame(paint)
      },
      { defer: true },
    ),
  )
  onCleanup(() => {
    if (frameRequest !== undefined) cancelAnimationFrame(frameRequest)
  })

  return (
    <section
      class="visualizer"
      classList={{ 'visualizer--off': !visEnabled() }}
      aria-label="Visualizer"
    >
      <div class="vis-columns" ref={columns}>
        <Index each={Array.from({ length: bandCount() })}>
          {() => (
            <div class="vis-column" style={FLOOR}>
              <div class="vis-column__fill" />
              <div class="vis-column__lattice" />
              <div class="vis-column__pip" />
            </div>
          )}
        </Index>
      </div>
    </section>
  )
}

export default Visualizer
