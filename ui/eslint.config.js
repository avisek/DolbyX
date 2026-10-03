// @ts-check
import js from '@eslint/js'
import { defineConfig } from 'eslint/config'
import solidTypeChecked from 'eslint-plugin-solid/configs/typescript'
import tseslint from 'typescript-eslint'

// eslint-plugin-solid 0.14 ships rule typings predating ESLint 9's core
// ones — runtime-compatible, type-incompatible. Cast until it updates.
const solid = /** @type {import('eslint').Linter.Config} */ (
  /** @type {unknown} */ (solidTypeChecked)
)

export default defineConfig(
  { ignores: ['dist/', 'test-results/', 'playwright-report/'] },
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  { files: ['src/**/*.{ts,tsx}'], ...solid },
  // Skin contract (ADR-0011): components import no CSS. Each Skin entry
  // point imports its skin's every stylesheet; the Skin registry imports
  // the entry points as text (ADR-0013) — the one exemption. `**/*.css`
  // never matches `x.css?inline`, hence the query pattern. The rule is
  // the test — see src/skin.test.ts.
  {
    files: ['**/*.{ts,tsx}'],
    ignores: ['src/skins/index.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['*.css', '**/*.css', '**/*.css?*'],
              message:
                "Stylesheets belong to a skin: @import it from that skin's index.css; only the Skin registry (src/skins/index.ts) imports CSS (ADR-0011, ADR-0013).",
            },
          ],
        },
      ],
    },
  },
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  // This config file itself: type-checked by tsc (tsconfig.node.json),
  // linted untyped.
  { files: ['**/*.js'], extends: [tseslint.configs.disableTypeChecked] },
)
