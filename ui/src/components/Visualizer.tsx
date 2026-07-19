import {
  Index,
  createEffect,
  on,
  onCleanup,
  onMount,
  type Component,
} from 'solid-js'
import { DB_FRAC_BITS, rawToDisplay } from '../lib/units'
import { selectedProfile, visEnabled } from '../store/state'
import { visFrame, visIdle } from '../store/vis'
import EqCurve from './EqCurve'
import './Visualizer.css'

/**
 * What streamed silence produces — every column's from-mount floor,
 * snapped back to under Vis idle (data, not appearance: the floor's
 * *look*, and how the display descends to it, is the skin's).
 */
const FLOOR = { '--exc': '-12', '--gain': '0' }

/**
 * The live band count — the resolved `vcnb` state param, reactive. The
 * event arrays stay fixed 20-slot; the component reads the first
 * `vcnb` slots.
 */
const bandCount = () => selectedProfile()?.params['vcnb']?.[0] ?? 0

/**
 * The original DDP's visualizer (ADR-0008), a pure render of the
 * latest `vis` frame — no ballistics, no fade, no client smoothing:
 * the engine's excitation data is already ballistic. The one discrete
 * state is **Vis idle** (a dead feed has no data to falsify): every
 * column snaps to the floor and the root carries `visualizer--idle`;
 * enter and exit both land inside the rAF paint, vars + modifier in
 * one style recalc — exit never flashes the floor. Markup per the skin
 * contract (ADR-0011): one `vis-column` per live band publishing
 * `--exc` (`vcbe[c]`) / `--gain` (`vcbg[c]`) as continuous dB floats;
 * quantization, colors, the idle descent, and every off-look live in
 * skin CSS. The GEQ editor (issue #25) rides in the same root.
 */
const Visualizer: Component = () => {
  let section!: HTMLElement
  let columns!: HTMLDivElement
  let frameRequest: number | undefined

  /** Paints the latest frame — or the idle floor — onto the columns. */
  const paint = () => {
    frameRequest = undefined
    const idle = visIdle()
    section.classList.toggle('visualizer--idle', idle)
    if (idle) {
      for (const column of columns.children) {
        if (!(column instanceof HTMLElement)) continue
        column.style.setProperty('--exc', FLOOR['--exc'])
        column.style.setProperty('--gain', FLOOR['--gain'])
      }
      return
    }
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
          String(rawToDisplay(exc, DB_FRAC_BITS)),
        )
      }
      if (gain !== undefined) {
        column.style.setProperty(
          '--gain',
          String(rawToDisplay(gain, DB_FRAC_BITS)),
        )
      }
    }
  }

  // Coalesce to display frames: several events per frame schedule one
  // rAF, and `paint` reads the signals then — the last event wins.
  // `defer` keeps a pre-mount frame from repainting a fresh mount.
  createEffect(
    on(
      [visFrame, visIdle],
      () => {
        frameRequest ??= requestAnimationFrame(paint)
      },
      { defer: true },
    ),
  )
  // From-mount state without a paint: the static FLOOR style below is
  // the vars half; the modifier matches whatever the feed already is
  // (onMount runs untracked — later flips go through `paint`).
  onMount(() => {
    section.classList.toggle('visualizer--idle', visIdle())
  })
  onCleanup(() => {
    if (frameRequest !== undefined) cancelAnimationFrame(frameRequest)
  })

  return (
    <section
      class="visualizer"
      classList={{ 'visualizer--off': !visEnabled() }}
      aria-label="Visualizer"
      ref={section}
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
      <EqCurve />
    </section>
  )
}

export default Visualizer
