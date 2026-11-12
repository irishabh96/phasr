import { expect, test, type Page } from "@playwright/test";
import { bootApp, calls, clearCalls, expectBackend, makeFixtures, terminal, world } from "./harness";

/**
 * Agent transcript view (specs/agent-transcript-view-spec.md): a Claude
 * task whose `agentView` is "transcript" renders its conversation in the
 * app, and the composer is the only input. Against the STATEFUL harness
 * backend; the agent's stream is driven with `world.transcript` /
 * `turnStarts` / `turnEnds`, everything the user does goes through the UI.
 */

const BENIGN = /favicon|sourcemap|Download the React DevTools/i;
const realErrors = (errors: string[]) => errors.filter((e) => !BENIGN.test(e));

const TASK = "ws-agent";

function transcriptFixtures(extra: Record<string, unknown> = {}) {
  const f = makeFixtures() as ReturnType<typeof makeFixtures> & Record<string, unknown>;
  f.stateful = true;
  f.workspaces = f.workspaces.map((w) => (w.id === TASK ? { ...w, agentView: "transcript" } : w)) as typeof f.workspaces;
  return Object.assign(f, extra);
}

const transcript = (page: Page) => page.getByTestId("transcript").filter({ visible: true });
const items = (page: Page, kind?: string) =>
  transcript(page).locator(kind ? `[data-transcript-item="${kind}"]` : "[data-transcript-item]");
const composer = (page: Page) => page.getByLabel("Message Claude");
const callsOf = async (page: Page, cmd: string) => (await calls(page)).filter((c) => c.cmd === cmd).map((c) => c.args);
const runningStrip = (page: Page) => page.getByRole("group", { name: "Running", exact: true });
const inspector = (page: Page) => page.getByRole("complementary", { name: "Inspector" });
const subagentPanel = (page: Page) => inspector(page).getByTestId("subagent-panel");
/** A tool call a subagent made (nested under it by the harness). */
const subStep = (id: string, title: string, status = "running") => ({
  kind: "tool",
  id,
  tool: title.startsWith("Reading") ? "Read" : "Bash",
  input: {},
  title,
  status,
});

async function boot(page: Page, extra: Record<string, unknown> = {}) {
  const res = await bootApp(page, transcriptFixtures(extra) as never);
  await expect(transcript(page)).toBeVisible({ timeout: 20_000 });
  return res;
}

test.describe("Agent transcript view", () => {
  test("one input, streamed text, tool lines, an edit diff and a command's output tail", async ({ page }) => {
    const { errors } = await boot(page);

    // No terminal anywhere, and the composer is the only text input.
    await expect(page.getByTestId("terminal-surface")).toHaveCount(0);
    await expect(composer(page)).toBeVisible();
    await expect(page.locator("textarea:visible, input:not([type=hidden]):not([type=checkbox]):visible")).toHaveCount(1);
    expect(await callsOf(page, "open_task_terminal")).toEqual([]);

    // The user's message goes to the task, and appears in the transcript.
    await composer(page).fill("Fix the login redirect");
    await page.keyboard.press("Meta+Enter");
    await expect(items(page, "user")).toContainText("Fix the login redirect");
    expect(await callsOf(page, "send_message_to_task")).toEqual([{ taskId: TASK, text: "Fix the login redirect", submit: true }]);

    // Assistant text streams in: one item, updated in place, with a caret.
    await world.transcript(page, TASK, { kind: "assistant", id: "a1", text: "The redirect loses", streaming: true });
    await expect(items(page, "assistant")).toHaveText(/The redirect loses/);
    await world.transcript(page, TASK, {
      kind: "assistant",
      id: "a1",
      text: "The redirect loses the `?next=` param when the cookie refreshes.",
      streaming: true,
    });
    await expect(items(page, "assistant")).toHaveCount(1);
    await expect(items(page, "assistant")).toContainText("the ?next= param when the cookie refreshes.");
    await expect(items(page, "assistant").locator("[data-streaming-caret]")).toHaveCount(1);
    await world.transcript(page, TASK, {
      kind: "assistant",
      id: "a1",
      text: "The redirect loses the `?next=` param when the cookie refreshes.",
      streaming: false,
    });
    await expect(items(page, "assistant").locator("[data-streaming-caret]")).toHaveCount(0);

    // A tool line goes from running to done.
    await world.transcript(page, TASK, {
      kind: "tool",
      id: "t-read",
      tool: "Read",
      input: { file_path: "src/auth/redirect.ts" },
      title: "Reading src/auth/redirect.ts",
      status: "running",
    });
    const read = transcript(page).locator('[data-tool="Read"]');
    await expect(read).toHaveAttribute("data-status", "running");
    await expect(read.getByRole("img", { name: "running" })).toBeVisible();
    await world.transcript(page, TASK, {
      kind: "tool",
      id: "t-read",
      tool: "Read",
      input: { file_path: "src/auth/redirect.ts" },
      title: "Reading src/auth/redirect.ts",
      status: "done",
      output: "1\texport function redirect() {}",
    });
    await expect(read).toHaveAttribute("data-status", "done");
    await expect(read.getByRole("img", { name: "done" })).toBeVisible();
    // Compact: a Read's output stays out of the way.
    await expect(read).not.toContainText("export function redirect");

    // An Edit shows its −/+ diff inline.
    await world.transcript(page, TASK, {
      kind: "tool",
      id: "t-edit",
      tool: "Edit",
      input: {
        file_path: "src/auth/redirect.ts",
        old_string: "  return `/login?from=${encodeURIComponent(path)}`;",
        new_string: "  return buildLoginUrl(path, { next: search.get('next') });",
      },
      title: "Editing src/auth/redirect.ts",
      status: "done",
    });
    const edit = transcript(page).locator('[data-tool="Edit"]');
    await expect(edit.locator('[data-diff-line="remove"]')).toHaveText("-  return `/login?from=${encodeURIComponent(path)}`;");
    await expect(edit.locator('[data-diff-line="add"]')).toHaveText("+  return buildLoginUrl(path, { next: search.get('next') });");
    await expect(edit).toContainText("+1 −1");

    // Bash: the command, then the last 12 lines of its output, expandable.
    const out = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n");
    await world.transcript(page, TASK, {
      kind: "tool",
      id: "t-bash",
      tool: "Bash",
      input: { command: "pnpm test src/auth" },
      title: "Running pnpm test src/auth",
      status: "running",
    });
    const bash = transcript(page).locator('[data-tool="Bash"]');
    await expect(bash).toContainText("Running pnpm test src/auth");
    await world.transcript(page, TASK, {
      kind: "tool",
      id: "t-bash",
      tool: "Bash",
      input: { command: "pnpm test src/auth" },
      title: "Running pnpm test src/auth",
      status: "done",
      output: out,
    });
    await expect(bash).toHaveAttribute("data-status", "done");
    const tail = bash.locator("[data-output-tail]");
    await expect(tail).toContainText("line 20");
    await expect(tail).toContainText("line 9");
    await expect(tail).not.toContainText("line 8\n");
    await expect(tail.getByText("line 8", { exact: true })).toHaveCount(0);
    await tail.getByRole("button", { name: "Show all 20 lines" }).click();
    await expect(tail.getByText("line 1", { exact: true })).toBeVisible();

    // The turn's quiet result line.
    await world.turnEnds(page, TASK, { durationMs: 23_000, costUsd: 0.04 });
    await expect(items(page, "result")).toHaveText(/Done in 23s · \$0\.04/);

    expect(realErrors(errors)).toEqual([]);
  });

  test("an approval docks its card above the composer, and Allow clears it", async ({ page }) => {
    await boot(page);
    await world.turnStarts(page, TASK);
    await world.transcript(page, TASK, {
      kind: "tool",
      id: "t-rm",
      tool: "Bash",
      input: { command: "rm -rf build" },
      title: "Running rm -rf build",
      status: "running",
    });
    const attId = await world.agentAsks(page, TASK, { detail: "rm -rf build" });

    const card = page.getByRole("alertdialog", { name: "Claude wants to run a shell command" });
    await expect(card).toBeVisible();
    await expect(card).toContainText("rm -rf build");
    // The transcript stays; the composer waits for the answer.
    await expect(transcript(page)).toBeVisible();
    await expect(composer(page)).toHaveCount(0);
    await expect(page.getByText("Answer the request above to continue messaging Claude.")).toBeVisible();

    await card.getByRole("button", { name: /Allow once/ }).click();
    await expect(card).toBeHidden();
    expect(await callsOf(page, "respond_to_attention")).toEqual([{ taskId: TASK, attentionId: attId, response: "allow-once" }]);
    await expect(composer(page)).toBeVisible();
  });

  test("while a turn runs, Stop interrupts it and a sent message waits as Queued", async ({ page }) => {
    await boot(page);
    await world.turnStarts(page, TASK);

    const stop = page.getByRole("button", { name: "Stop turn" });
    await expect(stop).toBeVisible();
    await expect(page.getByRole("button", { name: "Send" })).toHaveCount(0);

    // The input stays usable: ⌘↵ queues instead of sending.
    await clearCalls(page);
    await composer(page).fill("Also handle deep links");
    await page.keyboard.press("Meta+Enter");
    const queued = page.getByRole("status", { name: "Queued message" });
    await expect(queued).toContainText("Queued");
    await expect(queued).toContainText("Also handle deep links");
    await expect(composer(page)).toHaveValue("");
    expect(await callsOf(page, "send_message_to_task")).toEqual([]);

    // Stop interrupts the turn (the session lives on); the queued message
    // goes once the turn has ended.
    await stop.click();
    await expect.poll(() => callsOf(page, "interrupt_task")).toEqual([{ taskId: TASK }]);
    await expect(items(page, "system")).toContainText("Interrupted");
    await expect(queued).toBeHidden();
    await expect
      .poll(() => callsOf(page, "send_message_to_task"))
      .toEqual([{ taskId: TASK, text: "Also handle deep links", submit: true }]);
    await expect(items(page, "user").last()).toContainText("Also handle deep links");
    // …which starts the next turn: Stop again.
    await expect(stop).toBeVisible();
  });

  test("the agent tab toggles to the terminal and back", async ({ page }) => {
    const { errors } = await boot(page);
    await world.transcript(page, TASK, { kind: "assistant", id: "a1", text: "Both call sites fixed.", streaming: false });
    await expect(items(page, "assistant")).toContainText("Both call sites fixed.");

    const agentTab = page.getByRole("tablist", { name: "Workspace tabs" }).getByRole("tab", { name: /Claude/ });
    await agentTab.getByLabel("Agent view").click();
    await page.getByRole("menuitem", { name: "View as terminal" }).click();

    await expectBackend(page);
    await expect(terminal(page)).toBeVisible();
    await expect(transcript(page)).toHaveCount(0);
    expect(await callsOf(page, "set_agent_view")).toEqual([{ taskId: TASK, view: "terminal" }]);
    await expect.poll(async () => (await callsOf(page, "open_task_terminal")).length).toBe(1);

    // Back, from a right-click on the tab this time.
    await agentTab.click({ button: "right" });
    await page.getByRole("menuitem", { name: "View as transcript" }).click();
    await expect(transcript(page)).toBeVisible();
    await expect(items(page, "assistant")).toContainText("Both call sites fixed.");
    await expect(page.getByTestId("terminal-surface").filter({ visible: true })).toHaveCount(0);

    expect(realErrors(errors)).toEqual([]);
  });

  test("a refused switch (a turn is running) says why", async ({ page }) => {
    await boot(page);
    await world.turnStarts(page, TASK);
    const agentTab = page.getByRole("tablist", { name: "Workspace tabs" }).getByRole("tab", { name: /Claude/ });
    await agentTab.getByLabel("Agent view").click();
    await page.getByRole("menuitem", { name: "View as terminal" }).click();
    await expect(page.getByText("Couldn't switch to the terminal")).toBeVisible();
    await expect(transcript(page)).toBeVisible();
    await expect(page.getByTestId("terminal-surface")).toHaveCount(0);
  });

  test("a reload restores the transcript", async ({ page }) => {
    await boot(page);
    await world.transcript(page, TASK, { kind: "assistant", id: "a1", text: "Restored after reload.", streaming: false });
    await world.transcript(page, TASK, {
      kind: "tool",
      id: "t-1",
      tool: "Bash",
      input: { command: "pnpm test" },
      title: "Running pnpm test",
      status: "done",
      output: "14 passed",
    });
    await expect(items(page)).toHaveCount(2);

    await page.reload();
    await expect(transcript(page)).toBeVisible({ timeout: 20_000 });
    await expect(items(page, "assistant")).toContainText("Restored after reload.");
    await expect(transcript(page).locator('[data-tool="Bash"]')).toContainText("14 passed");
    await expect(page.getByTestId("terminal-surface")).toHaveCount(0);
  });

  test("a long transcript virtualises, follows the end, and offers Jump to latest when scrolled up", async ({ page }) => {
    const base = Date.parse("2026-11-11T10:00:00.000Z");
    const seeded = Array.from({ length: 400 }, (_, i) => ({
      kind: "assistant",
      id: `seed-${i}`,
      ts: new Date(base + i * 1000).toISOString(),
      text: `Message number ${i}`,
      streaming: false,
    }));
    await boot(page, { transcripts: { [TASK]: seeded } });
    const log = transcript(page).getByRole("log", { name: "Transcript" });
    // Opens at the end, and only the visible slice is in the DOM.
    await expect(log.getByText("Message number 399", { exact: true })).toBeVisible();
    expect(await items(page).count()).toBeLessThan(120);

    // Pinned: a new item scrolls into view.
    await world.transcript(page, TASK, { kind: "assistant", id: "new-1", text: "Fresh reply", streaming: false });
    await expect(log.getByText("Fresh reply")).toBeVisible();

    // Scrolled up: it stays put, and the pill appears.
    await log.evaluate((el) => el.scrollTo({ top: 0 }));
    const pill = page.getByRole("button", { name: "Jump to latest" });
    await expect(pill).toBeVisible();
    await world.transcript(page, TASK, { kind: "assistant", id: "new-2", text: "Another reply", streaming: false });
    await expect(log.getByText("Message number 0", { exact: true })).toBeVisible();
    await expect(log.getByText("Another reply")).toHaveCount(0);

    await pill.click();
    await expect(log.getByText("Another reply")).toBeVisible();
    await expect(pill).toBeHidden();
  });

  test("a subagent call groups its steps: live activity and a count, collapsed, expanding to its own transcript", async ({ page }) => {
    const { errors } = await boot(page);
    await world.turnStarts(page, TASK);
    const step = (id: string, title: string, status = "running") => ({
      kind: "tool",
      id,
      tool: title.startsWith("Reading") ? "Read" : "Bash",
      input: {},
      title,
      status,
    });
    await world.subagent(page, TASK, { id: "agent-1", description: "Map the auth module" }, [step("s1", "Running ls src/auth", "done")]);
    // A second subagent in parallel: siblings, not nested.
    await world.subagent(page, TASK, { id: "agent-2", description: "Find the callers", type: "Explore" }, [step("s9", "Searching \"redirect(\"")]);

    const calls = transcript(page).locator('[data-tool="Agent"]');
    await expect(calls).toHaveCount(2);
    const first = calls.nth(0);
    await expect(first).toContainText("Subagent Map the auth module · general-purpose");
    await expect(first.locator("[data-subagent-latest]")).toHaveText("Running ls src/auth…");
    await expect(calls.nth(1)).toContainText("Find the callers · Explore");
    // Collapsed: the steps aren't rows of the transcript.
    await expect(transcript(page).locator('[data-item-id="s1"]')).toHaveCount(0);

    // It works on: the line follows it, the count grows.
    await world.subagent(page, TASK, { id: "agent-1", description: "Map the auth module" }, [
      step("s1", "Running ls src/auth", "done"),
      { kind: "thinking", id: "s2", text: "redirect.ts is the one.", durationMs: 1000 },
      step("s3", "Reading src/auth/redirect.ts"),
    ]);
    await expect(first.locator("[data-subagent-latest]")).toHaveText("Reading src/auth/redirect.ts…");
    const toggle = first.getByRole("button", { name: /2 steps/ });
    await expect(toggle).toHaveAttribute("aria-expanded", "false");

    await toggle.click();
    const group = first.getByRole("group", { name: "Subagent: Map the auth module" });
    await expect(group.locator("[data-transcript-item]")).toHaveCount(3);
    await expect(group.locator('[data-tool="Read"]')).toContainText("Reading src/auth/redirect.ts");
    await expect(group.locator('[data-tool="Read"]').getByRole("img", { name: "running" })).toBeVisible();
    // The other subagent stays collapsed.
    await expect(calls.nth(1).getByRole("group")).toHaveCount(0);

    // Done: no live line; the report is a toggle away; the group stays open.
    await world.subagent(
      page,
      TASK,
      { id: "agent-1", description: "Map the auth module", status: "done", output: "The redirect lives in `redirect.ts`." },
      [step("s1", "Running ls src/auth", "done"), { kind: "thinking", id: "s2", text: "redirect.ts is the one.", durationMs: 1000 }, step("s3", "Reading src/auth/redirect.ts", "done")],
    );
    await expect(first.getByRole("img", { name: "done" }).first()).toBeVisible();
    await expect(first.locator("[data-subagent-latest]")).toHaveCount(0);
    await first.getByRole("button", { name: "report" }).click();
    await expect(first.getByText("redirect.ts", { exact: true }).first()).toBeVisible();
    await expect(group).toBeVisible();
    expect(realErrors(errors)).toEqual([]);
  });

  test("background commands show in a strip above the composer; a chip scrolls to its item, × stops it", async ({ page }) => {
    const base = Date.parse("2026-11-11T10:00:00.000Z");
    const filler = (from: number, n: number) =>
      Array.from({ length: n }, (_, i) => ({
        kind: "assistant",
        id: `fill-${from + i}`,
        ts: new Date(base + (from + i) * 1000).toISOString(),
        text: `Working note ${from + i}`,
        streaming: false,
      }));
    const { errors } = await boot(page, { transcripts: { [TASK]: filler(0, 40) } });
    const startedAt = new Date(Date.now() - 65_000).toISOString();
    await world.backgroundShell(page, TASK, { id: "bg-dev", command: "pnpm dev --port 1420", output: "VITE ready in 312 ms\n➜ Local: http://localhost:1420/", startedAt });
    // The transcript goes on; the command's line scrolls out of view.
    for (const item of filler(40, 40)) await world.transcript(page, TASK, item);

    const strip = runningStrip(page);
    await expect(strip).toBeVisible();
    const chip = strip.getByRole("button", { name: /Show background command pnpm dev --port 1420/ });
    await expect(chip).toContainText("pnpm dev --port 1420");
    await expect(chip).toContainText(/1m \d+s/);
    // Just above the composer.
    const stripBox = (await strip.boundingBox())!;
    const composerBox = (await composer(page).boundingBox())!;
    expect(stripBox.y + stripBox.height).toBeLessThanOrEqual(composerBox.y);
    expect(composerBox.y - (stripBox.y + stripBox.height)).toBeLessThan(40);

    const row = transcript(page).locator('[data-item-id="bg-dev"]');
    await expect(row).toHaveAttribute("data-background-status", "running");
    await expect(row).not.toBeInViewport();
    await expect(row.getByText("VITE ready in 312 ms")).toHaveCount(0);
    await chip.click();
    await expect(row).toBeInViewport();
    // …and stays there while the transcript goes on (unpinned).
    await world.transcript(page, TASK, { kind: "assistant", id: "after-chip", text: "Still working.", streaming: false });
    await expect(transcript(page).getByText("Still working.")).toHaveCount(1);
    await expect(row).toBeInViewport();
    await expect(row.getByText("VITE ready in 312 ms")).toBeVisible();
    await expect(row).toContainText(/in background · 1m \d+s/);

    // × stops it: the item says so; the chip shows its end for a moment,
    // then the strip empties.
    await clearCalls(page);
    await strip.getByRole("button", { name: "Stop pnpm dev --port 1420" }).click();
    await expect.poll(() => callsOf(page, "stop_background_shell")).toEqual([{ taskId: TASK, toolUseId: "bg-dev" }]);
    await expect(row).toHaveAttribute("data-background-status", "killed");
    await expect(row).toContainText("stopped");
    await expect(strip.locator('[data-running-chip="bg-dev"]')).toHaveAttribute("data-status", "stopped");
    await expect(strip).toHaveCount(0, { timeout: 8_000 });
    expect(realErrors(errors)).toEqual([]);
  });

  test("running subagents are chips; a chip opens the subagent panel in the inspector column, live, and switches; Back returns", async ({ page }) => {
    const { errors } = await boot(page);
    await world.turnStarts(page, TASK);
    await world.subagent(page, TASK, { id: "agent-1", description: "Map the auth module" }, [
      subStep("s1", "Running ls src/auth", "done"),
      subStep("s2", "Reading src/auth/redirect.ts"),
    ]);
    await world.subagent(page, TASK, { id: "agent-2", description: "Find the callers", type: "Explore" }, [subStep("s9", 'Searching "redirect("')]);

    // Two subagents at work: two chips, each with its live step count.
    const strip = runningStrip(page);
    await expect(strip.locator('[data-chip-kind="subagent"]')).toHaveCount(2);
    const chip1 = strip.getByRole("button", { name: /Open subagent Map the auth module/ });
    const chip2 = strip.getByRole("button", { name: /Open subagent Find the callers/ });
    await expect(chip1).toContainText("2 steps");
    await expect(chip2).toContainText("1 step");
    await expect(chip1.getByRole("img")).toHaveCount(1); // the agent mark; the spinner is decorative

    // The inspector starts collapsed: opening a subagent shows the column.
    await page.getByRole("button", { name: "Collapse inspector" }).click();
    await expect(inspector(page)).toHaveAttribute("data-state", "closed");
    await chip1.click();
    await expect(inspector(page)).toHaveAttribute("data-state", "open");
    const panel = subagentPanel(page);
    await expect(panel).toBeVisible();
    await expect(panel.getByRole("heading", { name: "Map the auth module" })).toBeVisible();
    await expect(panel.locator("[data-subagent-meta]")).toContainText(/general-purpose\s*·\s*running\s*·\s*\d+s\s*·\s*2 steps/);
    await expect(panel.getByRole("button").first()).toHaveAccessibleName("Back");
    await expect(panel.locator('[data-tool="Bash"]')).toContainText("Running ls src/auth");
    await expect(panel.locator('[data-tool="Read"]')).toContainText("Reading src/auth/redirect.ts");
    await expect(panel.locator("time")).toHaveCount(0);
    // The task's own inspector content is swapped out (same column).
    await expect(inspector(page).getByRole("region", { name: "Changes" })).toHaveCount(0);

    // A new nested step appears live.
    await world.subagent(page, TASK, { id: "agent-1", description: "Map the auth module" }, [
      subStep("s1", "Running ls src/auth", "done"),
      subStep("s2", "Reading src/auth/redirect.ts", "done"),
      subStep("s3", "Running pnpm test src/auth"),
    ]);
    await expect(panel.locator('[data-item-id="s3"]')).toContainText("Running pnpm test src/auth");
    await expect(panel.locator("[data-subagent-meta]")).toContainText("3 steps");
    await expect(chip1).toContainText("3 steps");

    // The other chip switches the panel.
    await chip2.click();
    await expect(panel.getByRole("heading", { name: "Find the callers" })).toBeVisible();
    await expect(panel.locator("[data-subagent-meta]")).toContainText("Explore");
    await expect(panel.locator('[data-item-id="s9"]')).toBeVisible();
    await expect(panel.locator('[data-item-id="s1"]')).toHaveCount(0);

    // Back returns to the inspector; so does Esc.
    await panel.getByRole("button", { name: "Back" }).click();
    await expect(subagentPanel(page)).toHaveCount(0);
    await expect(inspector(page).getByRole("region", { name: "Changes" })).toBeVisible();
    await chip1.click();
    await expect(subagentPanel(page)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(subagentPanel(page)).toHaveCount(0);
    expect(realErrors(errors)).toEqual([]);
  });

  test("a finished subagent's chip drops off after a moment unless pinned; a pinned one stays until dismissed", async ({ page }) => {
    const { errors } = await boot(page);
    await world.turnStarts(page, TASK);
    await world.subagent(page, TASK, { id: "agent-1", description: "Map the auth module" }, [subStep("s1", "Running ls", "done")]);
    await world.subagent(page, TASK, { id: "agent-2", description: "Find the callers" }, [subStep("s9", "Searching")]);
    const strip = runningStrip(page);
    const chip2 = strip.locator('[data-running-chip="agent-2"]');
    // The pin shows on hover (and focus).
    const pin = chip2.getByRole("button", { name: "Pin Find the callers" });
    await expect(pin).toHaveCSS("opacity", "0");
    await chip2.hover();
    await expect(pin).toHaveCSS("opacity", "1");
    await pin.click();
    await expect(chip2.getByRole("button", { name: "Unpin Find the callers" })).toHaveAttribute("aria-pressed", "true");

    await world.subagent(page, TASK, { id: "agent-1", description: "Map the auth module", status: "done", output: "Done." }, [subStep("s1", "Running ls", "done")]);
    await world.subagent(page, TASK, { id: "agent-2", description: "Find the callers", status: "done", output: "Found 3." }, [subStep("s9", "Searching", "done")]);
    const chip1 = strip.locator('[data-running-chip="agent-1"]');
    // Both show their end state…
    await expect(chip1).toHaveAttribute("data-status", "done");
    await expect(chip1).toContainText("✓");
    await expect(chip2).toHaveAttribute("data-status", "done");
    // …then the unpinned one drops off; the pinned one stays.
    await expect(chip1).toHaveCount(0, { timeout: 8_000 });
    await expect(chip2).toBeVisible();
    await expect(chip2).toHaveAttribute("data-pinned", "true");
    await chip2.getByRole("button", { name: "Dismiss Find the callers" }).click();
    await expect(strip).toHaveCount(0);
    expect(realErrors(errors)).toEqual([]);
  });

  test("a subagent's row opens its panel and its chevron expands inline; “Show in transcript” scrolls the main view to it", async ({ page }) => {
    const base = Date.parse("2026-11-11T10:00:00.000Z");
    const filler = (from: number, n: number) =>
      Array.from({ length: n }, (_, i) => ({
        kind: "assistant",
        id: `fill-${from + i}`,
        ts: new Date(base + (from + i) * 1000).toISOString(),
        text: `Working note ${from + i}`,
        streaming: false,
      }));
    const { errors } = await boot(page, { transcripts: { [TASK]: filler(0, 30) } });
    await world.subagent(
      page,
      TASK,
      { id: "agent-1", description: "Map the auth module", status: "done", output: "The redirect lives in `redirect.ts`.", tokens: 14_117 },
      [subStep("s1", "Running ls src/auth", "done"), subStep("s2", "Reading src/auth/redirect.ts", "done")],
    );
    const row = transcript(page).locator('[data-item-id="agent-1"]');
    await expect(row).toBeVisible();

    // The row's title opens the panel; it doesn't expand inline.
    await row.getByRole("button", { name: /Subagent Map the auth module/ }).click();
    const panel = subagentPanel(page);
    await expect(panel.getByRole("heading", { name: "Map the auth module" })).toBeVisible();
    await expect(row.locator("[data-subagent-transcript]")).toHaveCount(0);
    await expect(row).toHaveAttribute("data-selected", "true");
    // Done: how long it ran, its steps and tokens (no cost per subagent).
    await expect(panel.locator("[data-subagent-meta]")).toContainText(/general-purpose\s*·\s*done\s*·\s*\d+(\.\d)?s\s*·\s*2 steps\s*·\s*14.1k tokens/);
    // Done: its report, collapsible.
    const report = panel.getByRole("region", { name: "Report" });
    await expect(report).toContainText("The redirect lives in redirect.ts.");
    await report.getByRole("button", { name: "Report" }).click();
    await expect(report.locator("[data-subagent-final-report]")).toHaveCount(0);

    // The chevron still expands it inline, and leaves the panel be.
    await panel.getByRole("button", { name: "Back" }).click();
    await row.getByRole("button", { name: /2 steps/ }).click();
    await expect(row.getByRole("group", { name: "Subagent: Map the auth module" })).toBeVisible();
    await expect(subagentPanel(page)).toHaveCount(0);
    // Its row's empty space opens it too.
    const rowBox = (await row.boundingBox())!;
    await row.click({ position: { x: rowBox.width - 8, y: 6 } });
    await expect(subagentPanel(page)).toBeVisible();

    // The transcript goes on; the row scrolls out of view.
    for (const item of filler(30, 40)) await world.transcript(page, TASK, item);
    await expect(row).not.toBeInViewport();
    await panel.getByRole("button", { name: /Show in transcript/ }).click();
    await expect(row).toBeInViewport();
    await expect(row).toHaveAttribute("data-flash", "true");
    await expect(row).not.toHaveAttribute("data-flash", "true", { timeout: 4_000 });
    expect(realErrors(errors)).toEqual([]);
  });

  test("thinking without a summary is a plain line; with one it expands", async ({ page }) => {
    await boot(page);
    await world.transcript(page, TASK, { kind: "thinking", id: "th-empty", text: "", durationMs: 1000 });
    const empty = transcript(page).locator('[data-item-id="th-empty"]');
    await expect(empty).toHaveText(/Thought for 1s/);
    await expect(empty.getByRole("button")).toHaveCount(0);
    await expect(empty.locator("svg")).toHaveCount(0);

    await world.transcript(page, TASK, { kind: "thinking", id: "th-sum", text: "The cookie refresh drops ?next=.", durationMs: 2000 });
    const summarized = transcript(page).locator('[data-item-id="th-sum"]');
    await summarized.getByRole("button", { name: /Thought for 2s/ }).click();
    await expect(summarized).toContainText("The cookie refresh drops ?next=.");
  });

  test("a Claude task without a view keeps its terminal, and offers the switch", async ({ page }) => {
    const f = makeFixtures() as ReturnType<typeof makeFixtures> & Record<string, unknown>;
    f.stateful = true;
    await bootApp(page, f as never);
    await expectBackend(page);
    await expect(page.getByTestId("transcript")).toHaveCount(0);
    expect(await callsOf(page, "get_transcript")).toEqual([]);
    const tabs = page.getByRole("tablist", { name: "Workspace tabs" });
    await expect(tabs.getByLabel("Agent view")).toHaveCount(1);
    // The composer is today's: the mic (Send once there's text), no Stop, no queue.
    await expect(page.getByRole("button", { name: "Dictate" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Stop turn" })).toHaveCount(0);
  });

  test("other agents stay on the terminal with no toggle (phase 1)", async ({ page }) => {
    // Even a stray agentView doesn't put Codex in transcript view.
    const f = transcriptFixtures();
    f.workspaces = f.workspaces.map((w) => (w.id === TASK ? { ...w, agent: "codex", command: "codex" } : w)) as typeof f.workspaces;
    await bootApp(page, f as never);
    await expectBackend(page);
    await expect(page.getByTestId("transcript")).toHaveCount(0);
    await expect(page.getByRole("tablist", { name: "Workspace tabs" }).getByLabel("Agent view")).toHaveCount(0);
    expect(await callsOf(page, "get_transcript")).toEqual([]);
  });
});

/**
 * Reply suggestions: in transcript view the composer's chips are what the
 * last turn suggests. The conversation's own (an offer's options) show at
 * once; `suggest_replies` (Haiku, via the user's CLI) replaces them through
 * `phasr://suggestions`. A chip fills the input; only ⌘↵ sends.
 */
test.describe("Reply suggestions", () => {
  const OFFER =
    "Fixed: the redirect keeps `?next=` across the cookie refresh.\n\nWant me to open a draft PR, or also handle the mobile deep-link case?";
  const replies = (page: Page) => page.getByRole("group", { name: "Suggested replies" });

  /** A user message, the agent's answer, and the turn's end (result `r1`). */
  async function turn(page: Page, text: string) {
    await composer(page).fill("Fix the login redirect");
    await page.keyboard.press("Meta+Enter");
    await expect(items(page, "user")).toContainText("Fix the login redirect");
    await expect(replies(page).getByRole("button")).toHaveCount(0);
    await world.transcript(page, TASK, { kind: "assistant", id: "a1", text, streaming: false });
    await world.turnEnds(page, TASK, { id: "r1", durationMs: 4_000, costUsd: 0.01 });
  }

  test("a turn ending with an offer shows its options; a click fills the composer and doesn't send", async ({ page }) => {
    await boot(page);
    await turn(page, OFFER);
    await expect(replies(page).getByRole("button")).toHaveText(["Open a draft PR", "Also handle the mobile deep-link case"]);
    await expect.poll(() => callsOf(page, "suggest_replies")).toEqual([{ taskId: TASK }]);

    await clearCalls(page);
    await replies(page).getByRole("button", { name: "Also handle the mobile deep-link case" }).click();
    await expect(composer(page)).toHaveValue("Also handle the mobile deep-link case");
    await expect(composer(page)).toBeFocused();
    // The input has text now: the chips are gone.
    await expect(replies(page).getByRole("button")).toHaveCount(0);
    expect(await callsOf(page, "send_message_to_task")).toEqual([]);

    // Emptied: they come back, and Tab reaches the first one.
    await composer(page).fill("");
    await expect(replies(page).getByRole("button")).toHaveCount(2);
    await composer(page).focus();
    await page.keyboard.press("Tab");
    await expect(replies(page).getByRole("button", { name: "Open a draft PR" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(composer(page)).toHaveValue("Open a draft PR");
    expect(await callsOf(page, "send_message_to_task")).toEqual([]);

    // ⌘↵ is what sends; the chips hide while the turn runs.
    await page.keyboard.press("Meta+Enter");
    await expect
      .poll(() => callsOf(page, "send_message_to_task"))
      .toEqual([{ taskId: TASK, text: "Open a draft PR", submit: true }]);
    await expect(page.getByRole("button", { name: "Stop turn" })).toBeVisible();
    await expect(replies(page).getByRole("button")).toHaveCount(0);
  });

  test("generated suggestions replace the conversation's own", async ({ page }) => {
    await boot(page, { holdSuggestions: true });
    await turn(page, OFFER);
    await expect(replies(page).getByRole("button")).toHaveText(["Open a draft PR", "Also handle the mobile deep-link case"]);
    const before = await replies(page).boundingBox();
    await world.suggestionsReady(page, TASK, "r1", [
      {
        label: "Open a draft PR for the fix",
        text: "Open a draft PR for the redirect fix, with the ?next= test in the description.",
        source: "generated",
      },
      {
        label: "Handle deep links on iOS too",
        text: "Also handle the mobile deep-link case, starting with iOS universal links.",
        source: "generated",
      },
    ]);
    await expect(replies(page).getByRole("button")).toHaveText(["Open a draft PR for the fix", "Handle deep links on iOS too"]);
    await expect(replies(page).locator("[data-suggestion-source=generated]")).toHaveCount(2);
    // Same row, same place: nothing around it moved.
    expect(await replies(page).boundingBox()).toEqual(before);
    await replies(page).getByRole("button", { name: "Handle deep links on iOS too" }).click();
    await expect(composer(page)).toHaveValue("Also handle the mobile deep-link case, starting with iOS universal links.");
    expect(await callsOf(page, "send_message_to_task")).toHaveLength(1);
  });

  test("while they're being generated and the turn suggests nothing itself, a shimmer holds the place", async ({ page }) => {
    await boot(page, { holdSuggestions: true });
    await turn(page, "The redirect now keeps `?next=` across the cookie refresh.");
    await expect(replies(page).locator("[data-suggestion-shimmer]")).toBeVisible();
    await expect(replies(page).getByRole("button")).toHaveCount(0);
    await world.suggestionsReady(page, TASK, "r1", [
      { label: "Add a test for the refresh", text: "Add a regression test for ?next= surviving the cookie refresh.", source: "generated" },
    ]);
    await expect(replies(page).getByRole("button")).toHaveText(["Add a test for the refresh"]);
    await expect(replies(page).locator("[data-suggestion-shimmer]")).toHaveCount(0);
  });

  test("with Suggest replies off, suggest_replies is never called", async ({ page }) => {
    await boot(page);
    await page.keyboard.press("Meta+,");
    const sheet = page.getByRole("dialog", { name: "Settings" });
    await sheet.getByRole("navigation", { name: "Settings sections" }).getByRole("button", { name: "Agents & keys" }).click();
    const toggle = sheet.getByRole("switch", { name: "Suggest replies" });
    await expect(toggle).toBeChecked();
    await expect(sheet).toContainText(
      "After each turn, a quick Haiku call through your Claude login suggests what to say next (≈$0.001 per turn). Off: suggestions come only from the conversation itself.",
    );
    await toggle.click();
    await expect(toggle).not.toBeChecked();
    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();

    await turn(page, OFFER);
    // The conversation's own suggestions still show.
    await expect(replies(page).getByRole("button")).toHaveText(["Open a draft PR", "Also handle the mobile deep-link case"]);
    await page.waitForTimeout(300);
    expect(await callsOf(page, "suggest_replies")).toEqual([]);
    await expect(replies(page).locator("[data-suggestion-shimmer]")).toHaveCount(0);
  });
});
