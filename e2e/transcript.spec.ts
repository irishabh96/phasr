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

  test("a Claude task without a view keeps its terminal, and offers the switch", async ({ page }) => {
    const f = makeFixtures() as ReturnType<typeof makeFixtures> & Record<string, unknown>;
    f.stateful = true;
    await bootApp(page, f as never);
    await expectBackend(page);
    await expect(page.getByTestId("transcript")).toHaveCount(0);
    expect(await callsOf(page, "get_transcript")).toEqual([]);
    const tabs = page.getByRole("tablist", { name: "Workspace tabs" });
    await expect(tabs.getByLabel("Agent view")).toHaveCount(1);
    // The composer is today's: Send, no Stop, no queue.
    await expect(page.getByRole("button", { name: "Send" })).toBeVisible();
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
