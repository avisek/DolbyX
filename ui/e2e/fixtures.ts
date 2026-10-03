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
  /**
   * Its `config.toml`: hand-write it between `stop` and `start` to boot
   * over a chosen overlay (a skin id the UI doesn't ship, #138).
   */
  readonly configPath: string
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

  get configPath(): string {
    return join(this.#configDir, 'config.toml')
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

/** Nothing overflows sideways: `scrollWidth` equals `innerWidth`. */
export async function expectNoOverflow(page: Page): Promise<void> {
  const { scrollWidth, innerWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }))
  expect(scrollWidth).toBe(innerWidth)
}

/** Flips LAN via the Row's text — the label forwards to the switch. */
export async function flipLan(page: Page, on: boolean): Promise<void> {
  await page.getByText('LAN Access').click()
  await expect(page.getByRole('switch', { name: 'LAN access' })).toBeChecked({
    checked: on,
  })
}

/** Waits until the LAN tools' fold has landed — no transition still running. */
export const foldSettled = (page: Page) =>
  expect
    .poll(() =>
      page
        .locator('.lan-access__tools')
        .evaluate((el) => el.getAnimations().length),
    )
    .toBe(0)

/**
 * Expands the Advanced panel. The open pref is per origin, so a second
 * page of the same context starts open — only a collapsed panel gets
 * the click.
 */
export async function expandAdvanced(page: Page): Promise<void> {
  await setAdvanced(page, true)
}

/** Collapses the Advanced panel — the contract loop's reset between skins. */
export async function collapseAdvanced(page: Page): Promise<void> {
  await setAdvanced(page, false)
}

async function setAdvanced(page: Page, open: boolean): Promise<void> {
  const header = page.getByRole('button', { name: 'Advanced' })
  if ((await header.getAttribute('aria-expanded')) !== String(open)) {
    await header.click()
  }
  await expect(header).toHaveAttribute('aria-expanded', String(open))
}

/** The active skin's `<style>` text — what the page is painted with. */
export const skinText = (page: Page) =>
  page.evaluate(() => document.getElementById('skin')?.textContent ?? '')

/** The Skin picker's radios, pill order; each `value` is the id (Picker.tsx). */
export const skinRadios = (page: Page) =>
  page.locator('.picker--skin .picker__radio')

/** The Skin picker's radio for a registered id. */
export const skinRadio = (page: Page, id: string) =>
  skinRadios(page).and(page.locator(`[value="${id}"]`))

/**
 * The registered skins as the page offers them — the Skin picker's
 * radios, pill order: one source of truth, no CSS in Node (#138).
 */
export async function skinList(
  page: Page,
): Promise<{ id: string; label: string }[]> {
  const skins = await skinRadios(page).evaluateAll((radios) =>
    radios.map((radio) => ({
      id: (radio as HTMLInputElement).value,
      label: (radio as HTMLInputElement).labels?.[0]?.textContent ?? '',
    })),
  )
  // An empty loop would pass every contract vacuously.
  expect(skins.length).toBeGreaterThan(1)
  return skins
}

/**
 * Switches the daemon's skin from a probe socket the page opens — a
 * second client, so the daemon's fan-out reaches the page's own socket
 * (the picking tab never sees its own snapshot) — and waits for the
 * pill: the Shell swaps the `<style>` text in the same synchronous
 * effect that checks it (and two skins' texts may be byte-identical —
 * Classic is Remastered's copy until #139). Already the page's skin:
 * nothing to send.
 */
export async function setSkin(page: Page, id: string): Promise<void> {
  const radio = skinRadio(page, id)
  if (await radio.isChecked()) return
  await page.evaluate(
    (id) =>
      new Promise<void>((resolve, reject) => {
        const probe = new WebSocket(`ws://${location.host}/ws`)
        probe.onerror = () => {
          reject(new Error('probe socket failed'))
        }
        probe.onopen = () => {
          probe.send(
            JSON.stringify({ cmd: 'set_skin', request_id: 'probe', id }),
          )
        }
        probe.onmessage = (event) => {
          const frame = JSON.parse(String(event.data)) as {
            type: string
            request_id?: string
          }
          if (frame.request_id !== 'probe') return
          probe.close()
          if (frame.type === 'ack') resolve()
          else reject(new Error(`set_skin ${id}: ${frame.type}`))
        }
      }),
    id,
  )
  await expect(radio).toBeChecked()
}

/** Whether the painted skin declares both schemes on `:root`. */
export const declaresLightDark = (page: Page) =>
  page.evaluate(() => {
    const scheme = getComputedStyle(document.documentElement).colorScheme
    return scheme.includes('light') && scheme.includes('dark')
  })

/**
 * Every control in the tab order is reachable by the pointer: a hit at
 * the centre of its hit surface lands on itself, a descendant, or one
 * of its `label`s. The hit surface is the control's own box, or its
 * `label` where the skin took the control out of hit testing
 * (`pointer-events: none` — a hidden radio painted through its pill).
 * Visible means not folded away (`display` / `visibility`):
 * opacity-hidden chrome must still take the pointer (ADR-0011).
 * Disabled controls (`disabled`, or `aria-disabled` dropping a Slider
 * to `tabindex=-1`) and roving members (`tabindex=-1`: band editors,
 * opened through their band) are reached through their owner, not the
 * pointer, and are skipped.
 */
export async function expectReachable(page: Page): Promise<void> {
  const unreachable = await page.evaluate(() => {
    const misses: string[] = []
    const controls = document.querySelectorAll<HTMLElement>(
      'button, [role=switch], input[type=radio], [role=radio], [role=slider], input[type=text], textarea, [role=textbox]',
    )
    for (const el of controls) {
      if (!el.checkVisibility({ visibilityProperty: true })) continue
      if (el.matches(':disabled') || el.tabIndex < 0) continue
      const labels =
        el instanceof HTMLInputElement ? [...(el.labels ?? [])] : []
      const surface =
        getComputedStyle(el).pointerEvents === 'none' ? (labels[0] ?? el) : el
      surface.scrollIntoView({ block: 'center', inline: 'nearest' })
      const { left, top, width, height } = surface.getBoundingClientRect()
      const hit = document.elementFromPoint(left + width / 2, top + height / 2)
      const reached =
        hit !== null &&
        (el.contains(hit) || labels.some((label) => label.contains(hit)))
      if (!reached) {
        const name =
          el.getAttribute('aria-label') ?? (labels[0] ?? el).textContent.trim()
        misses.push(`${el.tagName.toLowerCase()}.${el.className} "${name}"`)
      }
    }
    return misses
  })
  expect(unreachable).toEqual([])
}

export { expect }
