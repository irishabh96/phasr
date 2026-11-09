import { test, expect } from "@playwright/test";
import { bootApp, callNames, makeFixtures } from "./harness";

// Boot artifacts from running without the native shell (or Clerk's network
// calls, which we don't exercise) — not app bugs.
const BENIGN =
  /__TAURI|invoke|clerk|Clerk|sentry|Sentry|supabase|favicon|sourcemap|Outdated Optimize Dep|net::|Failed to load resource|permission/i;

test("boots the authenticated shell to a workspace", async ({ page }) => {
  const { errors } = await bootApp(page);

  // The auth gate passed and the app shell rendered (sidebar shows repos).
  await expect(page.getByText("phasr", { exact: false }).first()).toBeVisible({
    timeout: 20000,
  });

  // Boot-critical IPC actually fired.
  const names = await callNames(page);
  for (const cmd of ["set_session", "list_repositories", "list_workspaces"]) {
    expect(names, `expected ${cmd} to have fired`).toContain(cmd);
  }

  // No REAL console errors (Tauri/Clerk/network noise filtered).
  const real = errors.filter((e) => !BENIGN.test(e));
  expect(real, real.join("\n---\n")).toHaveLength(0);
});

test("sidebar groups the running task under Running, and only it", async ({ page }) => {
  await bootApp(page);
  const sidebar = page.getByRole("complementary", { name: "Sidebar" });
  await expect(
    sidebar.getByRole("link").filter({ hasText: "add-feature" }),
  ).toBeVisible({ timeout: 20000 });

  // The status glyph replaced the activity dot: the task list groups rows by
  // what they need. Exactly one row is in Running, and it is the running one.
  const running = sidebar.getByRole("region", { name: "Running", exact: true });
  await expect(running.getByRole("link")).toHaveCount(1);
  await expect(running.getByRole("link")).toContainText("add-feature");

  // The finished task (worktree has changes) waits for review — not Running.
  const review = sidebar.getByRole("region", { name: "Needs review", exact: true });
  await expect(review.getByRole("link").filter({ hasText: "fix-bug" })).toBeVisible();

  // The in-place local checkout is not a task: it never appears in a group.
  for (const group of ["Running", "Needs review", "Failed", "Queued", "Done · today"]) {
    await expect(
      sidebar.getByRole("region", { name: group, exact: true }).getByRole("link").filter({ hasText: /^local/ }),
    ).toHaveCount(0);
  }
});

test("repository footer row toggles the repo filter on the board", async ({ page }) => {
  const f = makeFixtures();
  (f as { landing?: string }).landing = "board";
  await bootApp(page, f);
  const sidebar = page.getByRole("complementary", { name: "Sidebar" });
  const repos = sidebar.getByRole("navigation", { name: "Repositories" });
  const phasrRow = repos.getByRole("button", { name: "phasr", exact: true });
  const task = sidebar.getByRole("navigation", { name: "Tasks" }).getByText("add-feature", { exact: true });

  await expect(task).toBeVisible({ timeout: 20000 });

  // A repo with tasks: the row narrows the list to it, and toggles back off.
  await phasrRow.click();
  await expect(phasrRow).toHaveAttribute("aria-pressed", "true");
  await expect(task).toBeVisible();
  await phasrRow.click();
  await expect(phasrRow).toHaveAttribute("aria-pressed", "false");

  // A repo with no tasks: its filter empties the list instead of navigating.
  const sidecar = repos.getByRole("button", { name: "sidecar", exact: true });
  await sidecar.click();
  await expect(sidecar).toHaveAttribute("aria-pressed", "true");
  await expect(task).toBeHidden();
  await expect(page).not.toHaveURL(/repositories\//);
});
