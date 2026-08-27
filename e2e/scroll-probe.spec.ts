import { test, expect, type Page } from "@playwright/test";
import { bootApp, ptyOut, terminal } from "./harness";

/**
 * Scroll-smoothness probe. Feeds the terminal deep scrollback, drives
 * synthetic wheel scrolling, and records rAF frame deltas + layout/style
 * counters. Run with SCROLL_PROBE=1. Compare variants to localize jank
 * (base vs backdrop-filter disabled).
 */

async function feedScrollback(page: Page, lines: number) {
  const chunkLines: string[] = [];
  for (let i = 0; i < lines; i++) {
    chunkLines.push(
      `line ${String(i).padStart(5, "0")}  ${"lorem ipsum dolor sit amet ".repeat(3)}`,
    );
  }
  // Feed in bursts so the emulator parses without one giant string alloc.
  const burst = 500;
  for (let i = 0; i < chunkLines.length; i += burst) {
    await ptyOut(
      page,
      "ws-agent",
      chunkLines.slice(i, i + burst).join("\r\n") + "\r\n",
    );
    await page.waitForTimeout(50);
  }
  await page.waitForTimeout(500);
}

async function measureIdleFrames(page: Page, label: string, ms: number) {
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
  const frames = await page.evaluate(() => {
    const w = window as any;
    w.__framesOn = false;
    return w.__frames as number[];
  });
  const deltas = frames.slice(1);
  const sorted = [...deltas].sort((a, b) => a - b);
  const p = (q: number) => sorted[Math.floor(sorted.length * q)] ?? 0;
  const mean = deltas.reduce((a, b) => a + b, 0) / Math.max(1, deltas.length);
  console.log(
    `SCROLL ${label}: frames=${deltas.length} mean=${mean.toFixed(1)}ms p95=${p(0.95).toFixed(1)}ms >25ms=${deltas.filter((d) => d > 25).length}`,
  );
}

async function measureWheelScroll(
  page: Page,
  label: string,
  steps: number,
  deltaY: number,
) {
  const box = await terminal(page).boundingBox();
  if (!box) throw new Error("terminal not found");
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);

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

  for (let i = 0; i < steps; i++) {
    await page.mouse.wheel(0, deltaY);
    await page.waitForTimeout(16);
  }
  await page.waitForTimeout(100);

  const frames = await page.evaluate(() => {
    const w = window as any;
    w.__framesOn = false;
    return w.__frames as number[];
  });
  // Drop the first frame (warm-up) and compute stats.
  const deltas = frames.slice(1);
  const sorted = [...deltas].sort((a, b) => a - b);
  const p = (q: number) => sorted[Math.floor(sorted.length * q)] ?? 0;
  const mean = deltas.reduce((a, b) => a + b, 0) / Math.max(1, deltas.length);
  const dropped = deltas.filter((d) => d > 25).length;
  const bad = deltas.filter((d) => d > 50).length;
  console.log(
    `SCROLL ${label}: frames=${deltas.length} mean=${mean.toFixed(1)}ms p95=${p(0.95).toFixed(1)}ms max=${Math.max(...deltas, 0).toFixed(1)}ms >25ms=${dropped} >50ms=${bad}`,
  );
}

test("terminal scroll smoothness", async ({ page, browserName }) => {
  test.skip(!process.env.SCROLL_PROBE, "diagnostic — run with SCROLL_PROBE=1");
  test.setTimeout(180_000);

  await bootApp(page);
  await expect(page).toHaveURL(/workspaces\/ws-agent/, { timeout: 25_000 });
  await page.waitForTimeout(2000);
  await feedScrollback(page, 3000);

  await measureIdleFrames(page, "IDLE_BASELINE", 2000);
  await measureWheelScroll(page, "TERMINAL_UP_BASE", 60, -120);
  await measureWheelScroll(page, "TERMINAL_DOWN_BASE", 60, 120);

  // Variant: kill every backdrop blur, re-measure. A big delta implicates
  // the glass surfaces' backdrop-filter in scroll cost.
  await page.addStyleTag({
    content:
      "* { backdrop-filter: none !important; -webkit-backdrop-filter: none !important; }",
  });
  await page.waitForTimeout(300);
  await measureWheelScroll(page, "TERMINAL_UP_NOBLUR", 60, -120);

  // Variant: hide the animated status dots entirely (pulse rings), to see
  // whether compositor animations contend with scroll.
  await page.addStyleTag({
    content: "[aria-label='running'] { display: none !important; }",
  });
  await page.waitForTimeout(300);
  await measureWheelScroll(page, "TERMINAL_UP_NODOTS", 60, -120);

  // JS profile during a scroll storm — who actually burns the time?
  // CDP is Chromium-only; under `pnpm test:e2e:webkit` the frame numbers
  // above are the whole (and the load-bearing) story.
  if (browserName !== "chromium") return;
  const client = await page.context().newCDPSession(page);
  await client.send("Profiler.enable");
  await client.send("Profiler.setSamplingInterval", { interval: 200 });
  await client.send("Profiler.start");
  await measureWheelScroll(page, "TERMINAL_UP_PROFILED", 60, -120);
  const { profile } = (await client.send("Profiler.stop")) as {
    profile: {
      nodes: Array<{
        id: number;
        callFrame: { functionName: string; url: string };
        hitCount?: number;
      }>;
      samples?: number[];
      timeDeltas?: number[];
    };
  };
  const byFn = new Map<string, number>();
  for (const node of profile.nodes) {
    if (!node.hitCount) continue;
    const url = node.callFrame.url.split("/").slice(-2).join("/");
    const key = `${node.callFrame.functionName || "(anonymous)"} @ ${url}`;
    byFn.set(key, (byFn.get(key) ?? 0) + node.hitCount);
  }
  const top = [...byFn.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20);
  const total = [...byFn.values()].reduce((a, b) => a + b, 0);
  console.log(`PROFILE total samples=${total}`);
  for (const [fn, hits] of top) {
    console.log(`PROFILE ${((hits / total) * 100).toFixed(1)}% ${fn}`);
  }
});
