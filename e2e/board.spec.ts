import { expect, test, type Page } from "@playwright/test";
import { boardFixtures } from "./fixtures/board";
import { bootApp, calls, clearCalls, setResponse, waitForCall } from "./harness";

/**
 * Board (A-Polish Main): Queued · Needs you · Running · Review, failed tasks
 * in Needs you, no Done column (a "merged today" line opens the List
 * filtered to done), approvals answered from the card.
 */

const BENIGN = /favicon|sourcemap|Download the React DevTools/i;
const realErrors = (errors: string[]) => errors.filter((e) => !BENIGN.test(e));

async function boot(page: Page, fixtures = boardFixtures(), view: "board" | "list" = "board") {
  await page.addInitScript((v) => {
    localStorage.removeItem("phasr.lastWorkspace");
    localStorage.setItem("phasr.board.view", v);
  }, view);
  const res = await bootApp(page, fixtures as never);
  await expect(page.getByRole("heading", { name: "Board", level: 1 })).toBeVisible({ timeout: 20_000 });
  if (view === "board") {
    await expect(column(page, "Needs you").getByText("upgrade to tauri v2")).toBeVisible({ timeout: 20_000 });
  } else {
    await expect(page.locator("tbody tr[data-lane]").first()).toBeVisible({ timeout: 20_000 });
  }
  return res;
}

const board = (page: Page) => page.locator("[data-board-column]").first().locator("..");
const column = (page: Page, name: string) =>
  page.getByRole("region", { name, exact: true }).and(page.locator("[data-board-column]"));

test("four columns in order, failed under Needs you, no Done column", async ({ page }) => {
  const { errors } = await boot(page);
  const headings = board(page).locator("[data-board-column] > h2");
  await expect(headings).toHaveText([/^Queued\s*1$/, /^Needs you\s*2$/, /^Running\s*1$/, /^Review\s*2$/]);
  await expect(page.locator('[data-board-column="done"]')).toHaveCount(0);

  // Failed sits with the tasks that need you, after the approval.
  const needs = column(page, "Needs you");
  const cards = needs.locator("[data-lane]");
  await expect(cards.nth(0)).toHaveAttribute("data-lane", "needs-you");
  await expect(cards.nth(1)).toHaveAttribute("data-lane", "failed");
  await expect(cards.nth(1)).toContainText("Failed");
  await expect(cards.nth(1)).toContainText("exit 1");

  // Lane details: running activity, review checks + diff, queued repo + dependency.
  await expect(column(page, "Running")).toContainText("Running pnpm test src/auth");
  const review = column(page, "Review").locator("[data-lane]").first();
  await expect(review).toContainText("checks");
  await expect(review).toContainText("7 files");
  await expect(review).toContainText("+212 −48");
  const queued = column(page, "Queued").locator("[data-lane]").first();
  await expect(queued).toContainText("sidecar");
  await expect(queued).toContainText("after tauri-v2");
  await expect(queued.getByRole("button", { name: /Start now/ })).toBeVisible();

  // Timers are Inter with tabular figures, not mono.
  const waiting = cards.nth(0).getByText(/^waiting/);
  await expect(waiting).toHaveCSS("font-variant-numeric", "tabular-nums");
  expect(await waiting.evaluate((el) => getComputedStyle(el).fontFamily)).not.toMatch(/mono/i);

  expect(realErrors(errors), realErrors(errors).join("\n")).toHaveLength(0);
});

test("Allow answers the agent with the card's attention id", async ({ page }) => {
  await boot(page);
  await clearCalls(page);
  const card = column(page, "Needs you").locator('[data-lane="needs-you"]');
  await expect(card).toContainText("Wants to run");
  await expect(card).toContainText("pnpm install");
  await card.getByRole("button", { name: "Allow", exact: true }).click();
  await waitForCall(page, "respond_to_attention");
  const sent = (await calls(page)).filter((c) => c.cmd === "respond_to_attention");
  expect(sent).toHaveLength(1);
  expect(sent[0]!.args).toMatchObject({ taskId: "ws-needs", attentionId: "att-1", response: "allow-once" });
  // Answering doesn't open the task.
  await expect(page).not.toHaveURL(/workspaces\//);
});

test("Deny sends deny; a stale prompt says so instead of failing loudly", async ({ page }) => {
  await boot(page);
  await setResponse(page, "respond_to_attention", { __reject: "stale attention: att-1" });
  await clearCalls(page);
  const card = column(page, "Needs you").locator('[data-lane="needs-you"]');
  await card.getByRole("button", { name: "Deny", exact: true }).click();
  await waitForCall(page, "respond_to_attention");
  const sent = (await calls(page)).filter((c) => c.cmd === "respond_to_attention");
  expect(sent[0]!.args).toMatchObject({ attentionId: "att-1", response: "deny" });
  await expect(page.getByText("That prompt already changed")).toBeVisible();
});

test("right-click opens the task menu for the card under the pointer, and nothing off-card", async ({ page }) => {
  await boot(page);
  for (const name of ["fix login redirect bug", "move settings into a sheet"]) {
    await page.locator("[data-workspace-id]").filter({ hasText: name }).first().click({ button: "right" });
    await page.getByRole("menuitem", { name: "Rename…" }).click();
    const dialog = page.getByRole("dialog", { name: "Rename workspace" });
    await expect(dialog.getByRole("textbox", { name: "Workspace name" })).toHaveValue(name);
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
  }
  // Empty column space below the cards: no menu.
  const running = column(page, "Running");
  const box = (await running.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height - 20, { button: "right" });
  await expect(page.getByRole("menu")).toHaveCount(0);
});

test("a card opens its task; Review opens on Changes", async ({ page }) => {
  await boot(page);
  await expect(column(page, "Review").getByRole("link", { name: "move settings into a sheet" })).toHaveAttribute(
    "href",
    /pane=changes/,
  );
  await column(page, "Running").getByRole("link", { name: "fix login redirect bug" }).click();
  await expect(page).toHaveURL(/workspaces\/ws-running/);
});

test("merged today → Show opens the List filtered to done; Show all clears it", async ({ page }) => {
  await boot(page);
  const line = column(page, "Review").getByText("2 merged today");
  await expect(line).toBeVisible();
  await page.getByRole("button", { name: "Show done tasks" }).click();
  await expect(page.getByRole("radio", { name: "List" })).toHaveAttribute("aria-checked", "true");
  const rows = page.locator("tbody tr[data-lane]");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText("add run command presets");
  await expect(rows.nth(0)).toContainText("Merged");
  await page.getByRole("button", { name: "Show all" }).click();
  await expect(rows).toHaveCount(8);
  // Most urgent first: needs you, then failed.
  await expect(rows.nth(0)).toHaveAttribute("data-lane", "needs-you");
  await expect(rows.nth(1)).toHaveAttribute("data-lane", "failed");
});

test("keyboard: ↓ walks cards, → jumps columns, ↵ opens", async ({ page }) => {
  await boot(page);
  const first = column(page, "Needs you").getByRole("link", { name: "upgrade to tauri v2" });
  await first.focus();
  await page.keyboard.press("ArrowDown");
  await expect(column(page, "Needs you").getByRole("link", { name: "e2e tests for the board" })).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(column(page, "Running").getByRole("link", { name: "fix login redirect bug" })).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(column(page, "Review").getByRole("link", { name: "move settings into a sheet" })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(column(page, "Review").getByRole("link", { name: "write changelog for 0.4" })).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(column(page, "Running").getByRole("link", { name: "fix login redirect bug" })).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/workspaces\/ws-review-1/);
});

test("New task: one primary, ⌘N in the tooltip rather than a chip", async ({ page }) => {
  await boot(page);
  const header = page.locator("header").filter({ has: page.getByRole("heading", { name: "Board", level: 1 }) });
  const btn = header.getByRole("button", { name: "New task", exact: true });
  await expect(btn).toBeVisible();
  await expect(btn.locator("kbd")).toHaveCount(0);
  await btn.hover();
  await expect(page.getByRole("tooltip")).toContainText("⌘N");
  await expect(header).toContainText("All repositories");
  await expect(header).not.toContainText(/agents? running/);
});

test("500 tasks: columns virtualise and the board renders under 50ms", async ({ page }) => {
  await boot(page, boardFixtures({ extraTasks: 492 }), "list");
  // List with 500 rows renders a window, not every row.
  const listRows = await page.locator("tbody tr[data-lane]").count();
  expect(listRows).toBeLessThan(120);
  // List → Board, timed from the click to the next frame (render, commit,
  // layout effects and the virtualiser's measurements). Median of three,
  // so one GC pause on a loaded machine doesn't decide it.
  const switchToBoard = () =>
    page.evaluate(async () => {
      const radio = document.querySelector<HTMLButtonElement>('[role="radio"][aria-checked="false"]');
      const t0 = performance.now();
      radio!.click();
      await new Promise((r) => requestAnimationFrame(() => r(null)));
      return performance.now() - t0;
    });
  const times: number[] = [];
  for (let i = 0; i < 3; i++) {
    times.push(await switchToBoard());
    await expect(page.locator("[data-board-column]")).toHaveCount(4);
    if (i < 2) {
      await page.getByRole("radio", { name: "List" }).click();
      await expect(page.locator("tbody tr[data-lane]").first()).toBeVisible();
    }
  }
  const mounted = await page.locator("[data-board-column] [data-lane]").count();
  expect(mounted).toBeLessThan(120);
  const median = [...times].sort((a, b) => a - b)[1]!;
  console.log(
    `board render (500 tasks): median ${median.toFixed(1)}ms of [${times.map((t) => t.toFixed(1)).join(", ")}], ` +
      `${mounted} cards mounted, ${listRows} list rows`,
  );
  expect(median).toBeLessThan(50);
});
