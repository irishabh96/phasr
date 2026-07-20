import { test, expect, type Page } from "@playwright/test";
import { bootApp, callNames, makeFixtures, waitForCall } from "./harness";

/**
 * Regression lock for the interrupted-open fix (commit 57fd5cf).
 *
 * A subtask orphaned by an app relaunch is swept `running` → `stopped` with an
 * `interruptedAt` stamp. Before the fix, opening it silently re-ran the agent
 * (`stopped` isn't a FINISHED status, so the Terminal took the re-spawn branch).
 * The fix: `Terminal` gains an `interrupted` prop (`WorkspaceTabContent` passes
 * `status === "stopped" && interruptedAt != null`); when set, the Terminal
 * REPLAYS the pre-interruption log (`read_task_log`) behind an explicit "Resume"
 * banner and NEVER auto re-spawns (`open_task_terminal`) on open. Resume/Restart
 * are wired to a REAL re-spawn.
 *
 * Drives the REAL app via the mocked-IPC harness (like ops.spec.ts). Terminal
 * CONTENT is WebGL canvas — we assert IPC (call names) + the Resume affordance,
 * not buffer text.
 */

const BENIGN =
  /__TAURI|invoke|clerk|Clerk|sentry|Sentry|supabase|favicon|sourcemap|Outdated Optimize Dep|net::|Failed to load resource|permission|ResizeObserver|homeDir|plugin:/i;
const realErrors = (errors: string[]) => errors.filter((e) => !BENIGN.test(e));
const fired = async (page: Page, cmd: string) =>
  (await callNames(page)).includes(cmd);

/**
 * Boot with NO restored workspace so the boot path itself never mounts a
 * terminal — the ONLY `open_task_terminal` that can appear is the one the
 * workspace-under-test decides to fire (or not). Then navigate straight to the
 * target detail route (a fresh page load; the harness re-seeds its call log).
 */
async function bootAndOpen(page: Page, workspaceId: string) {
  const f = makeFixtures();
  f.lastWorkspace = null; // land on /worklist (no terminal), not a restore
  const res = await bootApp(page, f);
  await page.goto(`/repositories/repo-1/workspaces/${workspaceId}`);
  return res;
}

test.describe("Interrupted-open (relaunch recovery)", () => {
  test("interrupted subtask replays its log + explicit Resume, never auto re-spawns", async ({
    page,
  }) => {
    const { errors } = await bootAndOpen(page, "epic-1-interrupted");

    // (1) Opening REPLAYS the pre-interruption log …
    await waitForCall(page, "read_task_log");
    // … and must NOT auto re-spawn the agent. Give any stray spawn a beat to
    // land, then prove it never did.
    await page.waitForTimeout(500);
    expect(await fired(page, "open_task_terminal")).toBe(false);

    // (2) The explicit Resume affordance is offered. A subtask opens to its
    // Brief tab, so reveal the (default-hidden) Terminal inner tab to surface
    // the banner rendered over the replayed log.
    await page.getByRole("tab", { name: "Terminal" }).click();
    const banner = page.getByTestId("terminal-resume-banner");
    await expect(banner).toBeVisible();
    const resume = page.getByTestId("terminal-resume");
    await expect(resume).toBeVisible();

    // (3) Resuming is a REAL re-spawn — the agent restarts only on this
    // explicit action, never on open.
    await resume.click();
    await waitForCall(page, "open_task_terminal");

    expect(realErrors(errors), realErrors(errors).join("\n---\n")).toEqual([]);
  });

  test("control: a calm user-stopped subtask (interruptedAt null) still opens its terminal", async ({
    page,
  }) => {
    const { errors } = await bootAndOpen(page, "epic-1-control");

    // Same status ("stopped") and shape as the interrupted one, differing ONLY
    // in `interruptedAt: null` → the unchanged path: re-attach via
    // open_task_terminal on open (fires from the mounted-but-hidden main tab).
    await waitForCall(page, "open_task_terminal");

    // No log replay and no Resume affordance for a calm user-stop.
    expect(await fired(page, "read_task_log")).toBe(false);
    await expect(page.getByTestId("terminal-resume-banner")).toHaveCount(0);

    expect(realErrors(errors), realErrors(errors).join("\n---\n")).toEqual([]);
  });
});
