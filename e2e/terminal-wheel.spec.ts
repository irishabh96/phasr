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
 * What the mouse wheel sends to the PTY.
 *
 * The bug this pins down: `ghostty-web@0.4.0`'s own `handleWheel` fires up
 * to FIVE `\x1b[A` / `\x1b[B` per wheel tick whenever the app is on the
 * alternate screen, and never reports the mouse at all. Claude Code is on
 * the alternate screen (verified by driving the real CLI in a pty:
 * `\x1b[?1049h\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h` at startup), so
 * scrolling over it opened the prompt-history overlay and overwrote what
 * the user had typed — five entries at a time.
 *
 * These assert the contract phasr shipped before the engine swap:
 * mouse events when the app asked for them, at most one arrow when it
 * didn't, and nothing at all when the terminal can scroll itself.
 */

/** Claude Code's startup mode set, byte for byte. */
const CLAUDE_MODES = "\x1b[?1049h\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h";
/**
 * `less`, byte for byte: alt screen + DECCKM (application cursor keys),
 * no mouse tracking. Verified by running the real `less` in a pty — and
 * there it ONLY responds to `\x1bOB`; the `\x1b[B` ghostty-web hardcodes
 * scrolls it by nothing at all.
 */
const PAGER_MODES = "\x1b[?1049h\x1b[?1h";
/** Same, with DECCKM off — the `\x1b[A` form. */
const PAGER_MODES_NORMAL_CURSOR = "\x1b[?1049h";

async function ptyInput(page: Page): Promise<string[]> {
  return (await calls(page))
    .filter((c) => c.cmd === "send_input_to_task")
    .map((c) => String(c.args?.data ?? ""));
}

async function boot(page: Page, modes: string) {
  await bootApp(page, makeFixtures());
  await expect(page).toHaveURL(/workspaces\/ws-agent/, { timeout: 25_000 });
  await page.waitForTimeout(1200);
  await ptyOut(page, "ws-agent", `${modes}some output\r\n`);
  await page.waitForTimeout(400);
  await clearCalls(page);
}

/** Wheel over the middle of the terminal, `steps` discrete ticks. */
async function wheel(page: Page, steps: number, deltaY: number) {
  const box = await terminal(page).boundingBox();
  if (!box) throw new Error("terminal not found");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < steps; i++) {
    await page.mouse.wheel(0, deltaY);
    await page.waitForTimeout(60);
  }
  await page.waitForTimeout(300);
}

test("an alt-screen app that asked for mouse events gets mouse events, never arrow keys", async ({
  page,
}) => {
  await boot(page, CLAUDE_MODES);
  await wheel(page, 3, -120);

  const sent = await ptyInput(page);
  console.log(`WHEEL claude-modes up x3 -> ${JSON.stringify(sent)}`);

  // The regression, stated the way the user experienced it.
  expect(sent.join("")).not.toContain("\x1b[A");
  expect(sent.join("")).not.toContain("\x1b[B");
  // SGR wheel-up (button 64) with 1-based coordinates, one per tick.
  expect(sent).toHaveLength(3);
  for (const seq of sent) expect(seq).toMatch(/^\x1b\[<64;\d+;\d+M$/);

  await clearCalls(page);
  await wheel(page, 2, 120);
  const down = await ptyInput(page);
  console.log(`WHEEL claude-modes down x2 -> ${JSON.stringify(down)}`);
  expect(down).toHaveLength(2);
  for (const seq of down) expect(seq).toMatch(/^\x1b\[<65;\d+;\d+M$/);
});

test("an alt-screen app WITHOUT mouse tracking gets exactly one arrow per tick", async ({
  page,
}) => {
  await boot(page, PAGER_MODES_NORMAL_CURSOR);
  await wheel(page, 3, -120);

  const sent = await ptyInput(page);
  console.log(`WHEEL pager-modes up x3 -> ${JSON.stringify(sent)}`);
  // Stock ghostty-web sends up to 5 per tick (12 at this delta). The
  // conventional behaviour is 1, and so is ours.
  expect(sent).toEqual(["\x1b[A", "\x1b[A", "\x1b[A"]);
});

test("the arrow fallback follows DECCKM, the way `less` actually needs", async ({
  page,
}) => {
  await boot(page, PAGER_MODES);
  await wheel(page, 2, -120);

  const sent = await ptyInput(page);
  console.log(`WHEEL less-modes up x2 -> ${JSON.stringify(sent)}`);
  // SS3, not CSI. Driving the real `less` in a pty: `\x1bOB` scrolls one
  // line and `\x1b[B` — what stock ghostty-web sends — does nothing.
  expect(sent).toEqual(["\x1bOA", "\x1bOA"]);
});

test("wheel on the normal screen scrolls the terminal and sends nothing to the PTY", async ({
  page,
}) => {
  await bootApp(page, makeFixtures());
  await expect(page).toHaveURL(/workspaces\/ws-agent/, { timeout: 25_000 });
  await page.waitForTimeout(1200);
  const lines = Array.from(
    { length: 400 },
    (_, i) => `line ${String(i).padStart(4, "0")} lorem ipsum dolor sit amet`,
  );
  await ptyOut(page, "ws-agent", `${lines.join("\r\n")}\r\n`);
  await page.waitForTimeout(600);
  await clearCalls(page);

  const box = await terminal(page).boundingBox();
  if (!box) throw new Error("terminal not found");
  const before = await page.screenshot({ clip: box });
  await wheel(page, 5, -120);
  const after = await page.screenshot({ clip: box });

  const sent = await ptyInput(page);
  console.log(`WHEEL normal-screen up x5 -> ${JSON.stringify(sent)}`);
  expect(sent).toEqual([]);
  // …and it actually scrolled: the composited grid moved.
  expect(Buffer.compare(before, after)).not.toBe(0);
});
