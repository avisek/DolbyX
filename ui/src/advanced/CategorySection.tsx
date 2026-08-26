// PROTOTYPE — throwaway (Slice 20 spec exploration), do not review

/**
 * One category as one semantic section — the SAME DOM in every skin:
 * header (collapse toggle wrapping chevron + title, param count,
 * divergence marker, scoped reset) + body wrapper > param cards.
 * Collapsible via the header toggle; expanded by default; collapsed is
 * a BEM modifier on the section — the hide itself is skin CSS. Reset =
 * `resetProfile(id, ccs)`; see wiring's `categoryCcs` for the
 * preset-shadowing edge.
 */
import { For, createSignal, type Component } from 'solid-js'
import type { AdvancedCategory } from './categories'
import ParamCard from './ParamCard'
import { categoryDiverged, resetCategory } from './wiring'

const CategorySection: Component<{ category: AdvancedCategory }> = (props) => {
  const [open, setOpen] = createSignal(true)
  return (
    <section
      class="adv-cat"
      classList={{
        'adv-cat--collapsed': !open(),
        'adv-cat--diverged': categoryDiverged(props.category.params),
      }}
      aria-label={props.category.label}
    >
      <header class="adv-cat__head">
        <button
          type="button"
          class="adv-cat__toggle"
          aria-expanded={open()}
          onClick={() => setOpen(!open())}
        >
          <span class="adv-cat__chevron" aria-hidden="true" />
          <span class="adv-cat__title">{props.category.label}</span>
        </button>
        <span class="adv-cat__count">
          {String(props.category.params.length)}
        </span>
        <span class="adv-cat__dot" aria-hidden="true" />
        <button
          type="button"
          class="adv-cat__reset"
          disabled={!categoryDiverged(props.category.params)}
          aria-label={`Reset ${props.category.label}`}
          title={`Reset ${props.category.label}`}
          onClick={() => {
            resetCategory(props.category.params)
          }}
        />
      </header>
      <div class="adv-cat__body">
        <For each={props.category.params}>
          {(name) => <ParamCard name={name} />}
        </For>
      </div>
    </section>
  )
}

export default CategorySection
