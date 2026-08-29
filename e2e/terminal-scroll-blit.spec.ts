import { test, expect, type Page } from "@playwright/test";
import { bootApp, ptyOut, terminal } from "./harness";

/**
 * Perf phase 2, criterion 4 — active scrolling BLITS.
 *
 * While scrolled into history, a wheel step used to force a full-canvas
 * repaint: every row a getScrollbackLine WASM fetch plus a cell-by-cell
 * draw, to change what three rows display. The renderer now moves the
 * surviving region with a canvas self-drawImage and repaints only the
 * newly exposed rows.
 *
 * The visual suites (scrollback, scroll-follow, wheel, selection, theme)
 * assert the pixels stay CORRECT; what they cannot see is whether the
 * cheap path was taken — a regression to full repaints per step would
 * pass every one of them. The engine's own counter is the oracle:
 * `getRenderStats().blits`, incremented only when a frame moved the
 * window with a self-copy instead of repainting it.
 */

async function feedScrollback(page: Page, lines: number) {
  const burst = 500;
  for (let i = 0; i < lines; i += burst) {
    const chunk: string[] = [];
    for (let n = i; n < Math.min(i + burst, lines); n++) {
      chunk.push(`line ${String(n).padStart(5, "0")}  scroll blit corpus`);
    }
    await ptyOut(page, "ws-agent", chunk.join("\r\n") + "\r\n");
    await page.waitForTimeout(30);
  }
  await page.waitForTimeout(400);
}

test("wheel scrolling in deep scrollback blits instead of repainting in full", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await bootApp(page);
  await expect(page).toHaveURL(/workspaces\/ws-agent/, { timeout: 25_000 });
  await page.waitForTimeout(1500);
  await feedScrollback(page, 2000);

  const id = await page.evaluate(
    () => (window as any).__PHASR_TERM__.ids()[0] as string,
  );
  const stats = () =>
    page.evaluate(
      (i) => (window as any).__PHASR_TERM__.stats(i) as { blits: number },
      id,
    );
  const offset = () =>
    page.evaluate(
      (i) =>
        ((window as any).__PHASR_TERM__.viewport(i) as { offset: number })
          .offset,
      id,
    );

  // At the live bottom nothing has blitted — the counter must start flat.
  const atBottom = (await stats()).blits;

  const box = await terminal(page).boundingBox();
  if (!box) throw new Error("terminal not found");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);

  // Scroll up into history. The FIRST scrolled frame is a legitimate full
  // repaint (the previous frame was at the bottom — nothing on the canvas
  // is window-aligned); the steps after it must ride the blit.
  for (let i = 0; i < 12; i++) {
    await page.mouse.wheel(0, -120);
    await page.waitForTimeout(40);
  }
  await page.waitForTimeout(200);

  expect(await offset()).toBeGreaterThan(0);
  const afterUp = (await stats()).blits;
  expect(afterUp).toBeGreaterThan(atBottom);

  // And back down — the other blit direction.
  for (let i = 0; i < 6; i++) {
    await page.mouse.wheel(0, 120);
    await page.waitForTimeout(40);
  }
  await page.waitForTimeout(200);
  expect((await stats()).blits).toBeGreaterThan(afterUp);
});
