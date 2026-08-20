import { test, expect, type Page } from "@playwright/test";
import { bootApp, makeFixtures, ptyOut, terminal } from "./harness";

/**
 * A grapheme cluster split across two PTY chunks must never be painted
 * half-applied.
 *
 * `☁️` is U+2601 CLOUD followed by U+FE0F VARIATION SELECTOR-16. The base
 * codepoint alone is a small monochrome dingbat, painted in the cell's
 * foreground colour; with the selector it is a two-cell COLOUR BITMAP whose
 * pixels ignore `fillStyle` entirely. They are completely different glyphs.
 *
 * The render loop is `requestAnimationFrame`-driven and independent of
 * `write()`, so a frame that fires between the two chunks paints the wrong
 * one and corrects it a frame later. A real zsh prompt carries exactly this
 * cluster — captured from `zsh -l` under phasr's own environment:
 *
 *   \x1b[1;33m☁️  \x1b[0m\x1b[1;33m(ap-south-1)\x1b[0m
 *
 * so the flicker lands on the prompt, on every terminal, forever.
 *
 * This is NOT the same bug as `terminal-sync.spec.ts`: a synchronized update
 * is a program asking to be double-buffered, and a half-parsed ESCAPE
 * sequence produces no cell at all. Here the base codepoint IS a complete,
 * paintable cell — the parser has nothing to defer on. The fix is in
 * `graphemeTail.ts`: hold back a trailing codepoint a selector could still
 * follow, and write it when the rest arrives.
 *
 * Asserted on composited pixels, which is the only place the bug exists.
 */

/**
 * Classify the glyph in the first 3 cells of `row`.
 *
 * The block cursor is a coral FILL (`--color-accent-500`, #f78166) and would
 * otherwise be counted as glyph ink, so its pixels are discarded before the
 * decision — the specs below also hide the cursor, and this is the belt to
 * that pair of braces.
 */
const CLASSIFY = `(row) => {
  const c = document.querySelector('[data-testid="terminal-surface"] canvas');
  const bridge = window.__PHASR_TERM__;
  if (!c || !bridge) return null;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  const id = bridge.ids()[0];
  const c0 = id && bridge.cellRect(id, 0, row);
  const c1 = id && bridge.cellRect(id, 1, row);
  if (!ctx || !c0 || !c1) return null;
  const host = c.getBoundingClientRect();
  const dpr = c.width / host.width;
  const cw = (c1.x - c0.x) * dpr;
  const y0 = Math.round((c0.y - host.y) * dpr);
  const h = Math.max(1, Math.round(c0.height * dpr));
  const d = ctx.getImageData(0, y0, Math.min(c.width, Math.round(cw * 3)), h).data;
  let ink = 0, offFill = 0;
  for (let i = 0; i < d.length; i += 4) {
    const R = d[i], G = d[i + 1], B = d[i + 2];
    if (0.299 * R + 0.587 * G + 0.114 * B < 40) continue;
    // the block cursor, not a glyph
    if (Math.abs(R - 247) < 40 && Math.abs(G - 129) < 40 && Math.abs(B - 102) < 40) continue;
    ink++;
    // the SGR 33 fill is #d29922 == 210,153,34; a colour-bitmap emoji ignores it
    if (Math.abs(R - 210) > 45 || Math.abs(G - 153) > 45 || Math.abs(B - 34) > 70) offFill++;
  }
  if (ink < 6) return 'none';  // the cursor is hidden, so a blank row is 0
  return offFill > ink * 0.4 ? 'colour-emoji' : 'monochrome';
}`;

/** Hide the cursor so a blink cannot be mistaken for a glyph. */
async function hideCursor(page: Page) {
  await ptyOut(page, "ws-agent", "\x1b[?25l");
  await page.waitForTimeout(120);
}

/** What is on screen right now. */
const cloudKind = (page: Page, row: number) =>
  page.evaluate(
    ([fn, r]) => (0, eval)(fn as string)(r) as string | null,
    [CLASSIFY, row] as const,
  );

/** Record what every animation frame painted, until told to stop. */
async function watchFrames(page: Page, row: number) {
  await page.evaluate(
    ([fn, r]) => {
      const w = window as any;
      const classify = (0, eval)(fn as string);
      w.__SEEN__ = [] as string[];
      w.__WATCH__ = true;
      const tick = () => {
        if (!w.__WATCH__) return;
        const k = classify(r);
        if (k !== null) w.__SEEN__.push(k);
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    },
    [CLASSIFY, row] as const,
  );
}

const framesSeen = (page: Page) =>
  page.evaluate(() => {
    (window as any).__WATCH__ = false;
    return (window as any).__SEEN__ as string[];
  });

async function boot(page: Page) {
  await page.setViewportSize({ width: 1200, height: 800 });
  await bootApp(page, makeFixtures());
  await expect(page).toHaveURL(/workspaces\/ws-agent/, { timeout: 25_000 });
  await expect(terminal(page)).toHaveAttribute("data-terminal-kind", "ghostty", {
    timeout: 20_000,
  });
  await page.waitForTimeout(1200);
}

test("a cluster split across two chunks is never painted half-applied", async ({
  page,
}) => {
  await boot(page);
  await hideCursor(page);

  // Baseline: the whole cluster in one chunk is a colour emoji.
  await ptyOut(page, "ws-agent", "\x1b[1;33m☁️\x1b[0m\r\n");
  await page.waitForTimeout(400);
  expect(await cloudKind(page, 0)).toBe("colour-emoji");

  // Now split it. 30ms is ~2 animation frames: without the fix a frame lands
  // between the halves and paints the monochrome dingbat. It is also well
  // inside the 50ms hold, so the fix completes the cluster from the queue
  // rather than from the timeout.
  await watchFrames(page, 1);
  await ptyOut(page, "ws-agent", "\x1b[1;33m☁");
  await page.waitForTimeout(30);
  await ptyOut(page, "ws-agent", "️\x1b[0m\r\n");
  await page.waitForTimeout(500);
  const seen = await framesSeen(page);

  expect(seen.length).toBeGreaterThan(2);
  // THE ASSERTION: no frame ever showed the base codepoint on its own.
  expect(seen.filter((s) => s === "monochrome")).toEqual([]);
  // ...and the cluster still arrives.
  expect(await cloudKind(page, 1)).toBe("colour-emoji");
});

test("a writer that stops mid-cluster still gets its glyph", async ({ page }) => {
  await boot(page);
  await hideCursor(page);
  // Nothing follows the base codepoint. The hold is bounded, so the dingbat
  // must still be painted rather than swallowed.
  await ptyOut(page, "ws-agent", "\x1b[1;33m☁");
  await page.waitForTimeout(600);
  expect(await cloudKind(page, 0)).toBe("monochrome");
});

test("ASCII and TUI glyphs are not delayed", async ({ page }) => {
  await boot(page);
  // A box-drawing frame and a keystroke echo must be on screen immediately —
  // holding either would add a frame of latency to every TUI repaint.
  await ptyOut(page, "ws-agent", "\x1b[1;33m┌──┐");
  await page.waitForTimeout(120);
  const box = await page.evaluate(() => {
    const b = (window as any).__PHASR_TERM__;
    return b.lineText(b.ids()[0], 0);
  });
  expect(box?.startsWith("┌──┐")).toBe(true);
});
