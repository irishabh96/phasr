import { test, expect, type Page } from "@playwright/test";

/**
 * Phase 1 — the Planner review/edit surface (FE-1) on the dev-only
 * `/design-test` harness. Drives the rewritten `DecomposeForm` with a mocked
 * `plan_decomposition` (a canned 4-ticket / 3-edge ProposedPlan) and asserts:
 *   - goal → Decompose fires `plan_decomposition` ONCE → editable tickets + DAG
 *     render (agent selects list the mocked `list_agents`)
 *   - editing a role/agent/prompt, adding a ticket + an edge persists NOTHING
 *     until Start, which fires `start_decomposition` ONCE with the EDITED plan
 *     (and a renamed role cascades to its edges — client-id indirection)
 *   - an invalid draft (duplicate role / cycle) disables Start WITH a reason,
 *     and "Add ticket" disables at the MAX_SUBTASKS cap
 *   - a planner REJECT drops into manual editing (one seeded row + Details) and
 *     the user can still hand-build + Start — never a dead end
 *   - the harness renders with no console errors
 */

type Call = { cmd: string; args: unknown };

const PLANNER_CALLS = (page: Page, cmd: string) =>
  page.evaluate(
    (c) =>
      (
        window as unknown as { __PLANNER_CALLS__: Call[] }
      ).__PLANNER_CALLS__.filter((x) => x.cmd === c).length,
    cmd,
  );

test.describe("planner review surface (/design-test)", () => {
  let consoleErrors: string[] = [];
  const BENIGN =
    /__TAURI|invoke|auth callback|clerk|Clerk|sentry|Sentry|supabase|favicon|sourcemap|Outdated Optimize Dep|net::|Failed to load resource|permission|ResizeObserver|homeDir|plugin:/i;

  test.beforeEach(async ({ page }) => {
    consoleErrors = [];
    await page.addInitScript(() => {
      const calls: Call[] = [];
      (window as unknown as { __PLANNER_CALLS__: Call[] }).__PLANNER_CALLS__ =
        calls;

      const rejectPlanner = () =>
        (window as unknown as { __FORCE_PLANNER_REJECT__?: boolean })
          .__FORCE_PLANNER_REJECT__ === true;

      // A 4-ticket / 3-edge draft (Page 02's exact shape). Persists nothing.
      const PLAN = {
        subtasks: [
          { role: "backend", agent: "claude", prompt: "Build the comments API" },
          { role: "frontend", agent: "claude", prompt: "Wire the comments UI" },
          { role: "docs", agent: "gemini", prompt: "Document the API" },
          { role: "qa", agent: "codex", prompt: "Write e2e coverage" },
        ],
        edges: [
          { fromRole: "backend", toRole: "frontend" },
          { fromRole: "backend", toRole: "docs" },
          { fromRole: "frontend", toRole: "qa" },
        ],
      };

      (
        window as unknown as { __TAURI_INTERNALS__: unknown }
      ).__TAURI_INTERNALS__ = {
        invoke: (cmd: string, args: unknown) => {
          calls.push({ cmd, args });
          switch (cmd) {
            case "list_agents":
              return Promise.resolve([
                { agent: "claude", label: "Claude", command: "claude", isDefault: true },
                { agent: "codex", label: "Codex", command: "codex", isDefault: false },
                { agent: "gemini", label: "Gemini", command: "gemini", isDefault: false },
              ]);
            case "plan_decomposition":
              return rejectPlanner()
                ? Promise.reject("planner failed: claude binary not found")
                : Promise.resolve(PLAN);
            case "start_decomposition":
              return Promise.resolve({
                parent: { id: "parent-new" },
                subtasks: [],
                dependencies: [],
                contracts: [],
              });
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
    await expect(page.getByTestId("decompose")).toBeVisible();
  });

  /** Type a goal + run the planner; resolve once the tickets have rendered. */
  async function plan(page: Page) {
    const form = page.getByTestId("decompose");
    await form.getByTestId("decompose-goal").fill("Add task comments to checkout");
    await form.getByTestId("decompose-plan").click();
    await expect(form.getByTestId("decompose-ticket").first()).toBeVisible();
    return form;
  }

  test("goal → Decompose renders the editable plan; agent selects list the agents", async ({
    page,
  }) => {
    const form = page.getByTestId("decompose");

    // Empty goal → Decompose disabled (backend guard is behind this).
    await expect(form.getByTestId("decompose-plan")).toBeDisabled();

    const form2 = await plan(page);
    expect(await PLANNER_CALLS(page, "plan_decomposition")).toBe(1);

    // N tickets + M edges render, matching the canned plan.
    await expect(form2.getByTestId("decompose-ticket")).toHaveCount(4);
    await expect(form2.getByTestId("decompose-edge")).toHaveCount(3);
    await expect(form2.getByText("Planner proposed 4 tickets")).toBeVisible();

    // Each agent select lists the list_agents options.
    const agentOptions = await form2
      .getByTestId("decompose-ticket")
      .first()
      .getByTestId("decompose-agent")
      .locator("option")
      .allInnerTexts();
    expect(agentOptions).toEqual(["Claude", "Codex", "Gemini"]);

    // The derived per-row hint: the first ticket has no deps.
    await expect(form2.getByTestId("decompose-ticket").first()).toContainText(
      "runs first",
    );
  });

  test("editing persists nothing; Start fires start_decomposition once with the edited plan", async ({
    page,
  }) => {
    const form = await plan(page);
    const first = form.getByTestId("decompose-ticket").first();

    // Rename the role (cascades to its edges), change the agent, edit the prompt.
    await first.getByTestId("decompose-role").fill("api");
    await first.getByTestId("decompose-agent").selectOption("codex");
    await first.getByTestId("decompose-prompt").fill("EDITED backend prompt");

    // Add a ticket (role-5) + give it a prompt so the draft stays startable.
    await form.getByTestId("decompose-add-ticket").click();
    await expect(form.getByTestId("decompose-ticket")).toHaveCount(5);
    await form
      .getByTestId("decompose-ticket")
      .nth(4)
      .getByTestId("decompose-prompt")
      .fill("Fifth ticket work");

    // Add an edge api → role-5 via role-5's INLINE dependency picker
    // (dependencies now live on the ticket, not a separate DAG editor).
    await form
      .getByTestId("decompose-ticket")
      .nth(4)
      .getByTestId("decompose-dep-add")
      .selectOption({ label: "api" });
    await expect(
      form.getByTestId("decompose-ticket").nth(4).getByTestId("decompose-edge"),
    ).toContainText("api");

    // Nothing has persisted through all of that editing.
    expect(await PLANNER_CALLS(page, "start_decomposition")).toBe(0);

    // One Start → one gate call with the reviewed/edited plan.
    const submit = form.getByTestId("decompose-submit");
    await expect(submit).toBeEnabled();
    await submit.click();
    await expect.poll(() => PLANNER_CALLS(page, "start_decomposition")).toBe(1);

    const input = await page.evaluate(() => {
      const c = (
        window as unknown as {
          __PLANNER_CALLS__: Array<{
            cmd: string;
            args?: { input?: unknown };
          }>;
        }
      ).__PLANNER_CALLS__.find((x) => x.cmd === "start_decomposition");
      return c?.args?.input as
        | {
            parentPrompt: string;
            subtasks: Array<{ role: string; agent: string; prompt: string }>;
            edges: Array<{ fromRole: string; toRole: string }>;
          }
        | undefined;
    });

    expect(input).toBeTruthy();
    expect(input?.parentPrompt).toBe("Add task comments to checkout");
    // The edited first ticket.
    expect(input?.subtasks).toContainEqual({
      role: "api",
      agent: "codex",
      prompt: "EDITED backend prompt",
    });
    // The added ticket.
    expect(
      input?.subtasks.some((s) => s.role === "role-5" && s.prompt === "Fifth ticket work"),
    ).toBe(true);
    // The renamed role cascaded to its original edge (no orphan)…
    expect(input?.edges).toContainEqual({ fromRole: "api", toRole: "frontend" });
    // …and the newly-added edge is present.
    expect(input?.edges).toContainEqual({ fromRole: "api", toRole: "role-5" });
  });

  test("a duplicate role disables Start with a legible reason", async ({
    page,
  }) => {
    const form = await plan(page);
    // Rename frontend → backend, colliding with the first ticket.
    await form
      .getByTestId("decompose-ticket")
      .nth(1)
      .getByTestId("decompose-role")
      .fill("backend");

    await expect(form.getByTestId("decompose-submit")).toBeDisabled();
    await expect(form.getByTestId("decompose-reason")).toContainText(
      "share the role",
    );
    expect(await PLANNER_CALLS(page, "start_decomposition")).toBe(0);
  });

  test("a dependency cycle disables Start with a legible reason", async ({
    page,
  }) => {
    const form = await plan(page);
    // backend → frontend already exists; make backend also WAIT FOR frontend
    // (via backend's inline picker) to close a cycle.
    await form
      .getByTestId("decompose-ticket")
      .first()
      .getByTestId("decompose-dep-add")
      .selectOption({ label: "frontend" });

    await expect(form.getByTestId("decompose-submit")).toBeDisabled();
    await expect(form.getByTestId("decompose-reason")).toContainText("cycle");
  });

  test("Add ticket disables at the MAX_SUBTASKS cap", async ({ page }) => {
    const form = await plan(page); // 4 tickets
    const add = form.getByTestId("decompose-add-ticket");
    for (let i = 4; i < 12; i++) await add.click();
    await expect(form.getByTestId("decompose-ticket")).toHaveCount(12);
    await expect(add).toBeDisabled();
  });

  test("a planner reject drops into manual editing; the user can still Start", async ({
    page,
  }) => {
    await page.evaluate(() => {
      (
        window as unknown as { __FORCE_PLANNER_REJECT__?: boolean }
      ).__FORCE_PLANNER_REJECT__ = true;
    });

    const form = page.getByTestId("decompose");
    await form.getByTestId("decompose-goal").fill("Add task comments to checkout");
    await form.getByTestId("decompose-plan").click();

    // Manual-fallback note + a single seeded row + the raw-error disclosure.
    await expect(form.getByTestId("decompose-manual-note")).toBeVisible();
    await expect(form.getByTestId("decompose-ticket")).toHaveCount(1);
    await expect(form.getByTestId("decompose-error-details")).toBeVisible();

    // Hand-build the plan and Start — never a dead end.
    await form
      .getByTestId("decompose-ticket")
      .getByTestId("decompose-prompt")
      .fill("Do the whole thing");
    const submit = form.getByTestId("decompose-submit");
    await expect(submit).toBeEnabled();
    await submit.click();
    await expect.poll(() => PLANNER_CALLS(page, "start_decomposition")).toBe(1);
  });

  test("the planner harness renders with no console errors", async () => {
    expect(consoleErrors, consoleErrors.join("\n")).toHaveLength(0);
  });
});
