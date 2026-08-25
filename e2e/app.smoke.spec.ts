import { test, expect } from "@playwright/test";
import { bootApp, callNames } from "./harness";

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

test("sidebar activity dot marks the running workspace, and only it", async ({ page }) => {
  await bootApp(page);
  const sidebar = page.getByRole("complementary", { name: "Sidebar" });
  await expect(
    sidebar.getByText("add-feature", { exact: true }),
  ).toBeVisible({ timeout: 20000 });

  // Exactly one dot in the tree, and it lives in the running row.
  await expect(sidebar.locator('[aria-label="running"]')).toHaveCount(1);
  await expect(
    sidebar
      .getByRole("link")
      .filter({ hasText: "add-feature" })
      .locator('[aria-label="running"]'),
  ).toBeVisible();

  // Resting workspaces get no dot at all — not a grey/green one.
  for (const status of ["completed", "stopped", "failed", "pending"]) {
    await expect(sidebar.locator(`[aria-label="${status}"]`)).toHaveCount(0);
  }
});
