import { Index, createSignal, type Component } from 'solid-js'

/**
 * PROTOTYPE (#129): the Skin switcher on the Picker skeleton — label +
 * radio pills, no Picker actions. Registry stubbed, state in memory;
 * the real one reads the snapshot's `skin` and sends `set_skin`.
 */
const SKINS = [
  { id: 'remastered', label: 'Remastered' },
  { id: 'classic', label: 'Classic' },
] as const

const SkinPicker: Component = () => {
  const [skin, setSkin] = createSignal<string>('remastered')
  return (
    <div class="picker picker--skin">
      <span class="picker__label">Skin</span>
      <div class="picker__options" role="radiogroup" aria-label="Skin">
        <Index each={SKINS}>
          {(option) => (
            <>
              <input
                type="radio"
                id={`picker-skin-${option().id}`}
                class="picker__radio"
                name="picker-skin"
                checked={skin() === option().id}
                onChange={() => setSkin(option().id)}
              />
              <label class="picker__option" for={`picker-skin-${option().id}`}>
                <span class="picker__name">{option().label}</span>
              </label>
            </>
          )}
        </Index>
      </div>
    </div>
  )
}

export default SkinPicker
