import { test, expect, type Page } from "@playwright/test";
import {
  bootApp,
  callNames,
  clearCalls,
  makeFixtures,
  waitForCall,
} from "./harness";

/**
 * The REAL "New workflow" entry point (S1 enablement). Unlike board.spec.ts (which
 * drives the dev-only /design-test harness), this boots the ACTUAL app with a
 * mocked Tauri IPC and exercises the discoverable affordances a user reaches:
 *
 *   1. the repo-home pane's "New workflow" button (CreateFirstWorkspacePane), and
 *   2. the sidebar repo context menu's "New workflow" peer of
 *      "New workspace" (RepositorySidebarMenu),
 *
 * asserting each opens the shared Dialog + DecomposeForm, that the gate fires
 * `start_decomposition` exactly once, and that success navigates to the board
 * route (`/repositories/$repositoryId/board/$parentId`) which then renders.
 */

const BENIGN =
  /__TAURI|invoke|clerk|Clerk|sentry|Sentry|supabase|favicon|sourcemap|Outdated Optimize Dep|net::|Failed to load resource|permission|ResizeObserver|homeDir|plugin:/i;

function realErrors(errors: string[]) {
  return errors.filter((e) => !BENIGN.test(e));
}

/** Boot and wait until the shell has settled on the seeded workspace. */
async function boot(page: Page, fixtures = makeFixtures()) {
  const res = await bootApp(page, fixtures);
  await expect(page).toHaveURL(/workspaces\/ws-agent/, { timeout: 25_000 });
  return res;
}

/** Count how many times a given invoke command fired. */
async function callCount(page: Page, cmd: string) {
  return (await callNames(page)).filter((c) => c === cmd).length;
}

/**
 * Drive the Planner review surface to a startable draft: type a goal, run the
 * planner (mocked `plan_decomposition` → a canned ProposedPlan), and wait for
 * the editable tickets to render so "Start N agents" un-gates.
 */
async function planAndReview(
  page: Page,
  dialog: ReturnType<Page["getByRole"]>,
) {
  await dialog.getByTestId("decompose-goal").fill("Add task comments to checkout");
  await dialog.getByTestId("decompose-plan").click();
  await waitForCall(page, "plan_decomposition");
  await expect(dialog.getByTestId("decompose-ticket").first()).toBeVisible();
}

test.describe("New workflow entry point (real app)", () => {
  test("repo-home 'New workflow' button opens the decompose form, then navigates to the board", async ({
    page,
  }) => {
    const { errors } = await boot(page);

    // Enter a workspace-less repo (sidecar) so its home renders the
    // RepoEntryChoice onboarding surface, whose "New workflow" card is a
    // discoverable peer of the single-agent "New task" card — clearly separate
    // from the single-agent create-first-workspace flow.
    await page.locator('[aria-label="sidecar"]').first().click();
    const newEpic = page.getByRole("button", { name: "New workflow in sidecar" });
    await expect(newEpic).toBeVisible({ timeout: 15_000 });
    await newEpic.click();

    // The shared Dialog shell + existing DecomposeForm open.
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("New workflow · sidecar")).toBeVisible();
    const form = dialog.getByTestId("decompose-form");
    await expect(form).toBeVisible();

    // The gate holds until the user has reviewed a plan (nothing to start yet).
    const submit = dialog.getByTestId("decompose-submit");
    await expect(submit).toBeDisabled();
    await planAndReview(page, dialog);
    await expect(submit).toBeEnabled();

    await clearCalls(page);
    await submit.click();

    // Exactly one start_decomposition — the D1 gate holds, no auto-fan-out.
    await expect.poll(() => callCount(page, "start_decomposition")).toBe(1);

    // Success navigates to the board route for the new parent…
    await expect(page).toHaveURL(/repositories\/repo-2\/board\/parent-new/, {
      timeout: 10_000,
    });
    // …and the board renders end-to-end (get_board → BoardView cards).
    await expect(
      page.locator('[data-testid="board-card"][data-role="backend"]'),
    ).toBeVisible({ timeout: 10_000 });

    const bad = realErrors(errors);
    expect(bad, bad.join("\n---\n")).toHaveLength(0);
  });

  test("a repo whose only workspace is the auto-seeded local terminal lands on the choice screen, not the terminal", async ({
    page,
  }) => {
    // Reproduce a freshly-added repo: the backend `create_repository`
    // auto-seeds a `local` (terminal) workspace, so listWorkspaces is NON-empty.
    // useNavigateToRepoEntry must skip that local row and still route to the
    // repo-home RepoEntryChoice screen — not drop the user into a bare terminal.
    const f = makeFixtures();
    const localTemplate = f.workspaces.find((w) => w.id === "ws-local");
    if (!localTemplate) throw new Error("harness missing ws-local template");
    f.workspaces.push({
      ...localTemplate,
      id: "ws-local-sidecar",
      repositoryId: "repo-2",
      name: "main",
      worktreePath: "/Users/test/code/sidecar",
    });
    await boot(page, f);

    // Enter sidecar (repo-2) — its ONLY workspace is the local terminal.
    await page.locator('[aria-label="sidecar"]').first().click();

    // Lands on the RepoEntryChoice onboarding (all three cards), NOT a terminal.
    await expect(
      page.getByRole("heading", { name: "sidecar is ready" }),
    ).toBeVisible({ timeout: 15_000 });
    await expect(
      page.getByRole("button", { name: "New task in sidecar" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "New workflow in sidecar" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Open terminal in sidecar" }),
    ).toBeVisible();
    await expect(page).not.toHaveURL(/workspaces\//);
  });

  test("sidebar repo menu 'New workflow' opens the decompose form (peer of New workspace)", async ({
    page,
  }) => {
    await boot(page);

    // Right-click any repo row to reveal the context menu; "New workflow" sits right
    // below "New workspace" — the exact peer of the single-agent trigger. (The
    // ticket count is the planner's call, never a fixed "2 agents" in the label.)
    await page.locator('[aria-label="phasr"]').first().click({ button: "right" });
    await page.getByRole("menuitem", { name: "New workflow" }).click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("New workflow · phasr")).toBeVisible();
    await expect(dialog.getByTestId("decompose-form")).toBeVisible();

    // Cancel closes without persisting anything (nothing fired before the gate).
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByRole("dialog")).toBeHidden();
    expect(await callCount(page, "start_decomposition")).toBe(0);
  });
});

/**
 * The epic node + subtask drill-in navigation (Direction A). The harness seeds a
 * persisted decomposition on repo-1 (parent `epic-1` + `backend`/`frontend`
 * subtasks). Asserts the epic becomes a collapsible sidebar node whose subtasks
 * nest as the existing workspace rows, that a subtask row drills into the
 * `/workspaces/$workspaceId` detail verbatim, that the breadcrumbs navigate back,
 * that a not-started subtask lands on the honest "waiting" pane, and that a repo
 * with no epics keeps the single-agent sidebar untouched.
 */
const EPIC_GOAL = "Add a task-comments API and wire the comments UI";

test.describe("Epic node + subtask drill-in (Direction A)", () => {
  test("the epic renders as a sidebar node, expands to subtask rows, and is absent for a single-agent repo", async ({
    page,
  }) => {
    const { errors } = await boot(page);

    // The epic is a discoverable node in the sidebar (a peer of the workspace
    // list); its label carries the epic goal — meaning on text, not glyph alone.
    const epicNode = page.locator(`[aria-label="Workflow: ${EPIC_GOAL}"]`);
    await expect(epicNode.first()).toBeVisible({ timeout: 15_000 });

    // Progressive disclosure: exactly ONE epic node in the whole tree (repo-1's).
    // sidecar (repo-2) is a single-agent repo and contributes none.
    await expect(page.locator('[aria-label^="Workflow:"]')).toHaveCount(1);

    // Collapsed by default (not the active epic) → the chevron expands it and
    // reveals the subtask rows (reused WorkspaceLink rows), no navigation.
    await page.getByRole("button", { name: new RegExp(`Expand ${EPIC_GOAL}`) }).click();
    await expect(page.getByText("comments API", { exact: true })).toBeVisible();
    await expect(page.getByText("comments UI", { exact: true })).toBeVisible();
    // Expanding must NOT have navigated to the board.
    await expect(page).toHaveURL(/workspaces\/ws-agent/);

    const bad = realErrors(errors);
    expect(bad, bad.join("\n---\n")).toHaveLength(0);
  });

  test("a subtask row drills into the detail view; both breadcrumbs navigate back", async ({
    page,
  }) => {
    await boot(page);
    await page.getByRole("button", { name: new RegExp(`Expand ${EPIC_GOAL}`) }).click();

    // Click the started backend subtask → the EXISTING detail route verbatim.
    await page.getByText("comments API", { exact: true }).click();
    await expect(page).toHaveURL(
      /repositories\/repo-1\/workspaces\/epic-1-backend/,
      { timeout: 10_000 },
    );

    // The subtask breadcrumb links back to the epic's board.
    const crumb = page.getByTestId("subtask-breadcrumb-board");
    await expect(crumb).toBeVisible();
    await crumb.click();
    await expect(page).toHaveURL(/repositories\/repo-1\/board\/epic-1/, {
      timeout: 10_000,
    });

    // The board mounts its breadcrumb; the repo crumb links back to repo home.
    const repoCrumb = page.getByTestId("board-breadcrumb-repo");
    await expect(repoCrumb).toBeVisible();
    await repoCrumb.click();
    await expect(page).toHaveURL(/repositories\/repo-1$/, { timeout: 10_000 });
  });

  test("a not-started subtask lands on the honest 'waiting' pane (not a dead click)", async ({
    page,
  }) => {
    await boot(page);
    await page.getByRole("button", { name: new RegExp(`Expand ${EPIC_GOAL}`) }).click();

    // The pending frontend subtask has no worktree yet.
    await page.getByText("comments UI", { exact: true }).click();
    await expect(page).toHaveURL(/workspaces\/epic-1-frontend/, {
      timeout: 10_000,
    });

    await expect(page.getByText("Not started yet")).toBeVisible();
    // Honest: it names the producer it's waiting on, resolved from the DAG.
    await expect(page.getByText(/Waiting for backend/i)).toBeVisible();
    // The CTA routes to the board — never a dead end.
    await page.getByRole("button", { name: "View board" }).click();
    await expect(page).toHaveURL(/repositories\/repo-1\/board\/epic-1/, {
      timeout: 10_000,
    });
  });

  test("board cards are keyboard-activatable and open the subtask detail", async ({
    page,
  }) => {
    await boot(page);
    // Open the board directly via the epic node row (click, not the chevron).
    await page.locator(`[aria-label="Workflow: ${EPIC_GOAL}"]`).first().click();
    await expect(page).toHaveURL(/repositories\/repo-1\/board\/epic-1/, {
      timeout: 10_000,
    });

    const backendCard = page.locator(
      '[data-testid="board-card"][data-role="backend"]',
    );
    await expect(backendCard).toBeVisible();
    // Whole card is a button; Enter activates the drill-in.
    await backendCard.focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/workspaces\/epic-1-backend/, {
      timeout: 10_000,
    });
  });

  test("the single-agent sidebar is unchanged when a repo has no epics", async ({
    page,
  }) => {
    const fixtures = makeFixtures();
    // Drop the epic + its subtasks → a pure single-agent repo.
    fixtures.workspaces = fixtures.workspaces.filter(
      (w) => !w.id.startsWith("epic-"),
    );
    const { errors } = await bootApp(page, fixtures);
    await expect(page).toHaveURL(/workspaces\/ws-agent/, { timeout: 25_000 });

    // The flat agent/local rows render exactly as before…
    await expect(page.getByText("add-feature", { exact: true })).toBeVisible();
    // …and there is NO epic group anywhere in the tree.
    await expect(page.locator('[aria-label^="Workflow:"]')).toHaveCount(0);

    const bad = realErrors(errors);
    expect(bad, bad.join("\n---\n")).toHaveLength(0);
  });
});
