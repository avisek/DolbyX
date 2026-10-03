import type { Component } from 'solid-js'
import { skins } from '../skins'
import { state } from '../store/state'
import { setSkin } from '../store/ws'
import Picker from './Picker'

/**
 * The Skin picker (#137, CONTEXT.md): the Picker skeleton over the Skin
 * registry — one pill per entry in registry order, no Picker actions,
 * no rename; a pick is `set_skin`, ack-then-apply, moving the root
 * scalar for every connected UI (ADR-0013). `checked` is the store's
 * `skin`: an id the registry doesn't ship checks nothing — the default
 * paints, no pill claims to be it. `factory: true` throughout — no skin
 * is editable.
 */
const SkinPicker: Component = () => (
  <Picker
    kind="skin"
    label="Skin"
    noun="skin"
    options={skins.map((skin) => ({
      id: skin.id,
      name: skin.label,
      checked: state.skin === skin.id,
      factory: true,
    }))}
    onPick={(id) => {
      if (id !== null) setSkin(id)
    }}
  />
)

export default SkinPicker
