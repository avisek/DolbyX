import { For, createSignal, type Component } from 'solid-js'
import type { CategoryDef } from '../lib/parameters'
import { foldedCategories, setCategoryFolded } from '../lib/prefs'
import {
  categoryDiverges,
  categoryWritesToPreset,
  resetCategory,
} from '../store/wiring'
import ParamCard from './ParamCard'

/**
 * One Parameter category as a labelled section (#85): a header whose
 * fold toggle IS the header's box (chevron, title, count inside — no
 * nested interactive content) followed by the category's Reset marker
 * (#92: `disabled` while clean, one scoped `reset_*` on the category's
 * Source item), over a body of one card per param in `params` order.
 * The Fold is state — `adv-cat--collapsed`, content stays mounted, the
 * skin animates (ADR-0011 addendum) — remembered per browser
 * (`dolbyx.advanced.collapsed`).
 */
const CategorySection: Component<{ category: CategoryDef }> = (props) => {
  // Read once: the category table is static per page load (ADR-0006),
  // and the Fold is this section's own state, seeded from the pref.
  // eslint-disable-next-line solid/reactivity
  const stored = foldedCategories().includes(props.category.name)
  const [folded, setFolded] = createSignal(stored)
  const toggle = () => {
    setFolded(!folded())
    setCategoryFolded(props.category.name, folded())
  }
  return (
    <section
      class="adv-cat"
      classList={{
        'adv-cat--collapsed': folded(),
        'adv-cat--preset': categoryWritesToPreset(props.category),
        'adv-cat--diverged': categoryDiverges(props.category),
      }}
      aria-label={props.category.label}
    >
      <header class="adv-cat__head">
        <button
          type="button"
          class="adv-cat__toggle"
          aria-expanded={!folded()}
          onClick={toggle}
        >
          <span class="adv-cat__chevron" aria-hidden="true" />
          <span class="adv-cat__title">{props.category.label}</span>
          <span class="adv-cat__count">
            {String(props.category.params.length)}
          </span>
        </button>
        <button
          type="button"
          class="adv-cat__reset"
          disabled={!categoryDiverges(props.category)}
          aria-label={`Reset ${props.category.label}`}
          title={`Reset ${props.category.label}`}
          onClick={() => {
            resetCategory(props.category)
          }}
        />
      </header>
      <div class="adv-cat__body">
        <For each={props.category.params}>
          {(name) => (
            <ParamCard name={name} categoryLabel={props.category.label} />
          )}
        </For>
      </div>
    </section>
  )
}

export default CategorySection
