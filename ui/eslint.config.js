// @ts-check
import js from '@eslint/js'
import { defineConfig } from 'eslint/config'
import solid from 'eslint-plugin-solid/configs/typescript'
import tseslint from 'typescript-eslint'

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
  // The config file itself sits outside the tsconfigs — lint it untyped.
  { files: ['**/*.js'], extends: [tseslint.configs.disableTypeChecked] },
)
