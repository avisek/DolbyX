/**
 * #137: the Picker's optional prop groups. `actions` and `rename` are
 * each all-or-nothing: omitted, the skeleton renders no Picker actions
 * (and never sets `picker--diverged`) and no rename field; passed, the
 * profile / EQ preset behaviour pinned in ProfileTabs.test and
 * EqPresetPicker.test is unchanged.
 */
import { cleanup, render, screen } from '@solidjs/testing-library'
import { afterEach, expect, it, vi } from 'vitest'
import Picker, { type PickerOption } from './Picker'

afterEach(() => {
  cleanup()
})

const options: readonly PickerOption[] = [
  { id: 'a', name: 'A', checked: true, factory: true },
  { id: 'b', name: 'B', checked: false, factory: false },
]

const actions = () => ({
  onAdd: vi.fn(),
  renameDisabled: false,
  onRename: vi.fn(),
  deleteDisabled: false,
  onDelete: vi.fn(),
  resetDisabled: false,
  onReset: vi.fn(),
})

const rename = () => ({
  renaming: true,
  onRenameCommit: vi.fn(),
  onRenameCancel: vi.fn(),
})

const picker = () => {
  const el = document.querySelector('.picker')
  if (!el) throw new Error('no Picker rendered')
  return el
}

// Behavior 1 (#137): no `actions` ⇒ no `.picker__actions`, no buttons,
// and `picker--diverged` never set — there is no Reset to mean anything.
it('renders no Picker actions and never --diverged without the actions group', () => {
  render(() => (
    <Picker
      kind="skin"
      label="Skin"
      noun="skin"
      options={options}
      onPick={vi.fn()}
    />
  ))
  expect(picker().querySelector('.picker__actions')).toBeNull()
  expect(screen.queryByRole('button')).toBeNull()
  expect(picker().classList.contains('picker--diverged')).toBe(false)
  expect(picker().classList.contains('picker--skin')).toBe(true)
})

// Behavior 1 (#137): no `rename` ⇒ no field, even with actions present.
it('renders no rename field without the rename group', () => {
  render(() => (
    <Picker
      kind="skin"
      label="Skin"
      noun="skin"
      options={options}
      onPick={vi.fn()}
      actions={actions()}
    />
  ))
  expect(picker().querySelector('.picker__field')).toBeNull()
  expect(picker().querySelector('.picker__option--renaming')).toBeNull()
})

// Behavior 1 (#137): both groups ⇒ the four actions, `--diverged` on an
// enabled Reset, the rename field inside the checked pill — unchanged.
it('renders the actions, --diverged and the rename field with both groups', () => {
  render(() => (
    <Picker
      kind="profile"
      label="Profile"
      noun="profile"
      options={options}
      onPick={vi.fn()}
      actions={actions()}
      rename={rename()}
    />
  ))
  expect(
    screen
      .getAllByRole('button')
      .map((button) => button.getAttribute('aria-label')),
  ).toEqual([
    'Add profile',
    'Rename profile',
    'Delete profile',
    'Reset profile',
  ])
  expect(picker().classList.contains('picker--diverged')).toBe(true)
  expect(
    picker()
      .querySelector('.picker__option--renaming')
      ?.querySelector('.picker__field'),
  ).toBeTruthy()
})
