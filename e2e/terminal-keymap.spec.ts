import { test, expect, type Page } from "@playwright/test";
import {
  bootApp,
  calls,
  clearCalls,
  expectBackend,
  makeFixtures,
  terminal,
} from "./harness";

/**
 * Phase 0, question 3, answered for real rather than from a README: **does
 * the custom key handler suppress the emulator's own handling?**
 *
 * `attachCustomKeyEventHandler`'s polarity is **inverted** between the two
 * engines phasr has used:
 *
 * - the previous engine — return `false` to suppress its handling, `true` to allow.
 * - ghostty-web — `if (handler(e)) { e.preventDefault(); return; }`
 *   (`InputHandler.handleKeyDown`), i.e. return `true` to suppress.
 *
 * A backend that copied the old polarity would send every mapped chord to
 * the PTY *and* let ghostty handle the same key, and would swallow every
 * key the map declines — i.e. all ordinary typing. Both halves are
 * asserted here.
 *
 * `send_input_to_task` is the observable: it is what the surface's
 * `onData` feeds, so "the bytes reached the PTY" is exactly what the
 * recorded invoke args say.
 */

interface Sent {
  cmd: string;
  args: { data?: string };
}

const sentBytes = async (page: Page): Promise<string[]> =>
  (await calls(page))
    .filter((c) => c.cmd === "send_input_to_task")
    .map((c: Sent) => c.args?.data ?? "");

async function setup(page: Page) {
  await bootApp(page, makeFixtures());
  await expect(page).toHaveURL(/workspaces\/ws-agent/, { timeout: 25_000 });
  await expectBackend(page);
  await page.waitForTimeout(1200);
  await terminal(page).click();
  await page.waitForTimeout(300);
  await clearCalls(page);
}

/**
 * Chords the iTerm table owns. Only a handful, chosen to cover each
 * modifier family the table uses — the unit tests in `keymap.test.ts`
 * already cover all 40-odd entries, and what needs proving here is that
 * the *delivery mechanism* works, not the table.
 */
const CHORDS: [name: string, press: string, expected: string][] = [
  ["⌘⌫ kill-line", "Meta+Backspace", "\x15"],
  ["⌘← line start", "Meta+ArrowLeft", "\x01"],
  ["⌘→ line end", "Meta+ArrowRight", "\x05"],
  ["⌥← word back", "Alt+ArrowLeft", "\x1bb"],
  ["⌥→ word fwd", "Alt+ArrowRight", "\x1bf"],
  ["⇧↵ insert newline", "Shift+Enter", "\x1b\r"],
];

test.describe("terminal keymap", () => {
  for (const [name, press, expected] of CHORDS) {
    test(`${name} reaches the PTY exactly once`, async ({ page }) => {
      await setup(page);
      await page.keyboard.press(press);
      await page.waitForTimeout(400);

      const sent = await sentBytes(page);
      console.log(`KEYMAP ${press}: ${JSON.stringify(sent)}`);
      // Exactly one send: the mapped sequence, and nothing the
      // emulator's own key handling would have added on top of it.
      expect(sent).toEqual([expected]);
    });
  }

  test("an UNMAPPED key still reaches the PTY (the inverted-return trap)", async ({
    page,
  }) => {
    await setup(page);
    // The map returns null for these, so the emulator's own handling
    // must run. With the return polarity wrong on ghostty this is the
    // assertion that fails, and it fails as "typing does nothing".
    await page.keyboard.type("hi");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(400);

    const sent = await sentBytes(page);
    console.log(`KEYMAP plain: ${JSON.stringify(sent)}`);
    expect(sent.join("")).toBe("hi\r");
  });

  /**
   * ⌘K reaches the Command Palette, which listens on `document` in the
   * BUBBLE phase (`CommandPalette.tsx`). ghostty-web's `InputHandler`
   * calls `preventDefault()` **and `stopPropagation()`** on any key it
   * can encode, so an unguarded backend kills ⌘K — and with it every
   * other document-level bubble listener in the app (both sidebar
   * menus, `OpenInMenu`, `SyncButton`, `RunCommandPicker`,
   * `WorkspaceActionsMenu`) the moment a terminal has focus. The previous
   * engine ignored meta keys entirely, which is why this was never a
   * problem before.
   */
  test("an app ⌘-chord still reaches the app with the terminal focused", async ({
    page,
  }) => {
    await setup(page);
    await page.keyboard.press("Meta+k");
    await expect(page.locator("[cmdk-root]").first()).toBeVisible({
      timeout: 5000,
    });
    // …and it never reached the PTY.
    expect(await sentBytes(page)).toEqual([]);
  });

  test("a mapped chord does not also emit the emulator's default", async ({
    page,
  }) => {
    await setup(page);
    // ⌥⌫ is a chord AND a key both emulators would otherwise encode
    // themselves (as \x7f or \x1b\x7f). Only the mapped bytes may show up.
    await page.keyboard.press("Alt+Backspace");
    await page.waitForTimeout(400);
    expect(await sentBytes(page)).toEqual(["\x1b\x7f"]);
  });
});
