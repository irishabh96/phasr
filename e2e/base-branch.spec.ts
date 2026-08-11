/**
 * E2E: BaseBranchField combobox inside the real NewTaskModal.
 *
 * These cover exactly what jsdom can't: the portal-into-dialog layering
 * (pointer-events + scroll-lock island), Radix's Escape layer stack (list
 * closes, modal survives), real wheel scrolling of a long branch list, and
 * the ⌘↵-while-open path that must commit without submitting.
 */
import { test, expect, type Page } from "@playwright/test";
import {
  bootApp,
  makeFixtures,
  calls,
  setResponse,
  clearCalls,
  waitForCall,
} from "./harness";

const BENIGN =
  /__TAURI|invoke|clerk|Clerk|sentry|Sentry|supabase|favicon|sourcemap|Outdated Optimize Dep|net::|Failed to load resource|permission|ResizeObserver|homeDir|plugin:/i;

function realErrors(errors: string[]) {
  return errors.filter((e) => !BENIGN.test(e));
}

async function boot(page: Page, fixtures = makeFixtures()) {
  const res = await bootApp(page, fixtures);
  await expect(page).toHaveURL(/workspaces\/ws-agent/, { timeout: 25_000 });
  return res;
}

async function argsFor(page: Page, cmd: string) {
  const all = await calls(page);
  return all.filter((c) => c.cmd === cmd).map((c) => c.args);
}

async function openModal(page: Page) {
  await page.getByRole("button", { name: "New workspace in phasr" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
}

const field = (page: Page) => page.locator("#new-task-base-branch");
const listbox = (page: Page) =>
  page.getByRole("listbox", { name: "Base branch" });

test.describe("Base branch combobox (NewTaskModal)", () => {
  test("focus opens the grouped list; click commits; submit carries the pick", async ({
    page,
  }) => {
    const { errors } = await boot(page);
    await openModal(page);
    await page.locator("#new-task-name").fill("pick a base");
    await clearCalls(page);

    await field(page).click();
    await expect(listbox(page)).toBeVisible();
    // Grouping: default branch pinned with its badge, other branch listed.
    await expect(page.getByRole("option", { name: /main/ })).toBeVisible();
    // exact:true — case-insensitive substring matching would also hit the
    // "Default" group heading and trip strict mode.
    await expect(
      listbox(page).getByText("default", { exact: true }),
    ).toBeVisible();

    await page.getByRole("option", { name: /^dev$/ }).click();
    await expect(field(page)).toHaveValue("dev");
    await expect(listbox(page)).toBeHidden();

    await page.getByRole("button", { name: "Start task" }).click();
    await waitForCall(page, "start_task");
    const [args] = await argsFor(page, "start_task");
    expect((args as { input: { baseBranch: string } }).input.baseBranch).toBe(
      "dev",
    );
    expect(realErrors(errors), realErrors(errors).join("\n")).toHaveLength(0);
  });

  test("Escape closes the list but NOT the modal", async ({ page }) => {
    const { errors } = await boot(page);
    await openModal(page);

    await field(page).click();
    await expect(listbox(page)).toBeVisible();

    await field(page).press("Escape");
    await expect(listbox(page)).toBeHidden();
    await expect(page.getByRole("dialog")).toBeVisible();

    // A second Escape (list closed) dismisses the modal as usual.
    await field(page).press("Escape");
    await expect(page.getByRole("dialog")).toBeHidden();
    expect(realErrors(errors), realErrors(errors).join("\n")).toHaveLength(0);
  });

  test("⌘↵ with the list open commits the highlighted row without submitting", async ({
    page,
  }) => {
    await boot(page);
    await openModal(page);
    await page.locator("#new-task-name").fill("keyboard path");
    await clearCalls(page);

    await field(page).click();
    await expect(listbox(page)).toBeVisible();
    // Cursor parks on "main" (current value); ↓ moves to "dev".
    await field(page).press("ArrowDown");
    await field(page).press("Meta+Enter");

    // Committed, closed — and start_task must NOT have fired with the
    // pre-commit value.
    await expect(field(page)).toHaveValue("dev");
    await expect(listbox(page)).toBeHidden();
    expect(await argsFor(page, "start_task")).toHaveLength(0);

    // Now that the list is closed, ⌘↵ submits with the committed ref.
    await field(page).press("Meta+Enter");
    await waitForCall(page, "start_task");
    const [args] = await argsFor(page, "start_task");
    expect((args as { input: { baseBranch: string } }).input.baseBranch).toBe(
      "dev",
    );
  });

  test("unmatched ref shows the custom-ref row; Enter keeps it, no submit", async ({
    page,
  }) => {
    await boot(page);
    await openModal(page);
    await page.locator("#new-task-name").fill("custom ref");
    await clearCalls(page);

    await field(page).fill("v1.2.0");
    await expect(
      listbox(page).getByText(/as a custom ref/),
    ).toBeVisible();

    await field(page).press("Enter");
    await expect(field(page)).toHaveValue("v1.2.0");
    await expect(listbox(page)).toBeHidden();
    expect(await argsFor(page, "start_task")).toHaveLength(0);
  });

  test("phasr/* branches collapse behind a count and expand on demand", async ({
    page,
  }) => {
    await boot(page);
    await setResponse(page, "list_local_branches", [
      "dev",
      "main",
      "phasr/old-task-a1",
      "phasr/old-task-b2",
    ]);
    await openModal(page);

    await field(page).click();
    const expandRow = page.getByRole("option", {
      name: "Show 2 phasr task branches",
    });
    await expect(expandRow).toBeVisible();
    await expect(listbox(page).getByText("phasr/old-task-a1")).toBeHidden();

    await expandRow.click();
    await expect(listbox(page).getByText("phasr/old-task-a1")).toBeVisible();
    // Expanding keeps the list open and the field uncommitted.
    await expect(field(page)).toHaveValue("main");
  });

  test("long branch lists stay inside the viewport and scroll with the wheel", async ({
    page,
  }) => {
    await boot(page);
    await setResponse(page, "list_local_branches", [
      "main",
      ...Array.from({ length: 40 }, (_, i) => {
        return `feature/branch-${String(i).padStart(2, "0")}`;
      }),
    ]);
    await openModal(page);

    await field(page).click();
    await expect(listbox(page)).toBeVisible();

    // The scroll container is the popover content wrapping the listbox.
    const content = listbox(page).locator("..");
    const box = await content.boundingBox();
    expect(box).not.toBeNull();
    const viewport = page.viewportSize();
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.y + box!.height).toBeLessThanOrEqual(viewport!.height);

    const overflowing = await content.evaluate(
      (el) => el.scrollHeight > el.clientHeight,
    );
    expect(overflowing).toBe(true);

    // Real wheel scroll — this is the interaction that was broken when the
    // popover portalled to a pointer-dead body under the modal dialog.
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await page.mouse.wheel(0, 300);
    await expect
      .poll(() => content.evaluate((el) => el.scrollTop))
      .toBeGreaterThan(0);
  });
});
