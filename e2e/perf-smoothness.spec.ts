import { test, expect, type Page } from "@playwright/test";
import { bootApp, expectBackend, tuiFrame } from "./harness";

/**
 * "Buttery smooth" acceptance (specs/ui-mission-control-polish-spec.md §6.3),
 * measured in the page, not inferred from code:
 *
 *  - a 5 MB burst of agent-TUI output never blocks the main thread for more
 *    than 50 ms (`PerformanceObserver` 'longtask'), and frames keep landing
 *    while it streams;
 *  - opening the ⌘K palette and the New task dialog costs no long task.
 *
 * The panel-toggle check (0 terminal fits during the transition) belongs to
 * the shell work and lives with it.
 *
 * Every number is logged (`PERF_SMOOTH …`) so a before/after diff is one grep.
 * Marked `test.slow()`: these are wall-clock measurements, and a loaded CI
 * box is allowed more time to make them — never a looser threshold.
 */

const LONG_TASK_MS = 50;

interface Probe {
  longTasks: { start: number; duration: number }[];
  frames: number[];
  recording: boolean;
}

/** Long-task observer + a rAF frame recorder, installed once per page. */
async function installProbe(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { __perf?: Probe };
    if (w.__perf) return;
    const probe: Probe = { longTasks: [], frames: [], recording: false };
    w.__perf = probe;
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        probe.longTasks.push({ start: e.startTime, duration: e.duration });
      }
    }).observe({ type: "longtask", buffered: false });
    const tick = (t: number) => {
      if (probe.recording) probe.frames.push(t);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

interface Window_ {
  ms: number;
  frames: number;
  maxFrameGap: number;
  /** Frame intervals over one 60 Hz frame (16.7 ms), i.e. dropped frames. */
  slowFrames: number;
  longTasks: number[];
}

/** Run `body` and report what the main thread did meanwhile. */
async function measure(page: Page, body: () => Promise<void>): Promise<Window_> {
  const t0 = await page.evaluate(() => {
    const p = (window as unknown as { __perf: Probe }).__perf;
    p.frames.length = 0;
    p.recording = true;
    return performance.now();
  });
  await body();
  // Long-task entries are delivered asynchronously; give them a frame or two.
  await page.waitForTimeout(100);
  return page.evaluate((t0) => {
    const p = (window as unknown as { __perf: Probe }).__perf;
    p.recording = false;
    const t1 = performance.now();
    const gaps = p.frames.slice(1).map((t, i) => t - p.frames[i]!);
    return {
      ms: Math.round(t1 - t0),
      frames: p.frames.length,
      maxFrameGap: Math.round(Math.max(0, ...gaps)),
      slowFrames: gaps.filter((g) => g > 17.5).length,
      longTasks: p.longTasks
        .filter((l) => l.start >= t0)
        .map((l) => Math.round(l.duration)),
    };
  }, t0);
}

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

test.describe("perf smoothness (§6.3)", () => {
  test("a 5 MB burst of PTY output has no long task", async ({ page }) => {
    test.slow();
    await bootApp(page);
    await expect(page).toHaveURL(/workspaces\/ws-agent/, { timeout: 25_000 });
    await expectBackend(page);
    await page.waitForTimeout(1500); // let boot settle
    await installProbe(page);

    // 16 distinct ~32 KiB TUI frames, cycled. The coalescer on the Rust side
    // ships at most 32 KiB per event, so this is the real wire shape.
    const frames = Array.from({ length: 16 }, (_, i) => tuiFrame(i));
    const frameBytes = frames.map((f) => Buffer.byteLength(f, "utf8"));
    const chunks: string[] = [];
    let total = 0;
    for (let i = 0; total < 5 * 1024 * 1024; i++) {
      chunks.push(b64(frames[i % frames.length]!));
      total += frameBytes[i % frames.length]!;
    }

    const stats = await measure(page, async () => {
      // Each chunk is its own task, the way IPC channel messages arrive;
      // a burst posts 8 of them at once (≈ 280 KB), then the agent pauses.
      await page.evaluate(
        async ({ chunks, perBurst, gapMs }) => {
          const e2e = (window as unknown as {
            __E2E__: { pty(k: string, m: unknown): void };
          }).__E2E__;
          const ch = new MessageChannel();
          let delivered = 0;
          await new Promise<void>((done) => {
            ch.port1.onmessage = (ev: MessageEvent<number>) => {
              e2e.pty("ws-agent", { type: "output", chunk: chunks[ev.data] });
              delivered += 1;
              if (delivered === chunks.length) done();
            };
            let next = 0;
            const burst = () => {
              for (let i = 0; i < perBurst && next < chunks.length; i++) {
                ch.port2.postMessage(next++);
              }
              if (next < chunks.length) setTimeout(burst, gapMs);
            };
            burst();
          });
          // Let the terminal paint what it has.
          await new Promise((r) => setTimeout(r, 300));
        },
        { chunks, perBurst: 8, gapMs: 30 },
      );
    });

    console.log(
      `PERF_SMOOTH burst bytes=${total} chunks=${chunks.length} ${JSON.stringify(stats)}`,
    );
    expect(stats.frames, "frames kept landing during the burst").toBeGreaterThan(
      stats.ms / 1000 * 20,
    );
    expect(
      stats.longTasks.filter((d) => d > LONG_TASK_MS),
      "long tasks (ms) during the 5 MB burst",
    ).toEqual([]);
  });

  test("opening the ⌘K palette and the New task dialog has no long task", async ({
    page,
  }) => {
    test.slow();
    await bootApp(page);
    await expect(page).toHaveURL(/workspaces\/ws-agent/, { timeout: 25_000 });
    await expectBackend(page);
    await page.waitForTimeout(1500);
    await installProbe(page);

    const palette = page.locator("[cmdk-root]").first();
    const openPalette = async () => {
      await page.keyboard.press("Meta+k");
      await expect(palette).toBeVisible();
      await page.waitForTimeout(300); // the whole enter animation
    };
    const openNewTask = async () => {
      await page
        .getByRole("complementary", { name: "Sidebar" })
        .getByRole("button", { name: "New task", exact: true })
        .click();
      await expect(page.getByRole("dialog", { name: /New task/ })).toBeVisible();
      await page.waitForTimeout(300);
    };

    // The first open of each loads its code — under `vite dev` that is
    // hundreds of unbundled modules, which a packaged build does not pay.
    // Logged for the record; the gate is the open a user sees every time.
    const coldPalette = await measure(page, openPalette);
    await page.keyboard.press("Escape");
    await expect(palette).toBeHidden();
    const coldDialog = await measure(page, openNewTask);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.waitForTimeout(300);

    const warmPalette = await measure(page, openPalette);
    await page.keyboard.press("Escape");
    await expect(palette).toBeHidden();
    await page.waitForTimeout(300);
    const warmDialog = await measure(page, openNewTask);

    console.log(
      `PERF_SMOOTH palette cold=${JSON.stringify(coldPalette)} warm=${JSON.stringify(warmPalette)}`,
    );
    console.log(
      `PERF_SMOOTH new-task cold=${JSON.stringify(coldDialog)} warm=${JSON.stringify(warmDialog)}`,
    );
    expect(
      warmPalette.longTasks.filter((d) => d > LONG_TASK_MS),
      "long tasks (ms) opening the palette",
    ).toEqual([]);
    expect(
      warmDialog.longTasks.filter((d) => d > LONG_TASK_MS),
      "long tasks (ms) opening New task",
    ).toEqual([]);
  });
});
