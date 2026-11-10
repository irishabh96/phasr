import { test, expect, type Page } from "@playwright/test";
import { bootApp, expectBackend, makeFixtures, pty, terminal, waitForCall } from "./harness";

/**
 * A new terminal must never show an old one's output.
 *
 * Ghostty's page code assumes freshly allocated pages are zeroed; WASM's
 * allocator recycles a freed grid's pages with their bytes intact. When all
 * grids shared one instance, closing a terminal and opening another showed
 * the closed one's text (a deleted task's `claude --settings …` line, in the
 * reported recording) and rows of pointer bytes drawn as glyphs, and
 * writing emoji into recycled pages trapped out of bounds. Every grid now
 * gets its own instance (`backends/ghostty/engine.ts`).
 */

const BRIDGE = "__PHASR_TERM__";

const liveIds = (page: Page) =>
  page.evaluate((k) => (window as any)[k]?.ids() ?? [], BRIDGE) as Promise<string[]>;

const visibleId = async (page: Page) => (await terminal(page).getAttribute("data-terminal-id"))!;

const raw = (page: Page, key: string, text: string) =>
  pty(page, key, { type: "output", chunk: Buffer.from(text, "utf8").toString("base64") });

const screenText = (page: Page, id: string) =>
  page.evaluate(
    ([k, id]) => {
      const bridge = (window as any)[k as string];
      const g = bridge.grid(id);
      const rows: string[] = [];
      for (let r = 0; r < (g?.rows ?? 0); r++) rows.push(bridge.lineText(id, r) ?? "");
      return rows;
    },
    [BRIDGE, id] as const,
  );

const sessionKeys = (page: Page) =>
  page.evaluate(() =>
    (window as any).__E2E__.channelKeys().filter((k: string) => k.startsWith("session-")),
  ) as Promise<string[]>;

/** Rows holding the old terminal's marker or non-BMP junk (pointer bytes). */
const leaked = (rows: string[]) =>
  rows.filter((r) => r.includes("SECRET") || /[\u{10000}-\u{10FFFF}]/u.test(r.replace(/\p{Extended_Pictographic}/gu, "")));

const appErrors = (errors: string[]) =>
  errors.filter((e) => !/^Failed to load resource:/.test(e) && !/blocked by CORS policy/.test(e));

async function openTerminal(page: Page): Promise<string> {
  const before = await liveIds(page);
  await page.keyboard.press("Meta+t");
  await expect.poll(async () => (await liveIds(page)).length, { timeout: 15_000 }).toBeGreaterThan(before.length);
  await page.waitForTimeout(800);
  return visibleId(page);
}

test("a terminal opened after another closed starts blank, and emoji output into it renders", async ({ page }) => {
  const fx = makeFixtures();
  (fx as unknown as { userSettings: { cursorBlink: boolean } }).userSettings.cursorBlink = false;
  const { errors } = await bootApp(page, fx);
  await expect(page).toHaveURL(/workspaces\/ws-agent/, { timeout: 25_000 });
  await expectBackend(page);
  await waitForCall(page, "open_task_terminal", 15_000);
  await page.waitForTimeout(1000);

  for (let round = 0; round < 3; round++) {
    // A terminal full of what agent TUIs print: colour, emoji ZWJ
    // sequences, combining marks, CJK, links.
    const firstId = await openTerminal(page);
    const key = (await sessionKeys(page)).at(-1)!;
    const lines: string[] = [];
    for (let i = 0; i < 400; i++)
      lines.push(
        `\x1b[3${i % 8}mSECRET-${round} ${i} 👨‍👩‍👧 é̂ 中文 \x1b]8;;https://x.y/${i}\x07link\x1b]8;;\x07\x1b[0m\r\n`,
      );
    await raw(page, key, lines.join(""));
    await page.waitForTimeout(300);
    expect((await screenText(page, firstId)).some((r) => r.includes(`SECRET-${round}`))).toBe(true);

    // Close it — the grid is freed.
    await page.keyboard.press("Meta+w");
    await expect.poll(async () => (await liveIds(page)).includes(firstId), { timeout: 10_000 }).toBe(false);

    // The next terminal: nothing of the last one, before AND after output.
    const nextId = await openTerminal(page);
    expect(leaked(await screenText(page, nextId))).toEqual([]);
    const nextKey = (await sessionKeys(page)).at(-1)!;
    await raw(page, nextKey, "hello 👍 é 中文\r\n$ ");
    await page.waitForTimeout(300);
    const after = await screenText(page, nextId);
    expect(after[0]).toMatch(/^hello 👍/);
    expect(leaked(after)).toEqual([]);
    await page.keyboard.press("Meta+w");
    await expect.poll(async () => (await liveIds(page)).includes(nextId), { timeout: 10_000 }).toBe(false);
  }

  // No trapped write anywhere (a trap logs and drops output).
  expect(appErrors(errors).filter((e) => /out of bounds|rebuild|trapped/i.test(e))).toEqual([]);
});
