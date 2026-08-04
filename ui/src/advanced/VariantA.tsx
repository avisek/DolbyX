// PROTOTYPE — throwaway (Slice 20 spec exploration), do not review

/** Variant A — param-wise cards: one continuous auto-fill grid,
 * category headers as full-width dividers (with the shared per-category
 * divergence + reset), long arrays as editable bar strips. */
import { For, type Component } from 'solid-js'
import { CATEGORIES } from './categories'
import CategoryHead from './CategoryHead'
import ParamCard from './ParamCard'

const VariantA: Component = () => (
  <div class="adv-flat">
    <For each={CATEGORIES}>
      {(category) => (
        <>
          <div class="adv-flat__divider">
            <CategoryHead category={category} />
          </div>
          <For each={category.params}>
            {(name) => <ParamCard name={name} mode="strip" />}
          </For>
        </>
      )}
    </For>
  </div>
)

export default VariantA
