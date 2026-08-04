// PROTOTYPE — throwaway (Slice 20 spec exploration), do not review

/** Variant B — category-wise cards: each category one card (own
 * surface/border) holding its params as compact rows, long arrays as
 * scrubbable cell grids; cards flow in a CSS-columns masonry (small
 * categories make small cards). */
import { For, type Component } from 'solid-js'
import { CATEGORIES } from './categories'
import CategoryCard from './CategoryCard'

const VariantB: Component = () => (
  <div class="adv-cats">
    <For each={CATEGORIES}>
      {(category) => <CategoryCard category={category} />}
    </For>
  </div>
)

export default VariantB
