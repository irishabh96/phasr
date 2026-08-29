import { test, expect, type Page } from "@playwright/test";
import { bootApp, expectBackend, ptyOut, terminal } from "./harness";

/**
 * The render loop is the display.
 *
 * ghostty-web paints from ONE `requestAnimationFrame` chain that re-queues
 * itself from inside its own callback, and `write()` schedules nothing. So
 * a callback that fails to run is not a dropped frame — it is a terminal
 * that never paints again, while it keeps its focus, keeps accepting
 * keystrokes and keeps delivering them to the process. The user sees a
 * terminal that has "stopped responding to clicks" and reports it as lost
 * focus, which is the one thing it is not.
 *
 * Two things end a callback, and both happen to a machine left alone for a
 * while — the shape of the field report this spec exists for:
 *
 *   - it is never delivered (a web view suspended by sleep, occlusion or
 *     App Nap can drop a queued frame rather than defer it);
 *   - it throws (a canvas op after the GPU process restarts, a grid freed
 *     under the renderer).
 *
 * Both are simulated here, because neither can be provoked: a machine
 * cannot be put to sleep from a test, so what is tested is the
 * CONSEQUENCE — a chain that has ended — and whether anything brings the
 * terminal back. Before the fix, nothing did: measured 0 paints after a
 * single swallowed callback, through three clicks, a visibilitychange and
 * a window focus, for the rest of the terminal's life. The only escape was
 * a tab switch away and back, because `pause()` was the sole way the
 * engine's `isPaused` flag could be cleared, and `resume()` refused to
 * restart a loop that had never been paused.
 *
 * The oracle throughout is REAL PAINTS — `fillText` calls counted on the
 * canvas prototype — not `document.activeElement` and not a screenshot.
 * Focus was never the broken thing, and a stale canvas looks exactly like
 * a correct one.
 */

/**
 * Wraps `requestAnimationFrame` so a test can swallow the next callback,
 * and `fillText` so it can count paints and fail one on demand. Installed
 * before any app code runs, so it is the real loop being instrumented.
 */
async function installFrameProbe(page: Page) {
  await page.addInitScript(() => {
    const w = window as any;
    w.__FRAMES__ = { dropNext: 0, throwNext: 0, paints: 0 };
    const raf = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      if (w.__FRAMES__.dropNext > 0) {
        w.__FRAMES__.dropNext--;
        // A live handle whose callback never fires: exactly what a
        // suspended web view leaves behind.
        return raf(() => {});
      }
      return raf(cb);
    }) as typeof window.requestAnimationFrame;

    const proto = (window as any).CanvasRenderingContext2D?.prototype;
    const fillText = proto?.fillText;
    if (proto && fillText) {
      proto.fillText = function (...args: unknown[]) {
        w.__FRAMES__.paints++;
        if (w.__FRAMES__.throwNext > 0) {
          w.__FRAMES__.throwNext--;
          throw new Error("synthetic canvas failure");
        }
        return fillText.apply(this, args);
      };
    }
  });
}

const paints = (page: Page) =>
  page.evaluate(() => (window as any).__FRAMES__.paints as number);

/** Paints observed over `ms`, after running `act`. */
async function paintsOver(page: Page, ms: number, act?: () => Promise<void>) {
  const before = await paints(page);
  if (act) await act();
  await page.waitForTimeout(ms);
  return (await paints(page)) - before;
}

/** Boot to a live agent terminal that is demonstrably painting. */
async function bootPainting(page: Page) {
  await installFrameProbe(page);
  const booted = await bootApp(page);
  await expect(page).toHaveURL(/workspaces\/ws-agent/, { timeout: 25_000 });
  await expectBackend(page);
  await page.waitForTimeout(1500);
  await ptyOut(page, "ws-agent", "phasr on main\r\n");
  // Positive control. Every assertion below is "did it paint", so a build
  // that never paints at all would otherwise pass this spec vacuously.
  const baseline = await paintsOver(page, 500, () =>
    ptyOut(page, "ws-agent", "baseline\r\n"),
  );
  expect(baseline).toBeGreaterThan(0);
  return booted;
}

/** Kill the loop the way a suspension does, and wait past the stall bound. */
async function stall(page: Page, settleMs = 1400) {
  await page.evaluate(() => ((window as any).__FRAMES__.dropNext = 1));
  await page.waitForTimeout(settleMs);
  // Nothing is painting any more: the premise of every test below.
  expect(await paintsOver(page, 200)).toBe(0);
}

test("a click revives a terminal whose frame chain ended", async ({ page }) => {
  await bootPainting(page);
  await stall(page);

  const box = (await terminal(page).boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(600);

  // Both halves matter. The click has always focused the terminal — that
  // was never the bug — so a spec that only checked focus would have
  // passed against the broken build.
  expect(
    await page.evaluate(
      () =>
        !!(document.activeElement as HTMLElement | null)?.closest?.(
          "[data-testid='terminal-surface']",
        ),
    ),
  ).toBe(true);
  const revived = await paintsOver(page, 500, () =>
    ptyOut(page, "ws-agent", "after the click\r\n"),
  );
  expect(revived).toBeGreaterThan(0);
});

test("output revives a stalled terminal with nobody watching", async ({
  page,
}) => {
  // The case with no user in it at all: an agent works while the laptop
  // sits closed, and the terminal that woke up blind has to fix itself on
  // the next byte. Without this, the whole session's output is invisible
  // until the user happens to click.
  await bootPainting(page);
  await stall(page);

  const revived = await paintsOver(page, 700, () =>
    ptyOut(page, "ws-agent", "the agent kept working\r\n"),
  );
  expect(revived).toBeGreaterThan(0);
});

test("returning to the window revives a terminal that died while away", async ({
  page,
}) => {
  await bootPainting(page);
  await stall(page);

  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page.waitForTimeout(600);
  expect(
    await paintsOver(page, 500, () => ptyOut(page, "ws-agent", "back\r\n")),
  ).toBeGreaterThan(0);
});

test("the page becoming visible revives a terminal that died while hidden", async ({
  page,
}) => {
  // The closest a script can get to an occluded window. Real occlusion
  // also stops delivering frames, which is why this trigger exists at all.
  await bootPainting(page);
  await stall(page);

  await page.evaluate(() =>
    document.dispatchEvent(new Event("visibilitychange")),
  );
  await page.waitForTimeout(600);
  expect(
    await paintsOver(page, 500, () => ptyOut(page, "ws-agent", "shown\r\n")),
  ).toBeGreaterThan(0);
});

test("one throw inside a frame no longer ends the loop", async ({ page }) => {
  // The other half of the class, and the one that needs no recovery at
  // all: the loop body is wrapped, so a frame that fails is a frame that
  // fails. Before, the re-queue was the statement after the render and a
  // single throw skipped it for good.
  const { errors } = await bootPainting(page);
  await page.evaluate(() => ((window as any).__FRAMES__.throwNext = 1));
  await page.waitForTimeout(400);

  expect(
    await paintsOver(page, 600, () =>
      ptyOut(page, "ws-agent", "after the throw\r\n"),
    ),
  ).toBeGreaterThan(0);
  // The Sentry-bound report is READ off getRenderStats on the write path,
  // and under the damage-driven engine the throw happens on the write's
  // OWN frame — after that write's stats read — so it is the next chunk
  // that carries the report out. That next chunk always comes in the
  // scenario this spec models: an agent that keeps streaming.
  await ptyOut(page, "ws-agent", "and the agent kept going\r\n");
  // It is reported rather than swallowed — a renderer that fails is still
  // a bug, it just no longer takes the terminal with it. Two channels,
  // because the engine's own console line is the developer's and the
  // `reportP0Error` line is the one that reaches Sentry: before the loop
  // was wrapped, the throw escaped through `requestAnimationFrame` and
  // Sentry's browserApiErrors integration caught it for free. Catching it
  // took that away, so the surface hands it back deliberately.
  expect(errors.join("\n")).toContain("render frame failed");
  await expect
    .poll(() => errors.join("\n"), { timeout: 5_000 })
    .toContain("a render frame threw; the loop survived it");
});

test("the watchdog leaves parked terminals paused", async ({ page }) => {
  // The contract the watchdog could most easily break. A parked terminal
  // is paused ON PURPOSE — the free-running loop is exactly what
  // `setActive(false)` exists to stop — so "its frame counter is not
  // moving" must read as "correct", never as "stalled". Asserted per
  // surface through the bridge, because counting `fillText` cannot say
  // WHICH terminal painted and the second tab is painting throughout.
  await bootPainting(page);
  const agent = await page.evaluate(
    () => (window as any).__PHASR_TERM__.ids()[0] as string,
  );
  const tick = (id: string) =>
    page.evaluate((i) => (window as any).__PHASR_TERM__.renderTick(i), id);
  expect(await tick(agent)).toBeGreaterThan(0);

  // ⌘T parks the agent terminal behind a session terminal.
  await page.keyboard.press("Meta+t");
  await page.waitForTimeout(1500);
  await ptyOut(page, "ws-agent", "into a parked terminal\r\n");
  await page.waitForTimeout(600);
  // `null` is the surface saying "not my business" — and a write into it
  // must not have talked the write-path heal into resuming it.
  expect(await tick(agent)).toBeNull();

  await page.getByRole("tab").first().click();
  await page.waitForTimeout(1200);
  const revealed = await tick(agent);
  expect(revealed).not.toBeNull();
  await page.waitForTimeout(400);
  // And it is genuinely running again, not merely reporting a number.
  expect(await tick(agent)).toBeGreaterThan(revealed!);
});

test("the focus probe says which of the three failures it was", async ({
  page,
}) => {
  // The deliverable that survives this fix. The next report of "clicking
  // does nothing" has three possible causes that look identical to the
  // person reporting it, and one paste has to separate them.
  await bootPainting(page);
  await stall(page);

  const box = (await terminal(page).boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(600);

  const record = await page.evaluate(() => {
    const ring = (window as any).__PHASR_TERM_DIAG__?.focus?.() ?? [];
    return ring[ring.length - 1] ?? null;
  });
  console.log(`LIVENESS focus record: ${JSON.stringify(record)}`);
  expect(record).not.toBeNull();

  // Class 1 (clicks intercepted) ruled out: the click landed on the
  // terminal and the app is not pointer-dead.
  expect(record.surfaceId).toMatch(/^ghostty-/);
  expect(record.bodyPointerEvents).toBe("auto");
  // Class 2 (focus lost) ruled out: focus went where it should.
  expect(record.activeAfterInTerminal).toBe(true);
  expect(record.hasFocus).toBe(true);
  // Class 3 (renderer frozen) is what remains, and the counter is the
  // evidence: it was sampled before the recovery and had not moved.
  expect(typeof record.frames).toBe("number");
});

test("an idle chain degrades to the heartbeat; output wakes it within a frame", async ({
  page,
}) => {
  // Perf phase 1's whole point, asserted from the engine's own counters:
  // a visible terminal with nothing to draw ticks at ~1/s (the heartbeat),
  // not ~60/s — and the next byte of output paints immediately, not at
  // the heartbeat.
  await bootPainting(page);
  const agent = await page.evaluate(
    () => (window as any).__PHASR_TERM__.ids()[0] as string,
  );
  const tick = (id: string) =>
    page.evaluate(
      (i) => (window as any).__PHASR_TERM__.renderTick(i) as number,
      id,
    );
  const stats = (id: string) =>
    page.evaluate(
      (i) =>
        (window as any).__PHASR_TERM__.stats(i) as {
          cadence: number;
          bps: number;
          heartbeat: boolean;
        },
      id,
    );
  // Unfocus the surface: criterion 6 — an unfocused terminal requests no
  // blink frames, so what remains below is the bare heartbeat.
  await page.evaluate(() =>
    (document.activeElement as HTMLElement | null)?.blur?.(),
  );
  // Past IDLE_AFTER_MS (3 s) plus the one-frame decrease deferral.
  await page.waitForTimeout(3600);
  expect((await stats(agent)).cadence).toBe(1);
  const t1 = await tick(agent);
  await page.waitForTimeout(2000);
  const delta = (await tick(agent)) - t1;
  // ~1/s with jitter allowance — and nowhere near the ~120 the old
  // free-running chain would have racked up on this display.
  expect(delta).toBeGreaterThanOrEqual(1);
  expect(delta).toBeLessThanOrEqual(8);
  // The wake: output paints within a frame, and the cadence comes back up.
  expect(
    await paintsOver(page, 250, () => ptyOut(page, "ws-agent", "wake\r\n")),
  ).toBeGreaterThan(0);
  expect((await stats(agent)).cadence).toBe(60);
});

test("flood drops the cadence to ~30 fps — observably, via getRenderStats", async ({
  page,
}) => {
  // Criterion: adaptive cadence under load. >10 000 B/s must move the
  // scheduler to the reduced tier; the tick rate over the flood window is
  // the proof it actually painted at that tier.
  await bootPainting(page);
  const agent = await page.evaluate(
    () => (window as any).__PHASR_TERM__.ids()[0] as string,
  );
  const tick = (id: string) =>
    page.evaluate(
      (i) => (window as any).__PHASR_TERM__.renderTick(i) as number,
      id,
    );
  const chunk = ("x".repeat(80) + "\r\n").repeat(200); // ~16.4 KB
  const t1 = await tick(agent);
  const start = Date.now();
  for (let i = 0; i < 24; i++) {
    await ptyOut(page, "ws-agent", chunk);
    await page.waitForTimeout(100);
  }
  const elapsed = (Date.now() - start) / 1000; // ~150+ KB/s sustained
  const t2 = await tick(agent);
  const s = await page.evaluate(
    (i) =>
      (window as any).__PHASR_TERM__.stats(i) as {
        cadence: number;
        bps: number;
      },
    agent,
  );
  expect(s.cadence).toBe(30);
  expect(s.bps).toBeGreaterThan(10_000);
  const fps = (t2 - t1) / elapsed;
  // ~30, not the display rate: the reduced tier re-queues on a timer, so
  // vsync quantization lands runs anywhere in the 20s; the bound that
  // matters is "well under the ~60/~120 of the active tier".
  expect(fps).toBeGreaterThan(12);
  expect(fps).toBeLessThan(50);
});

test("five minutes idle, then output still paints (soak)", async ({
  page,
}) => {
  // The long-idle guarantee, run on demand: nothing in five minutes of
  // heartbeat idling may kill the chain OR talk the watchdog into a kick.
  test.skip(
    !process.env.LIVENESS_SOAK,
    "5-minute soak — run with LIVENESS_SOAK=1",
  );
  test.setTimeout(420_000);
  const { errors } = await bootPainting(page);
  await page.waitForTimeout(300_000);
  expect(
    await paintsOver(page, 500, () =>
      ptyOut(page, "ws-agent", "still alive after five minutes\r\n"),
    ),
  ).toBeGreaterThan(0);
  // The watchdog never fired during normal idle operation (criterion 9).
  const noise = errors.join("\n");
  expect(noise).not.toContain("render loop had stopped");
  expect(noise).not.toContain("restarting the render loop");
});

test("the probe records clicks that never go near a terminal", async ({
  page,
}) => {
  // The other reading of the report — "terminal OR INPUT". If the next
  // occurrence is a text field refusing focus, the ring has to have it.
  await bootPainting(page);
  await page.keyboard.press("Meta+k");
  await page.waitForTimeout(600);
  const palette = page.locator("input").first();
  if (await palette.isVisible().catch(() => false)) {
    await palette.click();
    await page.waitForTimeout(400);
    const ring = await page.evaluate(
      () => (window as any).__PHASR_TERM_DIAG__?.focus?.() ?? [],
    );
    const last = ring[ring.length - 1];
    console.log(`LIVENESS non-terminal click: ${JSON.stringify(last)}`);
    expect(last.surfaceId).toBeNull();
    expect(last.bodyPointerEvents).toBeTruthy();
  }
});
