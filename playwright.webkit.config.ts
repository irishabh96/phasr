/**
 * The suite, run under WebKit instead of Chromium.
 *
 * phasr ships in a WKWebView, and WebKit is the same engine. Chromium's
 * Skia raster path, GPU process and canvas text metrics are all different,
 * which is why every rendering and perf number taken under the default
 * config is directional only (ADR-002). This config is the closest proxy
 * available without building and driving the packaged .app by hand.
 *
 *   pnpm test:e2e:webkit
 *
 * Not the default: it needs `pnpm exec playwright install webkit`, and it
 * is slower. Reach for it when a change touches rendering, selection,
 * canvas metrics or clipboard behaviour.
 *
 * `E2E_PORT`: same isolation rule as the default config — an explicit port
 * guarantees the server under test is this checkout's, not whatever another
 * worktree left on 1420. Every recorded perf baseline states its port.
 */
import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.E2E_PORT) || 1420;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  reporter: [["list"]],
  use: { baseURL: `http://localhost:${port}`, trace: "off" },
  projects: [{ name: "webkit", use: { ...devices["Desktop Safari"] } }],
  webServer: {
    command: "pnpm dev",
    url: `http://localhost:${port}`,
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
