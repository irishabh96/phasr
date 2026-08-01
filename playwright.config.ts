import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright drives the Vite dev server (no Tauri shell) against the dev-only
 * `/design-test` harness route, which mounts the design-fix surfaces with no
 * IPC/auth. Validates the audit fixes end-to-end in a real browser.
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:1420",
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "pnpm dev",
    url: "http://localhost:1420",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
