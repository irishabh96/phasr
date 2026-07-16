import { describe, it, expect } from "vitest";
import { TEMPLATES } from "./templates";

/**
 * Deterministic, offline structural validation of the hardcoded template list.
 * Catches malformed/duplicate data on every `pnpm test`.
 *
 * URL REACHABILITY — whether each repo actually EXISTS / a clone would work — is
 * a NETWORK check and lives in `scripts/check-template-urls.mjs`
 * (`pnpm check:templates`), kept out of the unit suite so this stays offline and
 * deterministic. That reachability check is the one that catches a valid-format
 * but 404 URL (the `lapce/tauri-react-template` bug a mocked-IPC e2e can't see).
 */
describe("TEMPLATES data", () => {
  it("has at least one template", () => {
    expect(TEMPLATES.length).toBeGreaterThan(0);
  });

  it("every template has non-empty required fields", () => {
    for (const t of TEMPLATES) {
      expect(t.id, "id").toBeTruthy();
      expect(t.name, `name for ${t.id}`).toBeTruthy();
      expect(t.description, `description for ${t.id}`).toBeTruthy();
      expect(t.gitUrl, `gitUrl for ${t.id}`).toBeTruthy();
    }
  });

  it("gitUrls are well-formed https or ssh git remotes", () => {
    const remote = /^(https:\/\/\S+|git@[^\s:]+:\S+\.git)$/;
    for (const t of TEMPLATES) {
      expect(remote.test(t.gitUrl), `${t.id}: "${t.gitUrl}"`).toBe(true);
    }
  });

  it("ids are unique", () => {
    const ids = TEMPLATES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
