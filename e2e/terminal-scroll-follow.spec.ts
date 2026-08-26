import { expect, test, type Page } from "@playwright/test";
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
 * Scrolling while an agent streams — the 0.4.0 field reports.
 *
 * Three defects stacked into "I can't scroll the logs, and when I try it
 * hangs until I switch workspaces":
 *
 *  1. ghostty-web's `write()` ended with `viewportY !== 0 &&
 *     scrollToBottom()` — every PTY chunk snapped the viewport to the
 *     bottom, and the Rust coalescer delivers a chunk every 32 KiB / 8 ms,
 *     so no scroll position survived a frame under a busy agent.
 *  2. The snap moved `viewportY` while a wheel-started smooth scroll kept
 *     its stale target, so `animateScroll` jumped ~97% of the way back
 *     the next frame — a per-frame tug-of-war for as long as output
 *     arrived.
 *  3. The renderer treated `viewportY > 0` as "every row dirty, every
 *     frame", so merely being scrolled was a permanent full-canvas
 *     repaint. All three together saturated the main thread; queued
 *     wheel/mouse events read as a total hang.
 *
 * The patched engine anchors instead (grow the offset by the scrollback
 * growth, so on-screen content stays put), cancels the animation on any
 * direct viewport set, and repaints a scrolled viewport only when the
 * visible window actually changed. Snapping back to the bottom is the
 * user's own gesture: a keystroke.
 */

const BRIDGE = "__PHASR_TERM__";

/** The visible surface's id, through the DOM the way a user reaches it. */
const surfaceId = async (page: Page): Promise<string> => {
  const host = terminal(page);
  const id = await host.getAttribute("data-terminal-id");
  if (!id) throw new Error("no visible terminal surface");
  return id;
};

const view = (page: Page, id: string) =>
  page.evaluate(
    ([k, i]) => (window as any)[k].viewport(i) as { offset: number; scrollback: number },
    [BRIDGE, id] as const,
  );

/** Text of the top VISIBLE line: absolute row `scrollback - offset`. */
const topText = async (page: Page, id: string): Promise<string | null> => {
  return page.evaluate(
    ([k, i]) => {
      const bridge = (window as any)[k];
      const v = bridge.viewport(i);
      return bridge.lineText(i, v.scrollback - v.offset);
    },
    [BRIDGE, id] as const,
  );
};

const ptyInput = async (page: Page): Promise<string[]> =>
  (await calls(page))
    .filter((c) => c.cmd === "send_input_to_task")
    .map((c) => String(c.args?.data ?? ""));

/** Wheel over the middle of the terminal, `steps` discrete ticks. */
async function wheel(page: Page, steps: number, deltaY: number) {
  const box = await terminal(page).boundingBox();
  if (!box) throw new Error("terminal not found");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < steps; i++) {
    await page.mouse.wheel(0, deltaY);
    await page.waitForTimeout(60);
  }
  // Let the smooth-scroll glide settle before reading positions.
  await page.waitForTimeout(400);
}

test("streaming output never moves a scrolled viewport; a keypress snaps it back", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));

  const boot = await bootApp(page);
  await expectBackend(page);
  await terminal(page).click();
  const id = await surfaceId(page);

  const lines = Array.from(
    { length: 400 },
    (_, i) => `line ${String(i).padStart(4, "0")} lorem ipsum dolor sit amet`,
  );
  await ptyOut(page, "ws-agent", `${lines.join("\r\n")}\r\n`);
  await page.waitForTimeout(500);

  await wheel(page, 6, -120);
  const before = await view(page, id);
  expect(before.offset, "the wheel reached scrollback").toBeGreaterThan(0);
  const anchor = await topText(page, id);
  expect(anchor).toContain("line ");

  // A busy agent: one chunk per beat, the shape the Rust coalescer
  // delivers. The pre-fix engine snapped `offset` to 0 on the FIRST one.
  for (let i = 0; i < 10; i++) {
    await ptyOut(page, "ws-agent", `stream ${String(i).padStart(3, "0")} output while scrolled\r\n`);
    await page.waitForTimeout(50);
    const v = await view(page, id);
    expect(v.offset, `chunk ${i} must not snap the viewport to the bottom`).toBeGreaterThan(0);
  }
  await page.waitForTimeout(200);

  const after = await view(page, id);
  expect(
    after.offset,
    "the offset grows with the scrollback, keeping the content anchored",
  ).toBeGreaterThan(before.offset);
  expect(
    await topText(page, id),
    "the same line is still at the top of the viewport",
  ).toBe(anchor);

  // Returning to the bottom is the user's own gesture now.
  await page.keyboard.type("q");
  await expect
    .poll(async () => (await view(page, id)).offset, { timeout: 3_000 })
    .toBe(0);

  expect(errors).toEqual([]);
  void boot;
});

test("scrollback holds thousands of rows, not the old ~1,100-row byte floor", async ({
  page,
}) => {
  const boot = await bootApp(page);
  await expectBackend(page);
  const id = await surfaceId(page);

  // 4,000 numbered lines. Before the units fix the engine's default
  // budget was 10,000 BYTES (the line count fed into a byte field),
  // floored to ~1,129 retained rows — measured against the real WASM.
  const chunk = (start: number) =>
    Array.from(
      { length: 500 },
      (_, i) => `deep ${String(start + i).padStart(5, "0")} scrollback row`,
    ).join("\r\n") + "\r\n";
  for (let b = 0; b < 8; b++) {
    await ptyBurst(page, "ws-agent", [chunk(b * 500)]);
    await page.waitForTimeout(120);
  }
  await page.waitForTimeout(600);

  const v = await view(page, id);
  console.log(`DEEP scrollback after 4,000 lines -> ${v.scrollback}`);
  expect(
    v.scrollback,
    "history far past the old ~1,100-row cap is retained",
  ).toBeGreaterThan(3000);

  // And the oldest retained row is really readable, not just counted.
  const oldest = await page.evaluate(
    ([k, i]) => (window as any)[k].lineText(i, 0),
    [BRIDGE, id] as const,
  );
  expect(oldest).toContain("deep");
  void boot;
});

test("a double-click beside the grid neither starts a DOM selection nor eats typing", async ({
  page,
}) => {
  const boot = await bootApp(page);
  await expectBackend(page);
  await terminal(page).click();
  const id = await surfaceId(page);

  await ptyOut(page, "ws-agent", "alpha beta gamma\r\n");
  await page.waitForTimeout(300);

  // The strip the grid does not cover: ghostty-web reserves 15px of the
  // surface for its overlay scrollbar, so a point 5px from the right edge
  // is inside the CONTENTEDITABLE host but off the canvas — `cellAt`
  // returns null there. Before the fix, the un-preventDefault-ed native
  // double-click ran WebKit's editing machinery on the host and the
  // focus/selection state it left behind ate keystrokes ("sometimes when
  // I double click it hangs").
  const box = await terminal(page).boundingBox();
  if (!box) throw new Error("terminal not found");
  await page.mouse.dblclick(box.x + box.width - 5, box.y + box.height / 2);
  await page.waitForTimeout(200);

  // The native word-selection was suppressed…
  const selectionType = await page.evaluate(() =>
    String(document.getSelection()?.type),
  );
  expect(selectionType, "no DOM range selection on the host").not.toBe("Range");

  // …the terminal still has the keyboard…
  await clearCalls(page);
  await page.keyboard.type("z");
  await page.waitForTimeout(400);
  const sent = await ptyInput(page);
  console.log(`DBLCLICK off-grid, then typed -> ${JSON.stringify(sent)}`);
  expect(sent.join("")).toContain("z");

  // …and the render loop is still alive.
  const tick = () =>
    page.evaluate(
      ([k, i]) => (window as any)[k].renderTick(i) as number | null,
      [BRIDGE, id] as const,
    );
  const t0 = await tick();
  await expect
    .poll(async () => tick(), { timeout: 3_000 })
    .not.toBe(t0);
  void boot;
});
