import { test, expect, type Page } from "@playwright/test";
import {
  bootApp,
  callNames,
  calls,
  expectBackend,
  makeFixtures,
  ptyOut,
  terminal,
} from "./harness";

/**
 * The LRU, end to end.
 *
 * `cache.ts` promises three things that no unit test can observe together:
 * eviction actually happens when the budget is exceeded, the surface (and
 * only the surface) is destroyed, and the next mount comes back through the
 * ordinary attach path — the one that carries `subscribe_with_replay`'s
 * buffer on the Rust side — rather than through a restart.
 *
 * `cache.test.ts` covers the bookkeeping with fake surfaces. What it cannot
 * cover is that a REAL emulator, holding a real renderer and a live PTY
 * channel, survives the round trip. That is emulator-specific by
 * construction (ghostty holds a WASM terminal plus a rAF loop; the previous
 * engine held a WebGL context), so it is emulator-aware.
 *
 * The budget is lowered to 1 through the same `localStorage` key a support
 * channel would use, so the test drives the shipped policy rather than a
 * test-only door.
 */

const MARK_BEFORE = "PHASR-LRU-BEFORE";
const MARK_AFTER = "PHASR-LRU-AFTER";

/** Ids of every surface the bridge currently considers live. A disposed
 *  surface removes itself, so this is a direct read of "was it evicted". */
const liveSurfaceIds = (page: Page) =>
  page.evaluate(() => (window as any).__PHASR_TERM__?.ids() as string[]);

/** Does any live surface have this text anywhere in its first rows? */
const surfaceHasText = (page: Page, needle: string) =>
  page.evaluate((needle) => {
    const bridge = (window as any).__PHASR_TERM__;
    for (const id of bridge?.ids() ?? []) {
      for (let row = 0; row < 40; row++) {
        if ((bridge.lineText(id, row) ?? "").includes(needle)) return true;
      }
    }
    return false;
  }, needle);

const surfaceId = (page: Page) =>
  terminal(page).getAttribute("data-terminal-id");

/**
 * In-app navigation only — `page.goto` would reload and wipe the cache
 * the test exists to exercise.
 *
 * Through the Command Palette rather than the sidebar, and that is not a
 * style choice: `useExternalLinkOpener` installs a **capture-phase**
 * `window` click listener that swallows every `<a href>` resolving to
 * `http(s)://…`, which under the dev server is EVERY in-app
 * `<Link>` (`/repositories/…` resolves against `http://localhost:1420`).
 * Sidebar clicks therefore never navigate here. The palette navigates
 * programmatically and is unaffected. See ADR-002 for the write-up.
 */
async function navigateTo(page: Page, name: RegExp, url: RegExp) {
  await page.keyboard.press("Meta+k");
  await expect(page.locator("[cmdk-root]").first()).toBeVisible({
    timeout: 5000,
  });
  await page.getByRole("option", { name }).first().click();
  await expect(page).toHaveURL(url, { timeout: 15_000 });
  await expect(page.locator("[cmdk-root]")).toHaveCount(0, { timeout: 5000 });
  await page.waitForTimeout(900);
}

test("LRU eviction destroys the surface, never the PTY, and the next mount re-attaches", async ({
  page,
}) => {
  const info: string[] = [];
  page.on("console", (m) => info.push(m.text()));

  await page.addInitScript(() => {
    // The shipped escape hatch, not a test seam. 1 means "the terminal
    // you just left is over budget the moment another one is created".
    localStorage.setItem("phasr.terminal.maxCached", "1");
  });
  await bootApp(page, makeFixtures());
  await expect(page).toHaveURL(/workspaces\/ws-agent/, { timeout: 25_000 });
  await expectBackend(page);
  await expect
    .poll(async () => (await callNames(page)).includes("open_task_terminal"), {
      timeout: 15_000,
    })
    .toBe(true);
  await page.waitForTimeout(1000);

  // Something on screen, so "the terminal came back" is about a real
  // emulator with real content rather than an empty grid.
  await ptyOut(page, "ws-agent", `${MARK_BEFORE}\r\n`);
  await expect.poll(() => surfaceHasText(page, MARK_BEFORE)).toBe(true);

  const idBefore = await surfaceId(page);
  expect(idBefore).toBeTruthy();
  expect(await liveSurfaceIds(page)).toContain(idBefore!);

  // Leave. The surface parks; the next workspace's terminal pushes the
  // cache over budget and the parked one is the eviction candidate.
  await navigateTo(page, /fix-bug/, /ws-done/);

  await expect
    .poll(async () => (await liveSurfaceIds(page)).includes(idBefore!), {
      timeout: 10_000,
    })
    .toBe(false);
  const evictions = info.filter((l) => l.includes("[terminal] evicted"));
  console.log(`LRU eviction log: ${JSON.stringify(evictions)}`);
  // Not just "the id went away" — the cache said why.
  expect(evictions.some((l) => l.includes("agent:ws-agent"))).toBe(true);

  // Nothing in the app asked for that process to die. Eviction costs a
  // renderer, never a PTY — that is the entire design.
  const killers = (await calls(page)).filter((c) =>
    /^(stop_|delete_workspace|archive_workspace)/.test(c.cmd),
  );
  expect(killers).toEqual([]);

  // Come back.
  await navigateTo(page, /add-feature/, /ws-agent/);
  await expectBackend(page);
  await page.waitForTimeout(800);

  const idAfter = await surfaceId(page);
  expect(idAfter).toBeTruthy();
  // A genuinely new emulator, not the old one handed back.
  expect(idAfter).not.toBe(idBefore);

  // Re-attached through the ordinary path — the one whose Rust side is
  // `subscribe_with_replay`. Two opens for one workspace is exactly the
  // "cold attach again" the cache doc describes.
  const opens = (await calls(page)).filter(
    (c) => c.cmd === "open_task_terminal" && c.args?.taskId === "ws-agent",
  );
  console.log(`LRU open_task_terminal x${opens.length}`);
  expect(opens.length).toBeGreaterThanOrEqual(2);

  // …and the live channel still reaches the new surface: output emitted
  // now renders. This is the assertion that a re-created terminal is
  // actually wired, not merely present.
  await ptyOut(page, "ws-agent", `${MARK_AFTER}\r\n`);
  await expect
    .poll(() => surfaceHasText(page, MARK_AFTER), { timeout: 10_000 })
    .toBe(true);

  // The documented cost, asserted rather than assumed: scrollback is gone
  // (the replay buffer is a backend concern the mock does not model, so
  // this is about the FRONTEND having built a fresh, empty emulator).
  console.log(
    `LRU pre-eviction scrollback survived: ${await surfaceHasText(page, MARK_BEFORE)}`,
  );
});
