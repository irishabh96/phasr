import { test, expect, type Page } from "@playwright/test";
import {
  bootApp,
  cellPoint,
  expectBackend,
  makeFixtures,
  ptyOut,
} from "./harness";

// Exactly how Claude Code prints a link: OSC 8 ; ; <url> BEL <text> OSC 8 ; ; BEL
const URL = "https://en.wikipedia.org/wiki/Special:Random";
const OSC = "\x1b]8;;";
const BEL = "\x07";
const PREFIX = "Here you go: ";
const CHUNK = `${PREFIX}${OSC}${URL}${BEL}${URL}${OSC}${BEL} - random\r\n`;

/**
 * Targets an agent can print that must NEVER reach the OS. OSC 8 lets the
 * program pick an arbitrary URI, and terminal output is whatever an agent
 * decided to write — so this is untrusted input by construction.
 *
 * This is not hypothetical for the ghostty backend: `ghostty-web@0.4.0`'s
 * own `OSC8LinkProvider` activates with a bare
 * `window.open(uri, "_blank", "noopener,noreferrer")` and no scheme check,
 * and `Terminal.open()` registers it for you with no opt-out. The backend
 * removes it and installs a hardened one; this test is what proves the
 * removal actually happened.
 */
const HOSTILE = [
  "javascript:alert(document.cookie)",
  "file:///etc/passwd",
];
const HOSTILE_PREFIX = "Click here: ";

async function setup(page: Page, chunk = CHUNK) {
  await bootApp(page, makeFixtures());
  await expect(page).toHaveURL(/workspaces\/ws-agent/, { timeout: 25_000 });
  await expectBackend(page);
  await page.waitForTimeout(1000);
  await page.evaluate(() => {
    (window as any).__seen = [];
    (window as any).__opened = [];
    const nativeOpen = window.open;
    // `window.open` is the exact call the stock ghostty-web provider makes.
    // Recording it (instead of only recording IPC) is what turns "no opener
    // invoke" into "nothing opened at all, by any route".
    window.open = ((...args: unknown[]) => {
      (window as any).__opened.push(args[0]);
      return null;
    }) as typeof window.open;
    void nativeOpen;
    const orig = (window as any).__TAURI_INTERNALS__.invoke;
    (window as any).__TAURI_INTERNALS__.invoke = (c: string, a: any, o: any) => {
      (window as any).__seen.push({ cmd: c, args: a });
      return orig(c, a, o);
    };
  });
  await ptyOut(page, "ws-agent", chunk);
  await page.waitForTimeout(500);
}

/**
 * A point inside the rendered link text. The chunk under test is the first
 * thing this terminal ever receives, so it lands on row 0, and the URL
 * starts right after the prefix — any column past that and before the
 * trailing text is inside the link.
 *
 * This used to divide the emulator's private screen element's box by a hardcoded
 * 88×41 grid, which only held at one viewport size and mis-clicked
 * silently at any other. The bridge asks the surface for the actual cell,
 * and `cellPoint` fails loudly if row 0 isn't the line we think it is.
 */
const pointAt = (page: Page, prefix = PREFIX) =>
  cellPoint(page, prefix.length + 8, 0, prefix);

const openerCalls = (page: Page) =>
  page.evaluate(
    () =>
      ((window as any).__seen as { cmd: string; args: any }[]).filter((c) =>
        /opener/.test(c.cmd),
      ),
  );

const windowOpens = (page: Page) =>
  page.evaluate(() => (window as any).__opened as unknown[]);

async function metaClick(page: Page, p: { x: number; y: number }) {
  await page.keyboard.down("Meta");
  await page.mouse.move(p.x, p.y);
  await page.waitForTimeout(200);
  await page.mouse.click(p.x, p.y);
  await page.keyboard.up("Meta");
  await page.waitForTimeout(500);
}

test.describe("terminal links", () => {
  test("OSC 8 hyperlink opens on cmd+click", async ({ page }) => {
    await setup(page);
    await metaClick(page, await pointAt(page));
    const calls = await openerCalls(page);
    console.log(`OSC8 SEEN:`, JSON.stringify(calls));
    expect(calls.length).toBe(1);
    expect(calls[0]!.args.url).toBe(URL);
    expect(await windowOpens(page)).toEqual([]);
  });

  test("OSC 8 plain click does nothing", async ({ page }) => {
    await setup(page);
    const p = await pointAt(page);
    await page.mouse.click(p.x, p.y);
    await page.waitForTimeout(400);
    const calls = await openerCalls(page);
    console.log(`PLAIN SEEN:`, JSON.stringify(calls));
    expect(calls.length).toBe(0);
    expect(await windowOpens(page)).toEqual([]);
  });

  /**
   * Plain text, no OSC 8 at all. `ghostty-web`'s `UrlRegexProvider` —
   * also registered by `Terminal.open()` with no opt-out — matches
   * `mailto:`, `ftp://`, `ssh://`, `git://`, `tel:`, `magnet:`,
   * `gemini://`, `gopher://` and `news:` and hands each straight to
   * `window.open`. phasr's `isOpenableUrl` allows http(s) only, and it
   * never even sees these because its own detector doesn't match them —
   * so nothing but removing that provider stops them.
   *
   * This is the case that makes `unregisterBuiltinLinkProviders` load
   * bearing rather than belt-and-braces: for OSC 8, ours happens to win
   * because `LinkDetector.cacheLink` keys by hyperlink id and the last
   * provider registered overwrites. There is no such collision here.
   */
  for (const scheme of ["ftp://evil.example/x", "mailto:a@b.c"]) {
    test(`plain-text ${scheme.split(":")[0]}: URL is not openable`, async ({
      page,
    }) => {
      await setup(page, `${HOSTILE_PREFIX}${scheme} end\r\n`);
      await metaClick(page, await pointAt(page, HOSTILE_PREFIX));
      const calls = await openerCalls(page);
      const opened = await windowOpens(page);
      console.log(
        `PLAINTEXT ${scheme}: opener=${JSON.stringify(calls)} window.open=${JSON.stringify(opened)}`,
      );
      expect(calls).toEqual([]);
      expect(opened).toEqual([]);
    });
  }

  for (const hostile of HOSTILE) {
    const scheme = hostile.split(":")[0];
    test(`OSC 8 ${scheme}: target is refused even with cmd held`, async ({
      page,
    }) => {
      const label = `${scheme}-link-text-here`;
      await setup(
        page,
        `${HOSTILE_PREFIX}${OSC}${hostile}${BEL}${label}${OSC}${BEL} end\r\n`,
      );
      await metaClick(page, await pointAt(page, HOSTILE_PREFIX));

      const calls = await openerCalls(page);
      const opened = await windowOpens(page);
      console.log(
        `HOSTILE ${scheme}: opener=${JSON.stringify(calls)} window.open=${JSON.stringify(opened)}`,
      );
      // Zero invokes on BOTH routes: the Tauri opener plugin and the
      // webview's own `window.open`.
      expect(calls).toEqual([]);
      expect(opened).toEqual([]);
    });
  }
});
