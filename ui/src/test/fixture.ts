import { parse } from 'smol-toml'
import type { Bootstrap } from '../lib/bootstrap'
import type { CategoryDef, ParameterDef } from '../lib/parameters'
import type { EqPreset, Profile, StateSnapshot, VisParams } from '../lib/ws'
// The shipped table itself (ADR-0004) — the fixture is truth-derived, so
// panel tests exercise the real 64 shape and never drift (issue #85).
import parametersToml from '../../../crates/ddp-daemon/parameters.toml?raw'

/** One `[[param]]` row as the TOML carries it — `category` is derived. */
type ParamRow = Omit<ParameterDef, 'category'>

/**
 * The shipped `parameters.toml`, parsed once. The daemon's parser is the
 * validator (refuse-to-start on a malformed table); the cast trusts the
 * shape it enforces — kinds and accesses serialize identically in TOML
 * and JSON (externally tagged serde).
 */
const table = parse(parametersToml) as unknown as {
  readonly category: readonly CategoryDef[]
  readonly param: readonly ParamRow[]
}

/**
 * The real parameter table — every root leaf, `[[param]]` (engine) order,
 * each row's `category` derived from `[[category]]` membership the way
 * the daemon derives it.
 */
export function fixtureParams(): readonly ParameterDef[] {
  return table.param.map((row) => {
    const owner = table.category.find(({ params }) => params.includes(row.name))
    if (!owner)
      throw new Error(`parameters.toml: \`${row.name}\` uncategorized`)
    return { ...row, category: owner.name }
  })
}

/** The shipped `[[category]]` rows — section order, card order (issue #83). */
export function fixtureCategories(): readonly CategoryDef[] {
  return table.category
}

/** The real table with one row patched — for a def the table never ships. */
export function fixtureParamsWith(
  name: string,
  patch: Partial<ParameterDef>,
): readonly ParameterDef[] {
  return fixtureParams().map((def) =>
    def.name === name ? { ...def, ...patch } : def,
  )
}

/** Every writable param at its table default — a profile's full content. */
function writableDefaults(): Record<string, readonly number[]> {
  return Object.fromEntries(
    fixtureParams()
      .filter(
        (def) => def.access === 'settable' || def.access === 'experimental',
      )
      .map((def) => [def.name, def.default]),
  )
}

/**
 * The eight Readouts at their table defaults — what the main session
 * reads on the shipped engine (`vnnb` curates 20).
 */
function readouts(): Record<string, readonly number[]> {
  return Object.fromEntries(
    fixtureParams()
      .filter((def) => def.access === 'read_only_static')
      .map((def) => [def.name, def.default]),
  )
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

/**
 * The nine preset-carried params as the shared `[profile]` /
 * `[eq_preset]` layers resolve them — the 20-band structure on the
 * grid, GEQ and IEQ off, flat curves.
 */
const eqStructure = () => ({
  geon: [0],
  genb: [20],
  gebf: [...GEQ_GRID],
  gebg: Array.from({ length: 20 }, () => 0),
  ieon: [0],
  ienb: [20],
  iebf: [...GEQ_GRID],
  iebt: Array.from({ length: 20 }, () => 0),
  iea: [10],
})

/** One factory profile as the snapshot carries it. */
function factoryProfile(
  id: string,
  name: string,
  params: Profile['params'],
): Profile {
  // Every writable param resolves (the Cascade bottoms out on the table
  // default), then the `defaults.toml [profile]` shared visualizer + GEQ
  // pins (issues #24, #25) every resolved profile carries.
  const resolved = {
    ...writableDefaults(),
    ven: [1],
    vcnb: [20],
    vcbf: [...GEQ_GRID],
    ...eqStructure(),
    ...params,
  }
  return {
    id,
    name,
    is_factory: true,
    selected_eq_preset: null,
    params: resolved,
    // A freshly resolved factory item diverges nowhere: the
    // content-shaped baseline (ADR-0005) equals the resolved content.
    // Deep-copied — the wire never aliases (JSON), and a shared object
    // would let the store's reconcile move both sides at once.
    baseline: { selected_eq_preset: null, params: structuredClone(resolved) },
  }
}

/**
 * One factory EQ preset as the snapshot carries it (issue #23) —
 * complete: the `[eq_preset]` shared block resolves the 20-band
 * structure into every preset, so a picked preset shadows standalone.
 */
function factoryPreset(id: string, name: string): EqPreset {
  const resolved = { ...eqStructure(), ieon: [1] }
  return {
    id,
    name,
    is_factory: true,
    params: resolved,
    baseline: { params: structuredClone(resolved) },
  }
}

/**
 * The `lan_url` every fixture snapshot carries (issue #71) — populated
 * while `lan_access` is off, as daemon truth is regardless of the
 * toggle; hiding it while off is the UI's policy.
 */
export const FIXTURE_LAN_URL = 'http://192.168.1.23:9876'

/**
 * A daemon-truthful state snapshot: the master-control values each
 * factory profile resolves to (`defaults.toml` over table defaults).
 */
export function fixtureState(
  overrides: Partial<StateSnapshot> = {},
): StateSnapshot {
  return {
    power: true,
    lan_access: false,
    lan_url: FIXTURE_LAN_URL,
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
    readouts: readouts(),
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
  return {
    params: fixtureParams(),
    categories: fixtureCategories(),
    state: fixtureState(overrides),
  }
}

/** The fixture state with the active profile's params edited. */
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
