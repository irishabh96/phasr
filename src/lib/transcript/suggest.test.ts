import { describe, expect, it } from "vitest";
import type { TranscriptItem } from "@/lib/types";
import { clampLabel, endedTurn, heuristicSuggestions, isTestCommand, MAX_LABEL, sanitizeSuggestions } from "./suggest";

const ts = "2026-11-11T10:42:03.000Z";
const user = (id: string, text = "Fix the login redirect"): TranscriptItem => ({ kind: "user", id, ts, text });
const say = (id: string, text: string): TranscriptItem => ({ kind: "assistant", id, ts, text, streaming: false });
const result = (id: string, isError = false): TranscriptItem => ({ kind: "result", id, ts, durationMs: 1, costUsd: null, isError });
const bash = (id: string, command: string, status: "done" | "error" | "denied" = "done"): TranscriptItem => ({
  kind: "tool",
  id,
  ts,
  tool: "Bash",
  input: { command },
  title: `Running ${command}`,
  status,
});
const edit = (id: string, path = "src/auth/redirect.ts"): TranscriptItem => ({
  kind: "tool",
  id,
  ts,
  tool: "Edit",
  input: { file_path: `/w/${path}` },
  title: `Editing ${path}`,
  status: "done",
});

/** One ended turn whose last assistant message is `text`. */
const ending = (text: string, extra: TranscriptItem[] = []) =>
  heuristicSuggestions(endedTurn([user("u"), ...extra, say("a", text), result("r")]));
const labels = (text: string, extra: TranscriptItem[] = []) => ending(text, extra).map((c) => c.label);

describe("endedTurn", () => {
  it("is the last turn between results, keyed by its result id", () => {
    const items = [user("u0"), say("a0", "first"), result("r0"), user("u1"), edit("e1"), say("a1", "second"), result("r1")];
    const turn = endedTurn(items)!;
    expect(turn.turnId).toBe("r1");
    expect(turn.items.map((i) => i.id)).toEqual(["u1", "e1", "a1"]);
    expect(turn.lastText).toBe("second");
  });

  it("is null mid-turn and before any turn ended", () => {
    expect(endedTurn([user("u")])).toBeNull();
    expect(endedTurn([user("u"), result("r"), user("u2")])).toBeNull();
    // A subagent's items don't count as the main conversation's.
    const sub: TranscriptItem = { kind: "assistant", id: "s", ts, text: "sub", streaming: false, parentId: "agent" };
    expect(endedTurn([user("u"), say("a", "main"), sub, result("r")])!.lastText).toBe("main");
  });
});

describe("heuristicSuggestions: the agent's closing question", () => {
  it("turns 'Want me to X, or Y?' into one chip per option", () => {
    const chips = ending(
      "I added the `?next=` handling and the unit tests pass.\n\nWant me to open a draft PR, or also handle the mobile deep-link case?",
    );
    expect(chips.map((c) => c.label)).toEqual(["Open a draft PR", "Also handle the mobile deep-link case"]);
    expect(chips[0]).toEqual({ label: "Open a draft PR", text: "Open a draft PR", source: "heuristic" });
  });

  it("reads 'Should I A or B?' and the other offer phrasings", () => {
    expect(labels("The cache is stale after deploys. Should I keep the old TTL or drop it to five minutes?")).toEqual([
      "Keep the old TTL",
      "Drop it to five minutes",
    ]);
    expect(labels("Would you like me to add a migration for this?")).toEqual(["Add a migration for this"]);
    expect(labels("Done. Let me know if you want me to squash the commits.")).toEqual(["Squash the commits"]);
    expect(labels("I can either inline the helper, extract it to utils, or leave it as is. Which do you prefer? Shall I inline the helper, extract it to utils, or leave it as is?")).toEqual([
      "Inline the helper",
      "Extract it to utils",
      "Leave it as is",
    ]);
  });

  it("expands a noun-phrase alternative into a full clause", () => {
    expect(labels("Should I add tests for login or signup?")).toEqual(["Add tests for login", "Add tests for signup"]);
    expect(labels("Should I update the README or the changelog?")).toEqual(["Update the README", "Update the changelog"]);
  });

  it("keeps a yes/no question to its one option", () => {
    expect(labels("Should I proceed with the rename or not?")).toEqual(["Proceed with the rename"]);
    expect(labels("Want me to also bump the version, or is this good to go?")).toEqual(["Also bump the version"]);
  });

  it("makes chips from a numbered list the agent asked about", () => {
    const text = [
      "There are a few ways to fix the flaky test:",
      "",
      "1. **Mock the clock** – use fake timers so the retry fires deterministically",
      "2. **Raise the timeout** to 10s in CI only",
      "3. Delete the test",
      "",
      "Which would you prefer?",
    ].join("\n");
    const chips = ending(text);
    expect(chips.map((c) => c.label)).toEqual(["Mock the clock", "Raise the timeout", "Delete the test"]);
    expect(chips[0]?.text).toBe("Mock the clock – use fake timers so the retry fires deterministically");
  });

  it("makes chips from bullets under a question", () => {
    expect(labels("How do you want to handle the old sessions?\n- Expire them on deploy\n- Migrate them lazily")).toEqual([
      "Expire them on deploy",
      "Migrate them lazily",
    ]);
  });

  it("ignores a summary list and statements: no question, no chips", () => {
    expect(labels("Changes made:\n- Added the redirect guard\n- Fixed the cookie refresh")).toEqual([]);
    expect(labels("The redirect now keeps `?next=` across the cookie refresh.")).toEqual([]);
    // A question that isn't an offer of next steps.
    expect(labels("Did the previous deploy include the migration?")).toEqual([]);
  });

  it("clamps a long option's label but keeps its full text", () => {
    const c = ending("Want me to rewrite the session refresh so it retries with exponential backoff and jitter?")[0]!;
    expect(c.label.length).toBeLessThanOrEqual(MAX_LABEL);
    expect(c.label.endsWith("…")).toBe(true);
    expect(c.text).toBe("Rewrite the session refresh so it retries with exponential backoff and jitter");
  });
});

describe("heuristicSuggestions: what happened in the turn", () => {
  it("offers to fix tests that failed and haven't passed since", () => {
    expect(labels("The suite has 2 failures.", [edit("e"), bash("t", "pnpm test src/auth", "error")])).toEqual([
      "Fix the failing tests",
    ]);
    // Fixed within the turn: nothing to offer.
    expect(labels("All green now.", [bash("t1", "pnpm test", "error"), edit("e"), bash("t2", "pnpm test", "done")])).toEqual([]);
  });

  it("offers to run the tests after edits nothing tested", () => {
    expect(labels("Updated the redirect guard.", [edit("e")])).toEqual(["Run the tests"]);
    expect(labels("Updated it.", [bash("t", "cargo test", "done"), edit("e")])).toEqual(["Run the tests"]);
    expect(labels("Updated it.", [edit("e"), bash("t", "cargo test", "done")])).toEqual([]);
    expect(labels("Updated it.", [edit("e"), bash("l", "pnpm lint", "done")])).toEqual(["Run the tests"]);
  });

  it("puts the agent's own options first", () => {
    expect(labels("Want me to open a draft PR?", [edit("e")])).toEqual(["Open a draft PR", "Run the tests"]);
  });

  it("offers Continue after an interrupt and Try again after a failed turn", () => {
    const interrupted: TranscriptItem = { kind: "system", id: "s", ts, level: "info", text: "Interrupted" };
    const chips = heuristicSuggestions(endedTurn([user("u"), say("a", "Should I keep going or stop?"), interrupted, result("r")]));
    expect(chips).toEqual([{ label: "Continue", text: "Continue where you left off", source: "heuristic" }]);
    expect(heuristicSuggestions(endedTurn([user("u"), result("r", true)])).map((c) => c.label)).toEqual(["Try again"]);
  });

  it("suggests nothing for an ordinary turn", () => {
    expect(heuristicSuggestions(endedTurn([user("u"), say("a", "Here's how the redirect works: …"), result("r")]))).toEqual([]);
    expect(heuristicSuggestions(null)).toEqual([]);
  });

  it("recognises test commands", () => {
    for (const c of ["pnpm test", "cargo test -p app", "pytest -q", "npx vitest run", "go test ./...", "bundle exec rspec"]) {
      expect(isTestCommand(c)).toBe(true);
    }
    expect(isTestCommand("pnpm lint")).toBe(false);
  });
});

describe("sanitizeSuggestions", () => {
  it("keeps valid items, clamps them, and drops the rest", () => {
    const got = sanitizeSuggestions([
      { label: "Open a draft PR", text: "Open a draft PR for the login page.", source: "generated" },
      { label: "Open a draft PR", text: "dupe", source: "generated" },
      { label: "x".repeat(80), text: "long label", source: "native" },
      { label: "No text", source: "generated" },
      { text: "Run the e2e suite", source: "weird" },
      { label: "Fourth", text: "never shown", source: "generated" },
    ]);
    expect(got.map((g) => [g.label.length <= MAX_LABEL, g.source])).toEqual([
      [true, "generated"],
      [true, "native"],
      [true, "generated"],
    ]);
    expect(got[2]?.label).toBe("Run the e2e suite");
    expect(sanitizeSuggestions(null)).toEqual([]);
    expect(sanitizeSuggestions("[]")).toEqual([]);
    expect(sanitizeSuggestions([null, 3, "x"])).toEqual([]);
  });

  it("clamps labels on a word with an ellipsis", () => {
    expect(clampLabel('  "Open a draft PR".  ')).toBe("Open a draft PR");
    const long = clampLabel("Also handle the mobile deep-link case on iOS and Android");
    expect(long).toBe("Also handle the mobile deep-link case…");
    expect(clampLabel(".env cleanup")).toBe(".env cleanup");
  });
});
