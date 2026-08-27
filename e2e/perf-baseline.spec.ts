import { execSync } from "node:child_process";
import { test, expect, type Page } from "@playwright/test";
import {
  bootApp,
  calls,
  clearCalls,
  expectBackend,
  makeFixtures,
  ptyOut,
  terminal,
  tuiFrame,
} from "./harness";

/**
 * Perf Phase 0 — the ENGINE-AGNOSTIC baselines
 * (`specs/perf-p0-measurement-baseline-spec.md`, criteria 4 and the
 * resize rows of the Baseline table).
 *
 * Everything in this file runs identically under the default (Chromium)
 * config and `pnpm test:e2e:webkit`, because nothing here needs CDP: the
 * WKWebView-proxy numbers the spec calls for — idle cost, scroll frame
 * time, flood throughput, echo latency — all come from in-page
 * instrumentation (`perf.ts` / `getRenderStats()` / rAF sampling) plus,
 * for CPU, a `ps`-based cumulative-CPU diff over the browser's own
 * process tree (macOS only; skipped gracefully elsewhere).
 *
 * Chromium numbers from this file are drift detectors; ONLY the WebKit run
 * is treated as directional truth for paint cost (ADR-002).
 *
 * Run with `PHASE0_PROBE=1` and an explicit `E2E_PORT`. Keep `--workers=1`
 * so nothing else competes for the machine while a number is being taken.
 */

const skipUnlessProbe = () =>
  test.skip(
    !process.env.PHASE0_PROBE,
    "diagnostic, not a gate — run with PHASE0_PROBE=1",
  );

test.describe.configure({ mode: "serial" });

/**
 * Cumulative CPU seconds of the Playwright-managed browser's process tree
 * (all helpers included — on WebKit that is where the web content and GPU
 * work actually happens). Diffing two readings over a window gives real
 * CPU cost with no CDP. macOS `ps` TIME is `mm:ss.cc`.
 */
function browserCpuSeconds(browserName: string): number | null {
  if (process.platform !== "darwin") return null;
  const needle = `ms-playwright/${browserName === "chromium" ? "chromium" : "webkit"}`;
  try {
    const out = execSync("ps -Ao time,args", {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
    let sum = 0;
    let matched = 0;
    for (const line of out.split("\n")) {
      if (!line.includes(needle)) continue;
      const m = line.trim().match(/^(\d+):(\d{2})\.(\d{2})\s/);
      if (!m) continue;
      sum += Number(m[1]) * 60 + Number(m[2]) + Number(m[3]) / 100;
      matched += 1;
    }
    return matched > 0 ? sum : null;
  } catch {
    return null;
  }
}

/** rAF frame deltas over a window — the shared measuring stick. */
async function sampleFrames(page: Page, ms: number) {
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
  await page.waitForTimeout(ms);
  const frames: number[] = await page.evaluate(() => {
    const w = window as any;
    w.__framesOn = false;
    return w.__frames as number[];
  });
  const deltas = frames.slice(1);
  const sorted = [...deltas].sort((a, b) => a - b);
  const p = (q: number) => sorted[Math.floor(sorted.length * q)] ?? 0;
  const mean = deltas.reduce((a, b) => a + b, 0) / Math.max(1, deltas.length);
  return {
    n: deltas.length,
    mean,
    p50: p(0.5),
    p95: p(0.95),
    max: Math.max(...deltas, 0),
    over25: deltas.filter((d) => d > 25).length,
  };
}

async function feedScrollback(page: Page, lines: number) {
  const burst = 500;
  for (let i = 0; i < lines; i += burst) {
    const chunk: string[] = [];
    for (let n = i; n < Math.min(i + burst, lines); n++) {
      chunk.push(
        `line ${String(n).padStart(5, "0")}  ${"lorem ipsum dolor sit amet ".repeat(3)}`,
      );
    }
    await ptyOut(page, "ws-agent", chunk.join("\r\n") + "\r\n");
    await page.waitForTimeout(20);
  }
  await page.waitForTimeout(500);
}

/**
 * Echo latency, measured exactly the way the shipped instrumentation
 * defines it (spec criterion 2): a mark in the surface's `onData` path,
 * resolved on the first painted frame that entered after it, read off
 * `__PHASR_PERF__`. What this measures is input→next-paint on THIS
 * engine's pipeline; the PTY round trip on top of it is a packaged-build
 * measurement (see the spec's mocked-IPC limitation).
 */
test("echo keystroke→paint latency via perf instrumentation", async ({
  page,
  browserName,
}) => {
  skipUnlessProbe();
  test.setTimeout(180_000);

  // Before boot, so surfaces are constructed with perf attached.
  await page.addInitScript(() => {
    localStorage.setItem("phasr.perf.hud", "1");
  });
  await bootApp(page, makeFixtures());
  await expect(page).toHaveURL(/workspaces\/ws-agent/, { timeout: 25_000 });
  await expectBackend(page);
  await page.waitForTimeout(2000);

  await terminal(page).click();
  await page.waitForTimeout(300);

  // A minute of typing compressed: 60 keystrokes at a human-ish cadence,
  // with the echo byte fed back so the frame that resolves the mark has
  // real content to paint.
  for (let i = 0; i < 60; i++) {
    await page.keyboard.press(String.fromCharCode(97 + (i % 26)));
    await ptyOut(page, "ws-agent", String.fromCharCode(97 + (i % 26)));
    await page.waitForTimeout(50);
  }
  await page.waitForTimeout(500);

  const snap = await page.evaluate(() => {
    const perf = (window as any).__PHASR_PERF__;
    if (!perf) throw new Error("__PHASR_PERF__ missing (not a DEV build?)");
    // The surface the typing landed on is the one with samples.
    let best: any = null;
    for (const id of perf.ids()) {
      const s = perf.snapshot(id);
      if (s && (!best || s.latency.count > best.latency.count)) best = s;
    }
    return best;
  });

  expect(snap).not.toBeNull();
  const s = snap as {
    latency: { last: number; p50: number; p95: number; count: number; expired: number };
    fps: number;
  };
  console.log(
    `ECHO engine=${browserName} keystroke→paint p50=${s.latency.p50.toFixed(1)}ms ` +
      `p95=${s.latency.p95.toFixed(1)}ms last=${s.latency.last.toFixed(1)}ms ` +
      `n=${s.latency.count} expired=${s.latency.expired} fps=${s.fps.toFixed(1)}`,
  );
  // Most keystrokes must have produced a sample; a stalled loop expiring
  // marks would make the percentiles a fiction.
  expect(s.latency.count).toBeGreaterThanOrEqual(30);
  expect(s.latency.expired).toBe(0);
});

test("idle cost, 1 visible terminal, 8s", async ({ page, browserName }) => {
  skipUnlessProbe();
  test.setTimeout(180_000);

  await bootApp(page, makeFixtures());
  await expect(page).toHaveURL(/workspaces\/ws-agent/, { timeout: 25_000 });
  await expectBackend(page);
  await page.waitForTimeout(3000); // boot settle

  const cpu0 = browserCpuSeconds(browserName);
  const frames = await sampleFrames(page, 8000);
  const cpu1 = browserCpuSeconds(browserName);
  const cpu =
    cpu0 !== null && cpu1 !== null ? (cpu1 - cpu0).toFixed(2) : "n/a";
  console.log(
    `IDLE_8S engine=${browserName} browser-tree CPU=${cpu}s ` +
      `frames: n=${frames.n} mean=${frames.mean.toFixed(1)}ms p95=${frames.p95.toFixed(1)}ms >25ms=${frames.over25}`,
  );
  expect(frames.n).toBeGreaterThan(60);
});

/**
 * Flood: the 2 MB escape-dense TUI stream, fed in coalescer-shaped bursts
 * (8×~32 KiB per task, one yield between — the ≤125 ev/s shape the Rust
 * side actually emits), timed INSIDE the page so Playwright round trips
 * are not part of the number. Also samples the engine's own tick counter
 * across the window — the A1 cadence baseline ("flood drops the frame
 * rate to ~30fps" is P1's target; this is where today's truth gets
 * recorded).
 */
test("flood throughput + frame cadence under flood", async ({
  page,
  browserName,
}) => {
  skipUnlessProbe();
  test.setTimeout(180_000);

  await bootApp(page, makeFixtures());
  await expect(page).toHaveURL(/workspaces\/ws-agent/, { timeout: 25_000 });
  await expectBackend(page);
  await page.waitForTimeout(2000);

  const chunks = Array.from({ length: 64 }, (_, i) =>
    Buffer.from(tuiFrame(i), "utf8").toString("base64"),
  );

  const result = await page.evaluate(async (encoded) => {
    const bridge = (window as any).__PHASR_TERM__;
    const e2e = (window as any).__E2E__;
    if (!bridge || !e2e) throw new Error("bridges missing (not a DEV build?)");
    // The visible surface is the only one whose renderTick is non-null.
    const id = bridge.ids().find((x: string) => bridge.renderTick(x) !== null);
    if (!id) throw new Error("no painting surface");
    const tick0 = bridge.renderTick(id) as number;
    let bytes = 0;
    const t0 = performance.now();
    for (let i = 0; i < encoded.length; i += 8) {
      for (let j = i; j < Math.min(i + 8, encoded.length); j++) {
        const chunk = encoded[j]!;
        bytes += Math.floor((chunk.length * 3) / 4);
        e2e.pty("ws-agent", { type: "output", chunk });
      }
      // Yield the task, exactly one macrotask per burst — the event shape
      // the real forwarder produces.
      await new Promise((r) => setTimeout(r, 0));
    }
    const ms = performance.now() - t0;
    // One settle frame, then read how many frames the flood window ran.
    await new Promise((r) => requestAnimationFrame(r));
    const tick1 = bridge.renderTick(id) as number;
    return { ms, bytes, framesDuring: tick1 - tick0 };
  }, chunks);

  const mbPerSec = result.bytes / 1_048_576 / (result.ms / 1000);
  const fps = result.framesDuring / (result.ms / 1000);
  console.log(
    `FLOOD engine=${browserName} ${(result.bytes / 1_048_576).toFixed(2)}MB in ${result.ms.toFixed(0)}ms ` +
      `= ${mbPerSec.toFixed(1)}MB/s  frames=${result.framesDuring} (~${fps.toFixed(1)}fps during flood)`,
  );
  expect(result.bytes).toBeGreaterThan(1_500_000);
  expect(result.ms).toBeGreaterThan(0);
});

test("scroll frame time over deep scrollback", async ({
  page,
  browserName,
}) => {
  skipUnlessProbe();
  test.setTimeout(240_000);

  await bootApp(page, makeFixtures());
  await expect(page).toHaveURL(/workspaces\/ws-agent/, { timeout: 25_000 });
  await expectBackend(page);
  await page.waitForTimeout(2000);
  await feedScrollback(page, 3000);

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
  const deltas = frames.slice(1);
  const sorted = [...deltas].sort((a, b) => a - b);
  const p = (q: number) => sorted[Math.floor(sorted.length * q)] ?? 0;
  const mean = deltas.reduce((a, b) => a + b, 0) / Math.max(1, deltas.length);
  console.log(
    `SCROLL_DEEP engine=${browserName} frames=${deltas.length} mean=${mean.toFixed(1)}ms ` +
      `p50=${p(0.5).toFixed(1)}ms p95=${p(0.95).toFixed(1)}ms max=${Math.max(...deltas, 0).toFixed(1)}ms ` +
      `>25ms=${deltas.filter((d) => d > 25).length}`,
  );
  expect(deltas.length).toBeGreaterThan(30);
});

/**
 * `resize_task` calls per gesture — the two Baseline rows P5's criterion 1
 * is later judged against. A "gesture" is modelled as a 14-step viewport
 * drag over ~220 ms, the shape of a panel-toggle animation
 * (`REBUILD_QUIET_MS` exists because side panels animate width for 220 ms
 * and ResizeObserver fires per frame). The width half already debounces;
 * the rows-only path still fits immediately — this records both truths.
 */
test("resize_task calls per horizontal / vertical gesture", async ({
  page,
  browserName,
}) => {
  skipUnlessProbe();
  test.setTimeout(180_000);

  await bootApp(page, makeFixtures());
  await expect(page).toHaveURL(/workspaces\/ws-agent/, { timeout: 25_000 });
  await expectBackend(page);
  await page.waitForTimeout(2000);

  const countResizes = async () => {
    const byCmd = new Map<string, number>();
    for (const c of await calls(page)) {
      if (!c.cmd.startsWith("resize_")) continue;
      byCmd.set(c.cmd, (byCmd.get(c.cmd) ?? 0) + 1);
    }
    const total = [...byCmd.values()].reduce((a, b) => a + b, 0);
    const detail = [...byCmd.entries()]
      .map(([cmd, n]) => `${cmd}×${n}`)
      .join(" ");
    return { total, detail: detail || "none" };
  };

  // Horizontal: width shrinks 140px across 14 steps, then settles.
  await clearCalls(page);
  for (let i = 1; i <= 14; i++) {
    await page.setViewportSize({ width: 1280 - i * 10, height: 720 });
    await page.waitForTimeout(16);
  }
  await page.waitForTimeout(800); // outlast REBUILD_QUIET_MS + rebuild
  const horizontal = await countResizes();

  // Vertical: height shrinks 140px across 14 steps (rows-only path).
  await clearCalls(page);
  for (let i = 1; i <= 14; i++) {
    await page.setViewportSize({ width: 1140, height: 720 - i * 10 });
    await page.waitForTimeout(16);
  }
  await page.waitForTimeout(800);
  const vertical = await countResizes();

  console.log(
    `RESIZE_GESTURE engine=${browserName} horizontal=${horizontal.total} (${horizontal.detail}) ` +
      `vertical=${vertical.total} (${vertical.detail}) (14-step / ~220ms drag each)`,
  );
  // The gesture must have reached the PTY at least once each, or the
  // numbers describe a terminal that never resized at all.
  expect(horizontal.total).toBeGreaterThan(0);
  expect(vertical.total).toBeGreaterThan(0);
});
