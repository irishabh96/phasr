import { test, expect, type Page } from "@playwright/test";
import { bootApp, calls, clearCalls, emit, setResponse } from "./harness";

/**
 * Phase 3 — the command layer + QAS gates (G1 · R2 · V2 · the §R2 live
 * invalidation). Two harnesses:
 *
 *  1. `/design-test` (pure fixtures, no IPC) — the NextGate ladder's
 *     disabled-with-reason contract, the Validate chip states, and the derived
 *     Review lane / Approve+Bounce rendering.
 *  2. The REAL app (mocked IPC) — the ladder walk firing the right commands, the
 *     board moving live off a mutation, and a `phasr://board-changed` event
 *     invalidating the board query keyed on `parentId` (the biggest-risk fix).
 *
 * Caveat (MEMORY testing-blind-spots): the mocked IPC proves the verb FIRED and
 * the board RE-RENDERED — not that the check subprocess ran or the socket
 * round-trips. Those need the manual smoke.
 */

const BENIGN =
  /__TAURI|invoke|auth callback|clerk|Clerk|sentry|Sentry|supabase|favicon|sourcemap|Outdated Optimize Dep|net::|Failed to load resource|permission|ResizeObserver|homeDir|plugin:/i;

// ─────────────────────────────────────────────────────────────────────────────
// 1. /design-test — the pure ladder + chips (no IPC)
// ─────────────────────────────────────────────────────────────────────────────
test.describe("gate ladder + chips (/design-test)", () => {
  let consoleErrors: string[] = [];

  test.beforeEach(async ({ page }) => {
    consoleErrors = [];
    // A tiny IPC mock so the gated boards + showcase render without the shell.
    await page.addInitScript(() => {
      (
        window as unknown as { __TAURI_INTERNALS__: unknown }
      ).__TAURI_INTERNALS__ = {
        invoke: (cmd: string) => {
          if (cmd === "list_agents")
            return Promise.resolve([
              {
                agent: "claude",
                label: "Claude",
                command: "claude",
                isDefault: true,
              },
            ]);
          if (cmd === "get_board_gates")
            return Promise.resolve({ reviews: [], validations: [] });
          if (cmd === "git_merge_in_progress")
            return Promise.resolve({ kind: "none" });
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
    await expect(page.getByTestId("gate-ladder")).toBeVisible();
  });

  const gateIn = (page: Page, id: string) =>
    page.getByTestId(`gate-${id}`).getByTestId("next-gate");

  test("the ladder renders one derived gate per state, disabled-with-reason, never hidden", async ({
    page,
  }) => {
    // Validate — the enabled primary for a working ticket with checks.
    const validate = gateIn(page, "validate");
    await expect(validate).toHaveAttribute("data-gate-verb", "validate");
    await expect(validate).toHaveAttribute("data-gate-enabled", "true");

    // Request-review — DISABLED with the failing-check reason (V2 precondition).
    const blocked = gateIn(page, "request-review-blocked");
    await expect(blocked).toHaveAttribute("data-gate-verb", "request-review");
    await expect(blocked).toHaveAttribute("data-gate-enabled", "false");
    await expect(blocked).toHaveAttribute("title", "Fix 2 failing checks");

    // Approve (enabled) with a paired Bounce-back secondary.
    const approve = gateIn(page, "approve");
    await expect(approve).toHaveAttribute("data-gate-verb", "approve");
    await expect(approve).toHaveAttribute("data-gate-enabled", "true");
    await expect(
      page.getByTestId("gate-approve").getByTestId("next-gate-bounce"),
    ).toBeVisible();

    // Approved — a calm terminal success pill (disabled, never coral).
    const approved = gateIn(page, "approved");
    await expect(approved).toHaveAttribute("data-gate-enabled", "false");
    await expect(approved).toContainText("Approved");

    // Integrate — disabled-with-reason until the epic is integrable.
    const locked = gateIn(page, "integrate-locked");
    await expect(locked).toHaveAttribute("data-gate-verb", "integrate");
    await expect(locked).toHaveAttribute("data-gate-enabled", "false");
    await expect(locked).toHaveAttribute(
      "title",
      "Integration unlocks once every ticket is ready for review.",
    );

    // Integrate (enabled) → Ship (enabled) → Shipped (terminal pill).
    await expect(gateIn(page, "integrate")).toHaveAttribute(
      "data-gate-enabled",
      "true",
    );
    const ship = gateIn(page, "ship");
    await expect(ship).toHaveAttribute("data-gate-verb", "ship");
    await expect(ship).toHaveAttribute("data-gate-enabled", "true");
    await expect(ship).toContainText("Ship to main");
    const shipped = gateIn(page, "shipped");
    await expect(shipped).toHaveAttribute("data-gate-enabled", "false");
    await expect(shipped).toContainText("Shipped");
  });

  test("the Validate chip is honest (pass / fail-with-count / not-run / add-a-check) and never coral", async ({
    page,
  }) => {
    const chips = page.getByTestId("gate-chips");
    await expect(
      chips.locator('[data-testid="validate-chip"][data-validate="none"]'),
    ).toContainText("Add a check");
    await expect(
      chips.locator('[data-testid="validate-chip"][data-validate="not-run"]'),
    ).toContainText("Not validated");
    await expect(
      chips.locator('[data-testid="validate-chip"][data-validate="passed"]'),
    ).toContainText("Checks passed");
    const failed = chips.locator(
      '[data-testid="validate-chip"][data-validate="failed"]',
    );
    await expect(failed).toContainText("2 failing checks");

    // The bounce chip is neutral — a bounce is not the user's fault.
    await expect(chips.getByTestId("changes-requested-chip")).toContainText(
      "Changes requested",
    );
  });

  test("a review-requested ticket sits in the Review lane with Approve + Bounce (R2)", async ({
    page,
  }) => {
    const board = page.getByTestId("board-gates");

    // Backend = review requested → Review lane, In-review chip, validate passed.
    const backend = board.locator(
      '[data-testid="board-card"][data-role="backend"]',
    );
    await expect(
      board
        .getByTestId("board-column-review")
        .locator('[data-testid="board-card"][data-role="backend"]'),
    ).toBeVisible();
    await expect(backend.getByTestId("in-review-chip")).toBeVisible();
    await expect(
      backend.locator('[data-testid="validate-chip"][data-validate="passed"]'),
    ).toBeVisible();
    await expect(
      backend.locator('[data-testid="next-gate"][data-gate-verb="approve"]'),
    ).toHaveAttribute("data-gate-enabled", "true");
    await expect(backend.getByTestId("next-gate-bounce")).toBeVisible();

    // Frontend = working with checks configured, not validated → Validate gate.
    const frontend = board.locator(
      '[data-testid="board-card"][data-role="frontend"]',
    );
    await expect(
      frontend.locator(
        '[data-testid="validate-chip"][data-validate="not-run"]',
      ),
    ).toBeVisible();
    await expect(
      frontend.locator('[data-testid="next-gate"][data-gate-verb="validate"]'),
    ).toHaveAttribute("data-gate-enabled", "true");
  });

  test("the gate harness renders with no console errors", async () => {
    expect(consoleErrors, consoleErrors.join("\n")).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Real app — the ladder walk + the live board-changed invalidation
// ─────────────────────────────────────────────────────────────────────────────
test.describe("gate flows + live invalidation (real app)", () => {
  const BOARD_URL = "/repositories/repo-1/board/epic-1";

  /** Boot, then deep-link into the epic board. */
  async function bootToBoard(page: Page) {
    const res = await bootApp(page);
    await expect(page).toHaveURL(/workspaces\/ws-agent/, { timeout: 25_000 });
    await page.goto(BOARD_URL);
    await expect(page.getByTestId("board-view")).toBeVisible({
      timeout: 15_000,
    });
    return res;
  }

  const backendCard = (page: Page) =>
    page.locator('[data-testid="board-card"][data-role="backend"]');

  async function countCalls(page: Page, cmd: string): Promise<number> {
    const all = await calls(page);
    return all.filter((c) => c.cmd === cmd).length;
  }

  test("walks the ladder: Validate → Request review → the Review lane (live)", async ({
    page,
  }) => {
    await bootToBoard(page);
    const backend = backendCard(page);

    // The backend ticket (working, checks configured) → Validate is the primary.
    const validate = backend.locator(
      '[data-testid="next-gate"][data-gate-verb="validate"]',
    );
    await expect(validate).toHaveAttribute("data-gate-enabled", "true");
    await validate.click();

    // validate_ticket fires and, on success, the gate advances to Request review
    // (the gate side-load re-reads the now-passing validate.json).
    await expect.poll(() => countCalls(page, "validate_ticket")).toBe(1);
    const request = backend.locator(
      '[data-testid="next-gate"][data-gate-verb="request-review"]',
    );
    await expect(request).toHaveAttribute("data-gate-enabled", "true", {
      timeout: 10_000,
    });
    await request.click();

    // request_review fires and the ticket moves LIVE into the Review lane.
    await expect.poll(() => countCalls(page, "request_review")).toBe(1);
    await expect(
      page
        .getByTestId("board-column-review")
        .locator('[data-testid="board-card"][data-role="backend"]'),
    ).toBeVisible({ timeout: 10_000 });
    await expect(backend.getByTestId("in-review-chip")).toBeVisible();
  });

  test("Approve resolves the review and marks the ticket integrate-eligible", async ({
    page,
  }) => {
    await bootToBoard(page);
    const backend = backendCard(page);

    // Get the ticket into review (validate → request-review).
    await backend
      .locator('[data-testid="next-gate"][data-gate-verb="validate"]')
      .click();
    const request = backend.locator(
      '[data-testid="next-gate"][data-gate-verb="request-review"]',
    );
    await expect(request).toHaveAttribute("data-gate-enabled", "true", {
      timeout: 10_000,
    });
    await request.click();

    // Approve — the reviewer's gate.
    const approve = backend.locator(
      '[data-testid="next-gate"][data-gate-verb="approve"]',
    );
    await expect(approve).toHaveAttribute("data-gate-enabled", "true", {
      timeout: 10_000,
    });
    await approve.click();

    // resolve_review fires with the approve decision, and the ticket becomes
    // integrate-eligible (the Approved chip).
    await expect
      .poll(async () =>
        (await calls(page)).some(
          (c) =>
            c.cmd === "resolve_review" &&
            (c.args as { decision?: string }).decision === "approve",
        ),
      )
      .toBe(true);
    await expect(backend.getByTestId("approved-chip")).toBeVisible({
      timeout: 10_000,
    });
    // Approved = accepted — the card lands in the DONE lane (the ticket-level
    // terminal state; the epic's Integrate lives in the parent header). This
    // is the assertion whose absence let the Done lane stay structurally
    // unreachable for four phases.
    await expect(
      page.getByTestId("board-column-done").getByTestId("approved-chip"),
    ).toBeVisible({ timeout: 10_000 });
  });

  test("Bounce-back requires a comment, fires resolve_review(bounce), and re-opens the ticket", async ({
    page,
  }) => {
    await bootToBoard(page);
    const backend = backendCard(page);

    await backend
      .locator('[data-testid="next-gate"][data-gate-verb="validate"]')
      .click();
    const request = backend.locator(
      '[data-testid="next-gate"][data-gate-verb="request-review"]',
    );
    await expect(request).toHaveAttribute("data-gate-enabled", "true", {
      timeout: 10_000,
    });
    await request.click();

    // Open the Bounce-back comment dialog (paired secondary next to Approve).
    await expect(backend.getByTestId("next-gate-bounce")).toBeVisible({
      timeout: 10_000,
    });
    await backend.getByTestId("next-gate-bounce").click();

    // The submit is gated on a reason (required) — empty stays disabled.
    const submit = page.getByTestId("bounce-submit");
    await expect(submit).toBeDisabled();
    await page
      .getByTestId("bounce-comment")
      .fill("Match the 12px panel spacing.");
    await expect(submit).toBeEnabled();
    await submit.click();

    // resolve_review fires with the bounce decision + the comment, and the ticket
    // returns to In progress carrying the neutral changes-requested chip.
    await expect
      .poll(async () =>
        (await calls(page)).some(
          (c) =>
            c.cmd === "resolve_review" &&
            (c.args as { decision?: string }).decision === "bounce" &&
            (c.args as { comment?: string }).comment ===
              "Match the 12px panel spacing.",
        ),
      )
      .toBe(true);
    await expect(backend.getByTestId("changes-requested-chip")).toBeVisible({
      timeout: 10_000,
    });
    await expect(
      page
        .getByTestId("board-column-in-progress")
        .locator('[data-testid="board-card"][data-role="backend"]'),
    ).toBeVisible();
  });

  test("a phasr://board-changed event invalidates the board keyed on parentId → the lane moves live", async ({
    page,
  }) => {
    await bootToBoard(page);
    const backend = backendCard(page);

    // Initially the backend ticket is working → In progress.
    await expect(
      page
        .getByTestId("board-column-in-progress")
        .locator('[data-testid="board-card"][data-role="backend"]'),
    ).toBeVisible();

    // Simulate a CLI/gate-driven change: the gate side-load now reports the
    // ticket as review-requested, and the app emits the board-changed event.
    await setResponse(page, "get_board_gates", {
      reviews: [
        {
          subtaskId: "epic-1-backend",
          state: "requested",
          by: "qas-agent",
          comment: null,
          atMs: 0,
          validatePassed: true,
        },
      ],
      validations: [],
    });
    await clearCalls(page);
    await emit(page, "phasr://board-changed", { parentId: "epic-1" });

    // The board query re-reads (get_board + get_board_gates) and the ticket moves
    // LIVE into the Review lane — no manual refresh (Architect Stage-1 §R2).
    await expect
      .poll(() => countCalls(page, "get_board_gates"))
      .toBeGreaterThanOrEqual(1);
    await expect(
      page
        .getByTestId("board-column-review")
        .locator('[data-testid="board-card"][data-role="backend"]'),
    ).toBeVisible({ timeout: 10_000 });
    await expect(backend.getByTestId("in-review-chip")).toBeVisible();
  });

  test("a board-changed event for a DIFFERENT parent does not refetch this board", async ({
    page,
  }) => {
    await bootToBoard(page);
    await clearCalls(page);
    await emit(page, "phasr://board-changed", { parentId: "some-other-epic" });
    // Give any (incorrect) invalidation a chance to fire.
    await page.waitForTimeout(400);
    expect(await countCalls(page, "get_board")).toBe(0);
    expect(await countCalls(page, "get_board_gates")).toBe(0);
  });

  // ── G2: the ⌘K Commands group mirrors the CLI verbs for the open ticket ────
  test("⌘K Commands group advances a selected ticket's gate (Validate → validate_ticket)", async ({
    page,
  }) => {
    // Sit on a subtask detail page so the palette has a ticket/epic context
    // (activeWorkspaceContext = the open subtask → deriveNextGate ladder).
    await bootApp(page);
    await page.goto("/repositories/repo-1/workspaces/epic-1-backend");
    await expect(page).toHaveURL(/epic-1-backend/, { timeout: 20_000 });
    // Let the route + global ⌘K handler mount before driving the keyboard
    // (mirrors ops.spec's palette-open test).
    await page.waitForTimeout(800);

    await page.keyboard.press("Meta+k");
    await expect(page.locator("[cmdk-root]").first()).toBeVisible({
      timeout: 5_000,
    });

    // The backend ticket (running, checks configured, not yet validated) → the
    // one enabled gate is Validate; Request review is disabled-with-reason,
    // never hidden — the ⌘K mirror of the NextGateButton's ladder.
    const validate = page.getByTestId("gate-command-validate");
    await expect(validate).toBeVisible({ timeout: 5_000 });
    await expect(validate).toHaveAttribute("data-gate-enabled", "true");
    await expect(page.getByTestId("gate-command-request-review")).toHaveAttribute(
      "data-gate-enabled",
      "false",
    );

    // Selecting it fires the SAME validate_ticket mutation the board card does.
    await validate.click();
    await expect
      .poll(() => countCalls(page, "validate_ticket"))
      .toBeGreaterThanOrEqual(1);
  });
});
