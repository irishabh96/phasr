import { test, expect, type Page } from "@playwright/test";
import {
  bootApp,
  calls,
  clearCalls,
  expectBackend,
  ptyBurst,
  ptyOut,
  terminal,
} from "./harness";

/**
 * Where a terminal's content ENDS UP after the width changes, and whether
 * the grid still fills the pane when it gets there.
 *
 * Every reflow spec before this one was a colour oracle: feed the grid a
 * shape, resize it, assert the attributes survived. Chroma held at
 * 85-100% through 17->51->78 rows, a shrink to 25, and a forced wrap down
 * to 5 columns — and none of it could have caught this, because a reflow
 * that preserves every attribute and still moves the first line four rows
 * down passes all of it. This spec asserts POSITION instead: which row
 * the content is actually PAINTED on.
 *
 * The bug it pinned (see ADR-002, "the reflow anchor"): opening or closing
 * a side panel changed the terminal's width, and every width round trip
 * permanently converted trailing blank rows below the cursor into leading
 * history rows above it. The content marched down the screen a row or two
 * per toggle and never came back up.
 *
 * **It is fixed, and the two cases that used to be `test.fail()` are now
 * plain assertions.** phasr no longer reflows a live grid: a width change
 * is deferred until the container stops moving and then applied by
 * rebuilding the grid at the new width and replaying the retained output
 * into it (`lib/terminal/reflow.ts`, `backends/ghostty.ts` `rebuildGrid`).
 *
 * Which is why every test here asserts TWO things together. "The content
 * did not move" is trivial to satisfy by never resizing at all — and that
 * leaves every line clipped at the right-hand edge of a pane it no longer
 * fits, which is worse than the drift was. So each reading also carries
 * `slack`: how much of the pane the grid is failing to cover. Both, or
 * neither counts.
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
  /** The text on `bufferTop`. Guards "nothing moved" by blanking. */
  topLine: string | null;
  /** Width one cell occupies, in CSS px. */
  cell: number;
  /** Width the terminal has to fill, in CSS px. */
  available: number;
  /**
   * `available` minus the width the grid actually covers.
   *
   * Zero-to-just-under-one-cell is the whole of "correctly sized": a grid
   * is a whole number of cells, so it can never cover the last few pixels.
   * NEGATIVE means the grid is wider than the pane and the right-hand end
   * of every line is being clipped — the failure mode a naive "just skip
   * the resize" fix produces, and the one this spec exists to refuse.
   */
  slack: number;
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
      let topLine: string | null = null;
      for (let r = 0; r < grid.rows && bufferTop < 0; r++) {
        const line = bridge.lineText(id, vp.scrollback + r);
        if (line && line.trim().length > 0) {
          bufferTop = r;
          topLine = line.trim();
        }
      }

      // Exactly the sum `GhosttySurface.fit()` measures against, read off
      // the DOM instead of from the surface, so a bug in that arithmetic
      // cannot make its own spec pass. The surface's element is the
      // canvas's parent; the scrollbar reservation is ghostty-web's.
      const surfaceEl = canvas.parentElement as HTMLElement;
      const style = getComputedStyle(surfaceEl);
      const px = (v: string) => Number.parseInt(style.getPropertyValue(v)) || 0;
      const available =
        surfaceEl.clientWidth - px("padding-left") - px("padding-right") - 15;
      const cell = bridge.cellRect(id, 0, 0)?.width ?? 0;

      return {
        cols: grid.cols,
        rows: grid.rows,
        offset: vp.offset,
        scrollback: vp.scrollback,
        paintedTop,
        bufferTop,
        topLine,
        cell,
        available,
        slack: available - canvas.getBoundingClientRect().width,
      };
    },
    [BRIDGE, SCROLLBAR_GUTTER_PX] as const,
  );
}

/**
 * The grid covers the pane: no clipped right-hand edge, no dead strip
 * wider than the one cell a whole-number grid can never fill.
 */
function expectFillsPane(reading: Reading) {
  expect(reading.cell).toBeGreaterThan(0);
  expect(reading.slack).toBeGreaterThanOrEqual(0);
  expect(reading.slack).toBeLessThan(reading.cell);
}

/**
 * A screen shaped like the one in the user's recording: blank history
 * above, a short marker line, filler that MUST rewrap when the width
 * changes, a prompt, and nothing below it.
 *
 * The trailing blank rows are the fuel — the ratchet spent them — and
 * the blank scrollback is what makes drift show up as empty rows above
 * the text rather than as history sliding into view.
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

/**
 * Wait for the terminal to have finished reacting to a width change.
 *
 * Polling the GRID for "it stopped moving" — which is what this used to do
 * — stopped being a settle oracle the moment the grid stopped tracking the
 * animation: it now holds its old width all the way through and changes
 * exactly once, at the end, so "unchanged twice" resolves instantly and
 * every reading lands before anything has happened.
 *
 * So it waits on the two things that are actually true at the end: the
 * PANE has stopped animating, and the grid has caught up with it. The
 * second half is the pane-fit invariant, which means every test that
 * changes a width is enforcing it whether it asks or not.
 */
async function settle(page: Page) {
  let last = -1;
  let steady = 0;
  for (let i = 0; i < 60 && steady < 2; i++) {
    await page.waitForTimeout(50);
    const { available } = await read(page);
    if (available === last) steady += 1;
    else {
      steady = 0;
      last = available;
    }
  }
  if (steady < 2) throw new Error("the pane never stopped animating");
  await expect
    .poll(
      async () => {
        const r = await read(page);
        return r.slack >= 0 && r.slack < r.cell;
      },
      { timeout: 10_000 },
    )
    .toBe(true);
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
 * The diagnosis, pinned. It passed while the bug was live and it passes
 * now, which is the point: it says what the viewport and the paint are
 * doing, so neither the failure it used to sit next to nor the fix that
 * replaced it can be explained away as "the viewport scrolled".
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
  // first toggle goes depends on the panel's persisted state.
  expect(mid.cols).not.toBe(before.cols);
  expect(after.cols).toBe(before.cols);

  // Nothing is scrolled: the viewport never leaves the live bottom, so
  // "scroll to the bottom after the resize settles" is a no-op here and
  // could never have been the fix.
  expect(mid.offset).toBe(0);
  expect(after.offset).toBe(0);

  // What is painted is exactly what the buffer holds — the blank rows the
  // ratchet used to leave were in the buffer, not an artefact of the
  // incremental renderer.
  expect(mid.paintedTop).toBe(mid.bufferTop);
  expect(after.paintedTop).toBe(after.bufferTop);

  // The mechanism itself: the content sank by exactly the number of
  // history lines the reflow pulled onto the screen. Both sides are now
  // zero — no rows were converted, because nothing rewrapped.
  expect(before.scrollback - after.scrollback).toBe(
    after.paintedTop - before.paintedTop,
  );
  expect(after.scrollback).toBe(before.scrollback);
});

/**
 * The invariant a user cares about. **These two were `test.fail()` until
 * the rebuild landed** — the drift was real, reproducible from either
 * trigger, and there was no lever inside `ghostty_terminal_resize` to
 * reach for. They are ordinary assertions now.
 */
for (const [name, toggle] of Object.entries(TRIGGERS)) {
  test(`content keeps its row when the ${name} opens and closes`, async ({
    page,
  }) => {
    await boot(page);
    const before = await read(page);
    expectFillsPane(before);

    await toggle(page);
    const mid = await read(page);
    await toggle(page);
    const after = await read(page);

    // Guard the guard: if the trigger stopped changing the width this
    // test would pass while proving nothing.
    expect(mid.cols).not.toBe(before.cols);
    expect(after.cols).toBe(before.cols);

    expect(after.paintedTop).toBe(before.paintedTop);

    // ...and the terminal is still the size of the pane at BOTH widths.
    // Refusing the resize outright would satisfy the line above and leave
    // every line clipped, which is the trade this spec will not take.
    expectFillsPane(mid);
    expectFillsPane(after);

    // ...and the content is still there. A blanked screen has a very
    // stable `paintedTop`.
    expect(after.topLine).toBe("ANCHOR");
    expect(before.topLine).toBe("ANCHOR");
    expect(after.scrollback).toBe(before.scrollback);
  });
}

/**
 * The ratchet was cumulative — a row or two per toggle, forever. One round
 * trip is a weak oracle for that; the drift was only obvious because it
 * kept going. Twelve of them, alternating triggers, is the shape of the
 * complaint.
 */
test("twelve toggles do not move the content by a single row", async ({
  page,
}) => {
  await boot(page);
  const before = await read(page);
  const triggers = Object.values(TRIGGERS);

  for (let i = 0; i < 12; i++) {
    await triggers[i % triggers.length](page);
    const now = await read(page);
    // Not just at the end: a drift that cancelled itself out every other
    // toggle would still be a drift the user watches happen.
    expectFillsPane(now);
  }

  const after = await read(page);
  expect(after.cols).toBe(before.cols);
  expect(after.paintedTop).toBe(before.paintedTop);
  expect(after.scrollback).toBe(before.scrollback);
  expect(after.topLine).toBe("ANCHOR");
  expectFillsPane(after);
});

/**
 * The follow-up ADR-002 recorded next to the bug: one panel toggle sent
 * **13 `resize_task` calls in 220 ms**, because the `<aside>` animates its
 * width and every frame of it refit the grid. A real agent TUI repaints on
 * every SIGWINCH, so that was thirteen full repaints for one click.
 *
 * Deferring the width change collapses it for free: the grid is touched
 * once, at the end, and `onResize` fires from that one resize.
 */
test("a panel toggle costs the agent exactly one SIGWINCH", async ({
  page,
}) => {
  await boot(page);
  // Let the mount's own trailing refits (60/250/600 ms) go by first.
  await page.waitForTimeout(700);

  for (const [name, toggle] of Object.entries(TRIGGERS)) {
    await clearCalls(page);
    await toggle(page);
    const resizes = (await calls(page)).filter((c) => c.cmd === "resize_task");
    expect(resizes, `${name}: one resize per toggle`).toHaveLength(1);
  }
});

/**
 * A toggle the user reverses before it settles must cost nothing at all —
 * no rebuild, no SIGWINCH, no replay. The grid never left the width it is
 * being asked for again, so there is nothing to do.
 */
test("an open/close faster than the settle is a no-op", async ({ page }) => {
  await boot(page);
  await page.waitForTimeout(700);
  await clearCalls(page);
  const before = await read(page);

  const changes = page
    .getByRole("button", { name: /^(Show|Hide) changes$/ })
    .first();
  await changes.click();
  await changes.click();
  await settle(page);

  const after = await read(page);
  expect(after.cols).toBe(before.cols);
  expect(after.paintedTop).toBe(before.paintedTop);
  expect((await calls(page)).filter((c) => c.cmd === "resize_task")).toEqual(
    [],
  );
});

/**
 * Rebuilding a grid means freeing a WASM terminal and allocating another,
 * and ADR-002 Q5 measured one at ~5.2 MiB with its page pool allocated up
 * front. If `reset()` leaked even a fraction of that, a user who likes
 * ⌘B would find out the hard way.
 */
test("repeated rebuilds do not grow WASM memory", async ({ page }) => {
  await boot(page);
  await toggleChangesPanel(page);
  await toggleChangesPanel(page);
  const bytes = (page: Page) =>
    page.evaluate(() => (window as any).__PHASR_GHOSTTY__?.wasmBytes() ?? 0);
  const before = await bytes(page);
  expect(before).toBeGreaterThan(0);

  for (let i = 0; i < 10; i++) await toggleChangesPanel(page);

  expect(await bytes(page)).toBe(before);
});

/**
 * **A TUI's screen is rebuilt too, and so is the shell scrollback under
 * it.**
 *
 * The alternate screen looked like it could keep the cheap path: it has no
 * history, so the ratchet has nothing to trade, and six width round trips
 * left the frame exactly where it was. That reading was wrong, and this
 * test is what caught it — the SAVED PRIMARY SCREEN is reflowed while it
 * is hidden. With a plain resize its scrollback fell 102 -> 82 over six
 * toggles behind a TUI, i.e. the same drift, waiting to be revealed by
 * `\x1b[?1049l` minutes later.
 *
 * So both screens are asserted: the frame the user is looking at, and the
 * one they get back when the program exits.
 */
test("a toggle in the alternate screen keeps the frame, and the primary screen under it", async ({
  page,
}) => {
  await boot(page);
  const primaryBefore = await read(page);
  expect(primaryBefore.topLine).toBe("ANCHOR");
  expect(primaryBefore.scrollback).toBeGreaterThan(0);

  const frame: string[] = [];
  for (let i = 0; i < 8; i++) frame.push("=".repeat(70 + i * 5));
  await ptyOut(
    page,
    "ws-agent",
    `\x1b[?1049h\x1b[2J\x1b[HALT-ANCHOR\r\n${frame.join("\r\n")}\r\n> `,
  );
  await page.waitForTimeout(300);
  const altBefore = await read(page);
  // No history at all is what says the alternate screen is the live one.
  expect(altBefore.scrollback).toBe(0);
  expect(altBefore.topLine).toBe("ALT-ANCHOR");

  const triggers = Object.values(TRIGGERS);
  for (let i = 0; i < 6; i++) {
    await triggers[i % triggers.length](page);
    const now = await read(page);
    expect(now.scrollback).toBe(0);
    expect(now.topLine).toBe("ALT-ANCHOR");
    expect(now.bufferTop).toBe(altBefore.bufferTop);
    expectFillsPane(now);
  }

  await ptyOut(page, "ws-agent", "\x1b[?1049l");
  await page.waitForTimeout(300);
  const primaryAfter = await read(page);
  expect(primaryAfter.topLine).toBe("ANCHOR");
  expect(primaryAfter.scrollback).toBe(primaryBefore.scrollback);
  expect(primaryAfter.paintedTop).toBe(primaryBefore.paintedTop);
});

/**
 * The same terminal, once the `\x1b[?1049h` that entered the alternate
 * screen has fallen out of the retained window — which is what happens to
 * every long-lived TUI, because it sets its modes once and then runs.
 *
 * What is left in the window is a stream of frames with nothing saying
 * which screen they belong to. Replayed as-is they would be painted over
 * the user's shell scrollback and the mode repair would then switch to a
 * blank alternate screen on top of that, so the surface tracks where the
 * switch happened and re-enters the alternate screen ahead of the replay.
 */
test("a rebuild keeps the alternate screen after the sequence that entered it has aged out", async ({
  page,
}) => {
  await boot(page);
  await ptyOut(page, "ws-agent", "\x1b[?1049h\x1b[2J\x1b[HALT-ANCHOR\r\n> ");
  await page.waitForTimeout(200);
  expect((await read(page)).scrollback).toBe(0);

  // Past the 1 MiB budget. `ESC [ H` and no newline: in the alternate
  // screen this produces no history of its own, which is what keeps
  // `scrollback === 0` an honest oracle after the rebuild.
  const noise = "x".repeat(4096);
  for (let i = 0; i < 5; i++) {
    await ptyBurst(
      page,
      "ws-agent",
      Array.from({ length: 64 }, () => `\x1b[H${noise}`),
    );
  }
  await ptyOut(page, "ws-agent", "\x1b[2J\x1b[HALT-ANCHOR\r\n> ");
  await page.waitForTimeout(300);

  await toggleChangesPanel(page);

  const after = await read(page);
  expect(after.scrollback).toBe(0);
  expect(after.topLine).toBe("ALT-ANCHOR");
  expectFillsPane(after);
});

/**
 * A rebuilt grid is a *fresh* terminal, and a fresh terminal has forgotten
 * every mode the running program switched on. Usually the replay
 * re-establishes them, because the bytes that set them are still inside
 * the retained window — this test proves the case where they are NOT, and
 * that case is the normal one on any terminal that has been open a while:
 * a program sets its modes once at startup and then runs for hours, so
 * they are the FIRST thing to age out.
 *
 * Losing them is not cosmetic. DECCKM is the one under test because it is
 * directly observable: with it set, ↑ is `ESC O A`, and without it `ESC [
 * A` — which a program in application-cursor mode does not recognise as
 * an arrow key at all.
 */
test("a rebuild carries the modes the program set, after those bytes have aged out", async ({
  page,
}) => {
  await boot(page);
  const sentBytes = async (): Promise<string[]> =>
    (await calls(page))
      .filter((c) => c.cmd === "send_input_to_task")
      .map((c) => (c.args?.data as string) ?? "");

  // DECCKM on: the emulator now encodes arrows the application way.
  await ptyOut(page, "ws-agent", "\x1b[?1h");
  await page.waitForTimeout(150);
  await terminal(page).click();
  await clearCalls(page);
  await page.keyboard.press("ArrowUp");
  await page.waitForTimeout(300);
  expect(await sentBytes()).toEqual(["\x1bOA"]);

  // Push the retained window past its budget, so the `?1h` above is gone
  // from it. `ESC [ H` and no newline: this repaints the same rows rather
  // than producing a megabyte of scrollback to replay.
  const noise = "y".repeat(4096);
  for (let i = 0; i < 5; i++) {
    await ptyBurst(
      page,
      "ws-agent",
      Array.from({ length: 64 }, () => `\x1b[H${noise}`),
    );
  }
  await page.waitForTimeout(300);

  const started = Date.now();
  await toggleChangesPanel(page);
  const elapsed = Date.now() - started;

  await terminal(page).click();
  await clearCalls(page);
  await page.keyboard.press("ArrowUp");
  await page.waitForTimeout(300);
  expect(await sentBytes()).toEqual(["\x1bOA"]);
  expectFillsPane(await read(page));
  // Not an assertion — what a rebuild costs with the window full, logged
  // so a change that makes it expensive shows up here rather than only in
  // a user's hands.
  console.log(
    `[reflow] toggle with a full replay window settled in ${elapsed} ms`,
  );
});
