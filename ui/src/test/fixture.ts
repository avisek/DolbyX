import type { Bootstrap } from '../lib/bootstrap'
import type { ParameterDef } from '../lib/parameters'
import type { EqPreset, Profile, StateSnapshot, VisParams } from '../lib/ws'

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

/**
 * The `defaults.toml` shared 20-band GEQ grid — `gebf` on profiles and
 * presets, mirrored by the profiles' `vcbf` so the custom vis grid
 * tracks the GEQ grid (issue #25). Live resolves carry the full
 * 40-slot allocation; the head-20 the UI reads is identical.
 */
const GEQ_GRID = [
  43, 129, 215, 301, 431, 603, 775, 947, 1206, 1550, 2067, 2756, 3618, 4651,
  5685, 7063, 8958, 11025, 13781, 18777,
] as const

/** The 20-band structure both `[profile]` and `[eq_preset]` share. */
const eqStructure = () => ({
  geon: [0],
  genb: [20],
  gebf: [...GEQ_GRID],
  gebg: Array.from({ length: 20 }, () => 0),
})

/** One factory profile as the snapshot carries it. */
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
    // The `defaults.toml [profile]` shared visualizer + GEQ pins
    // (issues #24, #25) — every resolved profile carries them.
    params: {
      ven: [1],
      vcnb: [20],
      vcbf: [...GEQ_GRID],
      ...eqStructure(),
      ...params,
    },
  }
}

/**
 * One factory EQ preset as the snapshot carries it (issue #23) —
 * complete: the `[eq_preset]` shared block resolves the 20-band
 * structure into every preset, so a selection shadows standalone.
 */
function factoryPreset(id: string, name: string): EqPreset {
  return {
    id,
    name,
    is_factory: true,
    params: { ieon: [1], ...eqStructure() },
  }
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

/**
 * One `vis` event's params as the daemon broadcasts them (issue #24
 * part A): four fixed 20-slot arrays, raw i16 1/16-dB. Unset custom
 * slots carry what streamed silence produces — `vcbe` −192 (−12 dB),
 * `vcbg` 0.
 */
export function fixtureVis(
  head: { vcbg?: readonly number[]; vcbe?: readonly number[] } = {},
): VisParams {
  const pad = (values: readonly number[] | undefined, floor: number) =>
    Array.from({ length: 20 }, (_slot, band) => values?.[band] ?? floor)
  return {
    vnbg: pad(undefined, 0),
    vnbe: pad(undefined, -192),
    vcbg: pad(head.vcbg, 0),
    vcbe: pad(head.vcbe, -192),
  }
}

/** What the daemon injects as `window.__BOOTSTRAP__` (Slice 04, #12). */
export function fixtureBootstrap(
  overrides: Partial<StateSnapshot> = {},
): Bootstrap {
  return { params: fixtureParams(), state: fixtureState(overrides) }
}

/** The fixture state with the active profile's params overridden. */
export function fixtureStateWithParams(
  params: Record<string, readonly number[]>,
): StateSnapshot {
  const seeded = fixtureState()
  return {
    ...seeded,
    profiles: seeded.profiles.map((profile) =>
      profile.id === seeded.selected_profile
        ? { ...profile, params: { ...profile.params, ...params } }
        : profile,
    ),
  }
}

/** A 20-slot ramp: value = band · step — distinct per-slot values. */
export function fixtureRamp(step: number): number[] {
  return Array.from({ length: 20 }, (_slot, band) => band * step)
}
