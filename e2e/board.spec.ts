import { test, expect } from "@playwright/test";

/**
 * Task board P0 (S1/S2/Chunk 4) on the dev-only `/design-test` harness. Drives
 * the decompose form (the "Start 2 agents" approval gate), the read-only board
 * with mocked `{ state }` rows (no real IPC), and the "Integrate & review"
 * action + combined diff, asserting:
 *   - the form GATES on both role prompts and fires `start_decomposition` once
 *   - a subtask card renders HONEST status (reuses the Step 0 badge)
 *   - a BLOCKED card shows the "waiting for backend" chip and is NOT coral
 *   - cards land in the right DERIVED columns (fresh + post-handoff snapshots)
 *   - the Integrate action APPEARS ONLY when the board is integrable
 *   - clicking Integrate fires `integrate_parent` ONCE and renders the combined diff
 *   - an integration CONFLICT routes into the conflict-resolution surface (no dead end)
 *   - "Mark done" fires `publish_contract` for a stuck producer
 *   - the harness renders with no console errors
 */

// The coral accent fill (accent-500 #f78166) — a blocked card may never use it.
const CORAL = "rgb(247, 129, 102)";

test.describe("task board (/design-test)", () => {
  let consoleErrors: string[] = [];
  const BENIGN =
    /__TAURI|invoke|auth callback|clerk|Clerk|sentry|Sentry|supabase|favicon|sourcemap|Outdated Optimize Dep|net::|Failed to load resource|permission|ResizeObserver|homeDir|plugin:/i;

  test.beforeEach(async ({ page }) => {
    consoleErrors = [];
    // Tauri mock: records invoke calls and answers the board commands so the
    // gate + integrate flow run without the native shell. `integrate_parent`
    // resolves clean by default; setting `window.__FORCE_INTEGRATION_CONFLICT__`
    // makes it REJECT with the frozen conflict string AND flips git_status /
    // git_merge_in_progress into a mid-merge state (the parent worktree the
    // conflict surface reads).
    await page.addInitScript(() => {
      const calls: Array<{ cmd: string; args: unknown }> = [];
      (window as unknown as { __BOARD_CALLS__: typeof calls }).__BOARD_CALLS__ =
        calls;

      const conflicting = () =>
        (window as unknown as { __FORCE_INTEGRATION_CONFLICT__?: boolean })
          .__FORCE_INTEGRATION_CONFLICT__ === true;

      // A board whose parent carries the integration branch/worktree — the shape
      // both `integrate_parent` (clean) and `get_board` return post-integration.
      const integratedBoard = (parentId: string) => ({
        parent: {
          id: parentId,
          branch: "phasr/integration/task-comments-ab12cd",
          worktreePath: "/tmp/phasr/worktrees/" + parentId,
        },
        subtasks: [],
        dependencies: [],
        contracts: [],
      });

      const SAMPLE_DIFF =
        "diff --git a/src/comments/api.ts b/src/comments/api.ts\n" +
        "new file mode 100644\n" +
        "index 0000000..1111111\n" +
        "--- /dev/null\n" +
        "+++ b/src/comments/api.ts\n" +
        "@@ -0,0 +1,3 @@\n" +
        "+export function listComments() {\n" +
        "+  return db.comments.findMany();\n" +
        "+}\n";

      (
        window as unknown as { __TAURI_INTERNALS__: unknown }
      ).__TAURI_INTERNALS__ = {
        invoke: (cmd: string, args: unknown) => {
          calls.push({ cmd, args });
          const a = (args ?? {}) as { parentId?: string };
          switch (cmd) {
            case "list_agents":
              return Promise.resolve([
                { agent: "claude", label: "Claude", command: "claude", isDefault: true },
                { agent: "codex", label: "Codex", command: "codex", isDefault: false },
                { agent: "gemini", label: "Gemini", command: "gemini", isDefault: false },
              ]);
            case "plan_decomposition":
              // The Planner draft (§C) — a 4-ticket / 3-edge ProposedPlan the
              // review surface hydrates into editable rows. Persists nothing.
              return Promise.resolve({
                subtasks: [
                  { role: "backend", agent: "claude", prompt: "Build the comments API" },
                  { role: "frontend", agent: "claude", prompt: "Wire the comments UI" },
                  { role: "docs", agent: "gemini", prompt: "Document the API" },
                  { role: "qa", agent: "codex", prompt: "e2e coverage" },
                ],
                edges: [
                  { fromRole: "backend", toRole: "frontend" },
                  { fromRole: "backend", toRole: "docs" },
                  { fromRole: "frontend", toRole: "qa" },
                ],
              });
            case "start_decomposition":
              return Promise.resolve({
                parent: { id: "parent-new" },
                subtasks: [],
                dependencies: [],
                contracts: [],
              });
            case "integrate_parent":
              return conflicting()
                ? Promise.reject(
                    "integration stopped on conflicts in: src/comments/api.ts",
                  )
                : Promise.resolve(integratedBoard(a.parentId ?? "parent-clean"));
            case "publish_contract":
              return Promise.resolve(integratedBoard("parent-1"));
            case "get_board":
              return Promise.resolve(
                integratedBoard(a.parentId ?? "parent-clean"),
              );
            case "git_status":
              return Promise.resolve(
                conflicting()
                  ? [
                      {
                        path: "src/comments/api.ts",
                        oldPath: null,
                        staged: "conflicted",
                        unstaged: "conflicted",
                        adds: null,
                        removes: null,
                      },
                    ]
                  : [
                      {
                        path: "src/comments/api.ts",
                        oldPath: null,
                        staged: "added",
                        unstaged: "other",
                        adds: 3,
                        removes: 0,
                      },
                    ],
              );
            case "git_diff":
              return Promise.resolve(SAMPLE_DIFF);
            case "git_branch_status":
              return Promise.resolve({
                branch: "phasr/integration/task-comments-ab12cd",
                upstream: null,
                ahead: 0,
                behind: 0,
                hasRemote: false,
                detached: false,
                targetRef: null,
                aheadOfTarget: 0,
                behindOfTarget: 0,
              });
            case "git_merge_in_progress":
              return Promise.resolve(
                conflicting()
                  ? { kind: "merge", conflicts: ["src/comments/api.ts"] }
                  : { kind: "none" },
              );
            default:
              return Promise.resolve(null);
          }
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

  test("the planner drafts an editable plan, then the gate fires once", async ({
    page,
  }) => {
    const form = page.getByTestId("decompose");
    const submit = form.getByTestId("decompose-submit");
    const plan = form.getByTestId("decompose-plan");

    const count = (cmd: string) =>
      page.evaluate(
        (c) =>
          (
            window as unknown as { __BOARD_CALLS__: Array<{ cmd: string }> }
          ).__BOARD_CALLS__.filter((x) => x.cmd === c).length,
        cmd,
      );

    // Idle: nothing to start, and an empty goal can't be decomposed.
    await expect(submit).toBeDisabled();
    await expect(plan).toBeDisabled();

    await form.getByTestId("decompose-goal").fill("Add task comments");
    await expect(plan).toBeEnabled();
    await plan.click();

    // plan_decomposition fires exactly once and the editable tickets render.
    await expect.poll(() => count("plan_decomposition")).toBe(1);
    await expect(form.getByTestId("decompose-ticket")).toHaveCount(4);
    await expect(form.getByTestId("decompose-edge")).toHaveCount(3);

    // The reviewed plan is startable; one click fires the unchanged gate once.
    await expect(submit).toBeEnabled();
    await submit.click();
    await expect.poll(() => count("start_decomposition")).toBe(1);
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

  test("the Integrate action appears only when the board is integrable", async ({
    page,
  }) => {
    // Fresh (frontend blocked) + handoff (frontend still working) are NOT
    // integrable — the action is absent, replaced by a calm "when ready" hint.
    await expect(
      page.getByTestId("board-fresh").getByTestId("board-integrate"),
    ).toHaveCount(0);
    await expect(
      page.getByTestId("board-fresh").getByTestId("board-integrate-pending"),
    ).toBeVisible();
    await expect(
      page.getByTestId("board-handoff").getByTestId("board-integrate"),
    ).toHaveCount(0);

    // Integrable board (both subtasks in review) → the action is present + enabled.
    const integrate = page
      .getByTestId("board-integrable")
      .getByTestId("board-integrate");
    await expect(integrate).toBeVisible();
    await expect(integrate).toBeEnabled();
  });

  test("clicking Integrate fires integrate_parent once and renders the combined diff", async ({
    page,
  }) => {
    await page
      .getByTestId("board-integrable")
      .getByTestId("board-integrate")
      .click();

    // Exactly one integrate_parent — the D1 in-flight guard holds.
    await expect
      .poll(async () =>
        page.evaluate(
          () =>
            (
              window as unknown as { __BOARD_CALLS__: Array<{ cmd: string }> }
            ).__BOARD_CALLS__.filter((c) => c.cmd === "integrate_parent").length,
        ),
      )
      .toBe(1);

    // The success surface is the ONE combined diff against the parent worktree.
    const diff = page.getByTestId("board-combined-diff");
    await expect(diff).toBeVisible();
    await expect(diff).toContainText("src/comments/api.ts");
  });

  test("an integration conflict routes into the conflict-resolution surface (not a dead end)", async ({
    page,
  }) => {
    // Force the merge conflict for THIS page before integrating.
    await page.evaluate(() => {
      (
        window as unknown as { __FORCE_INTEGRATION_CONFLICT__?: boolean }
      ).__FORCE_INTEGRATION_CONFLICT__ = true;
    });

    await page
      .getByTestId("board-integrable")
      .getByTestId("board-integrate")
      .click();

    // Still fires integrate_parent exactly once (the reject is not a retry loop).
    await expect
      .poll(async () =>
        page.evaluate(
          () =>
            (
              window as unknown as { __BOARD_CALLS__: Array<{ cmd: string }> }
            ).__BOARD_CALLS__.filter((c) => c.cmd === "integrate_parent").length,
        ),
      )
      .toBe(1);

    // Routed into the EXISTING merge-in-progress surface (git_merge_in_progress),
    // NOT a dead end: the mid-merge banner + an explicit "Abort merge" escape.
    const surface = page.getByTestId("board-combined-diff");
    await expect(surface).toBeVisible();
    await expect(surface).toContainText("Merge in progress");
    await expect(surface.getByRole("button", { name: /abort merge/i })).toBeVisible();
  });

  test("Mark done publishes a stuck producer's contract (publish_contract)", async ({
    page,
  }) => {
    // The fresh board's backend is a producer with no published contract yet, so
    // it carries the "Mark done" override; the blocked frontend consumer does not.
    const backend = page
      .getByTestId("board-fresh")
      .locator('[data-testid="board-card"][data-role="backend"]');
    await backend.getByTestId("board-mark-done").click();

    await expect
      .poll(async () =>
        page.evaluate(
          () =>
            (
              window as unknown as {
                __BOARD_CALLS__: Array<{ cmd: string; args: unknown }>;
              }
            ).__BOARD_CALLS__.filter(
              (c) =>
                c.cmd === "publish_contract" &&
                (c.args as { subtaskId?: string }).subtaskId === "sub-backend",
            ).length,
        ),
      )
      .toBe(1);
  });

  test("the board harness renders with no console errors", async () => {
    expect(consoleErrors, consoleErrors.join("\n")).toHaveLength(0);
  });
});
