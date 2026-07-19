import { test, expect, type Page } from "@playwright/test";
import { bootApp, callNames, clearCalls, makeFixtures } from "./harness";

/**
 * The REAL "New epic" entry point (S1 enablement). Unlike board.spec.ts (which
 * drives the dev-only /design-test harness), this boots the ACTUAL app with a
 * mocked Tauri IPC and exercises the discoverable affordances a user reaches:
 *
 *   1. the repo-home pane's "New epic" button (CreateFirstWorkspacePane), and
 *   2. the sidebar repo context menu's "New epic (2 agents)" peer of
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

/** Fill the decompose gate's three required fields inside the given dialog. */
async function fillGate(dialog: ReturnType<Page["getByRole"]>) {
  await dialog.getByTestId("decompose-goal").fill("Add task comments");
  await dialog.getByTestId("decompose-backend").fill("Build the comments API");
  await dialog.getByTestId("decompose-frontend").fill("Wire the comments UI");
}

test.describe("New epic entry point (real app)", () => {
  test("repo-home 'New epic' button opens the decompose form, then navigates to the board", async ({
    page,
  }) => {
    const { errors } = await boot(page);

    // Enter a workspace-less repo (sidecar) so its home renders the
    // CreateFirstWorkspacePane, which carries the visible "New epic" button.
    await page.locator('[aria-label="sidecar"]').first().click();
    await expect(
      page.getByRole("heading", { name: "Create your first workspace" }),
    ).toBeVisible({ timeout: 15_000 });

    // The affordance is discoverable AND clearly separate from the single-agent
    // "Create your first workspace" flow.
    const newEpic = page.getByRole("button", { name: "New epic in sidecar" });
    await expect(newEpic).toBeVisible();
    await newEpic.click();

    // The shared Dialog shell + existing DecomposeForm open.
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("New epic · sidecar")).toBeVisible();
    const form = dialog.getByTestId("decompose-form");
    await expect(form).toBeVisible();

    // The gate holds until all three fields are set.
    const submit = dialog.getByTestId("decompose-submit");
    await expect(submit).toBeDisabled();
    await fillGate(dialog);
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

  test("sidebar repo menu 'New epic (2 agents)' opens the decompose form (peer of New workspace)", async ({
    page,
  }) => {
    await boot(page);

    // Right-click any repo row to reveal the context menu; "New epic (2 agents)"
    // sits right below "New workspace" — the exact peer of the single-agent
    // trigger, and semantically correct regardless of the repo's workspace count.
    await page.locator('[aria-label="phasr"]').first().click({ button: "right" });
    await page
      .getByRole("menuitem", { name: "New epic (2 agents)" })
      .click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("New epic · phasr")).toBeVisible();
    await expect(dialog.getByTestId("decompose-form")).toBeVisible();

    // Cancel closes without persisting anything (nothing fired before the gate).
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByRole("dialog")).toBeHidden();
    expect(await callCount(page, "start_decomposition")).toBe(0);
  });
});
