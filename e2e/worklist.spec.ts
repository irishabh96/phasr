import { test, expect, type Page } from "@playwright/test";
import { bootApp, makeFixtures } from "./harness";

/**
 * The Worklist / Home surface (stories F1 + F2), booted against the REAL app
 * with a mocked `list_worklist` (harness `f.worklist`). Asserts the cross-repo
 * attention buckets render from derived honest state, that a blocked ticket
 * lands in the CALM Waiting group (never Needs-you), that `j/k/↵` drives the
 * roving keyboard nav, and that the empty ("all caught up") state shows.
 */

const BENIGN =
  /__TAURI|invoke|clerk|Clerk|sentry|Sentry|supabase|favicon|sourcemap|Outdated Optimize Dep|net::|Failed to load resource|permission|ResizeObserver|homeDir|plugin:/i;

function realErrors(errors: string[]) {
  return errors.filter((e) => !BENIGN.test(e));
}

/** Boot (restores ws-agent), then open the Worklist via the sidebar Home entry. */
async function bootToWorklist(page: Page, fixtures = makeFixtures()) {
  const res = await bootApp(page, fixtures);
  await expect(page).toHaveURL(/workspaces\/ws-agent/, { timeout: 25_000 });
  await page.locator('[aria-label="Home"]').first().click();
  await expect(page).toHaveURL(/\/worklist/, { timeout: 10_000 });
  return res;
}

test.describe("Worklist home (stories F1 + F2)", () => {
  test("buckets render each ticket by derived honest state", async ({
    page,
  }) => {
    const { errors } = await bootToWorklist(page);

    // All four groups appear in order with the mockup's counts (2 · 2 · 1 · 2).
    const needsYou = page.getByTestId("worklist-group-needs-you");
    const running = page.getByTestId("worklist-group-running");
    const waiting = page.getByTestId("worklist-group-waiting");
    const recent = page.getByTestId("worklist-group-recent");
    for (const g of [needsYou, running, waiting, recent]) {
      await expect(g).toBeVisible();
    }

    // Needs you = failed (login-api) + needs-review (web-ui, published contract).
    // `exact` because a row's branch (e.g. phasr/login-api) contains its name.
    await expect(needsYou.getByText("login-api", { exact: true })).toBeVisible();
    await expect(needsYou.getByText("web-ui", { exact: true })).toBeVisible();
    await expect(needsYou.getByTestId("worklist-review-chip")).toBeVisible();

    // Running = the working subtask + the loose running agent.
    await expect(
      running.getByText("task-comments-api", { exact: true }),
    ).toBeVisible();
    await expect(running.getByText("add-feature", { exact: true })).toBeVisible();

    // Recent = the stopped spike + the done loose agent (merged into main).
    await expect(
      recent.getByText("spike-rate-limit", { exact: true }),
    ).toBeVisible();
    await expect(recent.getByText("fix-bug", { exact: true })).toBeVisible();
    await expect(recent.getByText("merged into main")).toBeVisible();

    // Sub-line carries repo · epic · branch (honest cross-repo context).
    await expect(page.getByText("phasr/comments-api")).toBeVisible();

    const bad = realErrors(errors);
    expect(bad, bad.join("\n---\n")).toHaveLength(0);
  });

  test("a blocked ticket sits in Waiting — never Needs you (the calm group)", async ({
    page,
  }) => {
    await bootToWorklist(page);

    const waiting = page.getByTestId("worklist-group-waiting");
    const needsYou = page.getByTestId("worklist-group-needs-you");

    // web-integration is a pending consumer of an unpublished producer → blocked.
    await expect(
      waiting.getByText("web-integration", { exact: true }),
    ).toBeVisible();
    await expect(waiting.locator('[data-state="blocked"]')).toHaveCount(1);
    await expect(waiting.getByTestId("worklist-blocked-chip")).toBeVisible();

    // …and it is NOT in Needs you — a blocked ticket is not the user's fault.
    await expect(
      needsYou.getByText("web-integration", { exact: true }),
    ).toHaveCount(0);
    await expect(needsYou.locator('[data-state="blocked"]')).toHaveCount(0);
  });

  test("j/k move the roving selection and ↵ opens the ticket", async ({
    page,
  }) => {
    await bootToWorklist(page);

    // The first visible row is selected by default (roving tabindex).
    const selected = page.locator('[role="option"][aria-selected="true"]');
    await expect(selected).toHaveCount(1);
    const firstId = await selected.first().getAttribute("data-row-id");

    // Focus the list, then j moves the selection to the next row.
    await selected.first().focus();
    await page.keyboard.press("j");
    const moved = page.locator('[role="option"][aria-selected="true"]');
    await expect(moved).toHaveCount(1);
    const secondId = await moved.first().getAttribute("data-row-id");
    expect(secondId).not.toBe(firstId);

    // k moves it back.
    await page.keyboard.press("k");
    await expect(
      page.locator('[role="option"][aria-selected="true"]'),
    ).toHaveAttribute("data-row-id", firstId!);

    // ↵ opens the selected ticket's detail (subtask id IS a workspace id).
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/repositories\/repo-1\/workspaces\//, {
      timeout: 10_000,
    });
  });

  test("clicking a row opens its detail view", async ({ page }) => {
    await bootToWorklist(page);
    await page
      .getByTestId("worklist-group-running")
      .getByText("task-comments-api", { exact: true })
      .click();
    await expect(page).toHaveURL(/workspaces\/w-backend/, { timeout: 10_000 });
  });

  test("the sidebar Home badge shows the Needs-you count", async ({ page }) => {
    await bootToWorklist(page);
    const badge = page.getByTestId("home-needs-you-count");
    await expect(badge).toBeVisible();
    await expect(badge).toHaveText("2");
  });

  test("empty worklist shows the calm 'all caught up' state (and is the new-user fallback)", async ({
    page,
  }) => {
    const fixtures = makeFixtures();
    // New user: no valid last-workspace → `/` falls through to /worklist.
    fixtures.lastWorkspace = null;
    // Repos exist but nothing is in flight → all-quiet empty.
    fixtures.worklist = {
      repositories: fixtures.worklist.repositories,
      boards: [],
      looseAgents: [],
    };
    const { errors } = await bootApp(page, fixtures);

    // F2: a no-last-workspace boot lands on the Worklist home, not a repo pane.
    await expect(page).toHaveURL(/\/worklist/, { timeout: 25_000 });
    await expect(page.getByText("Nothing needs you right now")).toBeVisible();

    const bad = realErrors(errors);
    expect(bad, bad.join("\n---\n")).toHaveLength(0);
  });

  test("⌘⇧H jumps to the Worklist from a workspace", async ({ page }) => {
    await bootApp(page);
    await expect(page).toHaveURL(/workspaces\/ws-agent/, { timeout: 25_000 });
    await page.keyboard.press("Meta+Shift+KeyH");
    await expect(page).toHaveURL(/\/worklist/, { timeout: 10_000 });
  });
});
