// PROTOTYPE — throwaway (Slice 20 spec exploration), do not review

/** The Advanced panel (Slice 20, #28) — inline disclosure section at
 * the bottom of the shell. Prototype defaults EXPANDED (production:
 * collapsed + localStorage). Layout comes from `?variant=`. */
import { Match, Show, Switch, createSignal, type Component } from 'solid-js'
import Switcher from './Switcher'
import VariantA from './VariantA'
import VariantB from './VariantB'
import VariantC from './VariantC'
import { variant } from './variant'
import './advanced.css'

const AdvancedPanel: Component = () => {
  const [open, setOpen] = createSignal(true)
  return (
    <section class="advanced" aria-label="Advanced">
      <button
        type="button"
        class="advanced__header"
        aria-expanded={open()}
        onClick={() => setOpen(!open())}
      >
        <span class="advanced__chevron" aria-hidden="true">
          {open() ? '▾' : '▸'}
        </span>
        Advanced
      </button>
      <Show when={open()}>
        <Switch>
          <Match when={variant() === 'a'}>
            <VariantA />
          </Match>
          <Match when={variant() === 'b'}>
            <VariantB />
          </Match>
          <Match when={variant() === 'c'}>
            <VariantC />
          </Match>
        </Switch>
      </Show>
      <Switcher />
    </section>
  )
}

export default AdvancedPanel
