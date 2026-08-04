// PROTOTYPE — throwaway (Slice 20 spec exploration), do not review

/** Variant C — rail + single category: a left category rail (top chip
 * row on narrow widths), one category's params as roomy settings rows. */
import { For, createSignal, type Component } from 'solid-js'
import { CATEGORIES } from './categories'
import ParamCard from './ParamCard'

const VariantC: Component = () => {
  const [active, setActive] = createSignal(CATEGORIES[0]?.name ?? '')
  const activeCategory = () =>
    CATEGORIES.find((category) => category.name === active()) ?? CATEGORIES[0]
  return (
    <div class="adv-rail">
      <nav class="adv-rail__nav" aria-label="Advanced categories">
        <For each={CATEGORIES}>
          {(category) => (
            <button
              type="button"
              class="adv-rail__item"
              classList={{
                'adv-rail__item--active': active() === category.name,
              }}
              onClick={() => setActive(category.name)}
            >
              {category.label}
              <span class="adv-rail__count">{category.params.length}</span>
            </button>
          )}
        </For>
      </nav>
      <div class="adv-rail__page">
        <h3 class="adv-rail__title">{activeCategory()?.label}</h3>
        <For each={activeCategory()?.params ?? []}>
          {(name) => <ParamCard name={name} row />}
        </For>
      </div>
    </div>
  )
}

export default VariantC
