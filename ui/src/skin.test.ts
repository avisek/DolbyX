/**
 * Slice 02 (#84): the Classic skin is the only stylesheet consumer —
 * one entry point imports every component's BEM CSS, components import
 * none (ADR-0011 addendum). The lint rule is the enforcement; these
 * tests pin that it exists and fires, and that the tree obeys it.
 * @vitest-environment node
 */
import { ESLint } from 'eslint'
import { describe, expect, it } from 'vitest'

/** Lint `code` as if it were `filePath`; the rule ids that fired. */
async function ruleIds(filePath: string, code: string): Promise<string[]> {
  const [result] = await new ESLint().lintText(code, { filePath })
  return (result?.messages ?? []).map((m) => m.ruleId ?? '')
}

describe('the css-import restriction', () => {
  // Behavior 1: a component importing a stylesheet fails lint — plain
  // or `?inline` (the registry's grammar is not a loophole)…
  it('fires on a component importing .css, plain or ?inline', async () => {
    expect(
      await ruleIds(
        'src/components/PowerToggle.tsx',
        "import './PowerToggle.css'\nexport {}\n",
      ),
    ).toContain('no-restricted-imports')
    expect(
      await ruleIds(
        'src/components/PowerToggle.tsx',
        "import css from '../skins/classic/index.css?inline'\nexport { css }\n",
      ),
    ).toContain('no-restricted-imports')
  }, 60_000)

  // …and passes with the import gone; the registry is the one exemption.
  it('is silent without the import, and on the Skin registry', async () => {
    expect(
      await ruleIds('src/components/PowerToggle.tsx', 'export {}\n'),
    ).not.toContain('no-restricted-imports')
    expect(
      await ruleIds(
        'src/skins/index.ts',
        "import css from './classic/index.css?inline'\nexport { css }\n",
      ),
    ).not.toContain('no-restricted-imports')
  }, 60_000)
})

// Behavior 2: the rule holds across the tree — no source outside the
// Skin registry imports a stylesheet, plain or `?inline`; the app entry
// included (first paint goes through `applySkin`, not an import).
describe('the tree', () => {
  const sources = import.meta.glob<string>(
    ['./**/*.{ts,tsx}', '!./**/*.test.{ts,tsx}', '!./skins/index.ts'],
    { query: '?raw', import: 'default', eager: true },
  )
  const cssImports = (code: string) =>
    code.match(/import\s+(?:\w+\s+from\s+)?['"][^'"]*\.css(?:\?\w+)?['"]/g) ??
    []

  it('imports no stylesheet outside the Skin registry', () => {
    expect(Object.keys(sources)).toContain('./main.tsx')
    const offenders = Object.entries(sources)
      .filter(([, code]) => cssImports(code).length > 0)
      .map(([path]) => path)
    expect(offenders).toEqual([])
  })
})

// #94, per skin: a Skin entry point reaches every sheet in its
// directory — through `@import` chains, nothing orphaned.
describe('each Skin entry point', () => {
  const sheets = import.meta.glob<string>('./skins/*/**/*.css', {
    query: '?raw',
    import: 'default',
    eager: true,
  })
  /** `./skins/<dir>/…` → `<dir>`. */
  const skinOf = (path: string) => path.split('/')[2] ?? ''
  /** Resolve `./a/../b.css` against the importing sheet's directory. */
  const resolve = (from: string, target: string) => {
    const parts = from.split('/').slice(0, -1)
    for (const segment of target.split('/')) {
      if (segment === '..') parts.pop()
      else if (segment !== '.') parts.push(segment)
    }
    return parts.join('/')
  }
  /** Every sheet `@import`-reachable from `entry`, `entry` included. */
  function reachable(entry: string): Set<string> {
    const seen = new Set<string>()
    const walk = (path: string) => {
      if (seen.has(path)) return
      seen.add(path)
      for (const [, target] of (sheets[path] ?? '').matchAll(
        /@import\s+'([^']+\.css)'/g,
      )) {
        walk(resolve(path, target ?? ''))
      }
    }
    walk(entry)
    return seen
  }

  const dirs = [...new Set(Object.keys(sheets).map(skinOf))].sort()

  it.each(dirs)('%s reaches every sheet in its directory', (dir) => {
    const own = Object.keys(sheets).filter((path) => skinOf(path) === dir)
    expect(own.length).toBeGreaterThan(1)
    const reached = reachable(`./skins/${dir}/index.css`)
    expect([...reached].sort()).toEqual([...own].sort())
  })
})

// A skin author has one screen to read — the UI README's authoring
// section, which names the registry a new skin must join.
describe('the authoring guide', () => {
  it('is a section of the UI README naming the Skin registry', async () => {
    const readme = (await import('../README.md?raw')).default
    expect(readme).toMatch(/^## Skin authoring$/m)
    expect(readme).toContain('src/skins/index.ts')
    expect(readme).toContain('color-scheme')
  })
})

// #136: the Skin registry is the single source of truth for what can be
// chosen — one `?inline` entry point per `skins/*/` directory, every
// directory registered, nothing else imported (1:1).
describe('the Skin registry', () => {
  it('imports one ?inline entry point per skin directory, each registered', async () => {
    const entryPoints = import.meta.glob('./skins/*/index.css')
    const dirs = Object.keys(entryPoints)
      .map((path) => path.split('/')[2] ?? '')
      .sort()
    const source = (await import('./skins/index.ts?raw')).default
    const imported = [
      ...source.matchAll(/from\s+'\.\/([^/']+)\/index\.css\?inline'/g),
    ]
      .map(([, dir]) => dir ?? '')
      .sort()
    const { skins } = await import('./skins')

    expect(dirs.length).toBeGreaterThan(0)
    expect(imported).toEqual(dirs)
    expect(skins.map(({ id }) => id).sort()).toEqual(dirs)
  })
})
