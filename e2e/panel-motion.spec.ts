import { test, expect, type Page } from "@playwright/test";
import { bootApp, expectBackend, waitForCall } from "./harness";

/**
 * Spec §5 / P1/P2 (ui-mission-control-polish-spec): toggling the sidebar or
 * the inspector must not touch the terminal while the panel moves. The
 * panel's slot animates its width, so the centre column grows and shrinks
 * with it on every frame — but every terminal fits exactly once, after the
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
    // The centre column, as the terminal sees it (the inspector sits inside
    // <main>, so <main> itself only moves for the sidebar).
    const pane = [...document.querySelectorAll<HTMLElement>("[data-testid='terminal-surface']")].find(
      (el) => el.offsetParent !== null,
    )!;
    // Nothing else is talking to the backend between `arm` and the toggle,
    // so a call the settle makes in the same task as the toggle (reduced
    // motion) still lands after this mark.
    const callsAtArm = w.__E2E__.calls.length as number;
    const rec = {
      sawAnimating: false,
      done: false,
      widths: [] as number[],
      resizeCallsDuring: 0,
      callsAtStart: callsAtArm,
      callsInFlight: callsAtArm,
    };
    const tick = () => {
      const width = pane.getBoundingClientRect().width;
      if (rec.widths[rec.widths.length - 1] !== width) rec.widths.push(width);
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

function expectOneFitAfter(
  { rec, fits, fitsWhileAnimating, resizeCallsAfter }: Awaited<ReturnType<typeof settled>>,
  { animated = true }: { animated?: boolean } = {},
) {
  expect(rec.sawAnimating, "the shell should carry data-panel-animating while the panel slides").toBe(true);
  expect(fitsWhileAnimating, "terminal fits during the transition").toBe(0);
  expect(rec.resizeCallsDuring, "resize_task calls during the transition").toBe(0);
  expect(fits, "terminal fits after the transition").toBe(1);
  // The PTY hears about the new size once, after the slide.
  expect(resizeCallsAfter, "resize_task calls after the transition").toBe(1);
  const seen = `centre widths seen: ${rec.widths.join(", ")}`;
  if (!animated) {
    // Reduced motion: one step, no tween.
    expect(rec.widths.length, seen).toBeLessThanOrEqual(2);
    return;
  }
  // The centre column follows the slot through intermediate widths, in one
  // direction only: no blank strip, no snap at the end.
  expect(rec.widths.length, seen).toBeGreaterThan(3);
  const dir = Math.sign(rec.widths[rec.widths.length - 1]! - rec.widths[0]!);
  for (let i = 1; i < rec.widths.length; i++) {
    expect(Math.sign(rec.widths[i]! - rec.widths[i - 1]!), seen).toBe(dir);
  }
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

  test("the slot animates width; the panel keeps its width, clipped, and fades", async ({ page }) => {
    await ready(page);
    const aside = sidebar(page);
    const panel = aside.locator(".panel-content");
    await expect(aside).toHaveCSS("transition-property", "none");
    const full = await panel.evaluate((el) => el.getBoundingClientRect().width);
    const slotOpen = await aside.evaluate((el) => el.getBoundingClientRect().width);

    // Sample mid-flight: the first frame on which the slot has moved (the
    // tween runs 160ms; its first frame is at t=0).
    await page.keyboard.press("Meta+b");
    const mid = await page.evaluate(
      (start) =>
        new Promise<{ transition: string; asideWidth: number; panelWidth: number; opacity: number; rail: number }>(
          (resolve) => {
            let n = 0;
            const tick = () => {
              const aside = document.querySelector<HTMLElement>('[aria-label="Sidebar"]')!;
              const w = aside.getBoundingClientRect().width;
              if (w === start && ++n < 10) return requestAnimationFrame(tick);
              const panel = aside.querySelector<HTMLElement>(".panel-content")!;
              const rail = aside.querySelector<HTMLElement>(".panel-rail")!;
              resolve({
                transition: getComputedStyle(aside).transitionProperty,
                asideWidth: w,
                panelWidth: panel.getBoundingClientRect().width,
                opacity: Number(getComputedStyle(panel).opacity),
                rail: Number(getComputedStyle(rail).opacity),
              });
            };
            requestAnimationFrame(tick);
          },
        ),
      slotOpen,
    );
    expect(mid.transition).toBe("width");
    expect(mid.asideWidth).toBeGreaterThan(48);
    expect(mid.asideWidth).toBeLessThan(slotOpen);
    // The content never rewraps: same width, clipped by the slot.
    expect(mid.panelWidth).toBe(full);
    expect(mid.opacity).toBeLessThan(1);
    expect(mid.rail).toBeGreaterThan(0);

    await expect(aside.getByRole("button", { name: "Expand task list" })).toBeVisible();
    await expect(aside.locator(".panel-content")).toHaveCount(0);
    await expect(aside).toHaveCSS("transition-property", "none");
  });

  test("toggling again mid-flight retargets from the current width and settles once", async ({ page }) => {
    await ready(page);
    const open = await sidebar(page).evaluate((el) => el.getBoundingClientRect().width);

    await arm(page);
    await page.evaluate(() => {
      const w = window as any;
      const aside = document.querySelector<HTMLElement>('[aria-label="Sidebar"]')!;
      w.__slot = [] as number[];
      const tick = () => {
        w.__slot.push(aside.getBoundingClientRect().width);
        if (!w.__panelRec.done) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    await page.keyboard.press("Meta+b");
    await page.waitForTimeout(60);
    await page.keyboard.press("Meta+b");
    const res = await settled(page);

    // One hold for the whole interrupted toggle; the terminal never fits
    // inside it (and at most once after — it may end where it started).
    expect(res.fitsWhileAnimating).toBe(0);
    expect(res.fits).toBeLessThanOrEqual(1);
    expect(res.rec.resizeCallsDuring).toBe(0);
    // No jump: the slot turns around where it was (one direction change,
    // no frame-to-frame step bigger than the tween's own).
    const slot = (await page.evaluate(() => (window as any).__slot)) as number[];
    const steps = slot
      .slice(1)
      .map((w, i) => w - slot[i]!)
      .filter((d) => d !== 0);
    const turns = steps.filter((d, i) => i > 0 && Math.sign(d) !== Math.sign(steps[i - 1]!));
    expect(turns.length, `slot widths: ${slot.join(", ")}`).toBe(1);
    expect(Math.max(...steps.map(Math.abs)), `slot widths: ${slot.join(", ")}`).toBeLessThan(80);

    // Settled fully open: full width, panel opaque and at rest, rail gone.
    const end = await sidebar(page).evaluate((el) => {
      const panel = el.querySelector<HTMLElement>(".panel-content");
      return {
        width: el.getBoundingClientRect().width,
        panelLeft: panel?.getBoundingClientRect().left ?? null,
        opacity: panel ? getComputedStyle(panel).opacity : null,
        rails: el.querySelectorAll(".panel-rail").length,
        animating: el.hasAttribute("data-animating"),
      };
    });
    expect(end).toEqual({ width: open, panelLeft: 0, opacity: "1", rails: 0, animating: false });
    await expect(page.locator("[data-panel-animating]")).toHaveCount(0);
  });

  test("drag-resize is instant: no transition while dragging", async ({ page }) => {
    await ready(page);
    const aside = sidebar(page);
    const handle = aside.getByRole("separator");
    const box = (await handle.boundingBox())!;
    const before = (await aside.boundingBox())!.width;
    await page.mouse.move(box.x + box.width / 2, box.y + 200);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 40, box.y + 200);
    // Read right after the move: a tween would still be near the start.
    const during = await aside.evaluate((el) => ({
      width: el.getBoundingClientRect().width,
      transition: getComputedStyle(el).transitionProperty,
    }));
    await page.mouse.up();
    expect(during.transition).toBe("none");
    expect(during.width).toBe(before + 40);
    await expect(page.locator("[data-panel-animating]")).toHaveCount(0);
  });

  test("reduced motion: no tween, the panel settles in one step", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await ready(page);

    await arm(page);
    await page.keyboard.press("Meta+b");
    const res = await settled(page);
    expectOneFitAfter(res, { animated: false });
    await expect(sidebar(page).locator(".panel-content")).toHaveCount(0);
  });
});
