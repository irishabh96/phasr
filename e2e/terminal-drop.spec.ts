import { test, expect, type Page } from "@playwright/test";
import { bootApp, expectBackend, makeFixtures, ptyOut } from "./harness";

/**
 * Dropping a file on a terminal types its path in.
 *
 * Two independent reasons this never worked: the emulator ships no drop
 * support at all (`drop`, `dragover`, `dataTransfer` are absent from
 * ghostty-web), and Tauri intercepts OS drops at the webview level so
 * HTML5 handlers never fire either. The path is therefore Tauri's
 * onDragDropEvent → routeDroppedPaths, which resolves the terminal under
 * the drop POINT rather than assuming the workspace's agent.
 *
 * Playwright cannot emit a Tauri drag event, so the spec drives the
 * routing directly at a real screen coordinate through the DEV bridge.
 */
const sent = (p: Page) =>
  p.evaluate(() =>
    ((((window as any).__E2E__?.calls) ?? []) as { cmd: string; args: any }[])
      .filter((c) => String(c.cmd).startsWith("send_"))
      .map((c) => `${c.cmd}:${c.args?.data}`),
  );
const clearCalls = (p: Page) =>
  p.evaluate(() => (window as any).__E2E__?.clearCalls?.());

const dropAt = (p: Page, paths: string[], x: number, y: number) =>
  p.evaluate(
    ([paths, x, y]) =>
      (window as any).__PHASR_TERM__.dropPaths(paths as string[], x, y),
    [paths, x, y] as const,
  );

test("a file dropped on the agent terminal is typed into it", async ({
  page,
}) => {
  await bootApp(page, makeFixtures());
  await expect(page).toHaveURL(/workspaces\/ws-agent/, { timeout: 25_000 });
  await expectBackend(page);
  await page.waitForTimeout(1500);
  await ptyOut(page, "ws-agent", "agent\r\n");

  const box = await page.getByTestId("terminal-surface").first().boundingBox();
  expect(box).not.toBeNull();

  await clearCalls(page);
  await dropAt(page, ["/tmp/a.txt"], box!.x + box!.width / 2, box!.y + 40);
  await page.waitForTimeout(300);

  const got = await sent(page);
  console.log(`DROP agent -> ${JSON.stringify(got)}`);
  expect(got.join("")).toContain("send_input_to_task:/tmp/a.txt");
});

test("a path with spaces is shell-quoted", async ({ page }) => {
  await bootApp(page, makeFixtures());
  await expect(page).toHaveURL(/workspaces\/ws-agent/, { timeout: 25_000 });
  await expectBackend(page);
  await page.waitForTimeout(1500);

  const box = await page.getByTestId("terminal-surface").first().boundingBox();
  await clearCalls(page);
  await dropAt(page, ["/tmp/my file.txt"], box!.x + 60, box!.y + 40);
  await page.waitForTimeout(300);

  const got = await sent(page);
  console.log(`DROP quoted -> ${JSON.stringify(got)}`);
  expect(got.join("")).toContain("'/tmp/my file.txt'");
});

test("dropping on a shell tab goes to THAT terminal, not the agent", async ({
  page,
}) => {
  await bootApp(page, makeFixtures());
  await expect(page).toHaveURL(/workspaces\/ws-agent/, { timeout: 25_000 });
  await expectBackend(page);
  await page.waitForTimeout(1500);

  // ⌘T opens a session terminal in a second inner tab.
  await page.keyboard.press("Meta+t");
  await page.waitForTimeout(2000);

  const visible = page
    .locator("[data-testid='terminal-surface']")
    .filter({ has: page.locator(":scope") });
  const boxes = await visible.evaluateAll((els) =>
    els
      .map((el) => {
        const r = el.getBoundingClientRect();
        return { id: el.getAttribute("data-terminal-id"), w: r.width, x: r.x, y: r.y, h: r.height };
      })
      .filter((b) => b.w > 0),
  );
  expect(boxes.length).toBe(1); // only the active tab has a box

  await clearCalls(page);
  await dropAt(page, ["/tmp/b.txt"], boxes[0].x + 60, boxes[0].y + 40);
  await page.waitForTimeout(300);

  const got = await sent(page);
  console.log(`DROP shell tab -> ${JSON.stringify(got)}`);
  // The regression: this used to fire send_input_to_task (the agent).
  expect(got.join("")).toContain("send_session_input:/tmp/b.txt");
  expect(got.join("")).not.toContain("send_input_to_task");
});
