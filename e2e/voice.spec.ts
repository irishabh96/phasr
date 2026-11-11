/**
 * E2E: voice input. The backend is mocked (no microphone or Whisper in a
 * browser): `list_voice_models` / `start_dictation` / `stop_dictation` are
 * answered by the harness, and the level meter and download progress are
 * emitted as their Tauri events.
 */
import { test, expect, type Page } from "@playwright/test";
import { bootApp, calls, clearCalls, expectBackend, makeFixtures, setResponse, waitForCall } from "./harness";

const SHOTS = process.env.PHASR_SHOTS_DIR;

const models = (installed: boolean) => [
  {
    id: "base-en",
    label: "Fast",
    detail: "Whisper base · English",
    sizeBytes: 147_964_211,
    languages: "english",
    installed,
    downloading: null,
  },
  {
    id: "small-en",
    label: "Accurate",
    detail: "Whisper small · English",
    sizeBytes: 190_098_681,
    languages: "english",
    installed: false,
    downloading: null,
  },
  {
    id: "large-v3-turbo",
    label: "Multilingual",
    detail: "Whisper large-v3 turbo · 99 languages",
    sizeBytes: 574_041_195,
    languages: "multilingual",
    installed: false,
    downloading: null,
  },
];

async function boot(page: Page, installed: boolean) {
  const f = makeFixtures() as ReturnType<typeof makeFixtures> & Record<string, unknown>;
  f.overrides = {
    ...((f.overrides as Record<string, unknown>) ?? {}),
    list_voice_models: models(installed),
    microphone_access: "authorized",
    start_dictation: null,
    cancel_dictation: null,
    download_voice_model: null,
  };
  const res = await bootApp(page, f as never);
  await expect(page).toHaveURL(/workspaces\/ws-agent/, { timeout: 25_000 });
  await expectBackend(page);
  return res;
}

const emit = (page: Page, event: string, payload: unknown) =>
  page.evaluate(([e, p]) => (window as any).__E2E__.emit(e, p), [event, payload] as const);

async function speak(page: Page, n = 40) {
  for (let i = 0; i < n; i++) {
    await emit(page, "phasr://voice-level", { level: 0.15 + 0.7 * Math.abs(Math.sin(i / 3)) });
  }
}

test("Composer: dictate, see the meter, ↵ inserts the text at the caret", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const { errors } = await boot(page, true);
  const box = page.getByPlaceholder(/^Reply to /);
  await box.fill("Please now");
  await box.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(6, 6));
  const before = await box.boundingBox();

  await setResponse(page, "stop_dictation", "run the tests");
  await clearCalls(page);
  // With text in the box the slot is Send; ⌘⇧D still dictates at the caret.
  await expect(page.getByRole("button", { name: "Send" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Dictate", exact: true })).toHaveCount(0);
  await page.keyboard.press("Meta+Shift+D");
  await waitForCall(page, "start_dictation");
  expect((await calls(page)).find((c) => c.cmd === "start_dictation")?.args).toEqual({ modelId: "base-en" });

  const bar = page.getByRole("group", { name: "Dictation" });
  await expect(bar).toHaveAttribute("data-dictation", "recording");
  await speak(page);
  await expect(page.getByTestId("dictation-waveform")).toHaveAttribute("data-readings", "40");
  await expect(page.getByRole("timer", { name: "Recording time" })).toHaveText(/^0:0\d$/);
  // The box keeps its size: the bar replaces the controls row.
  expect((await box.boundingBox())?.height).toBe(before?.height);
  if (SHOTS) await page.locator("textarea[id^=composer-]").locator("xpath=../..").screenshot({ path: `${SHOTS}/dictation-composer.png` });

  await page.keyboard.press("Enter");
  await waitForCall(page, "stop_dictation");
  await expect(box).toHaveValue("Please run the tests now");
  await expect(page.getByRole("button", { name: "Send" })).toBeVisible();
  await expect(bar).toHaveCount(0);
  // Inserted, not sent: the message waits for ⌘↵.
  expect((await calls(page)).some((c) => c.cmd === "send_message_to_task")).toBe(false);
  expect(errors.filter((e) => /Uncaught|PAGEERROR/.test(e))).toEqual([]);
});

test("Composer: an empty box's send slot is the mic; typing turns it into Send", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await boot(page, true);
  const box = page.getByPlaceholder(/^Reply to /);
  const mic = page.getByRole("button", { name: "Dictate", exact: true });
  await expect(mic).toBeVisible();
  await expect(page.getByRole("button", { name: "Send" })).toHaveCount(0);
  await expect(page.getByText("⌘↵ send")).toHaveCount(0);
  if (SHOTS) await box.locator("xpath=../..").screenshot({ path: `${SHOTS}/composer-empty.png` });
  await box.fill("hello");
  await expect(page.getByRole("button", { name: "Send" })).toBeVisible();
  await expect(mic).toHaveCount(0);
  if (SHOTS) await box.locator("xpath=../..").screenshot({ path: `${SHOTS}/composer-typed.png` });
  await box.fill("");
  await expect(mic).toBeVisible();

  // Clicking the mic records; finishing fills the box and the slot becomes Send.
  await setResponse(page, "stop_dictation", "Ship it.");
  await mic.click();
  await expect(page.getByRole("group", { name: "Dictation" })).toHaveAttribute("data-dictation", "recording");
  await page.getByRole("button", { name: "Finish dictation" }).click();
  await expect(box).toHaveValue("Ship it.");
  await expect(page.getByRole("button", { name: "Send" })).toBeVisible();
});

test("Composer: Esc cancels and nothing is inserted; ⌘⇧D toggles", async ({ page }) => {
  await boot(page, true);
  const box = page.getByPlaceholder(/^Reply to /);
  await box.click();
  await clearCalls(page);
  await page.keyboard.press("Meta+Shift+D");
  await waitForCall(page, "start_dictation");
  await expect(page.getByRole("group", { name: "Dictation" })).toHaveAttribute("data-dictation", "recording");
  await page.keyboard.press("Escape");
  await waitForCall(page, "cancel_dictation");
  await expect(page.getByRole("group", { name: "Dictation" })).toHaveCount(0);
  await expect(box).toHaveValue("");
  expect((await calls(page)).some((c) => c.cmd === "stop_dictation")).toBe(false);

  // ⌘⇧D again from the box: start, then ⌘⇧D stops and inserts.
  await setResponse(page, "stop_dictation", "Refactor the parser.");
  await box.click();
  await page.keyboard.press("Meta+Shift+D");
  await expect(page.getByRole("group", { name: "Dictation" })).toHaveAttribute("data-dictation", "recording");
  await page.keyboard.press("Meta+Shift+D");
  await expect(box).toHaveValue("Refactor the parser.");
});

test("First use: the mic offers the model, shows the download, then starts", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await boot(page, false);
  await clearCalls(page);
  await page.getByRole("button", { name: "Dictate", exact: true }).click();
  const setup = page.getByRole("dialog", { name: "Set up voice input" });
  await expect(setup).toBeVisible();
  await expect(setup).toContainText("Whisper base · English · 148 MB");
  expect((await calls(page)).some((c) => c.cmd === "start_dictation")).toBe(false);

  await setup.getByRole("button", { name: "Download" }).click();
  await waitForCall(page, "download_voice_model");
  await emit(page, "phasr://voice-model", { modelId: "base-en", phase: "downloading", downloaded: 61_000_000, total: 147_964_211, error: null });
  await expect(setup.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "41");
  await expect(setup).toContainText("61 MB of 148 MB");
  if (SHOTS) await setup.screenshot({ path: `${SHOTS}/dictation-download.png` });

  await emit(page, "phasr://voice-model", { modelId: "base-en", phase: "done", downloaded: 147_964_211, total: 147_964_211, error: null });
  await setResponse(page, "list_voice_models", models(true));
  await setup.getByRole("button", { name: "Start dictating" }).click();
  await waitForCall(page, "start_dictation");
  await expect(page.getByRole("group", { name: "Dictation" })).toBeVisible();
});

test("Settings › Voice lists the models with download, delete and the one in use", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await boot(page, true);
  await page.goto(page.url().replace(/(\?.*)?$/, "?settings=voice"));
  const sheet = page.getByRole("dialog", { name: "Settings" });
  await expect(sheet.getByRole("heading", { name: "Voice" })).toBeVisible();
  const group = sheet.getByRole("radiogroup", { name: "Speech model" });
  await expect(group.getByRole("radio", { name: "Use Fast" })).toHaveAttribute("aria-checked", "true");
  await expect(group.getByRole("radio", { name: "Use Accurate" })).toBeDisabled();
  await expect(sheet.getByRole("button", { name: "Delete" })).toHaveCount(1);
  await expect(sheet.getByRole("button", { name: "Download" })).toHaveCount(2);
  await clearCalls(page);
  await sheet.getByRole("button", { name: "Download" }).last().click();
  await waitForCall(page, "download_voice_model");
  expect((await calls(page)).find((c) => c.cmd === "download_voice_model")?.args).toEqual({ modelId: "large-v3-turbo" });
  await emit(page, "phasr://voice-model", { modelId: "large-v3-turbo", phase: "downloading", downloaded: 120_000_000, total: 574_041_195, error: null });
  await expect(sheet.getByRole("progressbar", { name: "Downloading Multilingual" })).toBeVisible();
  if (SHOTS) await sheet.screenshot({ path: `${SHOTS}/settings-voice.png` });
});

test("New task: the Dictate chip records into the prompt; Esc cancels without closing the dialog", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await boot(page, true);
  await page.getByRole("complementary", { name: "Sidebar" }).getByRole("button", { name: "New task", exact: true }).click();
  const modal = page.getByRole("dialog", { name: "New task · phasr" });
  await expect(modal).toBeVisible();

  await modal.getByRole("button", { name: "Dictate" }).click();
  await expect(modal.getByRole("group", { name: "Dictation" })).toHaveAttribute("data-dictation", "recording");
  await speak(page, 60);
  if (SHOTS) await modal.screenshot({ path: `${SHOTS}/dictation-new-task.png` });
  await page.keyboard.press("Escape");
  await expect(modal.getByRole("group", { name: "Dictation" })).toHaveCount(0);
  await expect(modal).toBeVisible();

  await setResponse(page, "stop_dictation", "Add dark mode to the settings page.");
  await modal.getByRole("button", { name: "Dictate" }).click();
  await expect(modal.getByRole("group", { name: "Dictation" })).toHaveAttribute("data-dictation", "recording");
  await modal.getByRole("button", { name: "Finish dictation" }).click();
  await expect(page.locator("#new-task-prompt")).toHaveValue("Add dark mode to the settings page.");
  await expect(modal.getByRole("button", { name: "Dictate" })).toBeVisible();
});
