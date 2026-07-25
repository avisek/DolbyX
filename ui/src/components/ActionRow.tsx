import { type Component } from 'solid-js'
import './ActionRow.css'

/**
 * The four CRUD affordances of one action row (issue #26), acting on
 * the caller's current selection: Add · Rename · Delete · Reset. All
 * four render always — state flips `disabled`, never presence, so the
 * layout never shifts; Add is never disabled. `kind` qualifies the
 * accessible names ("Add profile" vs "Add EQ preset").
 */
const ActionRow: Component<{
  /** The accessible-name qualifier: "profile" | "EQ preset". */
  kind: string
  onAdd: () => void
  renameDisabled: boolean
  onRename: () => void
  deleteDisabled: boolean
  onDelete: () => void
  resetDisabled: boolean
  onReset: () => void
}> = (props) => (
  <div class="action-row">
    <button
      type="button"
      class="action-row__button"
      aria-label={`Add ${props.kind}`}
      onClick={() => {
        props.onAdd()
      }}
    >
      Add
    </button>
    <button
      type="button"
      class="action-row__button"
      aria-label={`Rename ${props.kind}`}
      disabled={props.renameDisabled}
      onClick={() => {
        props.onRename()
      }}
    >
      Rename
    </button>
    <button
      type="button"
      class="action-row__button"
      aria-label={`Delete ${props.kind}`}
      disabled={props.deleteDisabled}
      onClick={() => {
        props.onDelete()
      }}
    >
      Delete
    </button>
    <button
      type="button"
      class="action-row__button"
      aria-label={`Reset ${props.kind}`}
      disabled={props.resetDisabled}
      onClick={() => {
        props.onReset()
      }}
    >
      Reset
    </button>
  </div>
)

export default ActionRow
