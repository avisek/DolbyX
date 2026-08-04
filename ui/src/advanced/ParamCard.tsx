// PROTOTYPE — throwaway (Slice 20 spec exploration), do not review

/**
 * One parameter's card: 4-CC code + label + widget, divergence marker
 * (BEM modifier, skin paints the dot), quiet Exp / RO badges, per-param
 * reset. Long arrays always render expanded (never collapsible). `row`
 * renders the compact category-card row shape (variants B/C) — same
 * internals, different modifier; array bodies drop to their own line.
 */
import { Show, type Component } from 'solid-js'
import { paramDef } from '../lib/parameters'
import WidgetFactory, { type ArrayMode } from './WidgetFactory'
import {
  canResetParam,
  paramDiverged,
  resetParam,
  writesToPreset,
} from './wiring'

const ParamCard: Component<{
  name: string
  row?: boolean
  mode?: ArrayMode
}> = (props) => {
  const def = paramDef(props.name)
  const wide = def.length > 8
  const readOnly =
    def.access === 'read_only_static' || def.access === 'read_only_dynamic'
  const tooltip =
    def.help === '' ? def.description : `${def.description}\n\n${def.help}`
  return (
    <div
      class="adv-card"
      classList={{
        'adv-card--row': props.row === true,
        'adv-card--wide': wide,
        'adv-card--diverged': paramDiverged(def),
        'adv-card--preset': writesToPreset(def),
      }}
      title={tooltip}
    >
      <div class="adv-card__head">
        <code class="adv-card__code">{def.name}</code>
        <span class="adv-card__label">{def.label}</span>
        <Show when={def.access === 'experimental'}>
          <span class="adv-badge">Exp</span>
        </Show>
        <Show when={readOnly}>
          <span class="adv-badge">RO</span>
        </Show>
        <Show when={writesToPreset(def)}>
          <span class="adv-badge adv-badge--preset">preset</span>
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
      </div>
      <div
        class="adv-card__body"
        classList={{ 'adv-card__body--block': def.length > 1 }}
      >
        <WidgetFactory def={def} mode={props.mode ?? 'strip'} />
      </div>
    </div>
  )
}

export default ParamCard
