import { test, expect, type Page } from "@playwright/test";
import { bootApp, calls, makeFixtures } from "./harness";

/**
 * Autopilot Stage B (spec §0.5) — the per-workflow review gate.
 *
 * The gate DEFAULTS ON: every Approve is the founder's, exactly like Stage A.
 * Turning it off delegates reviews to a spawned QAS agent, and that is a
 * deliberate, confirmed act — the dialog names both what changes and the
 * guardrails that hold regardless (Ship stays human; a verdict can't approve
 * past a red validate; a human who acts first wins).
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
    status: "running",
    branch: "phasr/x",
    worktreePath: "/Users/test/.phasr/worktrees/x",
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
    requireHumanApproval: true,
    reviewsSubtaskId: null,
    updatedAt: NOW,
    ...over,
  };
}

function boardWith(parentOver: Record<string, unknown>) {
  return {
    parent: row({
      id: "epic-1",
      workspaceKind: "parent",
      name: "task-comments",
      prompt: "Add a task-comments API and wire the comments UI",
      agent: null,
      parentId: null,
      status: "pending",
      branch: null,
      worktreePath: null,
      ...parentOver,
    }),
    subtasks: [row({ id: "epic-1-backend", role: "backend", name: "comments API" })],
    dependencies: [],
    contracts: [],
  };
}

async function bootToBoard(page: Page, parentOver: Record<string, unknown>) {
  const f = makeFixtures() as ReturnType<typeof makeFixtures> & {
    overrides?: Record<string, unknown>;
  };
  f.overrides = { get_board: boardWith(parentOver) };
  await bootApp(page, f);
  await expect(page).toHaveURL(/workspaces\/ws-agent/, { timeout: 25_000 });
  await page.goto(BOARD_URL);
  await expect(page.getByTestId("board-view")).toBeVisible({ timeout: 15_000 });
}

const gateToggle = (page: Page) => page.getByTestId("review-gate-toggle");

test.describe("Stage B — the per-workflow review gate", () => {
  test("is invisible until autopilot drives the workflow", async ({ page }) => {
    await bootToBoard(page, { autopilotEnabled: false });
    await expect(gateToggle(page)).toHaveCount(0);
  });

  test("defaults to 'You approve' and needs a confirmation to delegate", async ({
    page,
  }) => {
    await bootToBoard(page, { autopilotEnabled: true });
    const toggle = gateToggle(page);
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveAttribute("data-human-approval-required", "true");
    await expect(toggle).toContainText("You approve");

    await toggle.click();
    // The confirm names the risk AND the guardrails — never a bare "are you sure".
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText("Let a QAS agent approve this workflow?");
    await expect(dialog).toContainText("Ship stays yours");
    await expect(dialog).toContainText(/can't approve past a red validate|can't approve past|validate is failing/);

    // Backing out changes nothing.
    await dialog.getByRole("button", { name: "Keep approving myself" }).click();
    const seen = (await calls(page)).some(
      (c) => c.cmd === "set_require_human_approval",
    );
    expect(seen).toBe(false);
  });

  test("confirming delegates: set_require_human_approval(false)", async ({
    page,
  }) => {
    await bootToBoard(page, { autopilotEnabled: true });
    await gateToggle(page).click();
    await page.getByRole("button", { name: "Let QAS approve" }).click();

    await expect
      .poll(async () => {
        const c = (await calls(page)).find(
          (x) => x.cmd === "set_require_human_approval",
        );
        return c && (c.args as { required?: boolean }).required;
      })
      .toBe(false);
  });

  test("taking approval back is immediate — no confirmation to become SAFER", async ({
    page,
  }) => {
    await bootToBoard(page, {
      autopilotEnabled: true,
      requireHumanApproval: false,
    });
    const toggle = gateToggle(page);
    await expect(toggle).toContainText("QAS approves");
    await toggle.click();

    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect
      .poll(async () => {
        const c = (await calls(page)).find(
          (x) => x.cmd === "set_require_human_approval",
        );
        return c && (c.args as { required?: boolean }).required;
      })
      .toBe(true);
  });
});
