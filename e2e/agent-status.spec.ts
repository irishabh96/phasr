import { test, expect, type Page } from "@playwright/test";

/**
 * Step 0 — Honest Status (S0.1/S0.2) rendered on the dev-only `/design-test`
 * harness with mocked `{ state, since }` (no Tauri IPC). Verifies the honest
 * state model: each state shows its label + glyph, Wedged does NOT pulse (a
 * frozen agent must not look alive), the "Ns ago" copy is present, Idle is the
 * neutral grey (NOT coral), and the contrast-critical treatments render.
 */

/** Force the app to a known resolved theme via the harness toggle. */
async function setTheme(page: Page, want: "light" | "dark") {
  for (let i = 0; i < 3; i++) {
    const current = await page.locator("html").getAttribute("data-theme");
    if (current === want) return;
    await page.getByTestId("theme-toggle").click();
  }
  await expect(page.locator("html")).toHaveAttribute("data-theme", want);
}

// The neutral-AA meaning label per state — must match `agentStatusMeta`.
const LABELS: Record<string, string> = {
  resolving: "Starting…",
  working: "Working",
  idle: "Idle",
  wedged: "Wedged",
  done: "Done",
  failed: "Failed",
  interrupted: "Interrupted",
  stopped: "Stopped",
};

// The coral accent fill (accent-500 #f78166) — no P0 state may use it.
const CORAL = "rgb(247, 129, 102)";
// --color-text-primary per theme (the meaning-bearing label token).
const PRIMARY = { dark: "rgb(230, 237, 243)", light: "rgb(10, 10, 11)" } as const;

test.describe("agent honest status (/design-test)", () => {
  let consoleErrors: string[] = [];
  const BENIGN =
    /__TAURI|invoke|auth callback|clerk|Clerk|sentry|Sentry|supabase|favicon|sourcemap|Outdated Optimize Dep|net::|Failed to load resource|permission|ResizeObserver|homeDir|plugin:/i;

  test.beforeEach(async ({ page }) => {
    consoleErrors = [];
    await page.addInitScript(() => {
      (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ =
        {
          invoke: () => Promise.resolve(null),
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
    await expect(page.getByTestId("agentstatus")).toBeVisible();
  });

  test("every state renders its neutral label + a glyph", async ({ page }) => {
    for (const [state, label] of Object.entries(LABELS)) {
      const row = page.getByTestId(`agent-state-${state}`);
      await expect(row).toBeVisible();
      // Label appears (sidebar meta + header badge both carry it).
      await expect(row.getByTestId("agent-status-label")).toHaveText(label);
      await expect(row.getByTestId("agent-badge-label")).toHaveText(label);
      // The sidebar indicator glyph is present (role=img, labelled).
      await expect(row.getByRole("img", { name: label })).toBeVisible();
    }
  });

  test("Wedged does NOT pulse or spin (a frozen agent must not look alive)", async ({
    page,
  }) => {
    const wedgedGlyph = page
      .locator('[data-testid="agent-state-wedged"] [role="img"] svg')
      .first();
    const animation = await wedgedGlyph.evaluate(
      (el) => getComputedStyle(el).animationName,
    );
    expect(animation).toBe("none");

    // Positive control: Working's sidebar dot DOES pulse.
    const workingDot = page
      .locator('[data-testid="agent-state-working"] [role="img"] span')
      .first();
    const workingAnim = await workingDot.evaluate(
      (el) => getComputedStyle(el).animationName,
    );
    expect(workingAnim).toBe("pulse-dot");
  });

  test("the honest 'Ns ago' copy is present per state", async ({ page }) => {
    await expect(page.getByTestId("agent-state-working")).toContainText(
      "active 2s ago",
    );
    await expect(page.getByTestId("agent-state-idle")).toContainText("quiet 3m");
    await expect(page.getByTestId("agent-state-wedged")).toContainText(
      "no output 14m",
    );
    await expect(page.getByTestId("agent-state-failed")).toContainText(
      "exit code 1",
    );
    await expect(page.getByTestId("agent-state-interrupted")).toContainText(
      "when phasr last closed",
    );
  });

  test("Idle is neutral grey, NOT coral, in both themes", async ({ page }) => {
    for (const theme of ["dark", "light"] as const) {
      await setTheme(page, theme);
      const idle = page.getByTestId("agent-state-idle");
      // The indicator dot is muted grey — never the coral accent fill.
      const dotBg = await idle
        .locator('[role="img"] span')
        .first()
        .evaluate((el) => getComputedStyle(el).backgroundColor);
      expect(dotBg, `idle dot in ${theme}`).not.toBe(CORAL);
      // Meaning rides the neutral-AA primary label (not a colored fill).
      const labelColor = await idle
        .getByTestId("agent-status-label")
        .evaluate((el) => getComputedStyle(el).color);
      expect(labelColor, `idle label in ${theme}`).toBe(PRIMARY[theme]);
    }
  });

  test("attention states carry a neutral-AA label over a soft-tint chip", async ({
    page,
  }) => {
    for (const theme of ["dark", "light"] as const) {
      await setTheme(page, theme);
      for (const state of ["wedged", "failed", "interrupted"] as const) {
        const row = page.getByTestId(`agent-state-${state}`);
        // Label is the meaning-bearing primary token (≥ AA on any surface).
        const labelColor = await row
          .getByTestId("agent-badge-label")
          .evaluate((el) => getComputedStyle(el).color);
        expect(labelColor, `${state} label in ${theme}`).toBe(PRIMARY[theme]);
        // The header badge chip has a real (non-transparent) tinted background.
        const chipBg = await row
          .locator('[data-testid="agent-status-badge"] [role="status"]')
          .first()
          .evaluate((el) => getComputedStyle(el).backgroundColor);
        expect(chipBg, `${state} chip in ${theme}`).not.toBe("rgba(0, 0, 0, 0)");
      }
    }
  });

  test("Wedged/Failed/Interrupted surface a Restart affordance (no dead end)", async ({
    page,
  }) => {
    for (const state of ["wedged", "failed", "interrupted"] as const) {
      await expect(
        page.getByTestId(`agent-state-${state}`).getByTestId("agent-restart"),
      ).toBeVisible();
    }
    // Calm states do not.
    await expect(
      page.getByTestId("agent-state-working").getByTestId("agent-restart"),
    ).toHaveCount(0);
  });

  test("harness renders with no console errors", async () => {
    expect(consoleErrors, consoleErrors.join("\n")).toHaveLength(0);
  });
});
