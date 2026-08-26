import { expect, test, type Page } from "@playwright/test";
import {
  bootApp,
  expectBackend,
  makeFixtures,
  ptyOut,
  terminal,
  waitForCall,
} from "./harness";

/**
 * A changed `terminalScrollback` applies to LIVE terminals.
 *
 * ghostty-web ignores a post-`open()` scrollback write (`handleOptionChange`
 * has no case for it), so the surface applies the value the only way the
 * engine honours it: a same-width grid rebuild, which constructs a fresh
 * terminal through `buildWasmConfig()` — the one place the limit is read —
 * and carries the buffer over, truncated to the new limit.
 *
 * The engine's `scrollbackLimit` is a budget in BYTES with page-granular
 * eviction (`scrollbackBytes` feeds it correctly now), so a 60-LINE
 * setting cannot be delegated to it — 60 lines' worth of bytes floors to
 * the allocator's minimum pages, ~1,100 rows. The line limit asserted
 * here is phasr's own enforcement, at snapshot time during the rebuild.
 *
 * Driven through the REAL settings pipeline: the ⌘+ font-size chord fires
 * `update_user_settings`, whose mocked response is overridden to also carry
 * a smaller `terminalScrollback`; the mutation's `onSuccess` puts that row
 * in the query cache, the settings effect calls `applySettings`, and the
 * diff (`options.ts`) reports the scrollback write.
 */
const BRIDGE = "__PHASR_TERM__";

const sb = (page: Page) =>
  page.evaluate((k) => {
    const bridge = (window as any)[k];
    const host = [
      ...document.querySelectorAll("[data-testid='terminal-surface']"),
    ].find((el) => (el as HTMLElement).offsetParent !== null) as HTMLElement;
    const id = host.getAttribute("data-terminal-id")!;
    return bridge.viewport(id).scrollback as number;
  }, BRIDGE);

const rebuilds = (page: Page) =>
  page.evaluate(
    () => performance.getEntriesByName("phasr:terminal-rebuild").length,
  );

test("shrinking terminalScrollback truncates a live terminal's history", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (/\[terminal\].*(failed|trapped|gave up)/.test(m.text()))
      errors.push(m.text());
  });

  const boot = await bootApp(page);
  await expectBackend(page);
  await terminal(page).click();

  const lines: string[] = [];
  for (let i = 0; i < 300; i++) lines.push(`line ${i}`);
  await ptyOut(page, "ws-agent", lines.join("\r\n") + "\r\n");
  await page.waitForTimeout(400);

  const before = await sb(page);
  expect(before, "history accumulated at the fixture limit").toBeGreaterThan(200);
  const rebuildsBefore = await rebuilds(page);

  // The mocked settings echo, now carrying a smaller scrollback. The next
  // update_user_settings response returns it; onSuccess seeds the cache.
  const echoed = {
    ...makeFixtures().userSettings,
    baseFontSize: 14,
    terminalScrollback: 60,
  };
  await page.evaluate(
    (settings) => (window as any).__E2E__.setResponse("update_user_settings", settings),
    echoed,
  );
  await page.keyboard.press("Meta+=");
  await waitForCall(page, "update_user_settings");

  // Settle window (120 ms) + rebuild + margin.
  await expect
    .poll(async () => rebuilds(page), { timeout: 5_000 })
    .toBeGreaterThan(rebuildsBefore);
  const after = await sb(page);
  expect(after, "history truncated to the new limit").toBeLessThanOrEqual(60);
  expect(after, "the retained tail survived").toBeGreaterThan(20);
  expect(errors).toEqual([]);
  void boot;
});
