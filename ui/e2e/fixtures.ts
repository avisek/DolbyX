/**
 * The Slice 09 (#17) fixture: every test gets a private real daemon —
 * `QemuBackend` + `libdseffect.so`, staged by `just e2e` — over a fresh
 * temp config dir, plus `stop`/`start` to exercise restarts. `baseURL`
 * points at it, so specs simply `page.goto('/')`.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test as base, expect, type Page } from '@playwright/test'

const daemonBin = join(import.meta.dirname, '../../target/debug/ddp-daemon')
const uiHtml = join(import.meta.dirname, '../dist/index.html')

/** Spawn → `listening` log line; covers the qemu engine boot. */
const START_TIMEOUT_MS = 15_000
/** SIGTERM → exit; covers the shutdown `config.toml` flush. */
const STOP_TIMEOUT_MS = 10_000

/** One real daemon, private to a test. */
export interface DaemonHandle {
  /** `http://localhost:<port>` — the page's single front door. */
  readonly origin: string
  /** The plugin socket it serves (Slice 11) — synthetic plugins here. */
  readonly socketPath: string
  /** SIGTERMs and waits: flushes `config.toml`, reaps the engine. */
  stop(): Promise<void>
  /** Boots again on the same port over the same config dir. */
  start(): Promise<void>
}

class Daemon implements DaemonHandle {
  readonly #configDir: string
  readonly #log: string[] = []
  #child: ChildProcessWithoutNullStreams | undefined
  // First boot passes 0 (ephemeral — no clashes across parallel workers
  // or a dev daemon); the `listening` line pins the port restarts reuse,
  // keeping the page's origin — and its reconnecting WS — valid.
  #port = 0

  constructor(configDir: string) {
    this.#configDir = configDir
  }

  get origin(): string {
    return `http://localhost:${String(this.#port)}`
  }

  get socketPath(): string {
    return join(this.#configDir, 'dolbyx.sock')
  }

  /** Everything the daemon wrote — attached to failed tests. */
  get log(): string {
    return this.#log.join('')
  }

  async start(): Promise<void> {
    const child = spawn(daemonBin, [
      ...['--port', String(this.#port)],
      ...['--config-dir', this.#configDir],
      ...['--ui', uiHtml],
      // Slice 11: the plugin socket; the default /run/dolbyx path needs
      // root. Inside the per-test tempdir — unique across workers, and
      // a restart over the same dir reclaims the stale socket file.
      ...['--socket-path', this.socketPath],
    ])
    this.#child = child
    child.stderr.on('data', (chunk: Buffer) => this.#log.push(chunk.toString()))

    this.#port = await new Promise<number>((resolve, reject) => {
      const fail = (reason: string) => {
        reject(new Error(`${reason}\n--- daemon log ---\n${this.log}`))
      }
      const timer = setTimeout(() => {
        fail(`daemon not listening after ${String(START_TIMEOUT_MS)} ms`)
      }, START_TIMEOUT_MS)
      let buffered = ''
      child.stdout.on('data', (chunk: Buffer) => {
        const text = chunk.toString()
        this.#log.push(text)
        buffered += text
        const port = /listening addr=127\.0\.0\.1:(\d+)/.exec(buffered)?.[1]
        if (port !== undefined) {
          clearTimeout(timer)
          resolve(Number(port))
        }
      })
      child.once('exit', (code) => {
        clearTimeout(timer)
        fail(`daemon exited with ${String(code)} before listening`)
      })
      child.once('error', (error) => {
        clearTimeout(timer)
        fail(`daemon failed to spawn: ${error.message}`)
      })
    })
  }

  async stop(): Promise<void> {
    const child = this.#child
    // No pid: the spawn itself failed — nothing to wait on.
    if (!child || child.pid === undefined || child.exitCode !== null) return
    const exited = new Promise((resolve) => child.once('exit', resolve))
    child.kill('SIGTERM')
    const timer = setTimeout(() => child.kill('SIGKILL'), STOP_TIMEOUT_MS)
    await exited
    clearTimeout(timer)
  }
}

export const test = base.extend<{ daemon: DaemonHandle }>({
  // eslint-disable-next-line no-empty-pattern -- Playwright fixture API
  daemon: async ({}, use, testInfo) => {
    const configDir = await mkdtemp(join(tmpdir(), 'dolbyx-e2e-'))
    const daemon = new Daemon(configDir)
    try {
      await daemon.start()
      await use(daemon)
    } finally {
      // Runs on setup failures too — a daemon whose boot timed out is
      // still alive and must not outlive its test, nor its tempdir.
      await daemon.stop()
      if (testInfo.status !== testInfo.expectedStatus) {
        await testInfo.attach('daemon.log', { body: daemon.log })
      }
      await rm(configDir, { recursive: true, force: true })
    }
  },
  baseURL: async ({ daemon }, use) => {
    await use(daemon.origin)
  },
})

/**
 * Counts the `state` events a page's WS connections receive, across
 * reconnects — specs pin reconciles and originator suppression on the
 * real wire. Call before the first `goto`.
 */
export function countStateFrames(page: Page): () => number {
  let count = 0
  page.on('websocket', (ws) => {
    ws.on('framereceived', (frame) => {
      const event = JSON.parse(String(frame.payload)) as { type: string }
      if (event.type === 'state') count += 1
    })
  })
  return () => count
}

/** Opens the app at `width` and waits for the WS to be up. */
export async function openAt(page: Page, width: number): Promise<void> {
  await page.setViewportSize({ width, height: 900 })
  await page.goto('/')
  await expect(page.getByRole('status')).toHaveText('Connected')
}

export const TRANSPARENT = 'rgba(0, 0, 0, 0)'

/** The computed background of `selector`'s `::before` — a hover / focus surface. */
export const pseudoBackground = (page: Page, selector: string) =>
  page
    .locator(selector)
    .evaluate((el) => getComputedStyle(el, '::before').backgroundColor)

/** `scrollWidth` vs `innerWidth` — equal when nothing overflows sideways. */
export const pageOverflow = (page: Page) =>
  page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }))

/**
 * Whether `target` is what `elementFromPoint` finds 1 px inside and
 * 1 px outside each edge of the Shell column's `--space-3` bleed, at
 * the vertical centre of `row` (ADR-0011, second addendum: a surface
 * that bleeds reaches exactly that far into the gutter, never past).
 */
export const bleedHits = (page: Page, target: string, row = target) =>
  page.locator(target).evaluate((el, rowSelector) => {
    const rowEl = el.closest(rowSelector)
    const app = el.closest('.app')
    if (!rowEl || !app) throw new Error(`${rowSelector} / .app not rendered`)
    const appStyle = getComputedStyle(app)
    const appBox = app.getBoundingClientRect()
    const { top, height } = rowEl.getBoundingClientRect()
    const rootStyle = getComputedStyle(document.documentElement)
    const bleed =
      parseFloat(rootStyle.getPropertyValue('--space-3')) *
      parseFloat(rootStyle.fontSize)
    const columnLeft = appBox.left + parseFloat(appStyle.paddingLeft)
    const columnRight = appBox.right - parseFloat(appStyle.paddingRight)
    const y = top + height / 2
    const hit = (x: number) => document.elementFromPoint(x, y) === el
    return {
      columnLeft,
      columnRight,
      insideLeft: hit(columnLeft - bleed + 1),
      outsideLeft: hit(columnLeft - bleed - 1),
      insideRight: hit(columnRight + bleed - 1),
      outsideRight: hit(columnRight + bleed + 1),
    }
  }, row)

export { expect }
