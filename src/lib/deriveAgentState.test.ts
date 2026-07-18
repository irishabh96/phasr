import { describe, expect, it } from "vitest";
import {
  deriveAgentState,
  RESOLVING_GRACE_MS,
  type AgentLiveness,
} from "./deriveAgentState";
import type { Workspace } from "./types";

const NOW = Date.parse("2026-07-18T12:00:00.000Z");
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

type Row = Pick<
  Workspace,
  "status" | "exitCode" | "startedAt" | "finishedAt" | "interruptedAt"
>;

function row(overrides: Partial<Row>): Row {
  return {
    status: "running",
    exitCode: null,
    startedAt: null,
    finishedAt: null,
    interruptedAt: null,
    ...overrides,
  };
}

const live = (
  derivedState: AgentLiveness["derivedState"],
  msAgo: number | null,
): AgentLiveness => ({
  derivedState,
  lastActivityAt: msAgo == null ? null : iso(msAgo),
});

describe("deriveAgentState", () => {
  describe("running — prefers the backend liveness state", () => {
    it("maps live working → working and counts since last activity", () => {
      const r = deriveAgentState(row({}), live("working", 2_000), NOW);
      expect(r.state).toBe("working");
      expect(r.since).toBe(2_000);
    });

    it("maps live idle → idle (neutral, never coral)", () => {
      const r = deriveAgentState(row({}), live("idle", 90_000), NOW);
      expect(r.state).toBe("idle");
      expect(r.since).toBe(90_000);
    });

    it("maps live wedged → wedged", () => {
      const r = deriveAgentState(row({}), live("wedged", 840_000), NOW);
      expect(r.state).toBe("wedged");
      expect(r.since).toBe(840_000);
    });

    it("falls back to startedAt when the live snapshot has no lastActivityAt", () => {
      const r = deriveAgentState(
        row({ startedAt: iso(5_000) }),
        live("idle", null),
        NOW,
      );
      expect(r.state).toBe("idle");
      expect(r.since).toBe(5_000);
    });
  });

  describe("running — no liveness event yet (resolving grace)", () => {
    it("is resolving for a just-spawned row (< grace), never Working", () => {
      const r = deriveAgentState(
        row({ startedAt: iso(RESOLVING_GRACE_MS - 500) }),
        undefined,
        NOW,
      );
      expect(r.state).toBe("resolving");
      expect(r.since).toBeNull();
    });

    it("is resolving when startedAt is missing entirely", () => {
      expect(deriveAgentState(row({ startedAt: null }), undefined, NOW).state).toBe(
        "resolving",
      );
    });

    it("becomes optimistic Working once past the grace window", () => {
      const r = deriveAgentState(row({ startedAt: iso(5_000) }), undefined, NOW);
      expect(r.state).toBe("working");
      expect(r.since).toBe(5_000);
    });
  });

  describe("stopped — interrupted vs calm user-stop", () => {
    it("stopped + interruptedAt → interrupted (relaunch orphan)", () => {
      const r = deriveAgentState(
        row({ status: "stopped", interruptedAt: iso(30_000), finishedAt: iso(30_000) }),
        undefined,
        NOW,
      );
      expect(r.state).toBe("interrupted");
      expect(r.since).toBe(30_000);
    });

    it("stopped without interruptedAt stays a calm Stopped", () => {
      const r = deriveAgentState(
        row({ status: "stopped", finishedAt: iso(60_000) }),
        undefined,
        NOW,
      );
      expect(r.state).toBe("stopped");
      expect(r.since).toBe(60_000);
    });
  });

  describe("terminal exit states", () => {
    it("completed + exit 0 → done", () => {
      expect(
        deriveAgentState(row({ status: "completed", exitCode: 0 }), undefined, NOW)
          .state,
      ).toBe("done");
    });

    it("completed + nonzero exit → failed (stay honest)", () => {
      expect(
        deriveAgentState(row({ status: "completed", exitCode: 3 }), undefined, NOW)
          .state,
      ).toBe("failed");
    });

    it("completed + null exit → done", () => {
      expect(
        deriveAgentState(row({ status: "completed", exitCode: null }), undefined, NOW)
          .state,
      ).toBe("done");
    });

    it("failed → failed and counts since finishedAt", () => {
      const r = deriveAgentState(
        row({ status: "failed", exitCode: 1, finishedAt: iso(60_000) }),
        undefined,
        NOW,
      );
      expect(r.state).toBe("failed");
      expect(r.since).toBe(60_000);
    });
  });

  describe("other lifecycle statuses", () => {
    it("pending → resolving", () => {
      expect(deriveAgentState(row({ status: "pending" }), undefined, NOW).state).toBe(
        "resolving",
      );
    });

    it("archived → stopped", () => {
      expect(deriveAgentState(row({ status: "archived" }), undefined, NOW).state).toBe(
        "stopped",
      );
    });
  });

  it("the idle 'Ns ago' counter ticks up as `now` advances (no new event)", () => {
    const r = row({});
    const l = live("idle", 60_000);
    const t0 = deriveAgentState(r, l, NOW);
    const t1 = deriveAgentState(r, l, NOW + 3_000);
    expect(t0.since).toBe(60_000);
    expect(t1.since).toBe(63_000);
  });
});
