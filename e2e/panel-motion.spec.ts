import { test, expect, type Page } from "@playwright/test";
import { bootApp, expectBackend, waitForCall } from "./harness";

/**
 * Spec P1/P2 (ui-mission-control-polish-spec §6): toggling the sidebar or
 * the inspector must not touch the terminal while the panel slides. The
 * panels animate `transform` inside a clipped box, the centre column takes
 * its new width once, and every terminal fits exactly once — after the
 * transition, at the settled size.
 *
 * Instrumentation: `window.__PHASR_PERF__` (dev builds only, lib/terminal/
 * refit.ts) counts component fits and the ones made while the shell carries
 * `data-panel-animating`; the harness records `resize_task` IPC calls.
 */

interface Recording {
  sawAnimating: boolean;
  done: boolean;
  widths: number[];
  resizeCallsDuring: number;
  /** Harness call index when the slide started / last frame it was still sliding. */
  callsAtStart: number;
  callsInFlight: number;
}

async function ready(page: Page) {
  await bootApp(page);
  await expectBackend(page);
  await waitForCall(page, "open_task_terminal", 15_000);
  // Let the mount-time settle refits (60/250/600ms) and any deferred width
  // rebuild finish, so the counters below see only the toggle.
  await page.waitForTimeout(1_200);
}

/** Zero the probe and start recording the next panel animation. */
async function arm(page: Page) {
  await page.evaluate(() => {
    const w = window as any;
    w.__PHASR_PERF__ = { terminalFits: 0, terminalFitsWhileAnimating: 0 };
    const shell = document.querySelector("[data-app-shell]")!;
    const main = document.querySelector("main")!;
    const rec = {
      sawAnimating: false,
      done: false,
      widths: [] as number[],
      resizeCallsDuring: 0,
      callsAtStart: 0,
      callsInFlight: 0,
    };
    const tick = () => {
      const width = main.getBoundingClientRect().width;
      if (!rec.widths.includes(width)) rec.widths.push(width);
      // The settle refit runs synchronously as the attribute is removed, so
      // "during" ends at the last frame that still had it.
      if (shell.hasAttribute("data-panel-animating")) rec.callsInFlight = w.__E2E__.calls.length;
      if (!rec.done) requestAnimationFrame(tick);
    };
    tick();
    // Walk the records, not the current state: under reduced motion the
    // attribute is set and cleared within one task.
    const mo = new MutationObserver((records) => {
      for (const r of records) {
        const added = r.oldValue === null;
        if (added && !rec.sawAnimating) {
          rec.sawAnimating = true;
          rec.callsAtStart = rec.callsInFlight = w.__E2E__.calls.length;
        } else if (!added && rec.sawAnimating && !rec.done) {
          rec.done = true;
          rec.resizeCallsDuring = (w.__E2E__.calls as Array<{ cmd: string }>)
            .slice(rec.callsAtStart, rec.callsInFlight)
            .filter((c) => c.cmd === "resize_task").length;
          mo.disconnect();
        }
      }
    });
    mo.observe(shell, { attributes: true, attributeFilter: ["data-panel-animating"], attributeOldValue: true });
    w.__panelRec = rec;
  });
}

async function settled(
  page: Page,
): Promise<{ rec: Recording; fits: number; fitsWhileAnimating: number; resizeCallsAfter: number }> {
  await expect
    .poll(() => page.evaluate(() => (window as any).__panelRec.done as boolean), { timeout: 5_000 })
    .toBe(true);
  // Room for a stray observer echo or settle timer to show up if one exists.
  await page.waitForTimeout(400);
  return page.evaluate(() => {
    const w = window as any;
    const rec = w.__panelRec as Recording;
    return {
      rec,
      fits: w.__PHASR_PERF__.terminalFits as number,
      fitsWhileAnimating: w.__PHASR_PERF__.terminalFitsWhileAnimating as number,
      resizeCallsAfter: (w.__E2E__.calls as Array<{ cmd: string }>)
        .slice(rec.callsInFlight)
        .filter((c) => c.cmd === "resize_task").length,
    };
  });
}

function expectOneFitAfter({ rec, fits, fitsWhileAnimating, resizeCallsAfter }: Awaited<ReturnType<typeof settled>>) {
  expect(rec.sawAnimating, "the shell should carry data-panel-animating while the panel slides").toBe(true);
  expect(fitsWhileAnimating, "terminal fits during the transition").toBe(0);
  expect(rec.resizeCallsDuring, "resize_task calls during the transition").toBe(0);
  expect(fits, "terminal fits after the transition").toBe(1);
  // The PTY hears about the new size once, after the slide.
  expect(resizeCallsAfter, "resize_task calls after the transition").toBe(1);
  // The centre column jumps once (start of an expand, end of a collapse);
  // it never interpolates through intermediate widths.
  expect(rec.widths.length, `centre widths seen: ${rec.widths.join(", ")}`).toBeLessThanOrEqual(2);
}

const sidebar = (page: Page) => page.getByRole("complementary", { name: "Sidebar" });
const inspector = (page: Page) => page.getByRole("complementary", { name: "Inspector" });

test.describe("Panel motion (P1/P2)", () => {
  test("sidebar collapse and expand: 0 fits during the slide, 1 after", async ({ page }) => {
    await ready(page);

    await arm(page);
    await page.keyboard.press("Meta+b");
    expectOneFitAfter(await settled(page));
    await expect(sidebar(page).getByRole("button", { name: "Expand task list" })).toBeVisible();

    await arm(page);
    await page.keyboard.press("Meta+b");
    expectOneFitAfter(await settled(page));
    await expect(sidebar(page).getByRole("button", { name: "Collapse task list" })).toBeVisible();
  });

  test("inspector collapse and expand: 0 fits during the slide, 1 after", async ({ page }) => {
    await ready(page);

    await arm(page);
    // Collapse lives in the pane bar (A-Workspace); expand is on the rail.
    await page.getByRole("button", { name: "Collapse inspector" }).click();
    expectOneFitAfter(await settled(page));
    await expect(inspector(page).getByRole("button", { name: "Show inspector" })).toBeVisible();

    await arm(page);
    await inspector(page).getByRole("button", { name: "Show inspector" }).click();
    expectOneFitAfter(await settled(page));
    await expect(page.getByRole("button", { name: "Collapse inspector" })).toBeVisible();
  });

  test("the panel slides with transform; will-change only while it moves", async ({ page }) => {
    await ready(page);
    const panel = sidebar(page).locator(".panel-slide");
    await expect(panel).toHaveCSS("will-change", "auto");
    await expect(panel).toHaveCSS("transition-property", "transform");

    // Sample the sliding layer mid-flight, a frame after the toggle (the
    // slide runs 160ms).
    await page.keyboard.press("Meta+b");
    const mid = await page.evaluate(
      () =>
        new Promise<{ willChange: string; transform: string; asideWidth: number }>((resolve) => {
          requestAnimationFrame(() =>
            requestAnimationFrame(() => {
              const el = document.querySelector<HTMLElement>('[aria-label="Sidebar"] .panel-slide')!;
              const aside = document.querySelector<HTMLElement>('[aria-label="Sidebar"]')!;
              resolve({
                willChange: getComputedStyle(el).willChange,
                transform: getComputedStyle(el).transform,
                asideWidth: aside.getBoundingClientRect().width,
              });
            }),
          );
        }),
    );
    expect(mid.willChange).toBe("transform");
    expect(mid.transform).not.toBe("none");
    // A collapse keeps the panel's width until the slide ends.
    expect(mid.asideWidth).toBeGreaterThan(200);
    await expect(sidebar(page).getByRole("button", { name: "Expand task list" })).toBeVisible();
    await expect(sidebar(page).locator(".panel-slide")).toHaveCount(0);
  });

  test("reduced motion: no slide, the panel settles in one step", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await ready(page);

    await arm(page);
    await page.keyboard.press("Meta+b");
    const res = await settled(page);
    expectOneFitAfter(res);
    await expect(sidebar(page).locator(".panel-slide")).toHaveCount(0);
  });
});
