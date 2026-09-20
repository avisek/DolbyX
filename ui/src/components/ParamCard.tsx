import { Show, type Component } from 'solid-js'
import { paramDef } from '../lib/parameters'
import { isWritable } from '../store/wiring'
import WidgetFactory from './WidgetFactory'

/**
 * One AK parameter's card (#85): a `label` — no `for` yet, #86 points
 * it at the primary control — with flat children the skin subgrids
 * onto shared tracks. Zero appearance policy: the skin reads the
 * modifiers (ADR-0011); `title` is the engine's description. Labels
 * are category-relative, so the accessible name of every control
 * carries the category: "Volume Leveler Amount".
 */
const ParamCard: Component<{ name: string; categoryLabel: string }> = (
  props,
) => {
  // Static per card: the table never changes within a page load.
  // eslint-disable-next-line solid/reactivity
  const def = paramDef(props.name)
  const name = () => `${props.categoryLabel} ${def.label}`
  return (
    <label
      class="adv-card"
      classList={{
        'adv-card--array': def.length > 1,
        'adv-card--ro': !isWritable(def),
        'adv-card--exp': def.access === 'experimental',
      }}
      title={def.description}
    >
      <code class="adv-card__code">{def.name}</code>
      <span class="adv-card__label">{def.label}</span>
      {/* The reset marker — read-only params have no Content key, so
          no marker; `disabled` until divergence lands (#92). */}
      <Show when={isWritable(def)}>
        <button
          type="button"
          class="adv-card__reset"
          disabled
          aria-label={`Reset ${name()}`}
        />
      </Show>
      <div class="adv-card__control">
        <WidgetFactory def={def} name={name()} />
      </div>
    </label>
  )
}

export default ParamCard
