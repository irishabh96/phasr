import { test, expect, type Page } from "@playwright/test";
import { bootApp, expectBackend, ptyOut, terminal } from "./harness";

/**
 * Where a terminal's content ENDS UP after the width changes.
 *
 * Every reflow spec before this one was a colour oracle: feed the grid a
 * shape, resize it, assert the attributes survived. Chroma held at
 * 85-100% through 17->51->78 rows, a shrink to 25, and a forced wrap down
 * to 5 columns — and none of it could have caught this, because a reflow
 * that preserves every attribute and still moves the first line four rows
 * down passes all of it. This spec asserts POSITION instead: which row
 * the content is actually PAINTED on.
 *
 * The bug it pins (see ADR-002, "the reflow anchor"): opening or closing a
 * side panel changes the terminal's width, and every width round trip
 * permanently converts trailing blank rows below the cursor into leading
 * history rows above it. The content marches down the screen a row or two
 * per toggle and never comes back up.
 *
 * The two readings below are what make the diagnosis falsifiable, because
 * "the content is painted lower" has two causes that are pixel-identical
 * on screen and have opposite fixes:
 *
 *   - `offset` — how far the viewport is scrolled back from the live
 *     bottom. If THIS moved, the buffer is fine and the fix is ours: pin
 *     the viewport after the resize settles.
 *   - `bufferTop` vs `paintedTop` — where the buffer's own screen rows
 *     start, against where ink starts on the canvas. If these agree, the
 *     blank rows are really IN the buffer and no amount of scrolling will
 *     help.
 *
 * They are read every time, so a future change that swaps one cause for
 * the other cannot quietly keep the spec passing for the wrong reason.
 */

const BRIDGE = "__PHASR_TERM__";

/**
 * ghostty-web paints its own overlay scrollbar into the right-hand edge of
 * the same canvas, and fades it in on every resize. It is ink on every
 * row, so a naive "topmost row with any ink" oracle reports row 0 forever
 * and this spec would pass no matter how far the text had drifted.
 */
const SCROLLBAR_GUTTER_PX = 40;

interface Reading {
  cols: number;
  rows: number;
  /** Lines scrolled back from the live bottom. 0 = pinned to the bottom. */
  offset: number;
  /** Lines of history that exist right now. Moves under a reflow. */
  scrollback: number;
  /** Topmost CANVAS row carrying ink. -1 when the screen is blank. */
  paintedTop: number;
  /** Topmost SCREEN row of the buffer carrying text. -1 when all blank. */
  bufferTop: number;
}

async function read(page: Page): Promise<Reading> {
  return page.evaluate(
    ([bridgeKey, gutter]) => {
      const bridge = (window as any)[bridgeKey as string];
      if (!bridge) throw new Error(`${bridgeKey} missing (not a DEV build?)`);
      const host = [
        ...document.querySelectorAll("[data-testid='terminal-surface']"),
      ].find((el) => (el as HTMLElement).offsetParent !== null) as
        | HTMLElement
        | undefined;
      const canvas = host?.querySelector("canvas") as HTMLCanvasElement | null;
      if (!host || !canvas) throw new Error("no visible terminal canvas");
      const id = host.getAttribute("data-terminal-id")!;
      const grid = bridge.grid(id);
      const vp = bridge.viewport(id);

      const ctx = canvas.getContext("2d")!;
      const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
      // Background is whatever the bottom-left pixel is: the last row is
      // blank in every fixture here, and reading it beats hardcoding a
      // theme colour that a token change would silently invalidate.
      const b = (canvas.height - 1) * canvas.width * 4;
      const bg = [data[b], data[b + 1], data[b + 2]];
      const rowHeight = canvas.height / grid.rows;
      const width = Math.max(1, canvas.width - (gutter as number));
      let paintedTop = -1;
      for (let r = 0; r < grid.rows && paintedTop < 0; r++) {
        let ink = 0;
        for (
          let y = Math.floor(r * rowHeight);
          y < Math.floor((r + 1) * rowHeight);
          y++
        ) {
          for (let x = 0; x < width; x += 2) {
            const i = (y * canvas.width + x) * 4;
            if (
              Math.abs(data[i] - bg[0]) > 12 ||
              Math.abs(data[i + 1] - bg[1]) > 12 ||
              Math.abs(data[i + 2] - bg[2]) > 12
            ) {
              ink++;
              if (ink > 3) break;
            }
          }
          if (ink > 3) break;
        }
        if (ink > 3) paintedTop = r;
      }

      // Screen row r is buffer-absolute row `scrollback + r`.
      let bufferTop = -1;
      for (let r = 0; r < grid.rows && bufferTop < 0; r++) {
        const line = bridge.lineText(id, vp.scrollback + r);
        if (line && line.trim().length > 0) bufferTop = r;
      }

      return {
        cols: grid.cols,
        rows: grid.rows,
        offset: vp.offset,
        scrollback: vp.scrollback,
        paintedTop,
        bufferTop,
      };
    },
    [BRIDGE, SCROLLBAR_GUTTER_PX] as const,
  );
}

/**
 * A screen shaped like the one in the user's recording: blank history
 * above, a short marker line, filler that MUST rewrap when the width
 * changes, a prompt, and nothing below it.
 *
 * The trailing blank rows are the fuel — the ratchet spends them — and
 * the blank scrollback is what makes the drift show up as empty rows
 * above the text rather than as history sliding into view.
 */
async function seedDriftableScreen(page: Page) {
  await ptyOut(page, "ws-agent", "\r\n".repeat(140));
  await page.waitForTimeout(300);
  const filler: string[] = [];
  for (let i = 0; i < 10; i++) filler.push("#".repeat(80 + i * 4));
  await ptyOut(
    page,
    "ws-agent",
    `\x1b[2J\x1b[HANCHOR\r\n${filler.join("\r\n")}\r\n> `,
  );
  await page.waitForTimeout(500);
}

/** Wait for the terminal's width to stop moving. Both panels animate over
 *  220 ms, so the terminal is refit a dozen times on the way; polling the
 *  grid is what "the resize is over" actually means. */
async function settle(page: Page) {
  let last = -1;
  for (let i = 0; i < 40; i++) {
    await page.waitForTimeout(50);
    const { cols } = await read(page);
    if (cols === last) return;
    last = cols;
  }
  throw new Error("terminal width never settled");
}

/**
 * The two ways a user changes a terminal's width without touching the
 * window. Both are in the spec because the report named the sidebar and
 * the recording showed the Changes panel, and the answer turned out to be
 * "either, it is the width that matters".
 */
const TRIGGERS = {
  "changes panel": async (page: Page) => {
    await page
      .getByRole("button", { name: /^(Show|Hide) changes$/ })
      .first()
      .click();
    await settle(page);
  },
  "left sidebar": async (page: Page) => {
    // The collapse control is icon-only with a tooltip and no accessible
    // name, so drive it the way the user does.
    await page.keyboard.press("Meta+b");
    await settle(page);
  },
} as const;

const toggleChangesPanel = TRIGGERS["changes panel"];

async function boot(page: Page) {
  await bootApp(page);
  await expectBackend(page);
  await terminal(page).click();
  await seedDriftableScreen(page);
}

/**
 * The diagnosis, pinned. Passes today, and is what stops the expected
 * failure below from being written off as "the viewport scrolled".
 */
test("a width round trip leaves the viewport pinned and the paint faithful", async ({
  page,
}) => {
  await boot(page);
  const before = await read(page);
  expect(before.offset).toBe(0);
  expect(before.paintedTop).toBe(before.bufferTop);

  await toggleChangesPanel(page);
  const mid = await read(page);
  await toggleChangesPanel(page);
  const after = await read(page);

  // The width really did change and change back. Which way round the
  // first toggle goes depends on the panel's persisted state, and the
  // ratchet does not care — every round trip costs the same.
  expect(mid.cols).not.toBe(before.cols);
  expect(after.cols).toBe(before.cols);

  // Nothing is scrolled: the viewport never leaves the live bottom, so
  // "scroll to the bottom after the resize settles" is a no-op here and
  // cannot be the fix.
  expect(mid.offset).toBe(0);
  expect(after.offset).toBe(0);

  // What is painted is exactly what the buffer holds — the blank rows are
  // in the buffer, not an artefact of the incremental renderer.
  expect(mid.paintedTop).toBe(mid.bufferTop);
  expect(after.paintedTop).toBe(after.bufferTop);

  // And the mechanism itself: the content sank by exactly the number of
  // history lines the reflow pulled onto the screen.
  expect(before.scrollback - after.scrollback).toBe(
    after.paintedTop - before.paintedTop,
  );
});

/**
 * The invariant a user cares about, and the one that is broken.
 *
 * `test.fail()` rather than a skip: the assertion runs, so the day
 * ghostty-web's reflow anchors correctly this spec goes red and tells us
 * to delete the annotation instead of silently rotting. The defect is in
 * `ghostty_terminal_resize` inside the WASM, which takes no anchor
 * argument — there is no lever on our side of the boundary. See ADR-002.
 */
for (const [name, toggle] of Object.entries(TRIGGERS)) {
  test.fail(
    `content keeps its row when the ${name} opens and closes`,
    async ({ page }) => {
      await boot(page);
      const before = await read(page);

      await toggle(page);
      const mid = await read(page);
      await toggle(page);
      const after = await read(page);

      // Guard the guard: if the trigger stopped changing the width this
      // test would "fail as expected" while proving nothing.
      expect(mid.cols).not.toBe(before.cols);
      expect(after.cols).toBe(before.cols);

      expect(after.paintedTop).toBe(before.paintedTop);
    },
  );
}
