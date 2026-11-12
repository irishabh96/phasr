import { test, expect } from "@playwright/test";
import { bootApp, expectBackend, terminal } from "./harness";

/**
 * macOS showed Writing Tools' round icon and a "Write with Siri" bubble at
 * the agent terminal's top-left: where ghostty-web's hidden textarea sits,
 * focused. Chromium can't show that popup, so this checks the opt-outs are
 * on both editable elements a live terminal has (lib/terminal/textAssist).
 * The webview-wide Writing Tools switch is native (src-tauri
 * `writing_tools.rs`) and needs the real app to see.
 */
test("the terminal's editable elements opt out of writing aids", async ({ page }) => {
  await bootApp(page);
  await expectBackend(page);

  const surface = terminal(page);
  // The textarea is created by `term.open`, after the engine attaches.
  await expect(surface.locator("textarea")).toHaveCount(1);
  const attrs = await surface.evaluate((root) => {
    const pick = (el: Element) =>
      Object.fromEntries(
        ["writingsuggestions", "spellcheck", "autocorrect", "autocapitalize", "autocomplete", "aria-autocomplete"].map(
          (n) => [n, el.getAttribute(n)],
        ),
      );
    const host = root.querySelector('[contenteditable="true"]')!;
    const textarea = root.querySelector("textarea")!;
    return { host: pick(host), textarea: pick(textarea), hostFocusable: host.getAttribute("role") };
  });

  expect(attrs.hostFocusable).toBe("textbox");
  expect(attrs.host).toMatchObject({
    writingsuggestions: "false",
    spellcheck: "false",
    autocorrect: "off",
    autocapitalize: "off",
    "aria-autocomplete": "none",
  });
  expect(attrs.textarea).toMatchObject({
    writingsuggestions: "false",
    spellcheck: "false",
    autocorrect: "off",
    autocapitalize: "off",
    autocomplete: "off",
  });
});
