import { defineConfig, devices } from '@playwright/test'

// Slice 09 (#17): a real browser against the real stack — daemon +
// QemuBackend + libdseffect.so — nothing mocked (epic test policy).
// Every test boots its own daemon on an ephemeral port (e2e/fixtures.ts),
// so tests parallelize, restart their daemon freely, and never collide
// with a `just dev` daemon on :9876. Entry point: `just e2e`.
export default defineConfig({
  testDir: 'e2e',
  globalSetup: './e2e/global-setup',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  // Daemon boots (qemu spawn) + reconnect backoff make these seconds-long
  // tests; the margin absorbs slow CI runners, not slow assertions.
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list'], ['html', { open: 'never' }]],
  use: { trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
})
