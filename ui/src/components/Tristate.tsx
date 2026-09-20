import { For, type Component } from 'solid-js'

/** The three states of a `tristate` kind: raw 0 / 1 / 2. */
const OPTIONS = ['Off', 'On', 'Auto'] as const

/** The id of one option's radio — the card's `for` target while checked. */
export const tristateRadioId = (id: string, option: number): string =>
  `${id}-r${String(option)}`

/**
 * A shared three-way segmented control (#86): three native radios in
 * one group — one Tab stop, Arrow keys move within it natively; each
 * radio's `label` carries the option text, and the skin paints
 * `:checked + label` as the active segment (ADR-0011). Commits are
 * ack-then-apply like [`Toggle`]: the click cancels the native check,
 * `onSelect` gets the option (Chromium's Arrow-key move dispatches a
 * click too), and re-picking the checked option asks nothing.
 */
const Tristate: Component<{
  id: string
  /** Accessible name of the group. */
  name: string
  /** The checked option: raw 0 / 1 / 2. */
  value: number
  /** Called with the option the click asks for; the ack lands it. */
  onSelect: (option: number) => void
}> = (props) => (
  <div class="adv-tristate" role="radiogroup" aria-label={props.name}>
    <For each={OPTIONS}>
      {(text, option) => (
        <>
          <input
            type="radio"
            id={tristateRadioId(props.id, option())}
            class="adv-tristate__radio"
            name={props.id}
            value={String(option())}
            checked={props.value === option()}
            onClick={(event) => {
              event.preventDefault()
              if (props.value !== option()) props.onSelect(option())
            }}
          />
          <label
            class="adv-tristate__seg"
            for={tristateRadioId(props.id, option())}
          >
            {text}
          </label>
        </>
      )}
    </For>
  </div>
)

export default Tristate
