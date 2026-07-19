import { test, expect } from "@playwright/test";

/**
 * Task board P0 (S1/S2) on the dev-only `/design-test` harness. Drives the
 * decompose form (the "Start 2 agents" approval gate) and the read-only board
 * with mocked `{ state }` rows (no real IPC), asserting:
 *   - the form GATES on both role prompts and fires `start_decomposition` once
 *   - a subtask card renders HONEST status (reuses the Step 0 badge)
 *   - a BLOCKED card shows the "waiting for backend" chip and is NOT coral
 *   - cards land in the right DERIVED columns (fresh + post-handoff snapshots)
 *   - the harness renders with no console errors
 */

// The coral accent fill (accent-500 #f78166) — a blocked card may never use it.
const CORAL = "rgb(247, 129, 102)";

test.describe("task board (/design-test)", () => {
  let consoleErrors: string[] = [];
  const BENIGN =
    /invoke|__TAURI|auth callback|favicon|sourcemap|Outdated Optimize Dep/i;

  test.beforeEach(async ({ page }) => {
    consoleErrors = [];
    // Minimal Tauri mock: records invoke calls and answers start_decomposition
    // with a board so the gate's success path runs without the native shell.
    await page.addInitScript(() => {
      const calls: Array<{ cmd: string; args: unknown }> = [];
      (window as unknown as { __BOARD_CALLS__: typeof calls }).__BOARD_CALLS__ =
        calls;
      (
        window as unknown as { __TAURI_INTERNALS__: unknown }
      ).__TAURI_INTERNALS__ = {
        invoke: (cmd: string, args: unknown) => {
          calls.push({ cmd, args });
          if (cmd === "start_decomposition") {
            return Promise.resolve({
              parent: { id: "parent-new" },
              subtasks: [],
              dependencies: [],
              contracts: [],
            });
          }
          return Promise.resolve(null);
        },
        transformCallback: (cb: unknown) => cb,
        convertFileSrc: (s: string) => s,
      };
    });
    page.on("console", (m) => {
      if (m.type() === "error" && !BENIGN.test(m.text()))
        consoleErrors.push(m.text());
    });
    await page.goto("/design-test");
    await expect(
      page.getByRole("heading", { name: "Design test harness" }),
    ).toBeVisible();
    await expect(page.getByTestId("board-fresh")).toBeVisible();
  });

  test("the decompose form gates on both role prompts, then fires the gate once", async ({
    page,
  }) => {
    const form = page.getByTestId("decompose");
    const submit = form.getByTestId("decompose-submit");

    // Empty → gated.
    await expect(submit).toBeDisabled();

    await form.getByTestId("decompose-goal").fill("Add task comments");
    await form.getByTestId("decompose-backend").fill("Build the comments API");
    // Only one role prompt filled → STILL gated (nothing persisted yet).
    await expect(submit).toBeDisabled();

    await form.getByTestId("decompose-frontend").fill("Wire the comments UI");
    await expect(submit).toBeEnabled();

    await submit.click();

    // Exactly one start_decomposition — the gate holds; no auto-fan-out.
    await expect
      .poll(async () =>
        page.evaluate(
          () =>
            (
              window as unknown as {
                __BOARD_CALLS__: Array<{ cmd: string }>;
              }
            ).__BOARD_CALLS__.filter((c) => c.cmd === "start_decomposition")
              .length,
        ),
      )
      .toBe(1);
  });

  test("a subtask card renders honest agent status (reuses the Step 0 badge)", async ({
    page,
  }) => {
    const fresh = page.getByTestId("board-fresh");
    const backend = fresh.locator(
      '[data-testid="board-card"][data-role="backend"]',
    );
    await expect(backend).toBeVisible();
    // The honest Step 0 badge is reused verbatim, and it reads "Working".
    await expect(backend.getByTestId("agent-status-badge")).toBeVisible();
    await expect(backend).toContainText("Working");
  });

  test("a blocked card shows the 'waiting for backend' chip and is NOT coral", async ({
    page,
  }) => {
    const fresh = page.getByTestId("board-fresh");
    const frontend = fresh.locator(
      '[data-testid="board-card"][data-role="frontend"]',
    );
    await expect(frontend).toHaveAttribute("data-board-state", "blocked");

    const chip = frontend.getByTestId("board-blocked-chip");
    await expect(chip).toBeVisible();
    await expect(chip).toContainText("Blocked");
    await expect(chip).toContainText("waiting for backend");

    // Never coral: neither the meaning-bearing label nor the lock glyph uses
    // the accent fill (a blocked agent is not the user's fault, not an alert).
    const labelColor = await chip
      .locator("span")
      .first()
      .evaluate((el) => getComputedStyle(el).color);
    expect(labelColor, "blocked label color").not.toBe(CORAL);
    const glyphColor = await chip
      .locator("svg")
      .first()
      .evaluate((el) => getComputedStyle(el).color);
    expect(glyphColor, "blocked glyph color").not.toBe(CORAL);
  });

  test("cards land in the right derived columns (fresh + handoff)", async ({
    page,
  }) => {
    // FRESH: backend working → In progress; frontend blocked → Backlog.
    const fresh = page.getByTestId("board-fresh");
    await expect(
      fresh
        .getByTestId("board-column-in-progress")
        .locator('[data-testid="board-card"][data-role="backend"]'),
    ).toBeVisible();
    await expect(
      fresh
        .getByTestId("board-column-backlog")
        .locator('[data-testid="board-card"][data-role="frontend"]'),
    ).toBeVisible();

    // HANDOFF: backend contract published → Review; frontend working → In progress.
    const handoff = page.getByTestId("board-handoff");
    await expect(
      handoff
        .getByTestId("board-column-review")
        .locator('[data-testid="board-card"][data-role="backend"]'),
    ).toBeVisible();
    await expect(
      handoff
        .getByTestId("board-column-in-progress")
        .locator('[data-testid="board-card"][data-role="frontend"]'),
    ).toBeVisible();
    await expect(handoff.getByTestId("board-column-review")).toContainText(
      "Ready for review",
    );
  });

  test("the board harness renders with no console errors", async () => {
    expect(consoleErrors, consoleErrors.join("\n")).toHaveLength(0);
  });
});
