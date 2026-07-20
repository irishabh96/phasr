import { describe, expect, it } from "vitest";
import {
  deriveNextGate,
  failingCheckCount,
  isIntegrateEligible,
  type EpicGateInput,
  type TicketGateInput,
} from "./deriveNextGate";
import type { BoardCardState } from "./deriveBoardState";
import type { ReviewRecord, ValidateResult } from "./types";

function validateResult(
  over: Partial<ValidateResult> & { passed: boolean },
): ValidateResult {
  return {
    subtaskId: "sub-1",
    ranAtMs: 1_000,
    checks: over.checks ?? [
      {
        name: "lint",
        command: "pnpm lint",
        passed: over.passed,
        exitCode: over.passed ? 0 : 1,
        tailOutput: "",
      },
    ],
    ...over,
  };
}

function review(state: ReviewRecord["state"]): ReviewRecord {
  return {
    subtaskId: "sub-1",
    state,
    by: "you",
    comment: state === "changes-requested" ? "spacing is off" : null,
    atMs: 1_000,
    validatePassed: true,
  };
}

function ticket(over: Partial<TicketGateInput>): TicketGateInput {
  return {
    kind: "ticket",
    state: "working",
    validate: null,
    review: null,
    checksConfigured: false,
    ...over,
  };
}

function epic(over: Partial<EpicGateInput>): EpicGateInput {
  return {
    kind: "epic",
    ticketCount: 2,
    integrable: false,
    integrated: false,
    shipped: false,
    ...over,
  };
}

describe("deriveNextGate — ticket ladder", () => {
  it("working + checks configured + not yet validated → Validate (primary, enabled)", () => {
    const g = deriveNextGate(
      ticket({ state: "working", checksConfigured: true }),
    );
    expect(g.verb).toBe("validate");
    expect(g.enabled).toBe(true);
    expect(g.intent).toBe("primary");
    expect(g.reason).toBeNull();
  });

  it("no checks configured → Request review is the enabled primary (Validate is a no-op)", () => {
    const g = deriveNextGate(
      ticket({ state: "working", checksConfigured: false }),
    );
    expect(g.verb).toBe("request-review");
    expect(g.enabled).toBe(true);
    expect(g.intent).toBe("primary");
  });

  it("validate passed → Request review (enabled primary)", () => {
    const g = deriveNextGate(
      ticket({
        state: "needs-review",
        checksConfigured: true,
        validate: validateResult({ passed: true }),
      }),
    );
    expect(g.verb).toBe("request-review");
    expect(g.enabled).toBe(true);
  });

  it("validate failing → Request review DISABLED with 'Fix N failing checks'", () => {
    const validate = validateResult({
      passed: false,
      checks: [
        {
          name: "lint",
          command: "pnpm lint",
          passed: false,
          exitCode: 1,
          tailOutput: "",
        },
        {
          name: "test",
          command: "pnpm test",
          passed: false,
          exitCode: 1,
          tailOutput: "",
        },
        {
          name: "types",
          command: "pnpm typecheck",
          passed: true,
          exitCode: 0,
          tailOutput: "",
        },
      ],
    });
    const g = deriveNextGate(
      ticket({ state: "working", checksConfigured: true, validate }),
    );
    expect(g.verb).toBe("request-review");
    expect(g.enabled).toBe(false);
    expect(g.reason).toBe("Fix 2 failing checks");
    expect(g.intent).toBe("neutral");
  });

  it("validate failing with exactly one failure → singular 'check'", () => {
    const validate = validateResult({
      passed: false,
      checks: [
        {
          name: "lint",
          command: "pnpm lint",
          passed: false,
          exitCode: 1,
          tailOutput: "",
        },
      ],
    });
    const g = deriveNextGate(
      ticket({ state: "working", checksConfigured: true, validate }),
    );
    expect(g.reason).toBe("Fix 1 failing check");
  });

  it("blocked → disabled forward gate naming the producer it waits on", () => {
    const g = deriveNextGate(
      ticket({ state: "blocked", blockedOn: ["backend", "docs"] }),
    );
    expect(g.enabled).toBe(false);
    expect(g.reason).toBe("Waiting for backend, docs");
    expect(g.intent).toBe("neutral");
  });

  it("blocked with no named roles → 'Waiting for upstream'", () => {
    const g = deriveNextGate(ticket({ state: "blocked" }));
    expect(g.reason).toBe("Waiting for upstream");
  });

  it("in-review (requested) → Approve (primary, enabled)", () => {
    const g = deriveNextGate(
      ticket({ state: "in-review", review: review("requested") }),
    );
    expect(g.verb).toBe("approve");
    expect(g.enabled).toBe(true);
    expect(g.intent).toBe("primary");
  });

  it("approved → calm 'Approved' success pill (disabled, contributes to Integrate)", () => {
    const g = deriveNextGate(
      ticket({ state: "needs-review", review: review("approved") }),
    );
    expect(g.verb).toBe("approve");
    expect(g.label).toBe("Approved");
    expect(g.enabled).toBe(false);
    expect(g.intent).toBe("success");
  });

  it("changes-requested (re-opened) → back on the Request-review ladder", () => {
    // After a bounce the ticket returns to In progress; with checks passing again
    // the next gate is Request review once more.
    const g = deriveNextGate(
      ticket({
        state: "qas-changes-requested",
        review: review("changes-requested"),
        checksConfigured: true,
        validate: validateResult({ passed: true }),
      }),
    );
    expect(g.verb).toBe("request-review");
    expect(g.enabled).toBe(true);
  });

  it("changes-requested with failing checks → Request review disabled again", () => {
    const g = deriveNextGate(
      ticket({
        state: "qas-changes-requested",
        review: review("changes-requested"),
        checksConfigured: true,
        validate: validateResult({ passed: false }),
      }),
    );
    expect(g.verb).toBe("request-review");
    expect(g.enabled).toBe(false);
    expect(g.reason).toBe("Fix 1 failing check");
  });

  it("is pure — no confirm on cheap/reversible ticket gates", () => {
    for (const g of [
      deriveNextGate(ticket({ state: "working", checksConfigured: true })),
      deriveNextGate(ticket({ state: "needs-review" })),
      deriveNextGate(
        ticket({ state: "in-review", review: review("requested") }),
      ),
    ]) {
      expect(g.confirm).toBe(false);
    }
  });
});

describe("deriveNextGate — epic ladder", () => {
  it("not integrable → Integrate disabled with the unlock reason", () => {
    const g = deriveNextGate(epic({ integrable: false }));
    expect(g.verb).toBe("integrate");
    expect(g.enabled).toBe(false);
    expect(g.reason).toBe(
      "Integration unlocks once every ticket is ready for review.",
    );
    expect(g.intent).toBe("neutral");
  });

  it("no tickets → distinct empty reason", () => {
    const g = deriveNextGate(epic({ ticketCount: 0, integrable: false }));
    expect(g.reason).toBe("No tickets to integrate yet.");
  });

  it("integrable → Integrate & review (primary, confirm)", () => {
    const g = deriveNextGate(epic({ integrable: true }));
    expect(g.verb).toBe("integrate");
    expect(g.enabled).toBe(true);
    expect(g.intent).toBe("primary");
    expect(g.confirm).toBe(true);
  });

  it("integrated → Ship (primary, confirm), labelled with the base branch", () => {
    const g = deriveNextGate(
      epic({ integrable: true, integrated: true, baseBranch: "main" }),
    );
    expect(g.verb).toBe("ship");
    expect(g.label).toBe("Ship to main");
    expect(g.enabled).toBe(true);
    expect(g.intent).toBe("primary");
    expect(g.confirm).toBe(true);
  });

  it("shipped → calm 'Shipped' success pill (disabled, terminal)", () => {
    const g = deriveNextGate(
      epic({ integrated: true, shipped: true, baseBranch: "main" }),
    );
    expect(g.verb).toBe("ship");
    expect(g.label).toBe("Shipped");
    expect(g.enabled).toBe(false);
    expect(g.intent).toBe("success");
    expect(g.reason).toBe("Merged into main");
  });
});

describe("isIntegrateEligible", () => {
  const eligible: BoardCardState[] = ["needs-review", "done"];
  const notEligible: BoardCardState[] = [
    "working",
    "idle",
    "wedged",
    "failed",
    "blocked",
    "in-review",
    "qas-changes-requested",
  ];

  it("needs-review / done are eligible (approved collapses to needs-review)", () => {
    for (const s of eligible) expect(isIntegrateEligible(s)).toBe(true);
  });

  it("in-review (awaiting approval) and changes-requested are NOT eligible", () => {
    for (const s of notEligible) expect(isIntegrateEligible(s)).toBe(false);
  });
});

describe("failingCheckCount", () => {
  it("counts only the failing checks", () => {
    expect(
      failingCheckCount(
        validateResult({
          passed: false,
          checks: [
            {
              name: "a",
              command: "a",
              passed: true,
              exitCode: 0,
              tailOutput: "",
            },
            {
              name: "b",
              command: "b",
              passed: false,
              exitCode: 1,
              tailOutput: "",
            },
          ],
        }),
      ),
    ).toBe(1);
  });

  it("is 0 for null / all-passing", () => {
    expect(failingCheckCount(null)).toBe(0);
    expect(failingCheckCount(validateResult({ passed: true }))).toBe(0);
  });
});
