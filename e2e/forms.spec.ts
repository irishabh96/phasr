/**
 * CRITIQUE-MODE e2e: FORMS / DIALOGS / ONBOARDING / SETTINGS / NOTIFICATIONS.
 *
 * Drives the REAL app via the mocked-IPC harness (see harness.ts). Each test
 * exercises a user-facing operation adversarially: renders, right IPC + args,
 * response handling, validation, and the error path. Console `errors` are
 * watched on every boot; real (non-Tauri-noise) errors fail the test.
 *
 * NOTE on navigation: `page.goto()` RELOADS, which re-runs the harness
 * initScript and WIPES `setResponse` overrides + the recorded calls array.
 * So overrides that must be live at route-mount are set up via client-side
 * navigation (clicking sidebar rows) instead; overrides consumed by a later
 * user action are set after the goto.
 */
import { test, expect, type Page } from "@playwright/test";
import {
  bootApp,
  makeFixtures,
  calls,
  callNames,
  clearCalls,
  emit,
  expectBackend,
  setResponse,
  waitForCall,
} from "./harness";

// Boot noise from running the frontend without the native shell / Clerk /
// network — never app bugs.
const BENIGN =
  /__TAURI|invoke|clerk|Clerk|sentry|Sentry|supabase|favicon|sourcemap|Outdated Optimize Dep|net::|Failed to load resource|permission|ResizeObserver|homeDir|plugin:/i;

function realErrors(errors: string[]) {
  return errors.filter((e) => !BENIGN.test(e));
}

/** Boot and wait until the shell has settled on the seeded workspace. */
async function boot(page: Page, fixtures = makeFixtures()) {
  const res = await bootApp(page, fixtures);
  await expect(page).toHaveURL(/workspaces\/ws-agent/, { timeout: 25_000 });
  // The restored task's agent terminal takes focus once it is up; let that
  // settle so it can't land mid-test (e.g. pull focus out of an open modal).
  await expectBackend(page);
  return res;
}

/** Sidebar header "+" → New task modal for the current task's repository. */
async function openNewTask(page: Page, repo = "phasr") {
  await page
    .getByRole("complementary", { name: "Sidebar" })
    .getByRole("button", { name: "New task", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: `New task · ${repo}` });
  await expect(dialog).toBeVisible();
  return dialog;
}

/** Settings is a sheet over any route (`?settings=<section>`). Land on the
 *  board (not the restored task) so the sheet is the only thing loading. */
async function gotoSettings(page: Page, section: string) {
  const f = makeFixtures();
  (f as { landing?: string }).landing = "board";
  const res = await bootApp(page, f);
  await page.goto(`/?settings=${section}`);
  const sheet = page.getByRole("dialog", { name: "Settings" });
  await expect(sheet.getByRole("navigation", { name: "Settings sections" })).toBeVisible({
    timeout: 20_000,
  });
  return { ...res, sheet };
}

/** All recorded args for a given command, newest-last. */
async function argsFor(page: Page, cmd: string) {
  const all = await calls(page);
  return all.filter((c) => c.cmd === cmd).map((c) => c.args);
}

// ───────────────────────────────────────────────────────────────────────────
// NEW TASK FORM  (sidebar "+" → NewTaskModal → start_task)
// The app shell mounts NewTaskModal, so the sidebar's "+" (and ⌘N) opens
// the task form which calls start_task.
// ───────────────────────────────────────────────────────────────────────────
test.describe("New task form (NewTaskModal)", () => {
  test("renders all fields; base branch pre-filled; agent command shown", async ({
    page,
  }) => {
    const { errors } = await boot(page);
    const dialog = await openNewTask(page);

    // Prompt first, then the (optional) name.
    await expect(page.locator("#new-task-prompt")).toBeVisible();
    await expect(page.locator("#new-task-name")).toBeVisible();
    await expect(page.locator("#new-task-agent")).toBeVisible();
    // Base branch seeded from the repo's default branch.
    await expect(page.locator("#new-task-base-branch")).toHaveValue("main");
    // The agent picker defaults to the default agent; the plan prints its command.
    await expect(dialog.getByRole("radio", { name: "Claude" })).toHaveAttribute("aria-checked", "true");
    await expect(
      dialog.getByRole("list", { name: "What Phasr will run" }).getByText("claude", { exact: true }),
    ).toBeVisible();

    // The agent picker is a real radiogroup of buttons (keyboard-operable natively).
    const agentGroup = page.locator("#new-task-agent");
    expect(await agentGroup.getAttribute("role")).toBe("radiogroup");
    expect(
      await agentGroup.getByRole("radio").evaluateAll((els) => els.map((el) => el.tagName)),
    ).toEqual(["BUTTON", "BUTTON", "BUTTON"]);

    expect(realErrors(errors), realErrors(errors).join("\n")).toHaveLength(0);
  });

  test("required-field: submit disabled until a name or prompt is present", async ({
    page,
  }) => {
    await boot(page);
    await openNewTask(page);
    const submit = page.getByRole("button", { name: "Start task", exact: true });
    await expect(submit).toBeDisabled();
    await page.locator("#new-task-name").fill("fix login redirect");
    await expect(submit).toBeEnabled();
    // Whitespace-only is still "empty".
    await page.locator("#new-task-name").fill("   ");
    await expect(submit).toBeDisabled();
    // The name is optional: a prompt alone names the task.
    await page.locator("#new-task-prompt").fill("Repair the redirect loop");
    await expect(submit).toBeEnabled();
    await page.locator("#new-task-prompt").fill("   ");
    await expect(submit).toBeDisabled();
  });

  test("agent pick + Enter submit → start_task with right args → navigates", async ({
    page,
  }) => {
    const { errors } = await boot(page);
    const dialog = await openNewTask(page);
    await clearCalls(page);

    await page.locator("#new-task-prompt").fill("Repair the redirect loop");
    await page.locator("#new-task-name").fill("fix login redirect");
    await dialog.getByRole("radio", { name: "Codex" }).click();
    await expect(dialog.getByRole("radio", { name: "Codex" })).toHaveAttribute("aria-checked", "true");
    // Enter inside the name input submits the form.
    await page.locator("#new-task-name").press("Enter");

    await waitForCall(page, "start_task");
    const [args] = await argsFor(page, "start_task");
    // Defaults (permissions / notify / runs-in) are not sent.
    expect(args).toEqual({
      input: {
        repositoryId: "repo-1",
        agent: "codex",
        name: "fix login redirect",
        prompt: "Repair the redirect loop",
        baseBranch: "main",
      },
    });
    // onCreated navigates to the new task's detail pane.
    await expect(page).toHaveURL(/workspaces\/ws-created/, { timeout: 10_000 });
    expect(realErrors(errors), realErrors(errors).join("\n")).toHaveLength(0);
  });

  test("error path: rejected start_task shows humanized inline error, modal stays open", async ({
    page,
  }) => {
    const { errors } = await boot(page);
    await openNewTask(page);
    await setResponse(page, "start_task", {
      __reject: "fatal: a branch already exists",
    });

    await page.locator("#new-task-name").fill("dup task");
    await page.getByRole("button", { name: "Start task", exact: true }).click();

    // Humanized ("already exists" → destination copy), inline, non-crashing.
    await expect(page.getByText(/destination already exists/i)).toBeVisible();
    await expect(page.getByRole("dialog")).toBeVisible(); // still open
    await expect(page).toHaveURL(/workspaces\/ws-agent/); // no navigation
    // A page error (uncaught) is a real bug; humanized copy is not.
    const bad = errors.filter((e) => e.startsWith("PAGEERROR:"));
    expect(bad, bad.join("\n")).toHaveLength(0);
  });

  // D1 (FIXED): a `useRef` in-flight flag now guards each submit handler, so two
  // synchronous submits within one JS task fire start_task exactly ONCE. This
  // pins that fix (previously fired twice — a duplicate worktree+branch+agent).
  test("double-submit fires start_task exactly once (D1: re-entrancy guard)", async ({
    page,
  }) => {
    await boot(page);
    await openNewTask(page);
    // Keep the modal open (no navigation) so both clicks land on the button.
    await setResponse(page, "start_task", { __reject: "held-open-unique" });
    await page.locator("#new-task-name").fill("race task");
    await clearCalls(page);

    // Two synchronous clicks before React can disable the button.
    await page
      .getByRole("button", { name: "Start task", exact: true })
      .evaluate((el: HTMLButtonElement) => {
        el.click();
        el.click();
      });
    await page.waitForTimeout(400);

    const count = (await callNames(page)).filter(
      (c) => c === "start_task",
    ).length;
    // EXPECT exactly one — a second in-flight task is a duplicate-work bug.
    expect(count).toBe(1);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// RENAME WORKSPACE  (task list right-click → Rename… → update_workspace)
// ───────────────────────────────────────────────────────────────────────────
test.describe("Rename workspace modal", () => {
  async function openRename(page: Page) {
    const row = page
      .locator('nav[aria-label="Tasks"]')
      .getByText("add-feature", { exact: true });
    await row.click({ button: "right" });
    await page.getByRole("menuitem", { name: "Rename…" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
  }

  test("opens pre-filled + text selected; initial focus on the field (not close X); has Description; Esc closes", async ({
    page,
  }) => {
    const { errors } = await boot(page);
    await openRename(page);

    const input = page.getByLabel("Workspace name");
    await expect(input).toHaveValue("add-feature");

    // Initial focus is on the field, NOT the close button (Dialog primitive).
    const focus = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      return {
        tag: el?.tagName,
        isClose: el?.getAttribute("data-dialog-close") != null,
        aria: el?.getAttribute("aria-label"),
      };
    });
    expect(focus.isClose).toBe(false);
    expect(focus.tag).toBe("INPUT");
    expect(focus.aria).toBe("Workspace name");

    // onFocus selects the whole value so a retype replaces it.
    const sel = await input.evaluate((el: HTMLInputElement) => ({
      start: el.selectionStart,
      end: el.selectionEnd,
      len: el.value.length,
    }));
    expect(sel.start).toBe(0);
    expect(sel.end).toBe(sel.len);

    // Required a11y Description is present (sr-only) and wired.
    const described = await page
      .getByRole("dialog")
      .evaluate((d) => !!d.getAttribute("aria-describedby"));
    expect(described).toBe(true);

    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toBeHidden();
    expect(realErrors(errors), realErrors(errors).join("\n")).toHaveLength(0);
  });

  test("submit → update_workspace with new name; Save disabled when unchanged", async ({
    page,
  }) => {
    await boot(page);
    await openRename(page);
    const save = page.getByRole("button", { name: "Save" });
    // Unchanged value → Save disabled.
    await expect(save).toBeDisabled();

    const input = page.getByLabel("Workspace name");
    await input.fill("renamed-feature");
    // Harness gap: the mock's `update_workspace` returns null, which crashes
    // the hook's onSuccess (`workspace.repositoryId`). Return a real row.
    await setResponse(page, "update_workspace", {
      id: "ws-agent",
      repositoryId: "repo-1",
      name: "renamed-feature",
    });
    await clearCalls(page);
    await save.click();

    await waitForCall(page, "update_workspace");
    const [args] = await argsFor(page, "update_workspace");
    expect(args).toEqual({
      id: "ws-agent",
      input: { name: "renamed-feature" },
    });
    await expect(page.getByRole("dialog")).toBeHidden();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// ONBOARDING — a repository with no tasks yet (board empty state), and
// opening an existing non-git folder (GitInitConfirmModal)
// ───────────────────────────────────────────────────────────────────────────

/** Title bar "Board" — client-side, so live `setResponse` overrides survive. */
async function gotoBoard(page: Page) {
  // Let the restored task finish rendering first: leaving it while its route
  // is still pending leaves "/" blank (see report — app-side race).
  await expect(page.getByRole("tablist", { name: "Workspace tabs" })).toBeVisible({ timeout: 20_000 });
  await page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Board" }).click();
  await expect(page.getByRole("heading", { name: "Board", level: 1 })).toBeVisible({ timeout: 15_000 });
}

test.describe("First task in an empty repository", () => {
  test("empty repo board → New task → start_task for that repo with its base branch; Esc closes", async ({
    page,
  }) => {
    const { errors } = await boot(page);
    await gotoBoard(page);
    // Narrow the board to repo-2 (no tasks) from the Repositories footer.
    await page
      .getByRole("navigation", { name: "Repositories" })
      .getByRole("button", { name: "sidecar", exact: true })
      .click();
    const empty = page.locator("main").getByRole("heading", { name: "Give an agent its first task" });
    await expect(empty).toBeVisible({ timeout: 15_000 });
    const cta = empty.locator("..").getByRole("button", { name: /^New task/ });

    // Esc dismisses the modal without starting anything.
    await cta.click();
    await expect(page.getByRole("dialog", { name: "New task · sidecar" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toBeHidden();
    expect(await argsFor(page, "start_task")).toHaveLength(0);

    await cta.click();
    await expect(page.getByRole("dialog", { name: "New task · sidecar" })).toBeVisible();
    await page.locator("#new-task-name").fill("add dark mode");
    await expect(page.locator("#new-task-base-branch")).toHaveValue("main");
    await clearCalls(page);
    await page.getByRole("button", { name: "Start task", exact: true }).click();

    await waitForCall(page, "start_task");
    const [args] = await argsFor(page, "start_task");
    expect(args).toMatchObject({
      input: {
        repositoryId: "repo-2",
        agent: "claude",
        name: "add dark mode",
        baseBranch: "main",
      },
    });
    expect(realErrors(errors), realErrors(errors).join("\n")).toHaveLength(0);
  });

  test("open existing non-git folder → GitInitConfirmModal → git_init_repository; failure keeps dialog open", async ({
    page,
  }) => {
    const { errors } = await boot(page);
    await gotoBoard(page);
    // The native folder picker returns a folder that isn't a git repo yet.
    await setResponse(page, "plugin:dialog|open", "/Users/test/code/fresh");
    await setResponse(page, "validate_workspace_path", {
      path: "/Users/test/code/fresh",
      absolutePath: "/Users/test/code/fresh",
      exists: true,
      isDir: true,
      isGitRepo: false,
      message: null,
    });
    await page.getByRole("button", { name: "Add repository" }).click();
    await page.getByRole("dialog").getByText("Open existing").click();

    const dialog = page.getByRole("dialog", { name: "Initialize Git repository?" });
    await expect(dialog).toBeVisible({ timeout: 15_000 });
    const [created] = await argsFor(page, "create_repository");
    expect(created).toEqual({ input: { name: "fresh", localPath: "/Users/test/code/fresh" } });

    // Failure path first: inline humanized error, dialog stays open.
    await setResponse(page, "git_init_repository", {
      __reject: "could not resolve host github.com",
    });
    await dialog.getByRole("button", { name: "Initialize Git" }).click();
    await expect(dialog.getByText(/Network error/i)).toBeVisible();
    await expect(dialog).toBeVisible();

    // Success path: the real git_init_repository fires for the new repo.
    await setResponse(page, "git_init_repository", {
      id: "repo-new",
      name: "fresh",
    });
    await clearCalls(page);
    await dialog.getByRole("button", { name: "Initialize Git" }).click();
    await waitForCall(page, "git_init_repository");
    const [args] = await argsFor(page, "git_init_repository");
    expect(args).toEqual({ id: "repo-new" });
    await expect(dialog).toBeHidden();

    const bad = errors.filter((e) => e.startsWith("PAGEERROR:"));
    expect(bad, bad.join("\n")).toHaveLength(0);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// ADD REPOSITORY PICKER  (board → Repositories footer → Add repository)
// ───────────────────────────────────────────────────────────────────────────
test.describe("Add repository picker", () => {
  test("fans out to New project (navigates) and closes on Esc", async ({
    page,
  }) => {
    await boot(page);
    await gotoBoard(page);
    await page.getByRole("button", { name: "Add repository" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText("Add a repository")).toBeVisible();
    await expect(dialog.getByText("New project")).toBeVisible();
    await expect(dialog.getByText("Open existing")).toBeVisible();

    // Esc closes.
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toBeHidden();

    // Reopen → New project routes to the wizard.
    await page.getByRole("button", { name: "Add repository" }).click();
    await page.getByRole("dialog").getByText("New project").click();
    await expect(page).toHaveURL(/\/new-project/, { timeout: 10_000 });
  });
});

// ───────────────────────────────────────────────────────────────────────────
// NEW PROJECT PANE (/new-project) — Empty / Clone / Template, Enter submits
// ───────────────────────────────────────────────────────────────────────────
test.describe("New project pane", () => {
  async function gotoNewProject(page: Page) {
    await bootApp(page);
    await page.goto("/new-project");
    await expect(
      page.getByRole("heading", { name: "New Project" }),
    ).toBeVisible({ timeout: 20_000 });
    // Location seeds empty under the mock (homeDir → null); fill it.
    await page.getByPlaceholder("/Users/you/projects").fill("/tmp/projects");
  }

  test("Empty mode: Enter submits → git_init_empty_repository + create_repository", async ({
    page,
  }) => {
    await gotoNewProject(page);
    await page.locator("#empty-repo-name").fill("cool-app");
    await clearCalls(page);
    await page.locator("#empty-repo-name").press("Enter"); // the P0 Enter-submit fix

    await waitForCall(page, "git_init_empty_repository");
    const [initArgs] = await argsFor(page, "git_init_empty_repository");
    expect(initArgs).toEqual({ destinationPath: "/tmp/projects/cool-app" });
    await waitForCall(page, "create_repository");
    const [repoArgs] = await argsFor(page, "create_repository");
    expect(repoArgs).toEqual({
      input: { name: "cool-app", localPath: "/tmp/projects/cool-app" },
    });
  });

  test("Clone mode: dest preview + Enter → git_clone_repository", async ({
    page,
  }) => {
    await gotoNewProject(page);
    await page.getByRole("button", { name: /^Clone/ }).click();
    await page
      .locator("#clone-repo-url")
      .fill("https://github.com/acme/widget.git");
    // Destination preview derives the repo name.
    await expect(
      page.getByText("/tmp/projects/widget", { exact: false }),
    ).toBeVisible();
    await clearCalls(page);
    await page.locator("#clone-repo-url").press("Enter");

    await waitForCall(page, "git_clone_repository");
    const [args] = await argsFor(page, "git_clone_repository");
    expect(args).toEqual({
      url: "https://github.com/acme/widget.git",
      destinationPath: "/tmp/projects/widget",
    });
  });

  test("Template mode: picking a template → git_init_from_template", async ({
    page,
  }) => {
    await gotoNewProject(page);
    await page.getByRole("button", { name: /^Template/ }).click();
    // Pick the first template card.
    await page.getByRole("button", { name: /Next\.js \+ shadcn/ }).click();
    await expect(page.locator("#template-repo-name")).toBeVisible();
    await clearCalls(page);
    await page.getByRole("button", { name: "Use template" }).click();
    await waitForCall(page, "git_init_from_template");
  });

  test("error clears when switching modes (D2)", async ({ page }) => {
    await gotoNewProject(page);
    await setResponse(page, "git_init_empty_repository", {
      __reject: "disk full-xyz",
    });
    await page.locator("#empty-repo-name").fill("boom");
    await page.getByRole("button", { name: "Create" }).click();
    await expect(page.getByText("disk full-xyz")).toBeVisible();
    // Switch mode → the stale error must clear.
    await page.getByRole("button", { name: /^Clone/ }).click();
    await expect(page.getByText("disk full-xyz")).toBeHidden();
  });

  test("mode tiles show a focus-visible ring on keyboard focus", async ({
    page,
  }) => {
    await gotoNewProject(page);
    const tile = page.getByRole("button", { name: /^Clone/ });
    await tile.focus();
    const shadow = await tile.evaluate((el) => getComputedStyle(el).boxShadow);
    expect(shadow).not.toBe("none");
    expect(shadow.length).toBeGreaterThan(0);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// SETTINGS — Appearance theme
// ───────────────────────────────────────────────────────────────────────────
test.describe("Settings · appearance", () => {
  test("theme tiles update data-theme + persist to localStorage; rapid toggles don't crash", async ({
    page,
  }) => {
    const { errors, sheet } = await gotoSettings(page, "appearance");
    await expect(sheet.getByRole("heading", { name: "Appearance" })).toBeVisible();
    const themes = sheet.getByRole("radiogroup", { name: "Theme" });
    const tile = (name: string) => themes.getByRole("radio", { name, exact: true });

    await tile("Light").click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await expect(tile("Light")).toHaveAttribute("aria-checked", "true");
    expect(await page.evaluate(() => localStorage.getItem("phasr.theme"))).toBe(
      "light",
    );

    await tile("Dark").click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    expect(await page.evaluate(() => localStorage.getItem("phasr.theme"))).toBe(
      "dark",
    );

    // system resolves to light/dark; the stored value must be "system".
    await tile("System").click();
    expect(await page.evaluate(() => localStorage.getItem("phasr.theme"))).toBe(
      "system",
    );

    // Rapid toggles.
    for (let i = 0; i < 6; i++) {
      await tile(i % 2 ? "Dark" : "Light").click();
    }
    expect(realErrors(errors), realErrors(errors).join("\n")).toHaveLength(0);
  });
});

// Terminal font size lives in the sheet's Terminal section. ⌘0 is the reset.
test.describe("Settings · terminal", () => {
  test("terminal font size: stepper + ⌘=/⌘-/⌘0 fire update_user_settings and the readout tracks", async ({
    page,
  }) => {
    const { errors, sheet } = await gotoSettings(page, "terminal");
    const readout = sheet.getByRole("status");
    await expect(readout).toHaveText("13 px");
    await clearCalls(page);

    await sheet
      .getByRole("button", { name: "Increase terminal font size" })
      .click();
    await expect(readout).toHaveText("14 px");

    // Global shortcuts — the dispatcher owns these, not the page.
    await page.keyboard.press("Meta+=");
    await expect(readout).toHaveText("15 px");
    await page.keyboard.press("Meta+-");
    await expect(readout).toHaveText("14 px");
    await page.keyboard.press("Meta+0");
    await expect(readout).toHaveText("13 px");

    const updates = (await calls(page))
      .filter((c) => c.cmd === "update_user_settings")
      .map((c) => c.args?.settings?.baseFontSize);
    expect(updates).toEqual([14, 15, 14, 13]);

    // At the default size the reset has nothing to do — no IPC.
    await page.keyboard.press("Meta+0");
    await page.waitForTimeout(250);
    expect(
      (await calls(page)).filter((c) => c.cmd === "update_user_settings"),
    ).toHaveLength(4);
    expect(realErrors(errors), realErrors(errors).join("\n")).toHaveLength(0);
  });

  test("terminal font size: bounds disable the stepper and edge presses fire no IPC", async ({
    page,
  }) => {
    const { errors, sheet } = await gotoSettings(page, "terminal");
    const readout = sheet.getByRole("status");
    await expect(readout).toHaveText("13 px");
    await clearCalls(page);

    const increase = sheet.getByRole("button", {
      name: "Increase terminal font size",
    });
    const decrease = sheet.getByRole("button", {
      name: "Decrease terminal font size",
    });

    // Walk to the ceiling: 13 → 24 is 11 steps.
    for (let s = 14; s <= 24; s++) {
      await increase.click();
      await expect(readout).toHaveText(`${s} px`);
    }
    await expect(increase).toBeDisabled();
    // At the bound the shortcut no-ops — the guard fires no IPC at all.
    await page.keyboard.press("Meta+=");
    await page.waitForTimeout(250);

    await page.keyboard.press("Meta+0");
    await expect(readout).toHaveText("13 px");

    // Walk to the floor: 13 → 9 is 4 steps.
    for (let s = 12; s >= 9; s--) {
      await decrease.click();
      await expect(readout).toHaveText(`${s} px`);
    }
    await expect(decrease).toBeDisabled();
    await page.keyboard.press("Meta+-");
    await page.waitForTimeout(250);

    const updates = (await calls(page))
      .filter((c) => c.cmd === "update_user_settings")
      .map((c) => c.args?.settings?.baseFontSize);
    expect(updates).toEqual([
      14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 13, 12, 11, 10, 9,
    ]);
    expect(realErrors(errors), realErrors(errors).join("\n")).toHaveLength(0);
  });

  test("terminal font size: a failed update rolls the readout back", async ({
    page,
  }) => {
    const { errors, sheet } = await gotoSettings(page, "terminal");
    const readout = sheet.getByRole("status");
    await expect(readout).toHaveText("13 px");
    // goto() re-ran the initScript, so the override must be set AFTER it.
    await setResponse(page, "update_user_settings", {
      __reject: "sqlite is on fire",
    });
    await clearCalls(page);

    await sheet
      .getByRole("button", { name: "Increase terminal font size" })
      .click();
    await waitForCall(page, "update_user_settings");

    // Optimistic 14 flashes, then the rejection rolls the cache back.
    await expect(readout).toHaveText("13 px");
    await expect(
      sheet.getByRole("button", { name: "Decrease terminal font size" }),
    ).toBeEnabled();
    expect(
      (await calls(page)).filter((c) => c.cmd === "update_user_settings"),
    ).toHaveLength(1);
    expect(realErrors(errors), realErrors(errors).join("\n")).toHaveLength(0);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// SETTINGS — Run commands CRUD
// ───────────────────────────────────────────────────────────────────────────
test.describe("Settings · run commands", () => {
  // NOTE: the mock is stateless (mutations don't persist; a refetch returns
  // the seed rows), so each test asserts the IPC fired with the right args
  // rather than post-mutation UI state.
  async function gotoRepos(page: Page) {
    const { sheet } = await gotoSettings(page, "run-commands");
    await expect(
      sheet.getByRole("heading", { name: "Run commands", exact: true }),
    ).toBeVisible();
    // repo-1 seed commands render.
    // (the "When they run" card repeats the command text — take the list)
    await expect(sheet.getByRole("list").getByText("pnpm dev", { exact: true })).toBeVisible();
  }

  /** The add-command form (scopes the ambiguous "Add" submit). */
  const addForm = (page: Page) =>
    page.locator("form", { has: page.getByPlaceholder("Name (e.g. Dev)") });

  test("create → create_run_command with input", async ({ page }) => {
    await gotoRepos(page);
    await page.getByRole("button", { name: "Add command" }).click();
    await page.getByPlaceholder("Name (e.g. Dev)").fill("Lint");
    await page.getByPlaceholder("Command (e.g. npm run dev)").fill("pnpm lint");
    await clearCalls(page);
    await addForm(page)
      .getByRole("button", { name: "Add", exact: true })
      .click();
    await waitForCall(page, "create_run_command");
    const [args] = await argsFor(page, "create_run_command");
    expect(args).toMatchObject({
      input: { name: "Lint", command: "pnpm lint" },
    });
  });

  test("empty add form is validation-guarded (submit disabled)", async ({
    page,
  }) => {
    await gotoRepos(page);
    await page.getByRole("button", { name: "Add command" }).click();
    const submit = addForm(page).getByRole("button", {
      name: "Add",
      exact: true,
    });
    await expect(submit).toBeDisabled();
    await page.getByPlaceholder("Name (e.g. Dev)").fill("X");
    await expect(submit).toBeDisabled(); // command still empty
  });

  test("pin → update_run_command { pinned: true }", async ({ page }) => {
    await gotoRepos(page);
    await clearCalls(page);
    // "test" (rc-2) is unpinned → its button offers to pin.
    await page
      .getByRole("button", { name: /Pin to workspace toolbar/ })
      .click();
    await waitForCall(page, "update_run_command");
    const [args] = await argsFor(page, "update_run_command");
    expect(args).toMatchObject({ id: "rc-2", input: { pinned: true } });
  });

  test("edit → update_run_command with new name", async ({ page }) => {
    await gotoRepos(page);
    await page.getByRole("button", { name: "Edit" }).first().click(); // dev
    const editRow = page.locator("li", {
      has: page.getByRole("button", { name: "Save" }),
    });
    await editRow.locator("input").first().fill("dev-server");
    await clearCalls(page);
    await page.getByRole("button", { name: "Save" }).click();
    await waitForCall(page, "update_run_command");
    const [args] = await argsFor(page, "update_run_command");
    expect(args).toMatchObject({ id: "rc-1", input: { name: "dev-server" } });
  });

  test("delete → confirm dialog → delete_run_command", async ({ page }) => {
    await gotoRepos(page);
    await page.getByRole("button", { name: "Delete" }).last().click(); // test
    const confirm = page.getByRole("dialog");
    await expect(confirm.getByText("Delete run command?")).toBeVisible();
    await clearCalls(page);
    await confirm.getByRole("button", { name: "Delete" }).click();
    await waitForCall(page, "delete_run_command");
    const [args] = await argsFor(page, "delete_run_command");
    expect(args).toEqual({ id: "rc-2" });
  });
});

// ───────────────────────────────────────────────────────────────────────────
// SETTINGS — Account sign out
// ───────────────────────────────────────────────────────────────────────────
test.describe("Settings · account", () => {
  test("Sign out ends the session and lands on /sign-in", async ({ page }) => {
    const { sheet } = await gotoSettings(page, "account");
    await expect(sheet.getByRole("heading", { name: "Account" })).toBeVisible();

    await sheet.getByRole("button", { name: "Sign out" }).click();
    // signOutDesktopSession() → clear_session + navigation to the sign-in gate.
    await page.waitForURL(/\/sign-in/, { timeout: 15_000 });
  });
});

// ───────────────────────────────────────────────────────────────────────────
// COMPLETION NOTIFICATIONS  (phasr://task-status → in-app toast)
// The coalescing buffer flushes after 2500ms, so toasts appear ~2.5s later.
// ───────────────────────────────────────────────────────────────────────────
test.describe("Completion notifications", () => {
  const status = (over: Record<string, unknown>) => ({
    taskId: "ws-done",
    repositoryId: "repo-1",
    status: "completed",
    exitCode: 0,
    ...over,
  });

  test("completion for a NON-viewed workspace → success toast (role=status) with 'Review changes' that navigates", async ({
    page,
  }) => {
    const { errors } = await boot(page);
    // Ensure the sidebar workspace cache is populated so the name resolves.
    await expect(
      page
        .locator('nav[aria-label="Tasks"]')
        .getByText("fix-bug", { exact: true }),
    ).toBeVisible();

    await emit(page, "phasr://task-status", status({}));

    const toast = page
      .getByRole("status")
      .filter({ hasText: "fix-bug finished" });
    await expect(toast).toBeVisible({ timeout: 7000 });
    await expect(toast.locator("svg").first()).toBeVisible(); // intent icon
    // Action navigates to the finished workspace.
    await toast.getByRole("button", { name: "Review changes" }).click();
    await expect(page).toHaveURL(/workspaces\/ws-done/, { timeout: 10_000 });
    expect(realErrors(errors), realErrors(errors).join("\n")).toHaveLength(0);
  });

  test("failed completion → error toast (role=alert) that persists", async ({
    page,
  }) => {
    await boot(page);
    await expect(
      page
        .locator('nav[aria-label="Tasks"]')
        .getByText("fix-bug", { exact: true }),
    ).toBeVisible();

    await emit(
      page,
      "phasr://task-status",
      status({ status: "failed", exitCode: 1 }),
    );
    const toast = page.getByRole("alert").filter({ hasText: "fix-bug failed" });
    await expect(toast).toBeVisible({ timeout: 7000 });
    await expect(toast.getByText("exit code 1")).toBeVisible();
    // Error/action toasts never auto-dismiss.
    await page.waitForTimeout(1500);
    await expect(toast).toBeVisible();
    // Dismiss button removes it.
    await toast.getByRole("button", { name: "Dismiss notification" }).click();
    await expect(toast).toBeHidden();
  });

  test("SUPPRESSION: completion for the CURRENTLY-VIEWED workspace → no toast", async ({
    page,
  }) => {
    await boot(page);
    // Let the workspace route set activeWorkspaceContext.
    await page.waitForTimeout(400);
    await emit(
      page,
      "phasr://task-status",
      status({ taskId: "ws-agent", repositoryId: "repo-1" }),
    );
    // Wait past the 2.5s flush window; the toast must never appear.
    await page.waitForTimeout(3200);
    await expect(page.getByText("add-feature finished")).toHaveCount(0);
    await expect(page.getByRole("status")).toHaveCount(0);
    await expect(page.getByRole("alert")).toHaveCount(0);
  });

  test("LEADING-EDGE (D3): first finish shows immediately; stragglers coalesce", async ({
    page,
  }) => {
    await boot(page);
    await expect(
      page
        .locator('nav[aria-label="Tasks"]')
        .getByText("fix-bug", { exact: true }),
    ).toBeVisible();

    // First non-viewed finish → shown IMMEDIATELY (well under the 2.5s window),
    // not delayed. This is the D3 fix.
    const t0 = Date.now();
    await emit(page, "phasr://task-status", status({ taskId: "ws-done" }));
    await expect(page.getByRole("status").first()).toBeVisible({
      timeout: 1800,
    });
    expect(Date.now() - t0).toBeLessThan(2200);

    // Two more finishes within the cooldown window → they coalesce into one
    // trailing "2 agents finished" summary (leading-edge + trailing coalesce).
    await emit(
      page,
      "phasr://task-status",
      status({ taskId: "ws-other", repositoryId: "repo-1" }),
    );
    await emit(
      page,
      "phasr://task-status",
      status({ taskId: "ws-third", repositoryId: "repo-1" }),
    );
    await expect(
      page.getByRole("status").filter({ hasText: "2 agents finished" }),
    ).toBeVisible({ timeout: 6000 });
  });
});
