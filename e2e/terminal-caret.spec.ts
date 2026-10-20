import { test, expect, type Page } from "@playwright/test";
import {
  bootApp,
  calls,
  clearCalls,
  expectBackend,
  makeFixtures,
  terminal,
  waitForCall,
} from "./harness";

async function expectNativeCaretHidden(page: Page) {
  const host = terminal(page).locator('[contenteditable="true"]');
  await expect(host).toBeVisible();
  // The editable host wraps a full-height canvas. Its browser caret can
  // span that canvas, independently of Ghostty's own rendered cursor.
  await expect(host).toHaveCSS("caret-color", "rgba(0, 0, 0, 0)");
  await expect(host.locator("textarea")).toHaveCSS(
    "caret-color",
    "rgba(0, 0, 0, 0)",
  );
  await expect
    .poll(() => host.evaluate((el) => el.contains(document.activeElement)))
    .toBe(true);
}

async function expectInput(page: Page, text: string, target: string) {
  await clearCalls(page);
  await page.keyboard.type(text);
  await expect
    .poll(async () =>
      (await calls(page))
        .filter((c) => c.cmd.startsWith("send_"))
        .map(
          (c) =>
            `${c.cmd}:${c.args.taskId ?? c.args.sessionId}:${c.args.data}`,
        ),
    )
    .toEqual([`${target}:${text}`]);
}

test("native caret stays hidden through focus, clicks and tab switches without losing input", async ({
  page,
}) => {
  await bootApp(page, makeFixtures());
  await expect(page).toHaveURL(/workspaces\/ws-agent/, { timeout: 25_000 });
  await expectBackend(page);
  await waitForCall(page, "open_task_terminal", 15_000);
  await expectNativeCaretHidden(page);
  const agentId = await terminal(page).getAttribute("data-terminal-id");
  await expectInput(page, "a", "send_input_to_task:ws-agent");

  await terminal(page).locator("canvas").click({ position: { x: 30, y: 30 } });
  await expectNativeCaretHidden(page);
  await expectInput(page, "b", "send_input_to_task:ws-agent");

  await page.keyboard.press("Meta+t");
  await expect(page.getByRole("tab")).toHaveCount(2);
  await waitForCall(page, "start_session_terminal", 15_000);
  await expect(terminal(page)).not.toHaveAttribute("data-terminal-id", agentId!);
  await expectNativeCaretHidden(page);
  await expectInput(page, "c", "send_session_input:session-1");

  await page.getByRole("tab").first().click();
  await expect(terminal(page)).toHaveAttribute("data-terminal-id", agentId!);
  await expectNativeCaretHidden(page);
  await expectInput(page, "d", "send_input_to_task:ws-agent");
});
