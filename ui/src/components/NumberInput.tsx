import { Show, createEffect, on, type Component } from 'solid-js'

/** A complete number — rejects the partials typing passes through. */
const NUMBER = /^[-+]?(\d+(\.\d+)?|\.\d+)$/

/**
 * The one numeric box (#87), a shared control: the engine follows *as
 * you type*. Every complete number is a live write clamped to
 * `[min, max]` while the text stays as typed; blur / Enter commits if
 * it differs from store truth and re-syncs the text; Esc reverts.
 * Uncontrolled while focused, mirroring the store otherwise (read-only
 * always). Display units in and out — the caller converts.
 */
const NumberInput: Component<{
  id: string
  /** Accessible name. */
  name: string
  /** Store truth, display units. */
  value: () => number
  min: number
  max: number
  /** The kind's unit label — empty renders no overlay. */
  unit: string
  readOnly?: boolean | undefined
  /** Roving-tabindex members (band editors) pass -1. */
  tabIndex?: number | undefined
  /** The field element, for composites that focus it programmatically. */
  ref?: ((input: HTMLInputElement) => void) | undefined
  onLive?: ((value: number) => void) | undefined
  onCommit?: ((value: number) => void) | undefined
}> = (props) => {
  let input!: HTMLInputElement
  const editable = () => props.readOnly !== true
  const clamp = (value: number): number =>
    Math.min(props.max, Math.max(props.min, value))

  /** The field's text as a complete number, else undefined. */
  const parsed = (): number | undefined => {
    const text = input.value
    return NUMBER.test(text) ? Number(text) : undefined
  }

  /** Re-syncs the text to store truth. */
  const sync = (): void => {
    input.value = String(props.value())
  }

  // Mirror the store whenever the field isn't being typed in.
  createEffect(
    on(
      () => props.value(),
      () => {
        if (!editable() || document.activeElement !== input) sync()
      },
    ),
  )

  return (
    <span class="adv-input">
      <input
        ref={(element) => {
          input = element
          props.ref?.(element)
        }}
        id={props.id}
        class="adv-input__field"
        type="text"
        inputmode="decimal"
        aria-label={props.name}
        readonly={!editable()}
        tabindex={props.tabIndex}
        // Selected text must never start a drag — the scrub (#88)
        // depends on it.
        onDragStart={(event) => {
          event.preventDefault()
        }}
        onInput={() => {
          // Instant, clamped: the text stays as typed.
          const value = parsed()
          if (value !== undefined) props.onLive?.(clamp(value))
        }}
        onBlur={() => {
          const value = parsed()
          if (value !== undefined) {
            const clamped = clamp(value)
            if (clamped !== props.value()) props.onCommit?.(clamped)
          }
          sync()
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') input.blur()
          else if (event.key === 'Escape') {
            sync()
            input.blur()
          }
        }}
      />
      <Show when={props.unit !== ''}>
        <span class="adv-input__unit" aria-hidden="true">
          {props.unit}
        </span>
      </Show>
    </span>
  )
}

export default NumberInput
