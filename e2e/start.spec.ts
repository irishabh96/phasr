import { test, expect, type Page } from "@playwright/test";
import { bootApp, calls, makeFixtures } from "./harness";

/**
 * The manual Start gate (Phase 5 of the completion program): a ready-but-
 * unscheduled ticket's one next gate is Start — the human override that
 * spawns it now instead of waiting for the scheduler. Previously the `start`
 * verb existed in the ladder and nothing ever derived it; a queued ticket was
 * a passive waiting pane.
 */

const BOARD_URL = "/repositories/repo-1/board/epic-1";
const NOW = new Date().toISOString();

function row(over: Record<string, unknown>) {
  return {
    repositoryId: "repo-1",
    workspaceKind: "subtask",
    name: "ticket",
    prompt: null,
    agent: "claude",
    command: "claude",
    status: "pending",
    branch: null,
    worktreePath: null,
    exitCode: null,
    createdAt: NOW,
    startedAt: null,
    finishedAt: null,
    archivedAt: null,
    shippedAt: null,
    interruptedAt: null,
    parentId: "epic-1",
    role: null,
    autopilotEnabled: false,
    requireHumanApproval: true,
    reviewsSubtaskId: null,
    updatedAt: NOW,
    ...over,
  };
}

/** One QUEUED ticket (pending, NO incoming edges) beside a running one. */
function queuedBoard() {
  return {
    parent: row({
      id: "epic-1",
      workspaceKind: "parent",
      name: "task-comments",
      prompt: "Add a task-comments API and wire the comments UI",
      agent: null,
      parentId: null,
    }),
    subtasks: [
      row({
        id: "epic-1-backend",
        role: "backend",
        name: "comments API",
        status: "running",
        startedAt: NOW,
        branch: "phasr/epic-1-backend",
      }),
      row({
        id: "epic-1-docs",
        role: "docs",
        name: "API docs",
        status: "pending",
      }),
    ],
    dependencies: [],
    contracts: [],
  };
}

async function bootToBoard(page: Page) {
  const f = makeFixtures() as ReturnType<typeof makeFixtures> & {
    overrides?: Record<string, unknown>;
  };
  f.overrides = { get_board: queuedBoard() };
  const res = await bootApp(page, f);
  await expect(page).toHaveURL(/workspaces\/ws-agent/, { timeout: 25_000 });
  await page.goto(BOARD_URL);
  await expect(page.getByTestId("board-view")).toBeVisible({
    timeout: 15_000,
  });
  return res;
}

test.describe("manual Start gate", () => {
  test("a queued ticket's card offers Start and fires start_ticket", async ({
    page,
  }) => {
    await bootToBoard(page);
    const card = page.locator('[data-testid="board-card"][data-role="docs"]');
    const gate = card.locator(
      '[data-testid="next-gate"][data-gate-verb="start"]',
    );
    await expect(gate).toBeVisible();
    await expect(gate).toHaveAttribute("data-gate-enabled", "true");
    await expect(gate).toContainText("Start");

    await gate.click();
    await expect
      .poll(async () => {
        const all = await calls(page);
        const c = all.find((x) => x.cmd === "start_ticket");
        return c && (c.args as { subtaskId?: string }).subtaskId;
      })
      .toBe("epic-1-docs");
  });

  test("a BLOCKED pending ticket still gets the calm waiting gate, never Start", async ({
    page,
  }) => {
    // The default harness board: frontend is pending with an unsatisfied edge
    // from backend — the original honest presentation must be unchanged.
    const f = makeFixtures();
    await bootApp(page, f);
    await expect(page).toHaveURL(/workspaces\/ws-agent/, { timeout: 25_000 });
    await page.goto(BOARD_URL);
    const card = page.locator(
      '[data-testid="board-card"][data-role="frontend"]',
    );
    const gate = card.locator('[data-testid="next-gate"]');
    await expect(gate).toHaveAttribute("data-gate-enabled", "false");
    await expect(gate).not.toHaveAttribute("data-gate-verb", "start");
  });
});
