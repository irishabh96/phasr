import { defineConfig, devices } from '@playwright/test';

const baseURL = process.env.PHASR_BASE_URL || 'http://127.0.0.1:7777';
const serverURL = new URL(baseURL);

export default defineConfig({
  testDir: './tests',
  timeout: 30_000,
  expect: {
    timeout: 5_000,
  },
  use: {
    ...devices['Desktop Chrome'],
    baseURL,
    channel: 'chrome',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: `cd ../../.. && go run ./cmd/phasr -addr ${serverURL.hostname}:${serverURL.port || '7777'}`,
    url: baseURL,
    reuseExistingServer: true,
    timeout: 20_000,
  },
});
