// PROTOTYPE — throwaway (Slice 20 spec exploration), do not review

/** Variant C — category-wise cards + composite band plots: variant B's
 * card structure, but prefix-grouped band arrays merge into composite
 * plots sharing one `*bf` frequency axis (wiring's `compositeItems`). */
import { For, type Component } from 'solid-js'
import { CATEGORIES } from './categories'
import CategoryCard from './CategoryCard'

const VariantC: Component = () => (
  <div class="adv-cats adv-cats--composite">
    <For each={CATEGORIES}>
      {(category) => <CategoryCard category={category} composite />}
    </For>
  </div>
)

export default VariantC
