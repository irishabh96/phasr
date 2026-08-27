import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright drives the Vite dev server (no Tauri shell) against the dev-only
 * `/design-test` harness route, which mounts the design-fix surfaces with no
 * IPC/auth. Validates the audit fixes end-to-end in a real browser.
 *
 * `E2E_PORT`: with `reuseExistingServer`, a run on the default 1420 will
 * silently attach to ANY dev server already there — including another
 * worktree's, measuring stale code. Perf probes and parallel worktrees set
 * an explicit port (vite.config.ts reads the same variable) so the server
 * under test is their own.
 */
const port = Number(process.env.E2E_PORT) || 1420;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: `http://localhost:${port}`,
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "pnpm dev",
    url: `http://localhost:${port}`,
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
