import {
  test,
  expect,
  type BrowserContext,
  type Page,
} from "@playwright/test";
import {
  bootApp,
  cellPoint,
  expectBackend,
  makeFixtures,
  ptyOut,
} from "./harness";

/**
 * Clipboard permissions are a Chromium-only Playwright API — WebKit throws
 * `Unknown permission: clipboard-write` — and WebKit grants clipboard access
 * to the focused page anyway. Guarded so the same spec runs under
 * `playwright.webkit.config.ts`, which is the closest proxy we have to the
 * WKWebView phasr actually ships in.
 */
async function grantClipboard(
  context: BrowserContext,
  browserName: string,
): Promise<void> {
  if (browserName !== "chromium") return;
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
}

/**
 * Selection: what it copies, and what it LOOKS like.
 *
 * The colour half is a regression for the engine swap. ghostty-web models
 * selection as inverse video — `renderCellBackground` returned early and
 * painted `theme.selectionBackground` INSTEAD of the cell's own background,
 * and `renderCellText` repainted every selected glyph in
 * `theme.selectionForeground` (default `#1e1e1e`). phasr's
 * `--ansi-selection` is a translucent wash, so selecting output blended the
 * wash with the line fill instead of the cell (coloured backgrounds
 * vanished) and repainted the text near-black on a dark terminal.
 * `patches/ghostty-web@0.4.0.patch` restores the conventional model: paint the
 * cell, then composite the wash, and leave the glyph colour alone.
 *
 * Asserted on composited PIXELS because that is the only place the bug
 * exists — every DOM and options-level assertion passes while selected
 * text is unreadable.
 */

const LINE = "SELECT-THIS-LINE-0123456789 tail";
const SENTINEL = "PHASR-CLIPBOARD-SENTINEL";

/** blue background run, bright text, then unselected copies of both. */
const BG_RUN = `\x1b[44m${" ".repeat(70)}\x1b[0m`;
// Full blocks, not letters: ~100% cell coverage, so the sampled mean is
// the glyph colour rather than a coverage-weighted blend with antialiased
// edges, and the prediction below can be exact.
const TEXT_RUN = `\x1b[97m${"\u2588".repeat(70)}\x1b[0m`;
const SWATCHES = [BG_RUN, TEXT_RUN, "", BG_RUN, TEXT_RUN, ""].join("\r\n");

type Rgb = [number, number, number];

async function dragSelect(
  page: Page,
  from: { x: number; y: number },
  to: { x: number; y: number },
) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  // Several steps: a single jump can be treated as a click, not a drag.
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 6 });
  await page.mouse.move(to.x, to.y, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(600);
}

/**
 * ghostty-web's copy-on-select, observed rather than inferred. This is a
 * USER-VISIBLE BEHAVIOUR CHANGE that came with the engine, and it is
 * asserted here so that if upstream ever makes it opt-out-able (or phasr
 * suppresses it), this test says so loudly instead of the change going
 * unnoticed.
 */
test("what a drag-selection does to the clipboard", async ({
  page,
  context,
  browserName,
}) => {
  await grantClipboard(context, browserName);
  await bootApp(page, makeFixtures());
  await expect(page).toHaveURL(/workspaces\/ws-agent/, { timeout: 25_000 });
  await expectBackend(page);
  await page.waitForTimeout(1200);

  await ptyOut(page, "ws-agent", `${LINE}\r\n`);
  await page.waitForTimeout(500);

  // A known clipboard value, so "unchanged" is distinguishable from
  // "empty" and from "whatever the previous test left".
  await page.evaluate((s) => navigator.clipboard.writeText(s), SENTINEL);

  await dragSelect(
    page,
    await cellPoint(page, 1, 0, LINE),
    await cellPoint(page, 20, 0, LINE),
  );

  const after = await page.evaluate(() => navigator.clipboard.readText());
  console.log(`SELECTION clipboard after drag = ${JSON.stringify(after)}`);
  expect(after).not.toBe(SENTINEL);
  expect(LINE).toContain(after.trim().slice(0, 8));
});

test("selection is a translucent wash: cell colours survive and glyphs keep theirs", async ({
  page,
  context,
  browserName,
}) => {
  await grantClipboard(context, browserName);
  await bootApp(page, makeFixtures());
  await expect(page).toHaveURL(/workspaces\/ws-agent/, { timeout: 25_000 });
  await expectBackend(page);
  await page.waitForTimeout(1200);

  await ptyOut(page, "ws-agent", `${SWATCHES}\r\n`);
  await page.waitForTimeout(600);

  // The two colours the assertions are computed from, read from the app's
  // own tokens rather than hardcoded — a token change must move the
  // prediction, not break the test.
  const wash = await page.evaluate(() => {
    const raw = getComputedStyle(document.documentElement)
      .getPropertyValue("--ansi-selection")
      .trim();
    const m = raw.match(/rgba?\(([^)]+)\)/);
    if (!m) throw new Error(`--ansi-selection is not rgba(): ${raw}`);
    const parts = m[1]!.split(",").map((v) => Number(v.trim()));
    return {
      rgb: [parts[0]!, parts[1]!, parts[2]!] as [number, number, number],
      alpha: parts[3] ?? 1,
    };
  });

  // Select rows 0-1 (the blue background run and the bright text run);
  // rows 3-4 are identical and stay unselected as the control.
  await dragSelect(page, await cellXY(page, 0, 0), await cellXY(page, 68, 1));

  const bgSelected = await rowColor(page, 0);
  const textSelected = await rowColor(page, 1);
  const bgPlain = await rowColor(page, 3);
  const textPlain = await rowColor(page, 4);

  const over = (base: Rgb): Rgb =>
    base.map((c, i) => c * (1 - wash.alpha) + wash.rgb[i]! * wash.alpha) as Rgb;
  const dist = (a: Rgb, b: Rgb) =>
    Math.max(...a.map((c, i) => Math.abs(c - b[i]!)));

  const bgPredicted = over(bgPlain);
  console.log(
    `SELECTION bg plain=${fmt(bgPlain)} selected=${fmt(bgSelected)} predicted=${fmt(bgPredicted)} | ` +
      `text plain=${fmt(textPlain)} selected=${fmt(textSelected)}`,
  );

  // 1. A selected coloured background is that colour with the wash over
  //    it. Before the patch the cell background was never painted, so this
  //    landed on wash-over-terminal-background instead.
  expect(dist(bgSelected, bgPredicted)).toBeLessThan(16);
  // 2. And the difference is not academic: the buggy result is far away.
  const bgBuggy = over([0, 0, 0]);
  expect(dist(bgSelected, bgBuggy)).toBeGreaterThan(60);

  // 3. Selected TEXT keeps its own colour. The wash is painted as the
  //    cell's background and the glyph goes on top of it (a WebGL renderer
  //    does exactly this), so a full-coverage glyph is completely
  //    unchanged by being selected. Before the patch every selected glyph
  //    was repainted in `selectionForeground` — near-black on a dark
  //    terminal, i.e. selected output became unreadable.
  expect(dist(textSelected, textPlain)).toBeLessThan(12);
  expect(luma(textSelected)).toBeGreaterThan(200);
});

const fmt = (c: Rgb) => `(${c.map((v) => v.toFixed(0)).join(",")})`;
const luma = (c: Rgb) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

/**
 * Click point for a cell, by coordinates rather than by the text on the
 * line — `cellPoint` matches on `readLine`, which trims, so a row of
 * coloured SPACES is invisible to it.
 */
async function cellXY(page: Page, col: number, row: number) {
  return page.evaluate(
    ([col, row]) => {
      const bridge = (window as any).__PHASR_TERM__;
      const id = bridge?.ids()[0];
      const r = id && bridge.cellRect(id, col as number, row as number);
      if (!r) throw new Error(`no cell ${col},${row}`);
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    },
    [col, row] as const,
  );
}

/**
 * Mean colour of a run of cells on one row, located through the surface
 * bridge (never an emulator-specific selector) and read back through the
 * browser's own PNG decoder — the repo has no image library.
 */
async function rowColor(page: Page, row: number): Promise<Rgb> {
  const clip = await page.evaluate(
    ([row]) => {
      const bridge = (window as any).__PHASR_TERM__;
      const id = bridge?.ids()[0];
      if (!id) throw new Error("no live terminal surface");
      // Inset on every side: the wash's edges land on partial pixels, and
      // the glyph run must be sampled where it is dense.
      const a = bridge.cellRect(id, 4, row as number);
      const b = bridge.cellRect(id, 60, row as number);
      if (!a || !b) throw new Error("grid too small to sample");
      return {
        x: Math.round(a.x + 1),
        y: Math.round(a.y + 2),
        width: Math.round(b.x - a.x - 2),
        height: Math.round(a.height - 4),
      };
    },
    [row] as const,
  );
  const png = (await page.screenshot({ clip })).toString("base64");
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
    return [r / n, g / n, b / n] as Rgb;
  }, png);
}

/**
 * The two gestures the user reported as broken.
 *
 * Double-click was implemented upstream but returned null for any cell
 * that wasn't `[\w-]`, so double-clicking a space, a `:` or a box-drawing
 * character did nothing at all — indistinguishable from "the gesture is
 * dead". Triple-click did not exist upstream at any level.
 *
 * Asserted through the clipboard because copy-on-select is ghostty-web's
 * own behaviour, so it is the observable a user actually gets. Chromium
 * only: reading the clipboard needs a permission grant Playwright does not
 * expose on WebKit.
 */
const WORD_LINE = "run src/lib/terminal/options.ts now";

async function clickTimes(
  page: Page,
  point: { x: number; y: number },
  clickCount: number,
) {
  await page.mouse.click(point.x, point.y, { clickCount });
  await page.waitForTimeout(500);
}

test("double-click selects the whole path, not one fragment of it", async ({
  page,
  context,
  browserName,
}) => {
  test.skip(browserName !== "chromium", "clipboard read is Chromium-only here");
  await grantClipboard(context, browserName);
  await bootApp(page, makeFixtures());
  await expect(page).toHaveURL(/workspaces\/ws-agent/, { timeout: 25_000 });
  await expectBackend(page);
  await page.waitForTimeout(1200);

  await ptyOut(page, "ws-agent", `${WORD_LINE}\r\n`);
  await page.waitForTimeout(500);
  await page.evaluate((s) => navigator.clipboard.writeText(s), SENTINEL);

  // Land inside "terminal" — the middle segment of the path. Upstream's
  // `[\w-]` rule would stop at the surrounding slashes and yield exactly
  // that fragment; iTerm's word set takes the whole path.
  const col = WORD_LINE.indexOf("terminal") + 2;
  await clickTimes(page, await cellPoint(page, col, 0, WORD_LINE), 2);

  const got = (await page.evaluate(() => navigator.clipboard.readText())).trim();
  console.log(`DBLCLICK got=${JSON.stringify(got)}`);
  expect(got).toBe("src/lib/terminal/options.ts");
});

test("triple-click selects the whole line", async ({
  page,
  context,
  browserName,
}) => {
  test.skip(browserName !== "chromium", "clipboard read is Chromium-only here");
  await grantClipboard(context, browserName);
  await bootApp(page, makeFixtures());
  await expect(page).toHaveURL(/workspaces\/ws-agent/, { timeout: 25_000 });
  await expectBackend(page);
  await page.waitForTimeout(1200);

  await ptyOut(page, "ws-agent", `${WORD_LINE}\r\n`);
  await page.waitForTimeout(500);
  await page.evaluate((s) => navigator.clipboard.writeText(s), SENTINEL);

  const col = WORD_LINE.indexOf("terminal") + 2;
  await clickTimes(page, await cellPoint(page, col, 0, WORD_LINE), 3);

  const got = (await page.evaluate(() => navigator.clipboard.readText())).trim();
  console.log(`TRIPLECLICK got=${JSON.stringify(got)}`);
  expect(got).toBe(WORD_LINE);
});
