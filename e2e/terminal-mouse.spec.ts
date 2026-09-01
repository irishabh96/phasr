import { test, expect, type Page } from "@playwright/test";
import {
  bootApp,
  calls,
  clearCalls,
  makeFixtures,
  ptyOut,
  terminal,
} from "./harness";

/**
 * What a mouse BUTTON sends to the PTY.
 *
 * The bug these pin down: `ghostty-web@0.4.0` reports no mouse event of any
 * kind (`\x1b[<` and `\x1b[M` each appear zero times in its bundle), and
 * phasr's own reporting covered only the wheel. So a click inside a
 * mouse-aware TUI reached it as nothing at all — the field report was that
 * the agent rows under Claude Code's input box could not be clicked, and
 * the same was true of its task list, `vim` with `set mouse=a`, `htop` and
 * every other program that asks for tracking.
 *
 * The contract asserted here: buttons when the app asked for them, nothing
 * when it didn't, and shift always left to phasr so text is still
 * selectable while an app owns the mouse.
 */

/** Claude Code's startup mode set, byte for byte. */
const CLAUDE_MODES = "\x1b[?1049h\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h";
/** Alt screen, no mouse tracking — `less`. */
const PAGER_MODES = "\x1b[?1049h";

async function ptyInput(page: Page): Promise<string[]> {
  return (await calls(page))
    .filter((c) => c.cmd === "send_input_to_task")
    .map((c) => String(c.args?.data ?? ""));
}

/**
 * Press and release reports only.
 *
 * Moving the pointer into place is itself reportable under 1003, which
 * Claude Code asks for — so "sent nothing" is never the right assertion
 * for a click, only "reported no BUTTON". Motion carries bit 5 (>= 32);
 * a press or release does not.
 */
function buttonReports(sent: string[]): string[] {
  return sent.filter((seq) =>
    /^\x1b\[<(?:[0-2]|1[0-9]|2[0-9]);\d+;\d+[Mm]$/.test(seq),
  );
}

async function boot(page: Page, modes: string) {
  await bootApp(page, makeFixtures());
  await expect(page).toHaveURL(/workspaces\/ws-agent/, { timeout: 25_000 });
  await page.waitForTimeout(1200);
  await ptyOut(page, "ws-agent", `${modes}some output\r\n`);
  await page.waitForTimeout(400);
  await clearCalls(page);
}

/** Click in the middle of the terminal grid. */
async function clickTerminal(
  page: Page,
  options: { modifiers?: "Shift"[]; button?: "left" | "right" } = {},
) {
  const box = await terminal(page).boundingBox();
  if (!box) throw new Error("terminal not found");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  if (options.modifiers?.includes("Shift")) await page.keyboard.down("Shift");
  await page.mouse.down({ button: options.button ?? "left" });
  await page.waitForTimeout(80);
  await page.mouse.up({ button: options.button ?? "left" });
  if (options.modifiers?.includes("Shift")) await page.keyboard.up("Shift");
  await page.waitForTimeout(300);
}

test("an app that asked for the mouse gets the press and the release", async ({
  page,
}) => {
  await boot(page, CLAUDE_MODES);
  await clickTerminal(page);

  const sent = await ptyInput(page);
  console.log(`CLICK claude-modes -> ${JSON.stringify(sent)}`);

  // The regression, stated the way the user experienced it: before this,
  // a click produced nothing at all.
  expect(sent.length).toBeGreaterThanOrEqual(2);
  // SGR left press then release, same cell, 1-based coordinates.
  const press = sent.find((s) => /^\x1b\[<0;\d+;\d+M$/.test(s));
  const release = sent.find((s) => /^\x1b\[<0;\d+;\d+m$/.test(s));
  expect(press).toBeTruthy();
  expect(release).toBeTruthy();
  expect(press?.slice(0, -1)).toBe(release?.slice(0, -1));
});

test("a click sends nothing to an app that never asked for the mouse", async ({
  page,
}) => {
  await boot(page, PAGER_MODES);
  await clickTerminal(page);

  const sent = await ptyInput(page);
  console.log(`CLICK pager-modes -> ${JSON.stringify(sent)}`);
  expect(sent).toEqual([]);
});

test("shift+click stays phasr's, so text is still selectable under a tracking app", async ({
  page,
}) => {
  await boot(page, CLAUDE_MODES);
  await clickTerminal(page, { modifiers: ["Shift"] });

  const sent = await ptyInput(page);
  console.log(`SHIFT-CLICK claude-modes -> ${JSON.stringify(sent)}`);
  expect(buttonReports(sent)).toEqual([]);
});

test("right-click stays phasr's, so the native copy/paste menu survives", async ({
  page,
}) => {
  await boot(page, CLAUDE_MODES);
  await clickTerminal(page, { button: "right" });

  const sent = await ptyInput(page);
  console.log(`RIGHT-CLICK claude-modes -> ${JSON.stringify(sent)}`);
  expect(buttonReports(sent)).toEqual([]);
});

test("a drag under a tracking app reports motion instead of selecting text", async ({
  page,
}) => {
  await boot(page, CLAUDE_MODES);
  const box = await terminal(page).boundingBox();
  if (!box) throw new Error("terminal not found");

  await page.mouse.move(box.x + 40, box.y + 30);
  await page.mouse.down();
  // Many small steps, so the report count is governed by cells crossed and
  // not by how many `mousemove`s Playwright chose to dispatch.
  await page.mouse.move(box.x + 240, box.y + 30, { steps: 40 });
  await page.mouse.up();
  await page.waitForTimeout(300);

  const sent = await ptyInput(page);
  console.log(`DRAG claude-modes -> ${JSON.stringify(sent)}`);

  // Motion carries bit 5 (32 = left button held, moving).
  const motion = sent.filter((s) => /^\x1b\[<32;\d+;\d+M$/.test(s));
  expect(motion.length).toBeGreaterThan(1);

  // One report per cell, and never two for the same cell: 40 dispatched
  // moves across ~200px collapse to the number of columns actually crossed,
  // which is what "per cell" means and what an upper bound alone cannot show.
  const columns = motion.map((s) => s.split(";")[1]);
  expect(new Set(columns).size).toBe(columns.length);
  expect(motion.length).toBeLessThan(40);

  // The drag never became a text selection.
  expect(
    await page.evaluate(() => window.getSelection()?.toString() ?? ""),
  ).toBe("");
});
