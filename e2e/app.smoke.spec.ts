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
