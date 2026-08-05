import { test, expect, type Page } from "@playwright/test";
import { bootApp, makeFixtures, pty } from "./harness";

// Exactly how Claude Code prints a link: OSC 8 ; ; <url> BEL <text> OSC 8 ; ; BEL
const URL = "https://en.wikipedia.org/wiki/Special:Random";
const OSC = "]8;;";
const BEL = "";
const CHUNK = `Here you go: ${OSC}${URL}${BEL}${URL}${OSC}${BEL} - random\r\n`;

async function setup(page: Page) {
  await bootApp(page, makeFixtures());
  await expect(page).toHaveURL(/workspaces\/ws-agent/, { timeout: 25_000 });
  await page.waitForTimeout(1000);
  await page.evaluate(() => {
    (window as any).__seen = [];
    const orig = (window as any).__TAURI_INTERNALS__.invoke;
    (window as any).__TAURI_INTERNALS__.invoke = (c: string, a: any, o: any) => {
      (window as any).__seen.push({ cmd: c, args: a });
      return orig(c, a, o);
    };
  });
  await pty(page, "ws-agent", { type: "output", chunk: CHUNK });
  await page.waitForTimeout(500);
}

function pointAt(page: Page, col: number) {
  return page.evaluate((col) => {
    const el = document.querySelector(".xterm-screen") as HTMLElement;
    const r = el.getBoundingClientRect();
    return {
      x: r.left + (r.width / 88) * (col + 0.5),
      y: r.top + (r.height / 41) * 0.5,
    };
  }, col);
}

const openerCalls = (page: Page) =>
  page.evaluate(
    () =>
      ((window as any).__seen as { cmd: string; args: any }[]).filter((c) =>
        /opener/.test(c.cmd),
      ),
  );

test("OSC 8 hyperlink opens on cmd+click", async ({ page }) => {
  await setup(page);
  const p = await pointAt(page, 20); // inside the rendered link text
  await page.keyboard.down("Meta");
  await page.mouse.move(p.x, p.y);
  await page.waitForTimeout(200);
  await page.mouse.click(p.x, p.y);
  await page.keyboard.up("Meta");
  await page.waitForTimeout(500);
  const calls = await openerCalls(page);
  console.log("OSC8 SEEN:", JSON.stringify(calls));
  expect(calls.length).toBe(1);
  expect(calls[0]!.args.url).toBe(URL);
});

test("OSC 8 plain click does nothing", async ({ page }) => {
  await setup(page);
  const p = await pointAt(page, 20);
  await page.mouse.click(p.x, p.y);
  await page.waitForTimeout(400);
  const calls = await openerCalls(page);
  console.log("PLAIN SEEN:", JSON.stringify(calls));
  expect(calls.length).toBe(0);
});
