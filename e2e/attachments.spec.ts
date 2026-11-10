/**
 * E2E: attachments in the agent input flow (spec D5).
 *
 * The native file picker is the dialog plugin's `plugin:dialog|open`, which
 * the harness lets a spec answer via `setResponse`. OS file drops are Tauri
 * events Playwright can't emit, so drops go through the DEV bridge's
 * `dropPaths` at a real screen point, the same router the event feeds.
 */
import { test, expect, type Page } from "@playwright/test";
import { bootApp, calls, clearCalls, expectBackend, makeFixtures, setResponse, waitForCall } from "./harness";

const REPO = "/Users/test/code/phasr";
const WORKTREE = "/Users/test/.phasr/worktrees/ws-agent";

async function boot(page: Page) {
  const res = await bootApp(page, makeFixtures());
  await expect(page).toHaveURL(/workspaces\/ws-agent/, { timeout: 25_000 });
  await expectBackend(page);
  return res;
}

async function argsFor(page: Page, cmd: string) {
  return (await calls(page)).filter((c) => c.cmd === cmd).map((c) => c.args);
}

const dropAt = (page: Page, paths: string[], x: number, y: number) =>
  page.evaluate(
    ([paths, x, y]) => (window as any).__PHASR_TERM__.dropPaths(paths as string[], x, y),
    [paths, x, y] as const,
  );

const modal = (page: Page) => page.getByRole("dialog", { name: "New task · phasr" });

test("New task: attach via the picker and a drop, then start with the block", async ({ page }) => {
  await boot(page);
  await page
    .getByRole("complementary", { name: "Sidebar" })
    .getByRole("button", { name: "New task", exact: true })
    .click();
  await expect(modal(page)).toBeVisible();

  await setResponse(page, "plugin:dialog|open", [`${REPO}/src/app.ts`, "/Users/test/Desktop/bug.png"]);
  await modal(page).getByRole("button", { name: "Attach files" }).click();
  const chips = modal(page).getByRole("list", { name: "Attachments" });
  await expect(chips.getByRole("listitem")).toHaveCount(2);
  const [open] = await argsFor(page, "plugin:dialog|open");
  expect((open as { options: { multiple: boolean; directory: boolean } }).options).toMatchObject({
    multiple: true,
    directory: false,
  });

  // A drop anywhere while the dialog is open is an attachment, not path text.
  await clearCalls(page);
  await dropAt(page, ["/Users/test/Desktop/notes.md"], 40, 40);
  await expect(chips.getByRole("listitem")).toHaveCount(3);
  expect((await calls(page)).filter((c) => c.cmd.startsWith("send_"))).toHaveLength(0);

  await modal(page).getByRole("button", { name: "Remove notes.md" }).click();
  await expect(chips.getByRole("listitem")).toHaveCount(2);

  await page.locator("#new-task-prompt").fill("Fix the crash in the screenshot");
  await clearCalls(page);
  await modal(page).getByRole("button", { name: "Start task" }).click();
  await waitForCall(page, "start_task");
  const [args] = await argsFor(page, "start_task");
  expect((args as { input: { prompt: string } }).input.prompt).toBe(
    "Fix the crash in the screenshot\n\nAttached files:\n- src/app.ts\n- /Users/test/Desktop/bug.png",
  );
});

test("Composer: paperclip and a drop attach; ⌘↵ sends the block and clears", async ({ page }) => {
  await boot(page);
  const box = page.getByPlaceholder(/^Reply to /);
  await expect(box).toBeVisible();

  await setResponse(page, "plugin:dialog|open", [`${WORKTREE}/src/app.ts`]);
  await page.getByRole("button", { name: "Attach files" }).click();
  const chips = page.getByRole("list", { name: "Attachments" });
  await expect(chips.getByRole("button", { name: "app.ts", exact: true })).toBeVisible();

  // A file dropped on the composer becomes an attachment too.
  const surface = await chips.boundingBox();
  expect(surface).not.toBeNull();
  await clearCalls(page);
  await dropAt(page, ["/Users/test/Desktop/shot.png"], surface!.x + 4, surface!.y + 4);
  await expect(chips.getByRole("button", { name: "shot.png", exact: true })).toBeVisible();
  expect((await calls(page)).filter((c) => c.cmd.startsWith("send_"))).toHaveLength(0);

  await box.fill("what does this do?");
  await clearCalls(page);
  await box.press("Meta+Enter");
  await waitForCall(page, "send_message_to_task");
  const [args] = await argsFor(page, "send_message_to_task");
  expect(args).toMatchObject({
    taskId: "ws-agent",
    text: "what does this do?\n\nAttached files:\n- src/app.ts\n- /Users/test/Desktop/shot.png",
    submit: true,
  });
  await expect(chips).toHaveCount(0);
  await expect(box).toHaveValue("");
});
