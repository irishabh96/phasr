import { test, expect, type Page } from "@playwright/test";
import { bootApp, makeFixtures, ptyOut, terminal } from "./harness";

/**
 * DEC mode 2026 — synchronized output.
 *
 * A full-screen TUI redraws by erasing and repainting, and brackets each
 * frame with `\x1b[?2026h` … `\x1b[?2026l` so the terminal keeps showing
 * the PREVIOUS frame until the new one is complete. Claude Code does this
 * around every repaint (observed in a real pty capture).
 *
 * `ghostty-web@0.4.0` never read the mode — the string "2026" does not
 * appear anywhere in its bundle — and its render loop paints whatever is
 * in the grid on every animation frame. A frame split across two PTY
 * reads (which is normal: chunks break at read boundaries) was therefore
 * painted half-applied, and the erase half is a blank screen. That is the
 * flicker mechanism, and it is independent of scrolling: the wheel just
 * made it constant by making the app repaint several times per tick.
 *
 * `patches/ghostty-web@0.4.0.patch` makes the render loop skip painting
 * while the mode is set, bounded by a timeout so a program that sets the
 * mode and then hangs cannot freeze the display. Both halves are asserted
 * here, on composited pixels — the only place this bug exists.
 */

/** Enough rows of dense glyphs that "painted" and "erased" are far apart. */
const FULL_SCREEN = Array.from({ length: 40 }, () => "M".repeat(100)).join(
  "\r\n",
);

/** Mean luminance-ish value of the whole terminal, 0 (black) to 255. */
async function brightness(page: Page): Promise<number> {
  const box = await terminal(page).boundingBox();
  if (!box) throw new Error("terminal not found");
  const png = (await page.screenshot({ clip: box })).toString("base64");
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
    let sum = 0;
    for (let i = 0; i < px.length; i += 4) {
      sum += (px[i]! + px[i + 1]! + px[i + 2]!) / 3;
    }
    return sum / (px.length / 4);
  }, png);
}

test("a synchronized frame is never painted half-applied", async ({ page }) => {
  await bootApp(page, makeFixtures());
  await expect(page).toHaveURL(/workspaces\/ws-agent/, { timeout: 25_000 });
  await page.waitForTimeout(1500);

  await ptyOut(page, "ws-agent", `\x1b[?1049h\x1b[H${FULL_SCREEN}`);
  await page.waitForTimeout(500);
  const painted = await brightness(page);
  expect(painted).toBeGreaterThan(20);

  // Half a frame, inside a synchronized update. Several animation frames
  // pass before we look — the old content must still be on screen.
  await ptyOut(page, "ws-agent", "\x1b[?2026h\x1b[2J\x1b[H");
  await page.waitForTimeout(80);
  const midSync = await brightness(page);

  // The bounded part: a program that sets 2026 and never clears it (killed
  // mid-frame, hung) must not freeze the display forever.
  await page.waitForTimeout(400);
  const afterTimeout = await brightness(page);

  await ptyOut(page, "ws-agent", `${FULL_SCREEN}\x1b[?2026l`);
  await page.waitForTimeout(300);
  const afterSync = await brightness(page);

  // Control: the identical split with no synchronization requested. This
  // is what the terminal did to EVERY frame before the patch.
  await ptyOut(page, "ws-agent", "\x1b[2J\x1b[H");
  await page.waitForTimeout(200);
  const midPlain = await brightness(page);
  await ptyOut(page, "ws-agent", FULL_SCREEN);
  await page.waitForTimeout(300);

  console.log(
    `SYNC2026 painted=${painted.toFixed(1)} midSync=${midSync.toFixed(1)} ` +
      `afterTimeout=${afterTimeout.toFixed(1)} afterSync=${afterSync.toFixed(1)} midPlain=${midPlain.toFixed(1)}`,
  );

  // 1. Mid-frame under 2026: still the old frame, not a flash of nothing.
  expect(midSync).toBeGreaterThan(painted * 0.9);
  // 2. The control proves the terminal really would have shown the erase.
  expect(midPlain).toBeLessThan(painted * 0.1);
  // 3. …and that the deferral is bounded, not a freeze.
  expect(afterTimeout).toBeLessThan(painted * 0.1);
  // 4. The completed frame lands.
  expect(afterSync).toBeGreaterThan(painted * 0.9);
});
