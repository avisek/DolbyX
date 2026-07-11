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
  { ignores: ['dist/'] },
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  { files: ['src/**/*.{ts,tsx}'], ...solid },
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
