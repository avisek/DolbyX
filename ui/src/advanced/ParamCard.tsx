// PROTOTYPE — throwaway (Slice 20 spec exploration), do not review

/**
 * One parameter's card: 4-CC code + label + widget, divergence marker
 * (BEM modifier, skin paints the dot), experimental badge, per-param
 * reset. Long arrays (length ≥ 40) span the full row and collapse
 * behind a toggle. `row` renders the variant-C settings-row shape —
 * same internals, different modifier.
 */
import { Show, createSignal, type Component } from 'solid-js'
import { paramDef } from '../lib/parameters'
import WidgetFactory from './WidgetFactory'
import {
  canResetParam,
  paramDiverged,
  resetParam,
  writesToPreset,
} from './wiring'

const ParamCard: Component<{ name: string; row?: boolean }> = (props) => {
  const def = paramDef(props.name)
  const wide = def.length >= 40
  const [open, setOpen] = createSignal(false)
  const tooltip = def.help === '' ? def.description : `${def.description}\n\n${def.help}`
  return (
    <div
      class="adv-card"
      classList={{
        'adv-card--row': props.row === true,
        'adv-card--wide': wide,
        'adv-card--experimental': def.access === 'experimental',
        'adv-card--diverged': paramDiverged(def),
        'adv-card--preset': writesToPreset(def),
      }}
      title={tooltip}
    >
      <div class="adv-card__head">
        <code class="adv-card__code">{def.name}</code>
        <span class="adv-card__label">{def.label}</span>
        <Show when={def.access === 'experimental'}>
          <span class="adv-card__badge">experimental</span>
        </Show>
        <Show when={writesToPreset(def)}>
          <span class="adv-card__badge adv-card__badge--preset">preset</span>
        </Show>
        <span class="adv-card__dot" aria-hidden="true" />
        <Show when={canResetParam(def) && paramDiverged(def)}>
          <button
            type="button"
            class="adv-card__reset"
            title={`Reset ${def.name}`}
            onClick={() => {
              resetParam(def)
            }}
          >
            ↺
          </button>
        </Show>
        <Show when={wide}>
          <button
            type="button"
            class="adv-card__expand"
            aria-expanded={open()}
            onClick={() => setOpen(!open())}
          >
            {open() ? 'hide values' : 'show values'}
          </button>
        </Show>
      </div>
      <Show when={!wide || open()}>
        <div class="adv-card__body">
          <WidgetFactory def={def} />
        </div>
      </Show>
    </div>
  )
}

export default ParamCard
