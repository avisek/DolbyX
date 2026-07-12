import type { Bootstrap } from '../lib/bootstrap'
import type { ParameterDef } from '../lib/parameters'
import type { EqPreset, Profile, StateSnapshot } from '../lib/ws'

/** One table row over compact defaults — values stay daemon-truthful. */
function def(
  entry: Partial<ParameterDef> &
    Pick<ParameterDef, 'name' | 'kind' | 'category'>,
): ParameterDef {
  return {
    length: 1,
    min: 0,
    max: 1,
    frac_bits: 0,
    default: [0],
    access: 'settable',
    label: entry.name.toUpperCase(),
    description: '',
    help: '',
    ...entry,
  }
}

/**
 * The master-control rows of `parameters.toml` (+ the `vnnb` readout) —
 * ranges, `frac_bits`, kinds, and defaults verbatim from the shipped
 * table, so widgets resolve against daemon truth.
 */
export function fixtureParams(): readonly ParameterDef[] {
  return [
    def({
      name: 'vdhe',
      max: 2,
      kind: { tristate: { on: 2 } },
      category: 'headphone_virtualizer',
    }),
    def({
      name: 'dhsb',
      max: 96,
      frac_bits: 4,
      default: [96],
      kind: { decibel: { lkfs: false } },
      category: 'headphone_virtualizer',
    }),
    def({ name: 'deon', kind: 'toggle', category: 'dialog_enhancer' }),
    def({
      name: 'dea',
      max: 16,
      frac_bits: 4,
      kind: 'integer',
      category: 'dialog_enhancer',
    }),
    def({
      name: 'dvle',
      default: [1],
      kind: 'toggle',
      category: 'volume_leveller',
    }),
    def({
      name: 'dvla',
      max: 10,
      default: [7],
      kind: 'integer',
      category: 'volume_leveller',
    }),
    def({
      name: 'vnnb',
      min: 1,
      max: 20,
      default: [20],
      kind: 'integer',
      category: 'visualizer',
      access: 'read_only_static',
    }),
  ]
}

/** One factory profile as the snapshot carries it. */
function factoryProfile(
  id: string,
  name: string,
  params: Profile['params'],
): Profile {
  return { id, name, is_factory: true, selected_eq_preset: null, params }
}

/** One factory EQ preset as the snapshot carries it (issue #23). */
function factoryPreset(id: string, name: string): EqPreset {
  return { id, name, is_factory: true, params: { ieon: [1] } }
}

/**
 * A daemon-truthful state snapshot: the master-control values each
 * factory profile resolves to (`defaults.toml` over table defaults).
 */
export function fixtureState(
  overrides: Partial<StateSnapshot> = {},
): StateSnapshot {
  return {
    power: true,
    selected_profile: 'music',
    profiles: [
      factoryProfile('movie', 'Movie', {
        vdhe: [2],
        dhsb: [96],
        deon: [1],
        dea: [3],
        dvle: [0],
        dvla: [7],
      }),
      factoryProfile('music', 'Music', {
        vdhe: [2],
        dhsb: [48],
        deon: [1],
        dea: [2],
        dvle: [0],
        dvla: [4],
      }),
      factoryProfile('game', 'Game', {
        vdhe: [2],
        dhsb: [0],
        deon: [0],
        dea: [7],
        dvle: [1],
        dvla: [0],
      }),
      factoryProfile('voice', 'Voice', {
        vdhe: [0],
        dhsb: [0],
        deon: [1],
        dea: [10],
        dvle: [0],
        dvla: [0],
      }),
    ],
    eq_presets: [
      factoryPreset('open', 'Open'),
      factoryPreset('rich', 'Rich'),
      factoryPreset('focused', 'Focused'),
    ],
    readouts: { vnnb: [20] },
    ...overrides,
  }
}

/** What the daemon injects as `window.__BOOTSTRAP__` (Slice 04, #12). */
export function fixtureBootstrap(
  overrides: Partial<StateSnapshot> = {},
): Bootstrap {
  return { params: fixtureParams(), state: fixtureState(overrides) }
}
