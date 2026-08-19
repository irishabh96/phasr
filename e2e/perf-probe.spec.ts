import { test, expect, type Page } from "@playwright/test";
import { bootApp, ptyBurst, ptyOut, tuiFrame } from "./harness";

/**
 * Perf probe for the 0.3.5 -> 0.3.6 lag regression. Measures Chromium's
 * cumulative layout/style/script counters (CDP Performance domain) across
 * phases: idle workspace, streaming PTY output, New Task modal open,
 * combobox open. Run on both versions and diff the numbers.
 */

const KEYS = [
  "LayoutCount",
  "RecalcStyleCount",
  "LayoutDuration",
  "RecalcStyleDuration",
  "ScriptDuration",
  "TaskDuration",
  "Nodes",
  "JSEventListeners",
];

type Snap = Record<string, number>;

async function snap(client: {
  send: (m: string) => Promise<unknown>;
}): Promise<Snap> {
  const { metrics } = (await client.send("Performance.getMetrics")) as {
    metrics: Array<{ name: string; value: number }>;
  };
  return Object.fromEntries(
    metrics.filter((m) => KEYS.includes(m.name)).map((m) => [m.name, m.value]),
  );
}

function delta(a: Snap, b: Snap): Snap {
  return Object.fromEntries(
    Object.keys(a).map((k) => [k, +((b[k] ?? 0) - (a[k] ?? 0)).toFixed(3)]),
  );
}

async function phase(
  page: Page,
  client: { send: (m: string) => Promise<unknown> },
  label: string,
  run: () => Promise<void>,
) {
  const before = await snap(client);
  await run();
  const after = await snap(client);
  console.log(`PERF ${label}: ${JSON.stringify(delta(before, after))}`);
}


test("perf probe across app states", async ({ page }) => {
  test.skip(
    !process.env.PERF_PROBE,
    "diagnostic, not a gate — run with PERF_PROBE=1",
  );
  test.setTimeout(120_000);
  const client = await page.context().newCDPSession(page);
  await client.send("Performance.enable");

  await bootApp(page);
  await expect(page).toHaveURL(/workspaces\/ws-agent/, { timeout: 25_000 });
  await page.waitForTimeout(3000); // let boot settle

  await phase(page, client, "IDLE_WORKSPACE_8S", async () => {
    await page.waitForTimeout(8000);
  });

  await phase(page, client, "PTY_SPINNER_10HZ_8S", async () => {
    for (let i = 0; i < 80; i++) {
      await ptyOut(page, "ws-agent", `\r[2K⠋ Thinking… (${i}s · esc to interrupt)`);
      await page.waitForTimeout(100);
    }
  });

  // Throughput, not idle. This is the phase that can decide a change to the
  // OUTPUT WIRE FORMAT; the 10 Hz spinner above is far too small to resolve
  // one (80 x ~40 B is ~3 KB in total). Escape-dense frames at volume are
  // what phasr actually gets from an agent repainting its TUI.
  await phase(page, client, "PTY_BULK_TUI_2MB", async () => {
    for (let round = 0; round < 8; round++) {
      // 8 x ~32 KiB per round trip - one `evaluate` per burst so what is
      // measured is the write path, not Playwright's round-trip cost.
      await ptyBurst(
        page,
        "ws-agent",
        Array.from({ length: 8 }, (_, i) => tuiFrame(round * 8 + i)),
      );
      await page.waitForTimeout(50);
    }
    await page.waitForTimeout(500);
  });

  await phase(page, client, "IDLE_AFTER_STREAM_8S", async () => {
    await page.waitForTimeout(8000);
  });

  await page.getByRole("button", { name: "New workspace in phasr" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.locator("#new-task-name").fill("perf probe");
  await page.waitForTimeout(500);

  await phase(page, client, "MODAL_OPEN_IDLE_8S", async () => {
    await page.waitForTimeout(8000);
  });

  const baseBranch = page.locator("#new-task-base-branch");
  const hasCombobox = (await baseBranch.count()) > 0;
  if (hasCombobox) {
    await baseBranch.click();
    await page.waitForTimeout(300);
  }
  await phase(page, client, "BASE_BRANCH_FOCUSED_8S", async () => {
    await page.waitForTimeout(8000);
  });
});
