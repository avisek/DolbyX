import { execSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const uiDir = join(import.meta.dirname, '..')

/**
 * Builds the singlefile UI the fixture daemons serve, and refuses to run
 * without the staged daemon + engine (`just e2e` provides them — cargo
 * knowledge stays in the Justfile).
 */
export default function globalSetup(): void {
  // The exact artifact production serves: dist/index.html, everything
  // inlined (`tsc -b` also type-checks e2e/ via tsconfig.e2e.json).
  execSync('pnpm build', { cwd: uiDir, stdio: 'inherit' })

  const debugDir = join(uiDir, '..', 'target', 'debug')
  for (const staged of ['ddp-daemon', 'ddp-engine-arm', 'libdseffect.so']) {
    if (!existsSync(join(debugDir, staged))) {
      throw new Error(
        `${join(debugDir, staged)} missing — run \`just e2e\`, which builds the daemon and stages the engine first`,
      )
    }
  }
}
