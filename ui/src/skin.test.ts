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
  // Behavior 1: a component importing a stylesheet fails lint…
  it('fires on a component importing .css', async () => {
    const ids = await ruleIds(
      'src/components/PowerToggle.tsx',
      "import './PowerToggle.css'\nexport {}\n",
    )
    expect(ids).toContain('no-restricted-imports')
  }, 60_000)

  // …and passes with the import gone; the app entry is the one exemption.
  it('is silent without the import, and on the app entry', async () => {
    expect(
      await ruleIds('src/components/PowerToggle.tsx', 'export {}\n'),
    ).not.toContain('no-restricted-imports')
    expect(
      await ruleIds('src/main.tsx', "import './skins/classic/index.css'\n"),
    ).not.toContain('no-restricted-imports')
  }, 60_000)
})

// Behavior 2: the rule holds across the tree — nothing under
// components / store / lib imports a stylesheet, and the app entry
// imports exactly one: the Classic skin entry point.
describe('the tree', () => {
  const sources = import.meta.glob<string>(
    [
      './components/**/*.{ts,tsx}',
      './store/**/*.{ts,tsx}',
      './lib/**/*.{ts,tsx}',
    ],
    { query: '?raw', import: 'default', eager: true },
  )
  const cssImports = (code: string) =>
    code.match(/import\s+['"][^'"]*\.css['"]/g) ?? []

  it('has no .css import under components, store, or lib', () => {
    expect(Object.keys(sources).length).toBeGreaterThan(0)
    const offenders = Object.entries(sources)
      .filter(([, code]) => cssImports(code).length > 0)
      .map(([path]) => path)
    expect(offenders).toEqual([])
  })

  it('imports exactly one stylesheet from the app entry: the Classic skin', async () => {
    const main = (await import('./main.tsx?raw')).default
    expect(cssImports(main)).toEqual(["import './skins/classic/index.css'"])
  })
})

// Behavior 6: a skin author has one screen to read — the UI README's
// authoring section — and the token file names the contract it serves.
describe('the authoring guide', () => {
  it('is a section of the UI README', async () => {
    const readme = (await import('../README.md?raw')).default
    expect(readme).toMatch(/^## Skin authoring$/m)
    expect(readme).toContain('src/skins/classic/')
    expect(readme).toContain('--control-h')
  })

  it('has a token file citing ADR-0011, not ADR-0006', async () => {
    const theme = (await import('./skins/classic/theme.css?raw')).default
    const header = theme.slice(0, theme.indexOf(':root'))
    expect(header).toContain('ADR-0011')
    expect(header).not.toContain('ADR-0006')
  })
})
