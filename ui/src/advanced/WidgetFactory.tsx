// PROTOTYPE — throwaway (Slice 20 spec exploration), do not review

/**
 * One widget per (kind, access) combo, metadata-driven — no per-param
 * code. Discrete commits = ack-then-apply; slider drags = optimistic
 * live per step (MasterControls' precedent).
 */
import { For, type Component, type JSX } from 'solid-js'
import {
  onValue,
  paramDef,
  unitLabel,
  type ParameterDef,
} from '../lib/parameters'
import { displayToRaw, rawToDisplay } from '../lib/units'
import { visFrame, visIdle } from '../store/vis'
import type { VisParams } from '../lib/ws'
import {
  commitParam,
  effectiveCount,
  liveParam,
  paramValues,
} from './wiring'

/** Display value of one raw slot, float noise trimmed. */
const display = (def: ParameterDef, raw: number): number =>
  Number(rawToDisplay(raw, def.frac_bits).toFixed(2))

/** Raw head value. */
const head = (def: ParameterDef): number => paramValues(def)[0] ?? 0

/** Clamped display → raw commit value. */
const toRaw = (def: ParameterDef, value: number): number =>
  Math.min(def.max, Math.max(def.min, displayToRaw(value, def.frac_bits)))

const unit = (def: ParameterDef): string => unitLabel(def.kind)

/** Readout text: value + unit. */
const readout = (def: ParameterDef): string => {
  const text = String(display(def, head(def)))
  const suffix = unit(def)
  return suffix === '' ? text : `${text} ${suffix}`
}

// — Scalar widgets —

const Toggle: Component<{ def: ParameterDef }> = (props) => (
  <button
    type="button"
    class="adv-toggle"
    role="switch"
    aria-checked={head(props.def) !== 0}
    aria-label={props.def.label}
    onClick={() => {
      commitParam(props.def, [
        head(props.def) === 0 ? onValue(props.def.kind) : 0,
      ])
    }}
  >
    <span class="adv-toggle__track" aria-hidden="true">
      <span class="adv-toggle__thumb" />
    </span>
  </button>
)

/** 0 / 1 / 2 segmented — DAP_FEATURE_OFF / ON / AUTO (`tristate.on`
 * is what a curated *toggle* writes for "on"; the panel exposes all
 * three states explicitly). */
const Tristate: Component<{ def: ParameterDef }> = (props) => (
  <div class="adv-tristate" role="group" aria-label={props.def.label}>
    <For each={['Off', 'On', 'Auto']}>
      {(label, i) => (
        <button
          type="button"
          class="adv-tristate__seg"
          classList={{ 'adv-tristate__seg--active': head(props.def) === i() }}
          aria-pressed={head(props.def) === i()}
          onClick={() => {
            commitParam(props.def, [i()])
          }}
        >
          {label}
        </button>
      )}
    </For>
  </div>
)

/** Slider + readout, display units — decibel, degrees, small-range int. */
const Slider: Component<{ def: ParameterDef }> = (props) => (
  <div class="adv-slider">
    <input
      type="range"
      class="adv-slider__input"
      aria-label={props.def.label}
      min={rawToDisplay(props.def.min, props.def.frac_bits)}
      max={rawToDisplay(props.def.max, props.def.frac_bits)}
      step={rawToDisplay(1, props.def.frac_bits)}
      value={display(props.def, head(props.def))}
      onInput={(event) => {
        liveParam(props.def, [
          toRaw(props.def, event.currentTarget.valueAsNumber),
        ])
      }}
    />
    <span class="adv-slider__value">{readout(props.def)}</span>
  </div>
)

/** Number entry, display units — commit on change (blur / Enter). */
const NumberEntry: Component<{ def: ParameterDef }> = (props) => (
  <div class="adv-number">
    <input
      type="number"
      class="adv-number__input"
      aria-label={props.def.label}
      min={rawToDisplay(props.def.min, props.def.frac_bits)}
      max={rawToDisplay(props.def.max, props.def.frac_bits)}
      step={rawToDisplay(1, props.def.frac_bits)}
      value={display(props.def, head(props.def))}
      onChange={(event) => {
        const value = event.currentTarget.valueAsNumber
        if (Number.isNaN(value)) return
        commitParam(props.def, [toRaw(props.def, value)])
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur()
      }}
    />
    <span class="adv-number__unit">{unit(props.def)}</span>
  </div>
)

// — Array widgets —

/** Per-band mini-inputs, trimmed to the group's effective `*nb` count. */
const BandArray: Component<{ def: ParameterDef }> = (props) => {
  const count = () => effectiveCount(props.def)
  const slots = () => Array.from({ length: count() }, (_slot, i) => i)
  return (
    <div class="adv-bands">
      <For each={slots()}>
        {(i) => (
          <input
            type="number"
            class="adv-bands__input"
            aria-label={`${props.def.label} band ${String(i + 1)}`}
            step={rawToDisplay(1, props.def.frac_bits)}
            value={display(props.def, paramValues(props.def)[i] ?? 0)}
            onChange={(event) => {
              const value = event.currentTarget.valueAsNumber
              if (Number.isNaN(value)) return
              const next = paramValues(props.def).slice(0, count())
              next[i] = toRaw(props.def, value)
              commitParam(props.def, next)
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.currentTarget.blur()
            }}
          />
        )}
      </For>
      <span class="adv-bands__meta">
        {String(count())} of {String(props.def.length)} bands
      </span>
    </div>
  )
}

/** `aobg` — channel-major `[chan_id, gains…] × aocc`, terminator-aware
 * (terminator value AK_CHAN_EMPTY unknown; guessed as any negative id). */
const Aobg: Component<{ def: ParameterDef }> = (props) => {
  const chanCount = () => paramValues(paramDef('aocc'))[0] ?? 0
  const bandCount = () => paramValues(paramDef('aonb'))[0] ?? 0
  const rows = () => {
    const values = paramValues(props.def)
    const nb = bandCount()
    const parsed: { id: number; at: number; gains: readonly number[] }[] = []
    let pos = 0
    for (let chan = 0; chan < chanCount(); chan += 1) {
      const id = values[pos]
      if (id === undefined || id < 0) break
      parsed.push({ id, at: pos + 1, gains: values.slice(pos + 1, pos + 1 + nb) })
      pos += 1 + nb
    }
    return parsed
  }
  return (
    <div class="adv-aobg">
      <For
        each={rows()}
        fallback={<span class="adv-aobg__empty">no channels configured</span>}
      >
        {(row) => (
          <div class="adv-aobg__row">
            <span class="adv-aobg__chan">ch {String(row.id)}</span>
            <For each={row.gains}>
              {(gain, i) => (
                <input
                  type="number"
                  class="adv-bands__input"
                  aria-label={`${props.def.label} channel ${String(row.id)} band ${String(i() + 1)}`}
                  step={rawToDisplay(1, props.def.frac_bits)}
                  value={display(props.def, gain)}
                  onChange={(event) => {
                    const value = event.currentTarget.valueAsNumber
                    if (Number.isNaN(value)) return
                    const abs = row.at + i()
                    const next = paramValues(props.def).slice(
                      0,
                      Math.max(abs + 1, row.at + bandCount()),
                    )
                    next[abs] = toRaw(props.def, value)
                    commitParam(props.def, next)
                  }}
                />
              )}
            </For>
          </div>
        )}
      </For>
    </div>
  )
}

// — Read-only widgets —

/** ReadOnly-Static, from the snapshot `readouts` map. `ver` formats
 * dotted (`2.0.4.0`). */
const StaticReadout: Component<{ def: ParameterDef }> = (props) => {
  const text = () => {
    const values = paramValues(props.def).slice(0, effectiveCount(props.def))
    if (props.def.name === 'ver') return values.join('.')
    return values.map((raw) => String(display(props.def, raw))).join(', ')
  }
  return <span class="adv-readout">{text()}</span>
}

/** ReadOnly-Dynamic (`vnbg vnbe vcbg vcbe`) — live mini-bars off the
 * vis frame signal; dB published as `--db` (skin paints the height). */
const DynamicBands: Component<{ def: ParameterDef }> = (props) => {
  const key = props.def.name as keyof VisParams
  const bands = () => {
    if (visIdle()) return undefined
    return visFrame()?.[key]?.slice(0, effectiveCount(props.def))
  }
  return (
    <div class="adv-dyn">
      <For
        each={bands()}
        fallback={<span class="adv-dyn__idle">feed idle</span>}
      >
        {(raw) => (
          <span
            class="adv-dyn__bar"
            style={{ '--db': String(rawToDisplay(raw, props.def.frac_bits)) }}
            title={`${String(display(props.def, raw))} dB`}
          />
        )}
      </For>
    </div>
  )
}

/** Unknown combo fallback — opaque int display. */
const Opaque: Component<{ def: ParameterDef }> = (props) => (
  <span class="adv-readout">{paramValues(props.def).join(', ')}</span>
)

/** Dispatches a `(kind, access)` combo to its widget. `def` is static
 * per card, so plain setup-time branching stays sound. */
const WidgetFactory: Component<{ def: ParameterDef }> = (props): JSX.Element => {
  const def = props.def
  if (def.access === 'read_only_dynamic') return <DynamicBands def={def} />
  if (def.access === 'read_only_static') return <StaticReadout def={def} />
  const kind = def.kind
  if (typeof kind === 'object') {
    if ('tristate' in kind) return <Tristate def={def} />
    // decibel — scalar slider; band arrays fall through below.
    if (def.length === 1) return <Slider def={def} />
    return <BandArray def={def} />
  }
  if (kind === 'aobg_channel_major') return <Aobg def={def} />
  if (def.length > 1) {
    // per_band / frequency_hz arrays — mini-inputs either way.
    if (kind === 'per_band' || kind === 'frequency_hz') {
      return <BandArray def={def} />
    }
    console.warn(`advanced: no widget for ${def.name} (${kind}[])`)
    return <Opaque def={def} />
  }
  if (kind === 'toggle') return <Toggle def={def} />
  if (kind === 'degrees') return <Slider def={def} />
  if (kind === 'frequency_hz') return <NumberEntry def={def} />
  if (kind === 'integer') {
    // Small range → slider; wide (band counts, 20 kHz) → number entry.
    return def.max - def.min <= 32 ? (
      <Slider def={def} />
    ) : (
      <NumberEntry def={def} />
    )
  }
  console.warn(`advanced: no widget for ${def.name} (${String(kind)})`)
  return <Opaque def={def} />
}

export default WidgetFactory
