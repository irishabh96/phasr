import { expect, test, type Page } from "@playwright/test";
import { bootApp, makeFixtures, world } from "./harness";

/**
 * What agents actually write, rendered in the transcript: a GFM table (the
 * reported case — it showed as raw pipes), links to files and the web,
 * task lists, code inside a list item, and a mermaid diagram.
 */

const TASK = "ws-agent";
const SHOTS = process.env.PHASR_SHOTS_DIR;

const REPLY = `It's a working fintech MVP that clearly shipped, but the security problems on their own rule out production use.

| Area | Score | Why |
|---|:---:|---|
| **Security** | 1/10 | Keys and passwords are committed in \`src/env.js\`. Anyone can reset any user's password. |
| **Tests** | 0/10 | There are zero test files, even though Jest and Supertest are set up. |
| **Dependencies** | 2/10 | Node 12 is past end-of-life;<br>\`request\` is deprecated. |

See [env.js](src/env.js:12) and the [OWASP cheat sheet](https://cheatsheetseries.owasp.org/), or https://nodejs.org/en/about/eol.

1. Rotate the keys:
   \`\`\`bash
   git rm --cached src/env.js
   \`\`\`
2. ~~Patch v1~~ Delete v1 — ***v2 is the only one used***.

- [x] Audit routes
- [ ] Add tests

\`\`\`mermaid
graph LR
  App --> Hasura
  App --> Razorpay
  Cron --> App
\`\`\``;

async function boot(page: Page) {
  const f = makeFixtures() as ReturnType<typeof makeFixtures> & Record<string, unknown>;
  f.stateful = true;
  f.workspaces = f.workspaces.map((w) => (w.id === TASK ? { ...w, agentView: "transcript" } : w)) as typeof f.workspaces;
  const res = await bootApp(page, f as never);
  await expect(page.getByTestId("transcript").filter({ visible: true })).toBeVisible({ timeout: 20_000 });
  await world.transcript(page, TASK, { kind: "assistant", id: "md", text: REPLY, streaming: false });
  return res;
}

test("a reply's table, links, lists and diagram render as such, not as raw markdown", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const { errors } = await boot(page);
  const reply = page.locator('[data-transcript-item="assistant"]').filter({ hasText: "fintech MVP" });

  // The table: real header cells, inline formatting inside cells, no pipes.
  const table = reply.locator("table");
  await expect(table).toBeVisible();
  await expect(table.locator("th")).toHaveText(["Area", "Score", "Why"]);
  await expect(table.locator("tbody tr")).toHaveCount(3);
  await expect(table.locator("td strong").first()).toHaveText("Security");
  await expect(reply).not.toContainText("|---|");

  // Web links are anchors; the file link opens the Files pane.
  await expect(reply.locator('a[href="https://cheatsheetseries.owasp.org/"]')).toHaveText("OWASP cheat sheet");
  await expect(reply.locator('a[href="https://nodejs.org/en/about/eol"]')).toBeVisible();

  // Code inside a list item stays code; task items get boxes; strike works.
  await expect(reply.locator("pre", { hasText: "git rm --cached src/env.js" })).toBeVisible();
  await expect(reply.getByRole("img", { name: "Done", exact: true })).toHaveCount(1);
  await expect(reply.getByRole("img", { name: "Not done", exact: true })).toHaveCount(1);
  await expect(reply.locator("s")).toHaveText("Patch v1");

  // The diagram is drawn (lazy-loaded mermaid), not shown as source.
  await expect(reply.getByRole("img", { name: "Diagram" }).locator("svg")).toBeVisible({ timeout: 15_000 });
  await expect(reply.locator("pre", { hasText: "graph LR" })).toHaveCount(0);

  if (SHOTS) {
    await reply.scrollIntoViewIfNeeded();
    await reply.screenshot({ path: `${SHOTS}/markdown-dark.png` });
  }

  await reply.getByRole("button", { name: "env.js" }).click();
  await expect(page.getByRole("tab", { name: "Files", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tab", { name: "env.js", exact: true })).toHaveAttribute("aria-selected", "true");

  expect(errors.filter((e) => /mermaid|Markdown|Uncaught/i.test(e))).toEqual([]);
});
