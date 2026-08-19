import { test, expect, type Page } from "@playwright/test";
import { bootApp, expectBackend, makeFixtures, ptyOut } from "./harness";

/**
 * Regression for the live theme switch (DESIGN-AUDIT-2026-07-12 §127): a
 * theme flip has to be pushed INTO the emulator, which holds its own
 * rasterized copy of the palette. Before the fix the app chrome relit and
 * the terminal stayed on the old colours until it was recreated.
 *
 * Why pixels, and why this patch of pixels: the terminal's container has a
 * CSS `--color-bg-terminal` background that flips with the theme whether or
 * not the emulator ever hears about it. Asserting on the container — or on
 * any DOM/CSS property — passes while the bug is fully present. The only
 * honest evidence is the composited output of the terminal's own renderer,
 * so we sample a patch of the GRID (located through the surface bridge, not
 * through any emulator-specific selector) and compare mean colour.
 *
 * Why a control: the cursor blinks. Naive "screenshot A ≠ screenshot B"
 * diffing goes green on cursor phase alone and would pass with the theme
 * switch ripped out. So we first re-pick the ALREADY-ACTIVE theme and
 * measure how much the same patch moves on its own — the noise floor — and
 * require the real flip to clear it by a wide margin.
 */

type Rgb = [number, number, number];
type Patch = { x: number; y: number; width: number; height: number };

const dist = (a: Rgb, b: Rgb) =>
  Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);

/**
 * A rectangle over cells that are inside the grid and below anything we
 * wrote — so it is pure background, and the cursor (which sits on the line
 * after the last output) is nowhere near it.
 */
async function gridPatch(page: Page): Promise<Patch> {
  return page.evaluate(() => {
    const bridge = (window as any).__PHASR_TERM__;
    if (!bridge) throw new Error("__PHASR_TERM__ missing (not a DEV build?)");
    const id = bridge.ids()[0];
    if (!id) throw new Error("no live terminal surface");
    const grid = bridge.grid(id) as { rows: number; cols: number };
    // Stay well inside the grid on every axis: a terminal is only ~40 rows
    // tall in CI's viewport, and the last column/row can be a partial cell.
    const c0 = 2;
    const r0 = Math.min(8, Math.max(4, Math.floor(grid.rows / 3)));
    const c1 = Math.min(grid.cols - 2, c0 + 30);
    const r1 = Math.min(grid.rows - 2, r0 + 8);
    const a = bridge.cellRect(id, c0, r0);
    const b = bridge.cellRect(id, c1, r1);
    if (!a || !b) throw new Error("grid too small to sample");
    return {
      x: Math.round(a.x),
      y: Math.round(a.y),
      width: Math.round(b.x - a.x),
      height: Math.round(b.y - a.y),
    };
  });
}

/**
 * Mean RGB of the composited patch. The PNG is decoded by the browser's own
 * decoder (there is no image library in this repo's dev deps) and read back
 * through a 2D canvas.
 */
async function meanColor(page: Page, patch: Patch): Promise<Rgb> {
  const png = (await page.screenshot({ clip: patch })).toString("base64");
  return page.evaluate(async (data) => {
    const img = new Image();
    img.src = `data:image/png;base64,${data}`;
    await img.decode();
    const canvas = document.createElement("canvas");
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no 2d context");
    ctx.drawImage(img, 0, 0);
    const { data: px } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    let r = 0;
    let g = 0;
    let b = 0;
    const n = px.length / 4;
    for (let i = 0; i < px.length; i += 4) {
      r += px[i]!;
      g += px[i + 1]!;
      b += px[i + 2]!;
    }
    return [r / n, g / n, b / n] as [number, number, number];
  }, png);
}

/** Pick a theme through the real user path: ⌘K → the palette entry. */
async function pickTheme(page: Page, name: "dark" | "light") {
  await page.keyboard.press("Meta+k");
  await expect(page.locator("[cmdk-root]").first()).toBeVisible({
    timeout: 5000,
  });
  await page.getByRole("option", { name: `Switch to ${name} theme` }).click();
  // The palette closes on select; its backdrop sits over the terminal, so
  // sampling before it is gone would measure the overlay, not the grid.
  await expect(page.locator("[cmdk-root]")).toHaveCount(0, { timeout: 5000 });
  await page.waitForTimeout(600);
}

/**
 * ghostty-web *ignores* a post-`open()` theme write (it logs "theme
 * changes after open() are not yet fully supported" and does nothing), so
 * the backend pushes the palette into the renderer and forces a full
 * frame. This is what proves that still happens.
 */
test("theme switch repaints the terminal itself, not just the chrome", async ({
  page,
}) => {
  await bootApp(page, makeFixtures());
  await expect(page).toHaveURL(/workspaces\/ws-agent/, { timeout: 25_000 });
  await expectBackend(page);
  await page.waitForTimeout(1500);

  // Give the emulator something to have rendered, and put the cursor on a
  // line far above the patch we sample.
  await ptyOut(page, "ws-agent", "phasr theme probe\r\n");
  await page.waitForTimeout(800);

  const patch = await gridPatch(page);
  const before = await meanColor(page, patch);

  // Control: re-pick the theme that is already active. Everything that can
  // move on its own (cursor blink, antialiasing, compositing) moves here;
  // the palette itself opens and closes exactly as in the real flip.
  await pickTheme(page, "dark");
  const control = await meanColor(page, patch);
  const noise = dist(before, control);

  // The real flip.
  await pickTheme(page, "light");
  const after = await meanColor(page, patch);
  const flip = dist(control, after);

  console.log(
    `THEME patch=${JSON.stringify(patch)} dark=${before.map((v) => v.toFixed(1))} control=${control.map((v) => v.toFixed(1))} light=${after.map((v) => v.toFixed(1))} noise=${noise.toFixed(1)} flip=${flip.toFixed(1)}`,
  );

  // Absolute: #000000 -> #fafafb is ~750 summed across channels. A tenth of
  // that is unreachable by anything except the terminal actually relighting.
  expect(flip).toBeGreaterThan(75);
  // Relative: and it must dwarf what the same patch does when the theme is
  // re-picked but unchanged. Without this the test would pass on blink.
  expect(flip).toBeGreaterThan(noise * 10 + 20);
});
