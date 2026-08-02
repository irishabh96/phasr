import { test, expect, type Page } from "@playwright/test";
import { bootApp, calls, makeFixtures } from "./harness";

/**
 * The Ship gate, end to end against the mocked IPC (Phase 2 of the completion
 * program). Ship is LOCAL-MERGE-ONLY by decision: `ship_epic` merges the
 * integration branch into main and stamps `shippedAt`; pushing / opening a PR
 * are separate EXPLICIT follow-ups in the dialog, and repeat durably on the
 * board header once shipped. A conflicted ship is never a dead end — the
 * dialog offers the repo-scoped one-click Abort.
 *
 * Harness truth: these prove the WIRING (the right command with the right
 * args + the right state machine), not git behavior — that's ship_epic's Rust
 * suite (commands/board.rs) + the real-loop drive.
 */

const BOARD_URL = "/repositories/repo-1/board/epic-1";
const NOW = new Date().toISOString();

/** A workspace row for the get_board override (all Workspace fields). */
function boardRow(over: Record<string, unknown>) {
  return {
    repositoryId: "repo-1",
    workspaceKind: "subtask",
    name: "ticket",
    prompt: null,
    agent: "claude",
    command: "claude",
    status: "running",
    branch: null,
    worktreePath: null,
    exitCode: null,
    createdAt: NOW,
    startedAt: NOW,
    finishedAt: null,
    archivedAt: null,
    shippedAt: null,
    interruptedAt: null,
    parentId: "epic-1",
    role: null,
    autopilotEnabled: false,
    updatedAt: NOW,
    ...over,
  };
}

/** An INTEGRATED board: the parent carries the integration branch, so the
 *  epic's derived gate is Ship (branchStatus.aheadOfTarget=2 in the global
 *  fixture keeps it un-shipped). */
function integratedBoard(parentOver: Record<string, unknown> = {}) {
  return {
    parent: boardRow({
      id: "epic-1",
      workspaceKind: "parent",
      name: "task-comments",
      prompt: "Add a task-comments API and wire the comments UI",
      agent: null,
      parentId: null,
      status: "pending",
      branch: "phasr/integration/task-comments-epic1",
      worktreePath: "/Users/test/.phasr/worktrees/epic-1",
      ...parentOver,
    }),
    subtasks: [
      boardRow({
        id: "epic-1-backend",
        role: "backend",
        name: "comments API",
        branch: "phasr/epic-1-backend",
      }),
      boardRow({
        id: "epic-1-frontend",
        role: "frontend",
        name: "comments UI",
        branch: "phasr/epic-1-frontend",
      }),
    ],
    dependencies: [],
    contracts: [],
  };
}

function shipFixtures(opts?: {
  shipOutcome?: unknown;
  parentOver?: Record<string, unknown>;
}) {
  const f = makeFixtures() as ReturnType<typeof makeFixtures> & {
    overrides?: Record<string, unknown>;
  };
  f.overrides = {
    get_board: integratedBoard(opts?.parentOver),
    ...(opts?.shipOutcome !== undefined
      ? { ship_epic: opts.shipOutcome }
      : {}),
  };
  return f;
}

async function bootToBoard(page: Page, fixtures = shipFixtures()) {
  const res = await bootApp(page, fixtures);
  await expect(page).toHaveURL(/workspaces\/ws-agent/, { timeout: 25_000 });
  await page.goto(BOARD_URL);
  await expect(page.getByTestId("board-view")).toBeVisible({
    timeout: 15_000,
  });
  return res;
}

const headerGate = (page: Page) =>
  page
    .getByTestId("board-parent-card")
    .locator('[data-testid="next-gate"][data-gate-verb="ship"]');

async function firedCall(page: Page, cmd: string) {
  const all = await calls(page);
  return all.find((c) => c.cmd === cmd);
}

test.describe("Ship gate (real app, mocked IPC)", () => {
  test("clean ship: merge-only, then the EXPLICIT publish follow-ups", async ({
    page,
  }) => {
    await bootToBoard(page);

    // The integrated epic's one gate is Ship (coral primary, confirm-in-dialog).
    const gate = headerGate(page);
    await expect(gate).toBeVisible();
    await expect(gate).toContainText("Ship to main");
    await gate.click();

    // The Ship dialog: honest framing + a REAL radiogroup for the strategy.
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText("Ship to main");
    await expect(dialog).toContainText("nothing leaves this machine");
    await expect(dialog.getByRole("radiogroup")).toBeVisible();

    await dialog.getByRole("button", { name: "Ship", exact: true }).click();

    // ship_epic fired with the parent + default strategy — NOT git_merge_to_main.
    await expect
      .poll(async () => {
        const c = await firedCall(page, "ship_epic");
        return c && (c.args as { parentId?: string }).parentId;
      })
      .toBe("epic-1");
    const ship = await firedCall(page, "ship_epic");
    expect((ship!.args as { strategy?: string }).strategy).toBe("merge");
    expect(await firedCall(page, "git_merge_to_main")).toBeUndefined();

    // Terminal state: success banner + the explicit Publish block (repo-1 has
    // a remote). The dialog does NOT auto-close and nothing was pushed.
    await expect(dialog).toContainText(/Shipped — .* merged into main/);
    await expect(
      dialog.getByRole("button", { name: /Push main to origin/ }),
    ).toBeVisible();
    await expect(
      dialog.getByRole("button", { name: /Open a PR instead/ }),
    ).toBeVisible();
    expect(await firedCall(page, "git_push_default_branch")).toBeUndefined();

    // Push is the user's explicit call — and it reports honestly.
    await dialog.getByRole("button", { name: /Push main to origin/ }).click();
    await expect
      .poll(async () => {
        const c = await firedCall(page, "git_push_default_branch");
        return c && (c.args as { repositoryId?: string }).repositoryId;
      })
      .toBe("repo-1");
    await expect(dialog).toContainText("Pushed main to origin.");

    // Close is the calm exit (no Cancel once shipped). Exact name — the
    // dialog's X carries the distinct "Close dialog" label.
    await expect(
      dialog.getByRole("button", { name: "Close", exact: true }),
    ).toBeVisible();
  });

  test("the PR follow-up pushes the integration branch via open_pull_request", async ({
    page,
  }) => {
    await bootToBoard(page);
    await headerGate(page).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: "Ship", exact: true }).click();
    await expect(dialog).toContainText(/Shipped/);

    await dialog.getByRole("button", { name: /Open a PR instead/ }).click();
    await expect
      .poll(async () => {
        const c = await firedCall(page, "open_pull_request");
        return c && (c.args as { id?: string }).id;
      })
      .toBe("epic-1");
    await expect(dialog).toContainText(/Opened the github compare page/);
  });

  test("a conflicted ship offers the one-click repo-scoped Abort — never a dead end", async ({
    page,
  }) => {
    await bootToBoard(
      page,
      shipFixtures({
        shipOutcome: { kind: "conflicts", files: ["backend.txt", "README.md"] },
      }),
    );
    await headerGate(page).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: "Ship", exact: true }).click();

    // Honest conflict copy names the files; Ship is parked.
    await expect(dialog).toContainText(/Ship stopped on conflicts/);
    await expect(dialog).toContainText("backend.txt");
    await expect(
      dialog.getByRole("button", { name: "Ship", exact: true }),
    ).toBeDisabled();

    // Abort restores a clean main and re-arms Ship.
    await dialog.getByRole("button", { name: /Abort merge/ }).click();
    await expect
      .poll(async () => {
        const c = await firedCall(page, "git_repo_abort_merge");
        return c && (c.args as { repositoryId?: string }).repositoryId;
      })
      .toBe("repo-1");
    await expect(dialog).toContainText(/Merge aborted — main is clean again/);
    await expect(
      dialog.getByRole("button", { name: "Ship", exact: true }),
    ).toBeEnabled();
  });

  test("a shipped workflow keeps the publish follow-ups on the board header", async ({
    page,
  }) => {
    await bootToBoard(
      page,
      shipFixtures({ parentOver: { shippedAt: NOW } }),
    );

    // The durable shippedAt fact renders the terminal pill…
    const card = page.getByTestId("board-parent-card");
    await expect(
      card.locator('[data-testid="next-gate"][data-gate-verb="ship"]'),
    ).toContainText("Shipped");
    // …and the quiet publish ghosts (remote repo) live beside it, so closing
    // the ship dialog never orphans the follow-ups.
    await card.getByTestId("board-push-main").click();
    await expect
      .poll(async () => {
        const c = await firedCall(page, "git_push_default_branch");
        return c && (c.args as { repositoryId?: string }).repositoryId;
      })
      .toBe("repo-1");
  });
});
