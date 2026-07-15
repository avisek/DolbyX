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

/** The original 20-band grid — profiles resolve `gebf` to it. */
export const DDP_GRID = [
  43, 129, 215, 301, 431, 603, 775, 947, 1206, 1550, 2067, 2756, 3618, 4651,
  5685, 7063, 8958, 11025, 13781, 18777,
] as const

/**
 * The master-control and visualizer rows of `parameters.toml` (+ the
 * `vnnb` readout) — ranges, `frac_bits`, kinds, and defaults verbatim
 * from the shipped table, so widgets resolve against daemon truth.
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
    def({
      name: 'gebf',
      length: 40,
      min: 20,
      max: 20000,
      // The engine's 10-band power-on grid; the resolved 20-band grid
      // arrives via the profiles (defaults.toml shared block).
      default: [
        32,
        64,
        125,
        250,
        500,
        1000,
        2000,
        4000,
        8000,
        16000,
        ...Array<number>(30).fill(20),
      ],
      kind: 'frequency_hz',
      category: 'geq',
    }),
    def({
      name: 'vcbg',
      length: 20,
      min: -192,
      max: 576,
      frac_bits: 4,
      default: Array<number>(20).fill(0),
      kind: { decibel: { lkfs: false } },
      category: 'visualizer',
      access: 'read_only_dynamic',
    }),
  ]
}

/**
 * One factory profile as the snapshot carries it — every profile
 * resolves the shared 20-band `gebf` grid (defaults.toml `[profile]`).
 */
function factoryProfile(
  id: string,
  name: string,
  params: Profile['params'],
): Profile {
  return {
    id,
    name,
    is_factory: true,
    selected_eq_preset: null,
    params: { gebf: DDP_GRID, ...params },
  }
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
