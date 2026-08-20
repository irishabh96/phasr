import { test, expect, type Page } from "@playwright/test";
import {
  bootApp,
  calls,
  clearCalls,
  expectBackend,
  makeFixtures,
  pty,
  terminal,
  waitForCall,
} from "./harness";

/**
 * Opening terminals — the ⌘T path — end to end.
 *
 * Three things a user would notice, none of which any other spec covers:
 *
 * 1. **The PTY is spawned at the real grid.** `GhosttySurface.fit()` used to
 *    need the engine, and the engine attaches asynchronously
 *    (`preloadGhosttyEngine().then` — a microtask at best), so the
 *    "fit synchronously before starting the PTY" step every terminal
 *    component performs was a guaranteed no-op on the fresh path. Every PTY
 *    in the app was therefore spawned at the 24x80 fallback and resized a
 *    round trip later. A shell does not care; an agent TUI does — it reads
 *    its size once at startup, draws its welcome box at 80 columns, and
 *    then repaints IN PLACE against coordinates that no longer exist, which
 *    fuses the new frame into the old one and leaves the top of the screen
 *    permanently wrong.
 *
 * 2. **Every terminal renders, and the screen matches the buffer.** The
 *    render loop is incremental — it repaints only the rows the emulator
 *    marked dirty — so "the buffer has the right text" proves nothing about
 *    what is on screen. `__PHASR_TERM__.repaint()` forces a full redraw,
 *    which is by definition the truth; a live canvas that differs from it
 *    has stale rows. The oracle is itself checked (see the positive
 *    control) so a broken oracle cannot silently pass.
 *
 * 3. **Keystrokes reach the terminal you are looking at.** Asserted on the
 *    session id the bytes were sent to, not on `document.activeElement`.
 */

const BRIDGE = "__PHASR_TERM__";

const liveIds = (page: Page) =>
  page.evaluate((k) => (window as any)[k]?.ids() ?? [], BRIDGE) as Promise<
    string[]
  >;

const grid = (page: Page, id: string) =>
  page.evaluate(
    ([k, id]) => (window as any)[k as string]?.grid(id),
    [BRIDGE, id] as const,
  ) as Promise<{ rows: number; cols: number } | null>;

const visibleId = async (page: Page) =>
  (await terminal(page).getAttribute("data-terminal-id"))!;

/** Emit raw PTY bytes (escape sequences included) on a channel. */
const raw = (page: Page, key: string, text: string) =>
  pty(page, key, {
    type: "output",
    chunk: Buffer.from(text, "utf8").toString("base64"),
  });

/** Every `send_*` call, as "cmd:target:data" — who got which keystroke. */
const sent = (page: Page) =>
  page.evaluate(() =>
    (((window as any).__E2E__?.calls ?? []) as { cmd: string; args: any }[])
      .filter((c) => String(c.cmd).startsWith("send_"))
      .map(
        (c) =>
          `${c.cmd}:${c.args?.sessionId ?? c.args?.taskId ?? "?"}:${c.args?.data}`,
      ),
  );

/**
 * Per-terminal-row fingerprint of the LIVE canvas, plus how many pixels in
 * each row differ from the terminal's background.
 *
 * The background is taken as the canvas's modal colour rather than a corner
 * pixel: the cursor sits at 0,0 on a fresh terminal, so a corner sample
 * reports the cursor colour and every background pixel then counts as ink.
 * The rightmost strip is skipped — that is ghostty-web's overlay scrollbar,
 * which fades on its own schedule and is not part of the grid.
 */
async function canvasRows(
  page: Page,
  id: string,
): Promise<{ hash: number; ink: number }[]> {
  return page.evaluate(
    ([bridgeKey, id]) => {
      const bridge = (window as any)[bridgeKey as string];
      const host = document.querySelector(
        `[data-terminal-id="${id}"]`,
      ) as HTMLElement | null;
      const canvas = host?.querySelector("canvas") as HTMLCanvasElement | null;
      const g = bridge?.grid(id);
      if (!canvas || !g) return [];
      const ctx = canvas.getContext("2d");
      if (!ctx) return [];
      const cssW = parseFloat(canvas.style.width || `${canvas.width}`);
      const dpr = cssW > 0 ? canvas.width / cssW : 1;
      const stopX = Math.max(1, Math.floor(canvas.width - 20 * dpr));
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;

      const counts = new Map<number, number>();
      for (let i = 0; i < data.length; i += 4 * 37) {
        const key = (data[i]! << 16) | (data[i + 1]! << 8) | data[i + 2]!;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      let bg = 0;
      let best = -1;
      for (const [key, n] of counts) if (n > best) ((best = n), (bg = key));
      const br = (bg >> 16) & 255;
      const bgG = (bg >> 8) & 255;
      const bb = bg & 255;

      const rowH = canvas.height / g.rows;
      const out: { hash: number; ink: number }[] = [];
      for (let r = 0; r < g.rows; r++) {
        let hash = 0;
        let ink = 0;
        for (let y = Math.floor(r * rowH); y < Math.floor((r + 1) * rowH); y++) {
          const base = y * canvas.width * 4;
          for (let x = 0; x < stopX; x++) {
            const i = base + x * 4;
            const rr = data[i]!;
            const gg = data[i + 1]!;
            const bbb = data[i + 2]!;
            hash = (Math.imul(hash, 16777619) ^ (rr + gg * 3 + bbb * 7)) | 0;
            if (Math.abs(rr - br) + Math.abs(gg - bgG) + Math.abs(bbb - bb) > 24)
              ink++;
          }
        }
        out.push({ hash, ink });
      }
      return out;
    },
    [BRIDGE, id] as const,
  );
}

const forceRepaint = (page: Page, id: string) =>
  page.evaluate(
    ([k, id]) => (window as any)[k as string].repaint(id),
    [BRIDGE, id] as const,
  );

/**
 * Rows whose live pixels differ from what a forced full redraw paints —
 * i.e. rows the incremental render loop left stale. Empty is the only
 * acceptable answer.
 */
async function staleRows(page: Page, id: string): Promise<number[]> {
  const before = await canvasRows(page, id);
  await forceRepaint(page, id);
  await page.waitForTimeout(150);
  const after = await canvasRows(page, id);
  const stale: number[] = [];
  for (let i = 0; i < before.length; i++)
    if (before[i]!.hash !== after[i]!.hash) stale.push(i);
  return stale;
}

/**
 * Console output that is phasr's fault.
 *
 * The dev page talks to third-party origins (Clerk, Sentry) that are not
 * reachable from a test run, and the BROWSER — not the app — logs those as
 * console errors ("Failed to load resource: … 429", "blocked by CORS
 * policy"). Those are environment, and letting them fail a terminal spec
 * would train everyone to ignore this assertion. Everything else still
 * fails the test, `PAGEERROR:` (an uncaught throw, e.g. inside an effect —
 * invisible to every other assertion here) included.
 */
const appErrors = (errors: string[]) =>
  errors.filter(
    (e) =>
      !/^Failed to load resource:/.test(e) && !/blocked by CORS policy/.test(e),
  );

/** Fixtures with a steady cursor — a blinking one is not a stale row. */
function steadyFixtures() {
  const fx = makeFixtures();
  (fx as unknown as { userSettings: { cursorBlink: boolean } }).userSettings.cursorBlink =
    false;
  return fx;
}

async function bootWorkspace(page: Page) {
  const boot = await bootApp(page, steadyFixtures());
  await expect(page).toHaveURL(/workspaces\/ws-agent/, { timeout: 25_000 });
  await expectBackend(page);
  await waitForCall(page, "open_task_terminal", 15_000);
  await page.waitForTimeout(1200);
  return boot;
}

/** ⌘T. Returns the id of the terminal it opened. */
async function openTerminal(page: Page, settleMs = 1200): Promise<string> {
  const before = await liveIds(page);
  await page.keyboard.press("Meta+t");
  await expect
    .poll(async () => (await liveIds(page)).length, { timeout: 15_000 })
    .toBeGreaterThan(before.length);
  await page.waitForTimeout(settleMs);
  return visibleId(page);
}

test("a terminal reaches its PTY at the real grid, never the 24x80 fallback", async ({
  page,
}) => {
  const { errors } = await bootWorkspace(page);

  // The agent terminal, opened at boot — the case the engine really is
  // still loading for, and the one an agent TUI reads its size from.
  const agentId = await visibleId(page);
  const agentGrid = (await grid(page, agentId))!;
  const open = (await calls(page)).filter(
    (c) => c.cmd === "open_task_terminal",
  );
  expect(open.length).toBeGreaterThanOrEqual(1);
  console.log(
    `open_task_terminal ${open[0]!.args.rows}x${open[0]!.args.cols} vs settled grid ${JSON.stringify(agentGrid)}`,
  );
  // Width is exact. Height is asserted loosely on purpose: the workspace
  // pane's height settles a row or two after the terminal mounts (which is
  // what the trailing refits in the components exist for), so the first
  // measurement can legitimately be a row off the final one. What must
  // never happen is the 24x80 fallback, which is not a measurement at all.
  expect(open[0]!.args.cols).toBe(agentGrid.cols);
  expect(open[0]!.args.cols).not.toBe(80);
  expect(open[0]!.args.rows).not.toBe(24);
  expect(Math.abs(open[0]!.args.rows - agentGrid.rows)).toBeLessThanOrEqual(3);

  // ...and every ⌘T terminal after it.
  for (let i = 0; i < 3; i++) {
    await clearCalls(page);
    const id = await openTerminal(page);
    const g = (await grid(page, id))!;
    const starts = (await calls(page)).filter(
      (c) => c.cmd === "start_session_terminal",
    );
    expect(starts).toHaveLength(1);
    console.log(
      `start_session_terminal #${i + 1} ${JSON.stringify(starts[0]!.args.rows)}x${JSON.stringify(starts[0]!.args.cols)} vs grid ${JSON.stringify(g)}`,
    );
    expect({ rows: starts[0]!.args.rows, cols: starts[0]!.args.cols }).toEqual(g);
    // Belt and braces: the fallback is 24x80, and a real workspace pane in
    // this viewport is neither.
    expect(starts[0]!.args.cols).not.toBe(80);
  }

  expect(appErrors(errors)).toEqual([]);
});

test("several terminals opened in succession each render, and keystrokes reach the right PTY", async ({
  page,
}) => {
  const { errors } = await bootWorkspace(page);
  const agentId = await visibleId(page);

  // Three in a row with no pause between the presses — the case where one
  // surface is mid-attach while the next is being constructed.
  await page.keyboard.press("Meta+t");
  await page.keyboard.press("Meta+t");
  await page.keyboard.press("Meta+t");
  await expect
    .poll(async () => (await liveIds(page)).length, { timeout: 20_000 })
    .toBe(4);
  await page.waitForTimeout(2000);

  const ids = await liveIds(page);
  expect(new Set(ids).size).toBe(4);
  expect(ids[0]).toBe(agentId);

  // One shell PTY per terminal — not one id shared by all of them, and not
  // a terminal that never started.
  const sessions: string[] = await page.evaluate(() =>
    (window as any).__E2E__
      .channelKeys()
      .filter((k: string) => k.startsWith("session-")),
  );
  expect(sessions).toHaveLength(3);

  // Something distinct on each screen, so "it renders" is about content.
  for (let i = 0; i < sessions.length; i++) {
    await raw(page, sessions[i]!, `MARK-${i}-hello\r\n`);
  }
  await page.waitForTimeout(600);

  const tabs = page.getByRole("tab");
  await expect(tabs).toHaveCount(4);

  for (let i = 0; i < 4; i++) {
    await tabs.nth(i).click();
    await page.waitForTimeout(700);

    const id = await visibleId(page);
    expect(id).toBe(ids[i]);

    const g = (await grid(page, id))!;
    expect(g.cols).toBeGreaterThan(20);
    expect(g.rows).toBeGreaterThan(5);

    if (i > 0) {
      // Composited pixels: the marker's row has ink. A blank or frozen
      // terminal is the symptom no DOM assertion can see.
      const rows = await canvasRows(page, id);
      const inked = rows.filter((r) => r.ink > 0).length;
      console.log(`tab ${i} (${id}) inked rows: ${inked}`);
      expect(inked).toBeGreaterThan(0);
      expect(
        await page.evaluate(
          ([k, id]) => (window as any)[k as string].lineText(id, 0),
          [BRIDGE, id] as const,
        ),
      ).toContain(`MARK-${i - 1}-hello`);
    }

    // Nothing the incremental renderer failed to repaint.
    expect(await staleRows(page, id)).toEqual([]);

    // Typing goes to THIS terminal's PTY and to no other.
    await clearCalls(page);
    await page.keyboard.type("z");
    await page.waitForTimeout(400);
    const bytes = await sent(page);
    console.log(`tab ${i} typed -> ${JSON.stringify(bytes)}`);
    const expected =
      i === 0 ? "send_input_to_task:ws-agent:z" : `send_session_input:${sessions[i - 1]}:z`;
    expect(bytes).toEqual([expected]);
  }

  expect(appErrors(errors)).toEqual([]);
});

test("the screen matches the buffer when an agent takes over a freshly opened terminal", async ({
  page,
}) => {
  const { errors } = await bootWorkspace(page);
  const id = await openTerminal(page);
  const sessions: string[] = await page.evaluate(() =>
    (window as any).__E2E__
      .channelKeys()
      .filter((k: string) => k.startsWith("session-")),
  );
  const key = sessions.at(-1)!;

  // The oracle has to be able to fail. Scribble over the canvas and confirm
  // the forced repaint disagrees — otherwise "no stale rows" below would be
  // vacuous.
  await page.evaluate(
    ([id]) => {
      const canvas = document
        .querySelector(`[data-terminal-id="${id}"]`)
        ?.querySelector("canvas") as HTMLCanvasElement;
      const ctx = canvas.getContext("2d")!;
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = "#ff00ff";
      ctx.fillRect(0, 0, canvas.width, Math.floor(canvas.height / 10));
      ctx.restore();
    },
    [id] as const,
  );
  const control = await staleRows(page, id);
  console.log(`oracle positive control flagged rows: ${control.length}`);
  expect(control.length).toBeGreaterThan(0);

  // Now the real thing: shell output, then a TUI takeover bracketed in DEC
  // 2026 (synchronized output) and split across PTY reads, so render frames
  // land INSIDE the sync block and the render loop skips them.
  await raw(page, key, "phasr % claude --dangerously-skip-permissions\r\n");
  await raw(page, key, "shell noise one\r\nshell noise two\r\n");
  await page.waitForTimeout(250);

  await raw(page, key, "\x1b[?2026h");
  await page.waitForTimeout(50);
  await raw(page, key, "\x1b[?1049h");
  await page.waitForTimeout(50);
  await raw(page, key, "\x1b[H\x1b[2J");
  await page.waitForTimeout(50);
  await raw(
    page,
    key,
    "\x1b[1;1H WELCOME-0 ▐▛███▜▌\r\n" +
      " WELCOME-1 second line of the box\r\n" +
      " WELCOME-2 third line of the box\r\n",
  );
  await page.waitForTimeout(50);
  await raw(page, key, "\x1b[5;1H HELLO-4 what can I help with?");
  await page.waitForTimeout(50);
  await raw(page, key, "\x1b[?2026l");
  await page.waitForTimeout(900);

  const lines = await page.evaluate(
    ([k, id]) => {
      const b = (window as any)[k as string];
      return [0, 1, 2, 4].map((r) => b.lineText(id, r) ?? "");
    },
    [BRIDGE, id] as const,
  );
  console.log(`buffer: ${JSON.stringify(lines)}`);
  expect(lines[0]).toContain("WELCOME-0");
  expect(lines[3]).toContain("HELLO-4");
  // No trace of the pre-TUI screen — the takeover cleared it.
  expect(lines.join("")).not.toContain("claude --dangerously");

  expect(await staleRows(page, id)).toEqual([]);
  expect(appErrors(errors)).toEqual([]);
});
