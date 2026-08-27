import { test, expect, type Page } from "@playwright/test";
import {
  bootApp,
  expectBackend,
  makeFixtures,
  ptyBurst,
  ptyOut,
  terminal,
  tuiFrame,
} from "./harness";

/**
 * Phase 0 measurements for ADR-002 — the two spike questions Chromium can
 * actually answer.
 *
 * **Q5, per-terminal WASM linear memory.** Reported as growth of the ONE
 * shared `WebAssembly.Memory`: `preloadGhosttyEngine()` loads a single
 * `Ghostty` and passes it to every `Terminal` via `ITerminalOptions.ghostty`,
 * so terminals do not each get their own heap. This is a hard number.
 *
 * **Q4, canvas-2D throughput. DIRECTIONAL ONLY, AND NOT A GATE.** Playwright
 * drives Chromium (Skia, GPU-rasterized, out-of-process compositor).
 * phasr ships on WKWebView, whose synchronous GPU-process IPC is the actual
 * cause of the "terminal scroll is never smooth" history that WebGL was
 * brought in to fix. A green number here says nothing about that, and the
 * migration plan gates the default flip on WKWebView measurement plus a
 * manual matrix for exactly this reason. Numbers recorded to make a
 * *regression* visible, never to clear the gate.
 *
 * Run with `PHASE0_PROBE=1`.
 */

const skipUnlessProbe = () =>
  test.skip(
    !process.env.PHASE0_PROBE,
    "diagnostic, not a gate — run with PHASE0_PROBE=1",
  );

const wasmBytes = (page: Page) =>
  page.evaluate(() => (window as any).__PHASR_GHOSTTY__?.wasmBytes() ?? 0);

const surfaceCount = (page: Page) =>
  page.evaluate(() => (window as any).__PHASR_TERM__?.ids().length ?? 0);

const mib = (bytes: number) => (bytes / 1024 / 1024).toFixed(2);

/** `scrollback: 10000` worth of lines, in bursts so nothing allocates 10 MB. */
async function fillScrollback(page: Page, key: string, lines: number) {
  const burst = 500;
  for (let i = 0; i < lines; i += burst) {
    const chunk: string[] = [];
    for (let n = i; n < Math.min(i + burst, lines); n++) {
      chunk.push(
        `line ${String(n).padStart(5, "0")}  ${"lorem ipsum dolor sit amet ".repeat(3)}`,
      );
    }
    await ptyOut(page, key, chunk.join("\r\n") + "\r\n");
    await page.waitForTimeout(20);
  }
  await page.waitForTimeout(400);
}

// Two settings, 50x apart. ghostty-web forwards `scrollback` to
// `ghostty_terminal_new_with_config` as `scrollbackLimit`, so if the WASM
// heap were sized by it these two would differ. They do not — see ADR-002.
for (const scrollback of [200, 10_000]) {
  test(`Q5 — WASM linear memory per terminal at scrollback ${scrollback}`, async ({
    page,
  }) => {
    skipUnlessProbe();
    test.setTimeout(240_000);

    const fixtures = makeFixtures();
    fixtures.userSettings.terminalScrollback = scrollback;
    await bootApp(page, fixtures);
    await expect(page).toHaveURL(/workspaces\/ws-agent/, { timeout: 25_000 });
    await expectBackend(page);
    await page.waitForTimeout(2000);

    const oneTerminal = await wasmBytes(page);
    console.log(
      `Q5 engine+1 terminal (empty): ${mib(oneTerminal)} MiB, surfaces=${await surfaceCount(page)}`,
    );

    // More terminals through the real app path: ⌘T opens a shell tab, which
    // builds another surface. The LRU (bound 8) keeps them all alive.
    const created: number[] = [oneTerminal];
    for (let i = 0; i < 7; i++) {
      await page.keyboard.press("Meta+t");
      await page.waitForTimeout(900);
      const bytes = await wasmBytes(page);
      created.push(bytes);
      console.log(
        `Q5 after ⌘T #${i + 1}: ${mib(bytes)} MiB, surfaces=${await surfaceCount(page)}`,
      );
    }
    const surfaces = await surfaceCount(page);
    const perTerminal =
      surfaces > 1
        ? (created[created.length - 1]! - created[0]!) / (surfaces - 1)
        : Number.NaN;

    // Actually FILL one terminal's scrollback. Ghostty allocates the ring up
    // front (which is why an "empty" terminal already costs its full
    // scrollback), so this should be ~0 — and a nonzero number here would
    // mean the per-terminal figure above is a floor rather than the answer.
    const beforeFill = await wasmBytes(page);
    await fillScrollback(page, "ws-agent", scrollback);
    const afterFill = await wasmBytes(page);

    console.log(
      `Q5[${scrollback}] filling one terminal: ${mib(beforeFill)} -> ${mib(afterFill)} MiB (delta ${mib(afterFill - beforeFill)} MiB)`,
    );
    console.log(
      `Q5[${scrollback}] SUMMARY: surfaces=${surfaces}; engine+1=${mib(created[0]!)} MiB; per extra terminal ~${mib(perTerminal)} MiB; growth from filling +${mib(afterFill - beforeFill)} MiB; ${surfaces} terminals total=${mib(afterFill)} MiB`,
    );
    // The measurement is only meaningful if the terminals were actually
    // built — a silent failure to open tabs would otherwise report 0 MiB
    // per terminal and read as wonderful news.
    expect(surfaces).toBeGreaterThan(1);

    // Not an assertion on a number — only that the probe measured something
    // real. The number itself belongs in ADR-002, re-measured when it matters.
    expect(afterFill).toBeGreaterThan(0);
  });
}

/**
 * Frame deltas over a window of wheel scrolling, and CDP script/task time
 * over a bulk TUI write. Comparable to itself across runs, and to nothing
 * else.
 */
async function measureScroll(
  page: Page,
  label: string,
  snap: () => Promise<Record<string, number>>,
) {
  const cdpBefore = await snap();
  const box = await terminal(page).boundingBox();
  if (!box) throw new Error("terminal not found");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);

  await page.evaluate(() => {
    const w = window as any;
    w.__frames = [] as number[];
    w.__framesOn = true;
    let last = performance.now();
    const tick = (now: number) => {
      w.__frames.push(now - last);
      last = now;
      if (w.__framesOn) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  for (let i = 0; i < 60; i++) {
    await page.mouse.wheel(0, -120);
    await page.waitForTimeout(16);
  }
  await page.waitForTimeout(100);
  const frames: number[] = await page.evaluate(() => {
    const w = window as any;
    w.__framesOn = false;
    return w.__frames as number[];
  });

  const cdpAfter = await snap();
  const d = (k: string) =>
    +((cdpAfter[k] ?? 0) - (cdpBefore[k] ?? 0)).toFixed(3);

  const deltas = frames.slice(1);
  const sorted = [...deltas].sort((a, b) => a - b);
  const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? 0;
  const mean = deltas.reduce((a, b) => a + b, 0) / Math.max(1, deltas.length);
  // WORK done during the scroll. See the frame-count caveat below.
  console.log(
    `Q4 ${label} work: Script=${d("ScriptDuration")}s Task=${d("TaskDuration")}s`,
  );
  // CAVEAT: `frames` counts how often rAF fired, and ghostty-web runs its
  // OWN unconditional rAF loop, which keeps the frame pump saturated and
  // shrinks every delta. The figure is only comparable to ITSELF across
  // runs — never to another engine's.
  console.log(
    `Q4 ${label} frames (self-comparison only): n=${deltas.length} mean=${mean.toFixed(1)}ms p95=${p95.toFixed(1)}ms max=${Math.max(...deltas, 0).toFixed(1)}ms >25ms=${deltas.filter((d) => d > 25).length} >50ms=${deltas.filter((d) => d > 50).length}`,
  );
}

test("Q4 (DIRECTIONAL, Chromium not WKWebView) — ghostty throughput", async ({
  page,
  browserName,
}) => {
  skipUnlessProbe();
  test.skip(
    browserName !== "chromium",
    "CDP Performance metrics are Chromium-only — perf-baseline.spec.ts carries the engine-agnostic versions",
  );
  test.setTimeout(240_000);

  const client = await page.context().newCDPSession(page);
  await client.send("Performance.enable");
  const snap = async () => {
    const { metrics } = (await client.send("Performance.getMetrics")) as {
      metrics: Array<{ name: string; value: number }>;
    };
    return Object.fromEntries(metrics.map((m) => [m.name, m.value])) as Record<
      string,
      number
    >;
  };

  await bootApp(page, makeFixtures());
  await expect(page).toHaveURL(/workspaces\/ws-agent/, { timeout: 25_000 });
  await expectBackend(page);
  await page.waitForTimeout(3000);

  // Identical to `perf-probe.spec.ts`'s PTY_BULK_TUI_2MB phase — 2 MB of
  // escape-dense agent-TUI repaint traffic, deterministic per seed, so a
  // later run is fed byte-for-byte the same stream.
  const before = await snap();
  for (let round = 0; round < 8; round++) {
    await ptyBurst(
      page,
      "ws-agent",
      Array.from({ length: 8 }, (_, i) => tuiFrame(round * 8 + i)),
    );
    await page.waitForTimeout(50);
  }
  await page.waitForTimeout(500);
  const after = await snap();
  const d = (k: string) => +((after[k] ?? 0) - (before[k] ?? 0)).toFixed(3);
  console.log(
    `Q4 PTY_BULK_TUI_2MB: Script=${d("ScriptDuration")}s Task=${d("TaskDuration")}s Layout=${d("LayoutDuration")}s Recalc=${d("RecalcStyleDuration")}s Layouts=${d("LayoutCount")} Recalcs=${d("RecalcStyleCount")}`,
  );

  // Idle cost of N mounted terminals — the reason `setActive()` exists.
  // (Baseline row: "Idle script / 8 s, 1 visible — Chromium".)
  // ghostty-web free-runs a rAF loop per OPEN terminal, so this is the
  // number that says whether parked terminals are really paused.
  const idleBefore = await snap();
  await page.waitForTimeout(8000);
  const idleAfter = await snap();
  console.log(
    `Q4 IDLE_8S: Script=${(+(idleAfter.ScriptDuration! - idleBefore.ScriptDuration!)).toFixed(3)}s Task=${(+(idleAfter.TaskDuration! - idleBefore.TaskDuration!)).toFixed(3)}s`,
  );

  // Scroll smoothness over deep scrollback.
  await fillScrollback(page, "ws-agent", 3000);
  await measureScroll(page, "TERMINAL_UP", snap);

  expect(after.ScriptDuration).toBeGreaterThan(0);
});

/**
 * Perf Phase 0, criterion 7 (architect Q5) — `getScrollbackLine`
 * throughput, so F4's build-vs-patch decision starts from a measured band
 * instead of an argument.
 *
 * Runs under BOTH the default (Chromium) config and `pnpm test:e2e:webkit`
 * — it is a WASM/JS call with no CDP dependency and no IPC crossing, which
 * is also why it lives here and not in `perfbench.rs`. The loop runs
 * inside the page (`bridge.scrollbackBench`), so the Playwright boundary
 * is crossed once per run.
 *
 * Reports fetch-only AND fetch+`getScrollbackGraphemeString` separately:
 * F4 needs graphemes for correct match spans, so the cheaper number alone
 * would flatter it. Sanity anchor from the spec: the rebuild path measures
 * ~15 µs/row for read PLUS re-emit, so a fetch-only figure far above that
 * is a measurement bug, not a discovery.
 */
test("criterion 7 — getScrollbackLine throughput (fetch-only vs +graphemes)", async ({
  page,
  browserName,
}) => {
  skipUnlessProbe();
  test.setTimeout(240_000);

  await bootApp(page, makeFixtures());
  await expect(page).toHaveURL(/workspaces\/ws-agent/, { timeout: 25_000 });
  await expectBackend(page);
  await page.waitForTimeout(2000);

  // A known depth of mixed content: mostly the standard ASCII filler, with
  // every 16th line carrying CJK + emoji so the grapheme pass has real
  // clusters to resolve rather than a fast path all the way down.
  const lines = 5000;
  const burst = 500;
  for (let i = 0; i < lines; i += burst) {
    const chunk: string[] = [];
    for (let n = i; n < Math.min(i + burst, lines); n++) {
      chunk.push(
        n % 16 === 0
          ? `line ${String(n).padStart(5, "0")}  日本語テキスト 🚀 café naïve ${"─".repeat(20)}`
          : `line ${String(n).padStart(5, "0")}  ${"lorem ipsum dolor sit amet ".repeat(3)}`,
      );
    }
    await ptyOut(page, "ws-agent", chunk.join("\r\n") + "\r\n");
    await page.waitForTimeout(20);
  }
  await page.waitForTimeout(500);

  const result = await page.evaluate((samples) => {
    const bridge = (window as any).__PHASR_TERM__;
    if (!bridge) throw new Error("__PHASR_TERM__ missing (not a DEV build?)");
    // The surface fed above is the one with the deepest history.
    let best: string | null = null;
    let bestDepth = -1;
    for (const id of bridge.ids()) {
      const v = bridge.viewport(id);
      if (v && v.scrollback > bestDepth) {
        bestDepth = v.scrollback;
        best = id;
      }
    }
    if (!best) throw new Error("no live surface");
    return bridge.scrollbackBench(best, samples);
  }, 4000);

  expect(result).not.toBeNull();
  const r = result as {
    depth: number;
    sampled: number;
    fetchMs: number;
    graphemeMs: number;
    fetchLinesPerSec: number;
    graphemeLinesPerSec: number;
    fetchUsPerLine: number;
    graphemeUsPerLine: number;
    cells: number;
    chars: number;
  };
  console.log(
    `SCROLLBACK_BENCH engine=${browserName} depth=${r.depth} sampled=${r.sampled} ` +
      `fetch-only ${r.fetchUsPerLine.toFixed(2)}us/line (${Math.round(r.fetchLinesPerSec).toLocaleString()} lines/s) ` +
      `fetch+graphemes ${r.graphemeUsPerLine.toFixed(2)}us/line (${Math.round(r.graphemeLinesPerSec).toLocaleString()} lines/s) ` +
      `cells=${r.cells} chars=${r.chars}`,
  );
  // The probe measured something real, at a real depth…
  expect(r.depth).toBeGreaterThan(1000);
  expect(r.cells).toBeGreaterThan(0);
  expect(r.chars).toBeGreaterThan(0);
  // …and the fetch-only figure is in the physically plausible band (the
  // rebuild's read+re-emit is ~15 µs/row; two orders of magnitude above
  // that is a broken measurement, not a slow engine).
  expect(r.fetchUsPerLine).toBeLessThan(1500);
});
