// PROTOTYPE — throwaway (Slice 20 spec exploration), do not review

/**
 * One parameter's card — pure skeleton, zero layout policy: 4-CC code,
 * label, badge elements (text painted by the skin via `::before`;
 * `aria-label` carries the meaning), divergence marker element (BEM
 * modifier on the card; skin paints the dot), per-param reset (always
 * present, `disabled` when inapplicable — skins fade/hide disabled),
 * and the control region. Structural modifiers only: `--array` (long
 * array), `--ro`, `--exp`, `--diverged`, `--preset`.
 */
import { Show, type Component } from 'solid-js'
import { paramDef } from '../lib/parameters'
import WidgetFactory from './WidgetFactory'
import {
  canResetParam,
  paramDiverged,
  resetParam,
  writesToPreset,
} from './wiring'

const ParamCard: Component<{ name: string }> = (props) => {
  const def = paramDef(props.name)
  const readOnly =
    def.access === 'read_only_static' || def.access === 'read_only_dynamic'
  const tooltip =
    def.help === '' ? def.description : `${def.description}\n\n${def.help}`
  return (
    <div
      class="adv-card"
      classList={{
        'adv-card--array': def.length > 1,
        'adv-card--ro': readOnly,
        'adv-card--exp': def.access === 'experimental',
        'adv-card--diverged': paramDiverged(def),
        'adv-card--preset': writesToPreset(def),
      }}
      title={tooltip}
    >
      <div class="adv-card__head">
        <code class="adv-card__code">{def.name}</code>
        <span class="adv-card__label">{def.label}</span>
        <Show when={def.access === 'experimental'}>
          <span
            class="adv-badge adv-badge--exp"
            aria-label="Experimental parameter"
          />
        </Show>
        <Show when={readOnly}>
          <span
            class="adv-badge adv-badge--ro"
            aria-label="Read-only parameter"
          />
        </Show>
        <Show when={writesToPreset(def)}>
          <span
            class="adv-badge adv-badge--preset"
            aria-label="Writes to the selected EQ preset"
          />
        </Show>
        <span class="adv-card__dot" aria-hidden="true" />
        <button
          type="button"
          class="adv-card__reset"
          disabled={!(canResetParam(def) && paramDiverged(def))}
          aria-label={`Reset ${def.name}`}
          title={`Reset ${def.name}`}
          onClick={() => {
            resetParam(def)
          }}
        />
      </div>
      <div class="adv-card__control">
        <WidgetFactory def={def} />
      </div>
    </div>
  )
}

export default ParamCard
