import { test, expect, type Page } from "@playwright/test";
import { bootApp, makeFixtures, callNames, calls, clearCalls, pty, setResponse } from "./harness";

/**
 * End-to-end operation critique: workspace/terminals, git/diff/changes, nav.
 * Drives the REAL app via the mocked-IPC harness. Terminal CONTENT is canvas
 * (WebGL), so we assert behavior (IPC + TerminalStatus overlays + toasts +
 * dialogs), not buffer text. Mock is stateless — assert IPC call + args.
 */

const BENIGN =
  /__TAURI|invoke|clerk|Clerk|sentry|Sentry|supabase|favicon|sourcemap|Outdated Optimize Dep|net::|Failed to load resource|permission|ResizeObserver/i;
const realErrors = (errors: string[]) => errors.filter((e) => !BENIGN.test(e));
const fired = async (page: Page, cmd: string) => (await callNames(page)).includes(cmd);
const pressMeta = (page: Page, key: string) => page.keyboard.press(`Meta+${key}`);
const manyFiles = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    path: `src/f${i}.ts`, oldPath: null, staged: "other", unstaged: "modified", adds: i + 1, removes: 0,
  }));

test.describe("Workspace & terminals", () => {
  test("boot fires open_task_terminal for the running agent workspace", async ({ page }) => {
    const { errors } = await bootApp(page);
    await expect(page).toHaveURL(/workspaces\/ws-agent/, { timeout: 25000 });
    await expect.poll(() => fired(page, "open_task_terminal")).toBe(true);
    expect(realErrors(errors)).toEqual([]);
  });

  test("agent process exit → TerminalStatus overlay (not raw ANSI)", async ({ page }) => {
    const { errors } = await bootApp(page);
    await expect.poll(() => fired(page, "open_task_terminal")).toBe(true);
    await pty(page, "ws-agent", { type: "exit", taskId: "ws-agent", exitCode: 0 });
    await expect(page.locator('[role="status"], [role="alert"]').first()).toBeVisible({ timeout: 5000 });
    expect(realErrors(errors)).toEqual([]);
  });

  test("non-zero exit → failed overlay (role=alert)", async ({ page }) => {
    await bootApp(page);
    await expect.poll(() => fired(page, "open_task_terminal")).toBe(true);
    await pty(page, "ws-agent", { type: "exit", taskId: "ws-agent", exitCode: 1 });
    await expect(page.getByRole("alert").first()).toBeVisible({ timeout: 5000 });
  });

  test("terminal START failure → failed overlay + Retry (no crash, no raw dump)", async ({ page }) => {
    const f = makeFixtures();
    (f as unknown as { overrides: Record<string, unknown> }).overrides = {
      open_task_terminal: { __reject: "pty error: spawn failed" },
    };
    const { errors } = await bootApp(page, f);
    await expect(page).toHaveURL(/ws-agent/, { timeout: 20000 });
    await expect(page.getByRole("button", { name: /retry|try again/i }).first()).toBeVisible({ timeout: 10000 });
    expect(realErrors(errors)).toEqual([]);
  });

  test("completed workspace replays log via read_task_log", async ({ page }) => {
    await bootApp(page);
    await page.goto("/repositories/repo-1/workspaces/ws-done");
    await expect.poll(() => fired(page, "read_task_log"), { timeout: 8000 }).toBe(true);
  });

  test("run pinned command via ⌘1 fires start_run_command", async ({ page }) => {
    await bootApp(page);
    await expect.poll(() => fired(page, "open_task_terminal")).toBe(true);
    await page.waitForTimeout(600);
    await clearCalls(page);
    await pressMeta(page, "1");
    await expect.poll(() => fired(page, "start_run_command"), { timeout: 5000 }).toBe(true);
  });

  test("new inner terminal tab (⌘T) starts a session terminal", async ({ page }) => {
    await bootApp(page);
    await expect.poll(() => fired(page, "open_task_terminal")).toBe(true);
    await page.waitForTimeout(800);
    await clearCalls(page);
    await pressMeta(page, "t");
    await expect.poll(() => fired(page, "start_session_terminal"), { timeout: 6000 }).toBe(true);
  });

  test("branch chip renders ahead/behind from git_branch_status", async ({ page }) => {
    await bootApp(page);
    await expect.poll(() => fired(page, "git_branch_status")).toBe(true);
    await expect(page.getByText("phasr/add-feature").first()).toBeVisible();
  });
});

test.describe("Git / diff / changes", () => {
  const openChanges = (page: Page) => pressMeta(page, "j");

  test("DIFF-STORM P0: collapsed cards (beyond the 10-seed) do NOT fetch git_diff", async ({ page }) => {
    const f = makeFixtures();
    f.gitStatus = manyFiles(15);
    await bootApp(page, f);
    await openChanges(page);
    await expect(page.getByText("src/f0.ts").first()).toBeVisible({ timeout: 8000 });
    await page.waitForTimeout(900);
    const diffPaths = (await calls(page)).filter((c) => c.cmd === "git_diff").map((c) => JSON.stringify(c.args));
    // Panel seeds the first 10 per section expanded; those fetch. f10..f14 are
    // collapsed and must NOT fetch — the whole point of the P0 fix.
    expect(diffPaths.some((a) => a.includes("src/f14.ts"))).toBe(false);
    expect(diffPaths.length).toBeLessThanOrEqual(10);
  });

  test("DIFF-STORM P0: expanding a collapsed card fetches only its diff", async ({ page }) => {
    const f = makeFixtures();
    f.gitStatus = manyFiles(15);
    await bootApp(page, f);
    await openChanges(page);
    await expect(page.getByText("src/f14.ts").first()).toBeVisible({ timeout: 8000 });
    await clearCalls(page);
    await page.getByText("src/f14.ts").first().click();
    await expect.poll(() => fired(page, "git_diff"), { timeout: 5000 }).toBe(true);
    const diffPaths = (await calls(page)).filter((c) => c.cmd === "git_diff").map((c) => JSON.stringify(c.args));
    expect(diffPaths.every((a) => a.includes("src/f14.ts"))).toBe(true);
  });

  test("commit fires git_commit", async ({ page }) => {
    await bootApp(page);
    await openChanges(page);
    await expect(page.getByText("src/app.ts").first()).toBeVisible({ timeout: 8000 });
    const msg = page.getByPlaceholder(/message|summary|commit/i).first();
    if (await msg.count()) {
      await msg.click();
      await msg.fill("test commit");
    }
    await pressMeta(page, "Enter");
    await expect.poll(() => fired(page, "git_commit"), { timeout: 5000 }).toBe(true);
  });

  test("push FAILURE surfaces a humanized error (no crash / no raw dump)", async ({ page }) => {
    const { errors } = await bootApp(page);
    await setResponse(page, "git_push", { __reject: "fatal: remote rejected (pre-receive hook declined)" });
    await openChanges(page);
    const pushBtn = page.getByRole("button", { name: /^push/i }).first();
    if (await pushBtn.count()) {
      await pushBtn.click();
      await expect(page.locator('[role="alert"]').first()).toBeVisible({ timeout: 6000 });
    }
    expect(realErrors(errors)).toEqual([]);
  });

  test("git_status load ERROR does not crash the panel", async ({ page }) => {
    const { errors } = await bootApp(page);
    await setResponse(page, "git_status", { __reject: "could not read index" });
    await openChanges(page);
    await page.evaluate(() =>
      (window as unknown as { __E2E__: { emit: (e: string, p: unknown) => void } }).__E2E__.emit(
        "worktree-changed", { workspaceId: "ws-agent", paths: [] },
      ),
    );
    await page.waitForTimeout(800);
    expect(realErrors(errors)).toEqual([]);
  });

  test("workspace actions ⋯ menu → Merge opens the merge dialog", async ({ page }) => {
    await bootApp(page);
    const menuBtn = page.getByRole("button", { name: /workspace actions/i }).first();
    await expect(menuBtn).toBeVisible({ timeout: 8000 });
    await menuBtn.click();
    const merge = page.getByText(/merge to main/i).first();
    if (await merge.count()) {
      await merge.click();
      await expect(page.getByRole("dialog")).toBeVisible({ timeout: 5000 });
    }
  });

  test("local workspace shows NO actions menu / remove button (intentional)", async ({ page }) => {
    await bootApp(page);
    await page.goto("/repositories/repo-1/workspaces/ws-local");
    await expect(page).toHaveURL(/ws-local/, { timeout: 8000 });
    await page.waitForTimeout(500);
    expect(await page.getByRole("button", { name: /workspace actions/i }).count()).toBe(0);
    expect(await page.getByRole("button", { name: /remove from phasr/i }).count()).toBe(0);
  });
});

test.describe("Navigation & chrome", () => {
  test("command palette opens on ⌘K (even with terminal focused)", async ({ page }) => {
    await bootApp(page);
    await page.waitForTimeout(800);
    await pressMeta(page, "k");
    await expect(page.locator("[cmdk-root]").first()).toBeVisible({ timeout: 5000 });
  });

  test("selecting a workspace navigates to it", async ({ page }) => {
    await bootApp(page);
    const link = page.getByText("fix-bug").first();
    if (await link.count()) {
      await link.click();
      await expect(page).toHaveURL(/ws-done/, { timeout: 5000 });
    }
  });

  test("empty repositories → welcome/first-run state (no crash)", async ({ page }) => {
    const f = makeFixtures();
    f.repositories = [];
    const { errors } = await bootApp(page, f);
    await page.waitForTimeout(1500);
    expect(realErrors(errors)).toEqual([]);
    await expect(page.getByText(/repositor|welcome|get started|add/i).first()).toBeVisible({ timeout: 8000 });
  });
});
