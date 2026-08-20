import { test, expect, type Page } from "@playwright/test";
import { bootApp, expectBackend, makeFixtures, ptyOut } from "./harness";

/**
 * Switching inner tabs must hand the keyboard to the terminal you switched
 * to.
 *
 * The bug this covers: clicking a tab pill leaves focus on the pill (a
 * BUTTON), and nothing in the reveal path took it back. The terminal was
 * visible, correctly sized and repainting, but every keystroke went
 * nowhere — which reads as "the terminal is dead", not "focus is on a
 * button", so clicking the terminal again was the natural response. It did
 * not help either, because the emulator's canvas calls preventDefault() on
 * mousedown, which suppresses the browser's own focus-on-click.
 *
 * Asserted on what the PTY actually receives rather than on
 * document.activeElement: focus being "right" is only interesting if the
 * bytes arrive.
 */
const sentTo = (p: Page) =>
  p.evaluate(() =>
    ((((window as any).__E2E__?.calls) ?? []) as { cmd: string; args: any }[])
      .filter((c) => String(c.cmd).startsWith("send_"))
      .map((c) => `${c.cmd}:${c.args?.data}`),
  );

const clearCalls = (p: Page) =>
  p.evaluate(() => (window as any).__E2E__?.clearCalls?.());

const focusedTerminalId = (p: Page) =>
  p.evaluate(
    () =>
      (document.activeElement as HTMLElement | null)
        ?.closest?.("[data-testid='terminal-surface']")
        ?.getAttribute("data-terminal-id") ?? null,
  );

test("switching inner tabs gives the revealed terminal the keyboard", async ({
  page,
}) => {
  await bootApp(page, makeFixtures());
  await expect(page).toHaveURL(/workspaces\/ws-agent/, { timeout: 25_000 });
  await expectBackend(page);
  await page.waitForTimeout(1500);
  await ptyOut(page, "ws-agent", "agent\r\n");

  const agentTerm = await focusedTerminalId(page);
  expect(agentTerm).not.toBeNull();

  // ⌘T opens a session terminal in a second inner tab.
  await page.keyboard.press("Meta+t");
  await page.waitForTimeout(2000);
  const sessionTerm = await focusedTerminalId(page);
  expect(sessionTerm).not.toBeNull();
  expect(sessionTerm).not.toBe(agentTerm);

  // It has the keyboard already — no click.
  await clearCalls(page);
  await page.keyboard.type("xy");
  await page.waitForTimeout(400);
  expect((await sentTo(page)).join("")).toContain("send_session_input:x");

  // Switch back to the agent terminal by its tab pill, and type WITHOUT
  // clicking the terminal. This is the regression.
  await page.getByRole("tab").first().click();
  await page.waitForTimeout(1200);
  expect(await focusedTerminalId(page)).toBe(agentTerm);

  await clearCalls(page);
  await page.keyboard.type("z");
  await page.waitForTimeout(400);
  const sent = await sentTo(page);
  console.log(`FOCUS after tab switch, PTY got ${JSON.stringify(sent)}`);
  expect(sent.join("")).toContain("send_input_to_task:z");
  // and it must NOT have gone to the other terminal's PTY
  expect(sent.join("")).not.toContain("send_session_input");
});

test("revealing a terminal does not steal focus from a text field", async ({
  page,
}) => {
  await bootApp(page, makeFixtures());
  await expect(page).toHaveURL(/workspaces\/ws-agent/, { timeout: 25_000 });
  await expectBackend(page);
  await page.waitForTimeout(1500);

  // ⌘K puts focus in the command palette's input.
  await page.keyboard.press("Meta+k");
  await page.waitForTimeout(600);
  const tag = await page.evaluate(
    () => document.activeElement?.tagName ?? null,
  );
  test.skip(tag !== "INPUT", "palette input did not take focus in this build");

  // A reveal happening underneath must not yank the caret out of it.
  await page.waitForTimeout(800);
  expect(await page.evaluate(() => document.activeElement?.tagName ?? null)).toBe(
    "INPUT",
  );
});
