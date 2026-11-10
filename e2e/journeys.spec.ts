import { expect, test, type Locator, type Page } from "@playwright/test";
import { boardFixtures } from "./fixtures/board";
import { bootApp, calls, clearCalls, clearResponse, setResponse, waitForCall, world } from "./harness";

/**
 * User journeys, end to end, against the STATEFUL harness backend
 * (`fixtures.stateful`): every mutation changes the store and emits what the
 * real backend emits, so "after doing X, the UI shows Y" is testable.
 *
 * The user acts only through the UI — clicks and keys. Only what happens
 * outside the app (an agent asking, a PR merged on GitHub, the folder the
 * OS picker returns, an injected backend failure) is driven directly. Each
 * journey asserts every surface that should change: sidebar, board, list,
 * title bar, inspector, palette.
 */

const BENIGN = /favicon|sourcemap|Download the React DevTools/i;
const realErrors = (errors: string[]) => errors.filter((e) => !BENIGN.test(e));

type Fixtures = ReturnType<typeof boardFixtures> & Record<string, unknown>;

/** The board fixtures (a card in every lane) as the store's initial state. */
function journeyFixtures(extra: Record<string, unknown> = {}): Fixtures {
  return {
    ...boardFixtures(),
    stateful: true,
    // `dev` confirms a port once it starts.
    runPorts: { "rc-1": 3000 },
    ...extra,
  } as Fixtures;
}

/** Boot on the board (cold launch would otherwise reopen the last task). */
async function bootBoard(page: Page, fixtures: Fixtures = journeyFixtures()) {
  await page.addInitScript(() => {
    if (sessionStorage.getItem("phasr.e2e.booted")) return;
    sessionStorage.setItem("phasr.e2e.booted", "1");
    localStorage.removeItem("phasr.lastWorkspace");
    localStorage.setItem("phasr.board.view", "board");
  });
  const res = await bootApp(page, fixtures as never);
  await expect(page.getByRole("heading", { name: "Board", level: 1 })).toBeVisible({ timeout: 20_000 });
  await expect(column(page, "Running").getByText("fix login redirect bug")).toBeVisible({ timeout: 20_000 });
  return res;
}

// ── surfaces ────────────────────────────────────────────────────────────

const sidebar = (page: Page) => page.getByRole("complementary", { name: "Sidebar" });
const sidebarTasks = (page: Page) => sidebar(page).getByRole("navigation", { name: "Tasks" });
/** A task's sidebar row (its accessible name also carries the agent mark). */
const sidebarRow = (page: Page, name: string) =>
  sidebarTasks(page).getByRole("link").filter({ has: page.getByText(name, { exact: true }) });
const column = (page: Page, name: string) =>
  page.getByRole("region", { name, exact: true }).and(page.locator("[data-board-column]"));
const boardCard = (page: Page, name: string) => page.locator("[data-board-column] [data-lane]").filter({ hasText: name });
const listRows = (page: Page) => page.locator("tbody tr[data-lane]");
const titleBar = (page: Page) => page.locator("header[data-tauri-drag-region]").first();
const inspector = (page: Page) => page.getByRole("complementary", { name: "Inspector" });

/** Every sidebar group a task's row sits in (exactly one, or none). */
async function sidebarGroupsOf(page: Page, name: string): Promise<string[]> {
  return sidebarTasks(page)
    .getByRole("region")
    .evaluateAll(
      (els, n) =>
        els
          .filter((el) => [...el.querySelectorAll("a span")].some((sp) => sp.textContent?.trim() === n))
          .map((el) => el.getAttribute("aria-label") ?? ""),
      name,
    );
}

async function expectSidebarGroup(page: Page, name: string, group: string | null) {
  await expect.poll(() => sidebarGroupsOf(page, name), { message: `"${name}" sidebar group` }).toEqual(group ? [group] : []);
}

/** The board column a card sits in (exactly one, or none). */
async function boardColumnsOf(page: Page, name: string): Promise<string[]> {
  return page.locator("[data-board-column]").evaluateAll(
    (els, n) =>
      els
        .filter((el) => [...el.querySelectorAll("[data-lane]")].some((c) => c.textContent?.includes(n)))
        .map((el) => el.getAttribute("aria-label") ?? ""),
    name,
  );
}

async function expectBoardColumn(page: Page, name: string, col: string | null) {
  await expect.poll(() => boardColumnsOf(page, name), { message: `"${name}" board column` }).toEqual(col ? [col] : []);
}

async function gotoBoard(page: Page) {
  await page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Board" }).click();
  await expect(page).toHaveURL(/\/$|\/\?/);
  await expect(page.getByRole("heading", { name: "Board", level: 1 })).toBeVisible();
}

async function showList(page: Page) {
  await page.getByRole("radio", { name: "List" }).click();
  await expect(listRows(page).first()).toBeVisible();
}

async function showBoard(page: Page) {
  await page.getByRole("radio", { name: "Board" }).click();
  await expect(page.locator("[data-board-column]")).toHaveCount(4);
}

/** Open a task from its sidebar row and wait for its session. */
async function openTask(page: Page, name: string, id: string) {
  await sidebarRow(page, name).click();
  await expect(page).toHaveURL(new RegExp(`workspaces/${id}`));
  await expect(page.getByRole("tablist", { name: "Workspace tabs" })).toBeVisible();
}

/** Click somewhere inert so no terminal or field holds focus (page-level keys). */
async function focusPage(page: Page) {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
}

async function contextMenu(row: Locator, item: string) {
  await row.click({ button: "right" });
  await row.page().getByRole("menuitem", { name: item }).click();
}

const callsOf = async (page: Page, cmd: string) => (await calls(page)).filter((c) => c.cmd === cmd).map((c) => c.args);

// ═══════════════════════════════════════════════════════════════════════
// Close a task from the sidebar
// ═══════════════════════════════════════════════════════════════════════

test.describe("Close task from the sidebar", () => {
  test("the bug: a failed task in Needs you, closed from the sidebar, leaves every surface", async ({ page }) => {
    const { errors } = await bootBoard(page);
    const name = "e2e tests for the board";
    await expectSidebarGroup(page, name, "Needs you");
    await expectBoardColumn(page, name, "Needs you");

    await contextMenu(sidebarRow(page, name), "Close workspace");
    const dialog = page.getByRole("dialog", { name: `Close workspace "${name}"?` });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Close workspace" }).click();
    await expect(dialog).toBeHidden();

    // Gone from the sidebar and the board — and it stays gone once the
    // refetch the backend's task-cards-changed triggers has landed.
    await expectSidebarGroup(page, name, null);
    await expectBoardColumn(page, name, null);
    await waitForCall(page, "list_task_cards");
    await page.waitForTimeout(300);
    await expect(sidebarRow(page, name)).toHaveCount(0);
    await expect(boardCard(page, name)).toHaveCount(0);
    // The approval card is still the only thing in Needs you.
    await expect(column(page, "Needs you").locator("[data-lane]")).toHaveCount(1);

    // …and from the list.
    await showList(page);
    await expect(listRows(page).filter({ hasText: name })).toHaveCount(0);
    await expect(listRows(page).filter({ hasText: "upgrade to tauri v2" })).toHaveCount(1);

    expect(await callsOf(page, "delete_workspace")).toEqual([{ id: "ws-failed" }]);
    expect(realErrors(errors), realErrors(errors).join("\n")).toHaveLength(0);
  });

  test("closing the task you're viewing goes home, and it's gone there too", async ({ page }) => {
    await bootBoard(page);
    const name = "fix login redirect bug";
    await openTask(page, name, "ws-running");
    await expect(titleBar(page)).toContainText(name);

    await contextMenu(sidebarRow(page, name), "Close workspace");
    await page.getByRole("dialog", { name: `Close workspace "${name}"?` }).getByRole("button", { name: "Close workspace" }).click();

    await expect(page).not.toHaveURL(/workspaces\//);
    await expect(page.getByRole("heading", { name: "Board", level: 1 })).toBeVisible();
    await expect(titleBar(page)).not.toContainText(name);
    await expectSidebarGroup(page, name, null);
    await expectBoardColumn(page, name, null);
    await expect(column(page, "Running").locator("[data-lane]")).toHaveText([/add-feature/]);
  });

  test("a failed close says why, closes the dialog, and a retry works", async ({ page }) => {
    await bootBoard(page);
    const name = "move settings into a sheet";
    await setResponse(page, "delete_workspace", { __reject: "worktree is locked by another process" });

    await contextMenu(sidebarRow(page, name), "Close workspace");
    const dialog = page.getByRole("dialog", { name: `Close workspace "${name}"?` });
    await dialog.getByRole("button", { name: "Close workspace" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText(`Couldn't close "${name}"`)).toBeVisible();
    // An error toast stays until dismissed; it must not cover the title
    // bar while it does (here: Search, at the bar's right end).
    await page.getByRole("button", { name: "Search", exact: true }).click({ timeout: 3000 });
    await expect(page.getByPlaceholder("Search tasks, files, commands, settings…")).toBeVisible();
    await page.keyboard.press("Escape");
    // Nothing was removed.
    await expectSidebarGroup(page, name, "Review");
    await expectBoardColumn(page, name, "Review");

    // The second Close does something.
    await clearResponse(page, "delete_workspace");
    await contextMenu(sidebarRow(page, name), "Close workspace");
    await dialog.getByRole("button", { name: "Close workspace" }).click();
    await expect(dialog).toBeHidden();
    await expectSidebarGroup(page, name, null);
    await expectBoardColumn(page, name, null);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// New task
// ═══════════════════════════════════════════════════════════════════════

test.describe("New task", () => {
  test("⌘N → prompt, agent, base, permissions → Start: Running in the sidebar and board, session open", async ({ page }) => {
    const { errors } = await bootBoard(page);
    await focusPage(page);
    await page.keyboard.press("Meta+n");
    const dialog = page.getByRole("dialog", { name: "New task · phasr" });
    await expect(dialog).toBeVisible();

    await page.locator("#new-task-prompt").fill("Add a dark mode toggle to the settings sheet");
    await page.locator("#new-task-name").fill("dark mode toggle");

    await dialog.getByRole("button", { name: "Agent: Claude" }).click();
    await page.locator("#new-task-agent").getByRole("menuitemradio", { name: "Codex" }).click();
    await expect(dialog.getByRole("button", { name: "Agent: Codex" })).toBeVisible();

    await dialog.getByRole("button", { name: "Base branch: main" }).click();
    await page.getByRole("listbox", { name: "Base branch" }).getByRole("option", { name: "dev" }).click();
    await expect(dialog.getByRole("button", { name: "Base branch: dev" })).toBeVisible();

    await dialog.getByRole("button", { name: /^Permissions:/ }).click();
    await page.getByRole("menuitemradio", { name: /Ask for edits/ }).click();
    await expect(dialog.getByRole("button", { name: "Permissions: Ask for edits" })).toBeVisible();

    await dialog.getByRole("button", { name: "Start task", exact: true }).click();
    await expect(dialog).toBeHidden();

    // The session opens on the new task…
    await expect(page).toHaveURL(/workspaces\/ws-new-1/);
    await expect(titleBar(page)).toContainText("dark mode toggle");
    await expect(titleBar(page)).toContainText("phasr/dark-mode-toggle");
    await expect(inspector(page)).toContainText("Codex");
    await expect(inspector(page)).toContainText("dev");
    await expect(inspector(page)).toContainText("Ask for edits");
    // …it's under Running in the sidebar, the active row…
    await expectSidebarGroup(page, "dark mode toggle", "Running");
    await expect(sidebarRow(page, "dark mode toggle")).toHaveAttribute("aria-current", "page");
    // …the palette finds it…
    await focusPage(page);
    await page.keyboard.press("Meta+k");
    await page.getByPlaceholder("Search tasks, files, commands, settings…").fill("dark mode");
    await expect(page.getByRole("option", { name: /^dark mode toggle Codex · running/ })).toBeVisible();
    await page.keyboard.press("Escape");
    // …and it's on the board in Running.
    await gotoBoard(page);
    await expectBoardColumn(page, "dark mode toggle", "Running");

    const [args] = await callsOf(page, "start_task");
    expect((args as { input: unknown }).input).toEqual({
      repositoryId: "repo-1",
      agent: "codex",
      name: "dark mode toggle",
      prompt: "Add a dark mode toggle to the settings sheet",
      baseBranch: "dev",
      permissionMode: "ask-edits",
    });
    expect(realErrors(errors), realErrors(errors).join("\n")).toHaveLength(0);
  });

  test("⌘⇧↵ saves a draft into Queued; Start now moves it to Running", async ({ page }) => {
    await bootBoard(page);
    await focusPage(page);
    await page.keyboard.press("Meta+n");
    const dialog = page.getByRole("dialog", { name: "New task · phasr" });
    await page.locator("#new-task-prompt").fill("Write the release notes for 0.5");
    await page.locator("#new-task-name").fill("release notes 0.5");
    await page.keyboard.press("Meta+Shift+Enter");
    await expect(dialog).toBeHidden();
    await waitForCall(page, "create_task_draft");

    // A draft lives on the board, in Queued — not in the sidebar.
    await gotoBoard(page);
    await expectBoardColumn(page, "release notes 0.5", "Queued");
    await expectSidebarGroup(page, "release notes 0.5", null);
    expect(await callsOf(page, "start_task")).toHaveLength(0);

    await boardCard(page, "release notes 0.5").getByRole("button", { name: /Start now/ }).click();
    await expect(page).toHaveURL(/workspaces\/ws-new-1/);
    await expect(titleBar(page)).toContainText("release notes 0.5");
    await expectSidebarGroup(page, "release notes 0.5", "Running");
    await gotoBoard(page);
    await expectBoardColumn(page, "release notes 0.5", "Running");
    expect(await callsOf(page, "start_queued_task")).toEqual([expect.objectContaining({ id: "ws-new-1" })]);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Rename, archive, stop
// ═══════════════════════════════════════════════════════════════════════

test.describe("Task lifecycle", () => {
  test("Rename… shows the new name in the sidebar, board card, title bar and palette", async ({ page }) => {
    await bootBoard(page);
    await openTask(page, "fix login redirect bug", "ws-running");

    await contextMenu(sidebarRow(page, "fix login redirect bug"), "Rename…");
    const dialog = page.getByRole("dialog", { name: "Rename workspace" });
    await dialog.getByRole("textbox", { name: "Workspace name" }).fill("fix the OAuth redirect loop");
    await dialog.getByRole("button", { name: "Save" }).click();
    await expect(dialog).toBeHidden();

    await expect(titleBar(page)).toContainText("fix the OAuth redirect loop");
    await expect(sidebarRow(page, "fix the OAuth redirect loop")).toHaveAttribute("aria-current", "page");
    await expect(sidebarRow(page, "fix login redirect bug")).toHaveCount(0);

    await focusPage(page);
    await page.keyboard.press("Meta+k");
    await page.getByPlaceholder("Search tasks, files, commands, settings…").fill("OAuth redirect");
    await expect(page.getByRole("option", { name: /^fix the OAuth redirect loop Claude/ })).toBeVisible();
    await page.keyboard.press("Escape");

    await gotoBoard(page);
    await expectBoardColumn(page, "fix the OAuth redirect loop", "Running");
    await expect(boardCard(page, "fix login redirect bug")).toHaveCount(0);
    await showList(page);
    await expect(listRows(page).filter({ hasText: "fix the OAuth redirect loop" })).toHaveCount(1);
    await expect(listRows(page).filter({ hasText: "fix login redirect bug" })).toHaveCount(0);
    await showBoard(page);
  });

  test("Archive (Open in ▾) leaves Running and shows under Done", async ({ page }) => {
    await bootBoard(page);
    await expect(column(page, "Review").getByText("2 merged today")).toBeVisible();
    await openTask(page, "fix login redirect bug", "ws-running");

    await page.getByRole("button", { name: "Open in" }).click();
    await page.getByRole("menuitem", { name: "Archive" }).click();

    await expect(page.getByRole("heading", { name: "Board", level: 1 })).toBeVisible();
    await expectBoardColumn(page, "fix login redirect bug", null);
    await expect(column(page, "Review").getByText("3 done today")).toBeVisible();
    await expectSidebarGroup(page, "fix login redirect bug", "Done");

    await page.getByRole("button", { name: "Show done tasks" }).click();
    await expect(listRows(page).filter({ hasText: "fix login redirect bug" })).toHaveCount(1);
    expect(await callsOf(page, "archive_workspace")).toEqual([{ id: "ws-running" }]);
  });

  test("Stop (⌘. → confirm) updates the session, sidebar, title bar and board", async ({ page }) => {
    await bootBoard(page);
    await openTask(page, "fix login redirect bug", "ws-running");
    await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
    await expect(page.getByLabel("Message Claude")).toBeVisible();

    await page.keyboard.press("Meta+.");
    const confirm = page.getByRole("dialog", { name: "Stop Claude?" });
    await expect(confirm).toBeVisible();
    await confirm.getByRole("button", { name: "Stop agent" }).click();
    await expect(confirm).toBeHidden();

    // It has changes, so it's waiting for review now.
    await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
    await expect(page.getByLabel("Message Claude")).toHaveCount(0);
    await expectSidebarGroup(page, "fix login redirect bug", "Review");
    await expect(titleBar(page).locator("span[style*='status-review']")).toHaveCount(1);
    await gotoBoard(page);
    await expectBoardColumn(page, "fix login redirect bug", "Review");
    await showList(page);
    await expect(listRows(page).filter({ hasText: "fix login redirect bug" })).toHaveAttribute("data-lane", "review");
    expect(await callsOf(page, "stop_task")).toEqual([{ taskId: "ws-running" }]);
  });

  test("Stop from the button: a fresh task with no changes is Done", async ({ page }) => {
    await bootBoard(page);
    await focusPage(page);
    await page.keyboard.press("Meta+n");
    await page.locator("#new-task-prompt").fill("Try something small");
    await page.locator("#new-task-name").fill("small experiment");
    await page.getByRole("button", { name: "Start task", exact: true }).click();
    await expect(page).toHaveURL(/workspaces\/ws-new-1/);

    await page.getByRole("button", { name: "Stop", exact: true }).click();
    await page.getByRole("dialog", { name: "Stop Claude?" }).getByRole("button", { name: "Stop agent" }).click();
    await expectSidebarGroup(page, "small experiment", "Done");
    await gotoBoard(page);
    await expectBoardColumn(page, "small experiment", null);
    await expect(column(page, "Review").getByText("3 done today")).toBeVisible();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Needs you
// ═══════════════════════════════════════════════════════════════════════

test.describe("Needs you", () => {
  test("the agent asks: approval card, composer hidden, amber dot; ⌘⌫ denies from the session", async ({ page }) => {
    await bootBoard(page);
    await openTask(page, "fix login redirect bug", "ws-running");
    await expect(page.getByLabel("Message Claude")).toBeVisible();

    await world.agentAsks(page, "ws-running", { detail: "rm -rf node_modules" });

    const card = page.getByRole("alertdialog", { name: "Claude wants to run a shell command" });
    await expect(card).toBeVisible();
    await expect(card).toContainText("rm -rf node_modules");
    // The composer waits for the answer instead.
    await expect(page.getByLabel("Message Claude")).toHaveCount(0);
    await expect(page.getByText("Answer the request above to continue messaging Claude.")).toBeVisible();
    await expect(inspector(page).getByRole("region", { name: "Needs you" })).toBeVisible();
    await expectSidebarGroup(page, "fix login redirect bug", "Needs you");
    await expect(sidebarRow(page, "fix login redirect bug").locator("span[style*='status-attention']")).toHaveCount(1);
    await expect(titleBar(page).locator("span[style*='status-attention']")).toHaveCount(1);

    await focusPage(page);
    await page.keyboard.press("Meta+Backspace");
    await expect(card).toBeHidden();
    const sent = await callsOf(page, "respond_to_attention");
    expect(sent).toEqual([expect.objectContaining({ taskId: "ws-running", response: "deny" })]);

    await expect(page.getByLabel("Message Claude")).toBeVisible();
    await expectSidebarGroup(page, "fix login redirect bug", "Running");
    await expect(sidebarRow(page, "fix login redirect bug").locator("span[style*='status-running']")).toHaveCount(1);
  });

  test("on a shell tab the card stays on the agent's pane: the agent tab says needs you, ⌘Y does nothing", async ({ page }) => {
    await bootBoard(page);
    await openTask(page, "fix login redirect bug", "ws-running");
    const tabs = page.getByRole("tablist", { name: "Workspace tabs" });
    const agentTab = tabs.getByRole("tab", { name: /^Claude/ });
    await page.getByRole("button", { name: "New pane" }).click();
    await page.getByRole("menuitem", { name: "New terminal" }).click();
    await expect(tabs.getByRole("tab", { name: /^Terminal/ })).toHaveAttribute("aria-selected", "true");

    await world.agentAsks(page, "ws-running", { detail: "rm -rf node_modules" });
    // The sidebar still says so…
    await expectSidebarGroup(page, "fix login redirect bug", "Needs you");
    // …but no card over the shell; the agent tab carries it instead.
    const card = page.getByRole("alertdialog", { name: "Claude wants to run a shell command" });
    await expect(agentTab).toContainText("needs you");
    await expect(agentTab.locator("[data-needs-you] span[style*='status-attention']")).toHaveCount(1);
    await expect(card).toHaveCount(0);

    // ⌘Y / ⌘⌫ answer only a card you can see — even from the page, where
    // they'd fire if the card were up.
    await focusPage(page);
    await page.keyboard.press("Meta+y");
    await page.keyboard.press("Meta+Backspace");
    await page.waitForTimeout(300);
    expect(await callsOf(page, "respond_to_attention")).toEqual([]);

    // Changes / Files: still no card, still marked.
    await tabs.getByRole("tab", { name: /^Changes/ }).click();
    await expect(card).toHaveCount(0);
    await expect(agentTab).toContainText("needs you");

    // The agent tab is the way there.
    await agentTab.click();
    await expect(card).toBeVisible();
    await expect(card).toContainText("rm -rf node_modules");
    await expect(agentTab).not.toContainText("needs you");
    await focusPage(page);
    await page.keyboard.press("Meta+y");
    await expect(card).toBeHidden();
    expect(await callsOf(page, "respond_to_attention")).toEqual([
      expect.objectContaining({ taskId: "ws-running", response: "allow-once" }),
    ]);
  });

  test("Allow from the board card moves it out of Needs you", async ({ page }) => {
    await bootBoard(page);
    const attId = await world.agentAsks(page, "ws-running", { detail: "pnpm test" });
    await expectBoardColumn(page, "fix login redirect bug", "Needs you");
    const card = boardCard(page, "fix login redirect bug");
    await expect(card).toContainText("pnpm test");
    await expect(card.getByRole("button", { name: "Deny", exact: true })).toBeVisible();
    await expectSidebarGroup(page, "fix login redirect bug", "Needs you");

    await card.getByRole("button", { name: "Allow", exact: true }).click();
    await expectBoardColumn(page, "fix login redirect bug", "Running");
    await expectSidebarGroup(page, "fix login redirect bug", "Running");
    expect(await callsOf(page, "respond_to_attention")).toEqual([
      { taskId: "ws-running", attentionId: attId, response: "allow-once" },
    ]);
    // Answering doesn't open the task.
    await expect(page).not.toHaveURL(/workspaces\//);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Review close-out
// ═══════════════════════════════════════════════════════════════════════

test.describe("Review close-out", () => {
  test("Approve & create PR opens the PR; once it merges on GitHub the task is Done everywhere", async ({ page }) => {
    await bootBoard(page);
    await column(page, "Review").getByRole("link", { name: "move settings into a sheet" }).click();
    await expect(page).toHaveURL(/workspaces\/ws-review-1/);
    const approve = page.getByRole("button", { name: /Approve & create PR/ });
    await approve.click();
    await expect(page.getByText("PR #42 opened")).toBeVisible();
    await expect(page.getByRole("button", { name: /PR #42 open/ })).toBeVisible();
    // An open PR is still in review.
    await expectSidebarGroup(page, "move settings into a sheet", "Review");

    // Merged on GitHub; phasr re-reads PRs when the window regains focus.
    await world.prMergedOnRemote(page, "ws-review-1");
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await waitForCall(page, "refresh_pr_states");

    await expectSidebarGroup(page, "move settings into a sheet", "Done");
    await expect(titleBar(page).locator("span[style*='status-success']")).toHaveCount(1);
    await expect(page.getByRole("button", { name: /PR #42 open/ })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Merge locally" })).toBeDisabled();
    await gotoBoard(page);
    await expectBoardColumn(page, "move settings into a sheet", null);
    await expect(column(page, "Review").getByText("3 merged today")).toBeVisible();
  });

  test("Merge locally with a dirty worktree: commit everything and merge → Done", async ({ page }) => {
    await bootBoard(page, journeyFixtures({ taskMeta: { "ws-review-2": { dirty: true } } }));
    await column(page, "Review").getByRole("link", { name: "write changelog for 0.4" }).click();
    await expect(page).toHaveURL(/workspaces\/ws-review-2/);

    await page.getByRole("button", { name: "Merge locally" }).click();
    const dialog = page.getByRole("dialog", { name: "Merge into main" });
    await dialog.getByRole("button", { name: "Merge", exact: true }).click();
    const gate = dialog.getByRole("alert");
    await expect(gate).toContainText("uncommitted changes");
    await gate.getByRole("button", { name: "Commit everything and merge" }).click();
    await expect(dialog).toBeHidden({ timeout: 5000 });

    const merges = await callsOf(page, "git_merge_to_main");
    expect(merges).toEqual([
      { workspaceId: "ws-review-2", strategy: "merge" },
      { workspaceId: "ws-review-2", strategy: "merge", commitDirty: true },
    ]);
    await expectSidebarGroup(page, "write changelog for 0.4", "Done");
    await expect(titleBar(page).locator("span[style*='status-success']")).toHaveCount(1);
    // Merged: the close-out actions are spent.
    await expect(page.getByRole("button", { name: "Merge locally" })).toBeDisabled();
    await expect(page.getByRole("button", { name: /Approve & create PR/ })).toBeDisabled();
    await gotoBoard(page);
    await expectBoardColumn(page, "write changelog for 0.4", null);
    await expect(column(page, "Review").getByText("3 merged today")).toBeVisible();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Run command
// ═══════════════════════════════════════════════════════════════════════

test.describe("Run command", () => {
  test("+ → dev: the tab shows its port; Stop stops it; another task doesn't start it", async ({ page }) => {
    await bootBoard(page);
    await openTask(page, "fix login redirect bug", "ws-running");
    const tabs = page.getByRole("tablist", { name: "Workspace tabs" });

    await page.getByRole("button", { name: "New pane" }).click();
    await page.getByRole("menuitem", { name: /^dev/ }).click();
    const devTab = tabs.getByRole("tab", { name: /dev/ });
    await expect(devTab).toBeVisible();
    await expect(devTab).toContainText(":3000");
    const run = inspector(page).getByRole("region", { name: "Run" });
    await expect(run.getByRole("button", { name: "Stop dev" })).toBeAttached();
    expect(await callsOf(page, "start_run_command")).toEqual([
      expect.objectContaining({ id: "rc-1", workspaceId: "ws-running" }),
    ]);

    // Another task: no dev tab there, and nothing started for it.
    await openTask(page, "move settings into a sheet", "ws-review-1");
    await expect(tabs.getByRole("tab", { name: /dev/ })).toHaveCount(0);
    await expect(inspector(page).getByRole("region", { name: "Run" }).getByRole("button", { name: "Run dev" })).toBeAttached();
    expect(await callsOf(page, "start_run_command")).toHaveLength(1);

    // Back: still running, port and all.
    await openTask(page, "fix login redirect bug", "ws-running");
    await expect(devTab).toContainText(":3000");

    await run.getByRole("button", { name: "Stop dev" }).focus();
    await run.getByRole("button", { name: "Stop dev" }).click();
    await expect(tabs.getByRole("tab", { name: /dev/ })).toHaveCount(0);
    await expect(run.getByRole("button", { name: "Run dev" })).toBeAttached();
    expect(await callsOf(page, "stop_run_command")).toEqual([{ id: "rc-1", workspaceId: "ws-running" }]);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Settings
// ═══════════════════════════════════════════════════════════════════════

test.describe("Settings", () => {
  test("accent and default permission mode persist, and New task uses the new default", async ({ page }) => {
    await bootBoard(page);
    await focusPage(page);
    await page.keyboard.press("Meta+,");
    const sheet = page.getByRole("dialog", { name: "Settings" });
    await expect(sheet).toBeVisible();
    const nav = sheet.getByRole("navigation", { name: "Settings sections" });

    await nav.getByRole("button", { name: "Appearance" }).click();
    await sheet.getByRole("radio", { name: "Violet" }).click();
    await expect(sheet.getByRole("radio", { name: "Violet" })).toHaveAttribute("aria-checked", "true");

    await nav.getByRole("button", { name: "Agents & keys" }).click();
    const mode = sheet.getByRole("radiogroup", { name: "Default permission mode" });
    await mode.getByRole("radio", { name: "Ask for edits" }).click();
    await expect(mode.getByRole("radio", { name: "Ask for edits" })).toHaveAttribute("aria-checked", "true");

    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();
    await page.keyboard.press("Meta+,");
    await expect(sheet).toBeVisible();
    await expect(mode.getByRole("radio", { name: "Ask for edits" })).toHaveAttribute("aria-checked", "true");
    await nav.getByRole("button", { name: "Appearance" }).click();
    await expect(sheet.getByRole("radio", { name: "Violet" })).toHaveAttribute("aria-checked", "true");
    await page.keyboard.press("Escape");

    // Relaunch: the values come back from the backend.
    await page.reload();
    await expect(page.getByRole("heading", { name: "Board", level: 1 })).toBeVisible({ timeout: 20_000 });
    await focusPage(page);
    await page.keyboard.press("Meta+,");
    await nav.getByRole("button", { name: "Agents & keys" }).click();
    await expect(mode.getByRole("radio", { name: "Ask for edits" })).toHaveAttribute("aria-checked", "true");
    await nav.getByRole("button", { name: "Appearance" }).click();
    await expect(sheet.getByRole("radio", { name: "Violet" })).toHaveAttribute("aria-checked", "true");
    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();

    await page.keyboard.press("Meta+n");
    const dialog = page.getByRole("dialog", { name: "New task · phasr" });
    await expect(dialog.getByRole("button", { name: "Permissions: Ask for edits" })).toBeVisible();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Repositories
// ═══════════════════════════════════════════════════════════════════════

test.describe("Repositories", () => {
  const footer = (page: Page) => sidebar(page).getByRole("navigation", { name: "Repositories" });
  /** The repo switcher's entries (each label is preceded by its repo mark's letter). */
  async function switcherNames(page: Page) {
    await page.getByRole("button", { name: /^Repository:/ }).click();
    const names = await page.getByRole("menuitem").evaluateAll((els) => els.map((el) => el.textContent?.trim() ?? ""));
    await page.keyboard.press("Escape");
    return names.map((n) => n.replace(/^[A-Z](?=[a-z])/, ""));
  }

  test("add a repository (folder picker) → footer and switcher; remove it → gone from both", async ({ page }) => {
    await bootBoard(page);
    await setResponse(page, "plugin:dialog|open", "/Users/test/code/widgets");
    await sidebar(page).getByRole("button", { name: "Add repository" }).click();
    await page.getByRole("dialog", { name: "Add a repository" }).getByText("Open existing").click();
    await waitForCall(page, "create_repository");

    await gotoBoard(page);
    await expect(footer(page).getByRole("button", { name: "widgets", exact: true })).toBeVisible();
    expect(await switcherNames(page)).toContain("widgets");

    await footer(page).getByRole("button", { name: "widgets", exact: true }).click({ button: "right" });
    await page.getByRole("menuitem", { name: "Remove project" }).click();
    await page.getByRole("dialog", { name: /Remove project "widgets"\?/ }).getByRole("button", { name: /Remove/ }).click();
    await expect(footer(page).getByRole("button", { name: "widgets", exact: true })).toHaveCount(0);
    expect(await switcherNames(page)).not.toContain("widgets");
  });

  test("removing a repository takes its tasks off the board", async ({ page }) => {
    await bootBoard(page);
    await expectBoardColumn(page, "regenerate API reference from openapi.json", "Queued");

    await footer(page).getByRole("button", { name: "sidecar", exact: true }).click({ button: "right" });
    await page.getByRole("menuitem", { name: "Remove project" }).click();
    await page.getByRole("dialog", { name: /Remove project "sidecar"\?/ }).getByRole("button", { name: /Remove/ }).click();

    await expect(footer(page).getByRole("button", { name: "sidecar", exact: true })).toHaveCount(0);
    await expectBoardColumn(page, "regenerate API reference from openapi.json", null);
    await showList(page);
    await expect(listRows(page).filter({ hasText: "regenerate API reference" })).toHaveCount(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Panels and keys
// ═══════════════════════════════════════════════════════════════════════

test.describe("Panels and keys", () => {
  test("⌘B / ⌘I slide the panels; Esc closes dialogs; ⌘K opens a task by name", async ({ page }) => {
    await bootBoard(page);
    await openTask(page, "fix login redirect bug", "ws-running");
    await focusPage(page);

    await page.keyboard.press("Meta+b");
    await expect(page.getByRole("button", { name: "Expand task list" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Collapse task list" })).toHaveCount(0);
    await page.keyboard.press("Meta+b");
    await expect(page.getByRole("button", { name: "Collapse task list" })).toBeVisible();

    await page.keyboard.press("Meta+i");
    await expect(inspector(page).getByRole("button", { name: "Show inspector" })).toBeVisible();
    await page.keyboard.press("Meta+i");
    await expect(inspector(page).getByRole("region", { name: "Run" })).toBeVisible();

    await page.keyboard.press("Meta+n");
    await expect(page.getByRole("dialog", { name: "New task · phasr" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "New task · phasr" })).toBeHidden();

    await page.keyboard.press("Meta+k");
    const search = page.getByPlaceholder("Search tasks, files, commands, settings…");
    await expect(search).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(search).toBeHidden();

    await page.keyboard.press("Meta+k");
    await search.fill("changelog");
    await expect(page.getByRole("option", { name: /^write changelog for 0\.4 Claude/ })).toBeVisible();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/workspaces\/ws-review-2/);
    await expect(titleBar(page)).toContainText("write changelog for 0.4");
    await expect(sidebarRow(page, "write changelog for 0.4")).toHaveAttribute("aria-current", "page");
  });

  test("task shortcuts don't fire behind the Settings sheet", async ({ page }) => {
    await bootBoard(page);
    await openTask(page, "fix login redirect bug", "ws-running");
    await focusPage(page);
    await page.keyboard.press("Meta+,");
    const sheet = page.getByRole("dialog", { name: "Settings" });
    await expect(sheet).toBeVisible();
    await clearCalls(page);

    for (const key of ["Meta+n", "Meta+t", "Meta+.", "Meta+i", "Meta+b", "Meta+Shift+r", "Meta+1"]) {
      await page.keyboard.press(key);
    }
    await expect(sheet).toBeVisible();
    await expect(page.getByRole("dialog", { name: "New task · phasr" })).toHaveCount(0);
    await expect(page.getByRole("dialog", { name: "Stop Claude?" })).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();

    // Nothing changed underneath: same panels, same tabs, nothing started.
    await expect(page.getByRole("button", { name: "Collapse task list" })).toBeVisible();
    await expect(inspector(page).getByRole("region", { name: "Run" })).toBeVisible();
    const tabs = page.getByRole("tablist", { name: "Workspace tabs" }).getByRole("tab");
    await expect(tabs).toHaveText([/Claude/, /Changes/, /Files/]);
    const names = (await calls(page)).map((c) => c.cmd);
    expect(names).not.toContain("start_run_command");
    expect(names).not.toContain("start_session_terminal");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Board ↔ session
// ═══════════════════════════════════════════════════════════════════════

test.describe("Board ↔ session", () => {
  test("card → session → Board → back again: one row per task, no stale lanes", async ({ page }) => {
    await bootBoard(page);

    await column(page, "Running").getByRole("link", { name: "fix login redirect bug" }).click();
    await expect(page).toHaveURL(/workspaces\/ws-running/);
    await expect(titleBar(page)).toContainText("fix login redirect bug");

    // Something changes while you're in the session.
    await page.getByRole("button", { name: "Stop", exact: true }).click();
    await page.getByRole("dialog", { name: "Stop Claude?" }).getByRole("button", { name: "Stop agent" }).click();
    await expectSidebarGroup(page, "fix login redirect bug", "Review");

    await gotoBoard(page);
    await expectBoardColumn(page, "fix login redirect bug", "Review");
    await column(page, "Review").getByRole("link", { name: "fix login redirect bug" }).click();
    await expect(page).toHaveURL(/workspaces\/ws-running/);
    await gotoBoard(page);
    await column(page, "Needs you").getByRole("link", { name: "upgrade to tauri v2" }).click();
    await expect(page).toHaveURL(/workspaces\/ws-needs/);
    await expect(titleBar(page)).toContainText("upgrade to tauri v2");
    await gotoBoard(page);

    // Each task once in the sidebar, once on the board.
    const rows = (await sidebarTasks(page).locator("a span.truncate").allTextContents()).map((n) => n.trim());
    expect(new Set(rows).size, rows.join(", ")).toBe(rows.length);
    const cards = await page.locator("[data-board-column] [data-lane]").evaluateAll((els) =>
      els.map((el) => el.closest("[data-workspace-id]")?.getAttribute("data-workspace-id") ?? el.textContent),
    );
    expect(new Set(cards).size, cards.join(", ")).toBe(cards.length);
    await expectBoardColumn(page, "fix login redirect bug", "Review");
    await expectSidebarGroup(page, "fix login redirect bug", "Review");
  });
});
