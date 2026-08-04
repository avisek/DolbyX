// PROTOTYPE — throwaway (Slice 20 spec exploration), do not review

/**
 * One category as one card (variants B/C): own surface + border, the
 * shared CategoryHead (divergence + reset), params as compact rows.
 * `composite` swaps band-array groups for composite plots (variant C);
 * everything else stays cell-grid rows either way.
 */
import { For, Show, type Component } from 'solid-js'
import type { AdvancedCategory } from './categories'
import CategoryHead from './CategoryHead'
import Composite from './Composite'
import ParamCard from './ParamCard'
import { compositeItems } from './wiring'

const CategoryCard: Component<{
  category: AdvancedCategory
  composite?: boolean
}> = (props) => (
  <section class="adv-cat">
    <CategoryHead category={props.category} />
    <div class="adv-cat__body">
      <Show
        when={props.composite === true}
        fallback={
          <For each={props.category.params}>
            {(name) => <ParamCard name={name} row mode="cells" />}
          </For>
        }
      >
        <For each={compositeItems(props.category.params)}>
          {(item) =>
            'composite' in item ? (
              <Composite axis={item.composite.axis} rows={item.composite.rows} />
            ) : (
              <ParamCard name={item.param} row mode="cells" />
            )
          }
        </For>
      </Show>
    </div>
  </section>
)

export default CategoryCard
