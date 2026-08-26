import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { bootApp, expectBackend, ptyBurst, terminal } from "./harness";

/**
 * The aged-terminal rebuild, end to end — ADR-002's seventh pass.
 *
 * Every earlier reflow fixture was CLEAN: linear text, one screen, a fresh
 * surface. The field failures all came from the opposite — a days-old
 * terminal whose grid carries real zsh prompts (absolute positioning, the
 * PROMPT_EOL_MARK `%`), TUI frames, hundreds of styled runs — and they
 * came in three layers, each of which this spec would have caught:
 *
 *  1. Raw-byte replay re-parsed history at a width it was not written
 *     for: stranded `%` rows multiplied and content scattered (the
 *     recordings of Aug 21–25).
 *  2. The engine traps (`memory access out of bounds`) when styled or
 *     grapheme-bearing content is written into a grid created on pages
 *     recycled from an earlier free. The rebuild now creates the
 *     replacement BEFORE freeing the old grid, erases scrollback before
 *     the free, and quarantines any grid that still traps
 *     (`quarantinedGrids` in backends/ghostty.ts).
 *  3. A failed rebuild used to fall back to the live reflow — the drift —
 *     or snapshot the damaged grid (one 22-second rebuild, history gone).
 *     Now it rolls back to the intact old grid and retries.
 *
 * The oracles are user-facing: no console errors, content pinned to the
 * top, scrollback CONSERVED across width round trips, every rebuild fast.
 */

test.setTimeout(240_000);

const AGED = readFileSync(
  fileURLToPath(new URL("./fixtures/aged-shell-session.vt", import.meta.url)),
  "utf8",
);
const BRIDGE = "__PHASR_TERM__";

/** History accumulates the way a four-day-old terminal's does. */
const AGED_KEEP_HISTORY = AGED.replace(/\x1b\[3J/g, "");

/** Up to ~140 distinct SGR styles — hard, but under the engine's live-write ceiling. */
function loudLines(n: number): string {
  const out: string[] = [];
  for (let i = 0; i < n; i++)
    out.push(
      `\x1b[38;5;${i % 220};48;5;${(i * 7) % 12}m${String(i).padStart(4, "0")}\x1b[0m ` +
        "abcdefghij".repeat(6 + (i % 9)),
    );
  return out.join("\r\n") + "\r\n";
}

async function feed(page: Page, text: string) {
  const parts: string[] = [];
  for (let o = 0; o < text.length; o += 8192) parts.push(text.slice(o, o + 8192));
  await ptyBurst(page, "ws-agent", parts);
  await page.waitForTimeout(60);
}

interface Snap {
  cols: number;
  readable: boolean;
  scrollback: number;
  slack: number;
  top: number;
  pctRows: number;
  rebuilds: number[];
}

async function snap(page: Page): Promise<Snap> {
  return page.evaluate((bridgeKey) => {
    const bridge = (window as any)[bridgeKey];
    const host = [
      ...document.querySelectorAll("[data-testid='terminal-surface']"),
    ].find((el) => (el as HTMLElement).offsetParent !== null) as HTMLElement;
    const id = host.getAttribute("data-terminal-id")!;
    const grid = bridge.grid(id);
    let readable = true;
    let vp = { offset: 0, scrollback: 0 };
    try {
      vp = bridge.viewport(id);
    } catch {
      readable = false;
    }
    const screen: string[] = [];
    try {
      for (let r = 0; r < grid.rows; r++)
        screen.push(bridge.lineText(id, vp.scrollback + r) ?? "");
    } catch {
      readable = false;
    }
    const canvas = host.querySelector("canvas") as HTMLCanvasElement;
    const surfaceEl = canvas.parentElement as HTMLElement;
    const style = getComputedStyle(surfaceEl);
    const px = (v: string) => Number.parseInt(style.getPropertyValue(v)) || 0;
    const available =
      surfaceEl.clientWidth - px("padding-left") - px("padding-right") - 15;
    let pctRows = 0;
    try {
      for (let r = 0; r < vp.scrollback + grid.rows; r++)
        if ((bridge.lineText(id, r) ?? "").trim() === "%") pctRows++;
    } catch {
      pctRows = -1;
    }
    return {
      cols: grid.cols,
      readable,
      scrollback: vp.scrollback,
      slack: available - canvas.getBoundingClientRect().width,
      top: screen.findIndex((l) => l.trim().length > 0),
      pctRows,
      rebuilds: performance
        .getEntriesByName("phasr:terminal-rebuild")
        .map((e) => Math.round(e.duration)),
    };
  }, BRIDGE);
}

async function settlePane(page: Page) {
  let last = -1;
  let steady = 0;
  for (let i = 0; i < 80 && steady < 3; i++) {
    await page.waitForTimeout(50);
    const w = await page.evaluate(() => {
      const host = [
        ...document.querySelectorAll("[data-testid='terminal-surface']"),
      ].find((el) => (el as HTMLElement).offsetParent !== null) as HTMLElement;
      return host.clientWidth;
    });
    if (w === last) steady++;
    else {
      steady = 0;
      last = w;
    }
  }
  await page.waitForTimeout(500);
}

async function togglePanel(page: Page) {
  await page
    .getByRole("button", { name: /^(Show|Hide) changes$/ })
    .first()
    .click();
  await settlePane(page);
}

function watchConsole(
  page: Page,
  fatal = /\[terminal\].*(failed|FAILED|trapped|gave up)/,
): string[] {
  const errors: string[] = [];
  page.on("console", (m) => {
    const t = m.text();
    if (m.type() === "error" && !/429|Failed to load resource|CORS/.test(t))
      errors.push(`error: ${t}`);
    if (fatal.test(t)) errors.push(t);
  });
  page.on("pageerror", (e) => errors.push(`PAGEERROR: ${e.message}`));
  return errors;
}

/** Count console lines matching `pattern` without treating them as fatal. */
function countConsole(page: Page, pattern: RegExp): { count: number } {
  const box = { count: 0 };
  page.on("console", (m) => {
    if (pattern.test(m.text())) box.count++;
  });
  return box;
}

function assertStep(step: string, s: Snap, errors: string[]) {
  expect(errors, `${step}: console must stay clean`).toEqual([]);
  expect(s.readable, `${step}: buffer must stay readable`).toBe(true);
  // Content pinned to the top — the drift put it 4–10 rows down.
  expect(s.top, `${step}: first content row`).toBeLessThanOrEqual(1);
  // The grid always matches its pane.
  expect(s.slack, `${step}: pane slack`).toBeGreaterThanOrEqual(0);
  expect(s.slack, `${step}: pane slack`).toBeLessThanOrEqual(30);
  // The 22-second rebuild came from snapshotting a damaged grid.
  for (const ms of s.rebuilds)
    expect(ms, `${step}: rebuild duration`).toBeLessThan(1500);
}

test("an aged session survives width round trips: no traps, no drift, history conserved", async ({
  page,
}) => {
  const errors = watchConsole(page);
  await bootApp(page);
  await expectBackend(page);
  await terminal(page).click();
  for (let i = 0; i < 17; i++) await feed(page, AGED_KEEP_HISTORY);
  await page.waitForTimeout(700);

  const seeded = await snap(page);
  assertStep("seeded", seeded, errors);
  // The engine's byte budget (scrollbackBytes: 4 KiB per requested line)
  // deliberately over-provisions, so BETWEEN rebuilds a terminal can hold
  // far more than the fixture's 5,000-line setting — 17 fixture copies
  // seed ~11,700 rows. Before the units fix the engine's mis-fed 10 KB
  // budget capped this at ~1,100 rows and the setting never bit at all.
  expect(seeded.scrollback).toBeGreaterThan(5000);

  // The FIRST rebuild enforces the line setting (the one place phasr
  // controls), so conservation is measured from toggle 1 onward — the
  // seeded depth is above the cap by design and cannot round-trip.
  const byWidth = new Map<number, number>();
  for (let t = 1; t <= 6; t++) {
    await togglePanel(page);
    const s = await snap(page);
    assertStep(`toggle ${t}`, s, errors);
    // One rebuild per toggle — a missing one means the width change went
    // through the live-reflow path, which is the drift.
    expect(s.rebuilds.length, `toggle ${t}: rebuild count`).toBe(t);
    // Never more rows than the setting (post-join accounting only shrinks
    // the count at a wider pane).
    expect(
      s.scrollback,
      `toggle ${t}: the 5,000-line setting is enforced at the rebuild`,
    ).toBeLessThanOrEqual(5000);
    // Scrollback at a given width is CONSERVED across round trips (±20
    // rows of wrap-boundary accounting). Raw-byte replay lost it to 0;
    // the trap-then-snapshot path lost it to 6.
    const prior = byWidth.get(s.cols);
    if (prior !== undefined)
      expect(
        Math.abs(s.scrollback - prior),
        `toggle ${t}: scrollback at ${s.cols} cols (was ${prior}, now ${s.scrollback})`,
      ).toBeLessThanOrEqual(20);
    else byWidth.set(s.cols, s.scrollback);
    // Stranded `%` rows multiplied under byte replay; cell reads only
    // carry what the seed baked in.
    expect(s.pctRows, `toggle ${t}: PROMPT_EOL_MARK rows`).toBeLessThanOrEqual(
      seeded.pctRows + 2,
    );
  }
});

test("a style-saturated session (engine trap ceiling) rebuilds and lands, quarantine bounded", async ({
  page,
}) => {
  // Trapped ATTEMPTS are tolerated here — and only here. 140 distinct
  // styles over the volume a 5,000-row carry now re-emits (the byte-budget
  // fix retains every seeded round where ~1,100 rows used to be the
  // ceiling) puts the rebuild inside the engine's page-recycling defect:
  // an attempt can trap, park the damaged grid (`quarantinedGrids`), and
  // the retry lands on fresh memory. What this spec pins is that the
  // TRANSACTION holds at this volume: the rebuild lands, content stays
  // readable and pinned, nothing "gave up", and the quarantine stays
  // bounded by the attempt budget rather than growing without limit.
  const errors = watchConsole(page, /\[terminal\].*(failed|FAILED|gave up)/);
  const trapped = countConsole(page, /\[terminal\].*trapped/);
  await bootApp(page);
  await expectBackend(page);
  await terminal(page).click();
  // 140 distinct styles: hard enough that the pre-fix rebuild trapped on
  // every narrowing, comfortably under the engine's ~200-style ceiling at
  // which a LIVE grid falls over during plain writes with no rebuild
  // involved (its own bug, reproducible on WebKit at 220, and not this
  // spec's to assert).
  for (let i = 0; i < 4; i++) {
    await feed(page, AGED_KEEP_HISTORY);
    await feed(page, loudLines(140));
  }
  await page.waitForTimeout(700);
  assertStep("seeded", await snap(page), errors);

  for (let t = 1; t <= 4; t++) {
    await togglePanel(page);
    const s = await snap(page);
    assertStep(`toggle ${t}`, s, errors);
    expect(s.rebuilds.length, `toggle ${t}: rebuild count`).toBe(t);
    // Each rebuild gets MAX_REBUILD_ATTEMPTS (3), so at most 2 trapped
    // attempts per toggle can ever be legitimate.
    expect(
      trapped.count,
      `toggle ${t}: quarantined attempts stay inside the budget`,
    ).toBeLessThanOrEqual(t * 2);
  }
  console.log(`STYLE-SATURATED trapped attempts across 4 toggles: ${trapped.count}`);
});

test("grapheme-heavy content into a live grid needs no rebuild and no quarantine", async ({
  page,
}) => {
  const errors = watchConsole(page);
  await bootApp(page);
  await expectBackend(page);
  await terminal(page).click();
  const lines: string[] = [];
  for (let i = 0; i < 700; i++)
    lines.push(`line ${i} ☁️ ` + "abcdefghij".repeat(4));
  await feed(page, lines.join("\r\n"));
  await page.waitForTimeout(800);
  const s = await snap(page);
  assertStep("live", s, errors);
  expect(s.scrollback).toBeGreaterThan(600);
});
