import { describe, expect, it } from "vitest";
import {
  MAX_SUBTASKS,
  dependencyRoles,
  draftReducer,
  emptyDraft,
  hasCycle,
  toDecompositionInput,
  validateDraft,
  type DraftState,
} from "./decomposeDraft";
import type { ProposedPlan } from "./types";

// Strict-null-safe array accessors (tsconfig `noUncheckedIndexedAccess`).
function at<T>(arr: T[], i: number): T {
  const v = arr[i];
  if (v === undefined) throw new Error(`index ${i} out of range (len ${arr.length})`);
  return v;
}
const last = <T>(arr: T[]): T => at(arr, arr.length - 1);

const PLAN: ProposedPlan = {
  subtasks: [
    { role: "backend", agent: "claude", prompt: "Build the API" },
    { role: "frontend", agent: "claude", prompt: "Wire the UI" },
    { role: "docs", agent: "gemini", prompt: "Document it" },
  ],
  edges: [
    { fromRole: "backend", toRole: "frontend" },
    { fromRole: "backend", toRole: "docs" },
  ],
};

function hydrated(plan: ProposedPlan = PLAN): DraftState {
  return draftReducer(emptyDraft(), { type: "hydrate", plan });
}

describe("draftReducer — hydrate", () => {
  it("maps a proposed plan to tickets keyed by stable client ids", () => {
    const s = hydrated();
    expect(s.tickets.map((t) => t.role)).toEqual(["backend", "frontend", "docs"]);
    // Ids are stable client ids, not role strings.
    expect(s.tickets.map((t) => t.id)).toEqual(["t0", "t1", "t2"]);
    expect(at(s.tickets, 2).agent).toBe("gemini");
  });

  it("resolves plan edges (role-keyed) onto client ids", () => {
    const s = hydrated();
    const backend = at(s.tickets, 0);
    const frontend = at(s.tickets, 1);
    const docs = at(s.tickets, 2);
    expect(s.edges).toHaveLength(2);
    expect(at(s.edges, 0)).toMatchObject({ fromId: backend.id, toId: frontend.id });
    expect(at(s.edges, 1)).toMatchObject({ fromId: backend.id, toId: docs.id });
  });

  it("drops a dangling plan edge whose endpoint role does not exist", () => {
    const s = hydrated({
      subtasks: [{ role: "backend", agent: "claude", prompt: "x" }],
      edges: [{ fromRole: "backend", toRole: "ghost" }],
    });
    expect(s.edges).toHaveLength(0);
  });
});

describe("draftReducer — tickets", () => {
  it("adds a blank ticket with a fresh non-colliding role", () => {
    const s = draftReducer(hydrated(), { type: "addTicket", fallbackAgent: "claude" });
    expect(s.tickets).toHaveLength(4);
    const added = at(s.tickets, 3);
    expect(added.role).toBe("role-4");
    expect(added.prompt).toBe("");
    expect(added.agent).toBe("claude");
  });

  it("refuses to add past the MAX_SUBTASKS cap", () => {
    let s = emptyDraft();
    for (let i = 0; i < MAX_SUBTASKS + 3; i++) {
      s = draftReducer(s, { type: "addTicket", fallbackAgent: "claude" });
    }
    expect(s.tickets).toHaveLength(MAX_SUBTASKS);
  });

  it("removing a ticket cascades to prune every edge that touched it", () => {
    const s = hydrated();
    const backend = at(s.tickets, 0);
    const after = draftReducer(s, { type: "removeTicket", id: backend.id });
    expect(after.tickets).toHaveLength(2);
    // Both edges pointed at/from backend → both are gone (no orphans).
    expect(after.edges).toHaveLength(0);
  });

  it("setRole/setAgent/setPrompt mutate only the targeted ticket", () => {
    let s = hydrated();
    const id = at(s.tickets, 1).id;
    s = draftReducer(s, { type: "setRole", id, role: "web" });
    s = draftReducer(s, { type: "setAgent", id, agent: "codex" });
    s = draftReducer(s, { type: "setPrompt", id, prompt: "new" });
    expect(at(s.tickets, 1)).toMatchObject({ role: "web", agent: "codex", prompt: "new" });
    // Neighbours untouched.
    expect(at(s.tickets, 0).role).toBe("backend");
  });
});

describe("draftReducer — edges + role-rename cascade", () => {
  it("renaming a role keeps its edges intact (edges key on client id)", () => {
    let s = hydrated();
    const backendId = at(s.tickets, 0).id;
    s = draftReducer(s, { type: "setRole", id: backendId, role: "api" });
    // Both edges still reference backendId, now projecting to the renamed role.
    expect(s.edges.every((e) => e.fromId === backendId)).toBe(true);
    const input = toDecompositionInput(s, "repo-1", "goal");
    expect(input.edges).toEqual([
      { fromRole: "api", toRole: "frontend" },
      { fromRole: "api", toRole: "docs" },
    ]);
  });

  it("adds and removes edges", () => {
    let s = draftReducer(hydrated(), { type: "addEdge" });
    const newEdge = last(s.edges);
    expect(newEdge).toMatchObject({ fromId: "", toId: "" });
    const b = at(s.tickets, 1).id;
    const c = at(s.tickets, 2).id;
    s = draftReducer(s, { type: "setEdgeFrom", id: newEdge.id, fromId: b });
    s = draftReducer(s, { type: "setEdgeTo", id: newEdge.id, toId: c });
    expect(last(s.edges)).toMatchObject({ fromId: b, toId: c });
    s = draftReducer(s, { type: "removeEdge", id: newEdge.id });
    expect(s.edges.find((e) => e.id === newEdge.id)).toBeUndefined();
  });
});

describe("draftReducer — seedManual", () => {
  it("seeds exactly one blank ticket (manual fallback is never a dead end)", () => {
    const s = draftReducer(emptyDraft(), { type: "seedManual", fallbackAgent: "codex" });
    expect(s.tickets).toHaveLength(1);
    expect(at(s.tickets, 0)).toMatchObject({ role: "role-1", agent: "codex", prompt: "" });
    expect(s.edges).toHaveLength(0);
  });
});

describe("hasCycle (client Kahn mirror)", () => {
  it("accepts a DAG", () => {
    const s = hydrated();
    expect(hasCycle(s.tickets, s.edges)).toBe(false);
  });

  it("detects a two-node cycle", () => {
    let s = hydrated();
    const a = at(s.tickets, 0).id;
    const b = at(s.tickets, 1).id;
    // backend already → frontend; add frontend → backend to close a 2-cycle.
    s = draftReducer(s, { type: "addEdge" });
    const e = last(s.edges);
    s = draftReducer(s, { type: "setEdgeFrom", id: e.id, fromId: b });
    s = draftReducer(s, { type: "setEdgeTo", id: e.id, toId: a });
    expect(hasCycle(s.tickets, s.edges)).toBe(true);
  });

  it("detects a multi-hop cycle a→b→c→a", () => {
    let s = hydrated({
      subtasks: [
        { role: "a", agent: "claude", prompt: "x" },
        { role: "b", agent: "claude", prompt: "x" },
        { role: "c", agent: "claude", prompt: "x" },
      ],
      edges: [
        { fromRole: "a", toRole: "b" },
        { fromRole: "b", toRole: "c" },
      ],
    });
    const a = at(s.tickets, 0).id;
    const c = at(s.tickets, 2).id;
    s = draftReducer(s, { type: "addEdge" });
    const e = last(s.edges);
    s = draftReducer(s, { type: "setEdgeFrom", id: e.id, fromId: c });
    s = draftReducer(s, { type: "setEdgeTo", id: e.id, toId: a });
    expect(hasCycle(s.tickets, s.edges)).toBe(true);
  });
});

describe("validateDraft (mirrors the backend gate)", () => {
  it("accepts a valid hydrated plan", () => {
    expect(validateDraft(hydrated())).toEqual({ ok: true, reason: null });
  });

  it("rejects an empty draft", () => {
    const r = validateDraft(emptyDraft());
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/at least one/i);
  });

  it("rejects over the cap", () => {
    let s = emptyDraft();
    for (let i = 0; i < MAX_SUBTASKS + 1; i++) {
      // Bypass the addTicket cap to construct an over-cap state directly.
      s = {
        ...s,
        tickets: [...s.tickets, { id: `t${i}`, role: `role-${i}`, agent: "claude", prompt: "p" }],
      };
    }
    const r = validateDraft(s);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(new RegExp(`${MAX_SUBTASKS}`));
  });

  it("rejects an empty role", () => {
    let s = hydrated();
    s = draftReducer(s, { type: "setRole", id: at(s.tickets, 0).id, role: "  " });
    const r = validateDraft(s);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/needs a role/i);
  });

  it("rejects duplicate roles", () => {
    let s = hydrated();
    s = draftReducer(s, { type: "setRole", id: at(s.tickets, 1).id, role: "backend" });
    const r = validateDraft(s);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/share the role/i);
  });

  it("rejects an empty prompt", () => {
    let s = hydrated();
    s = draftReducer(s, { type: "setPrompt", id: at(s.tickets, 0).id, prompt: "" });
    const r = validateDraft(s);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/needs a prompt/i);
  });

  it("rejects a self-edge", () => {
    let s = hydrated();
    s = draftReducer(s, { type: "addEdge" });
    const e = last(s.edges);
    const id = at(s.tickets, 0).id;
    s = draftReducer(s, { type: "setEdgeFrom", id: e.id, fromId: id });
    s = draftReducer(s, { type: "setEdgeTo", id: e.id, toId: id });
    const r = validateDraft(s);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/depend on itself/i);
  });

  it("rejects an edge with an unset end", () => {
    const s = draftReducer(hydrated(), { type: "addEdge" });
    const r = validateDraft(s);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/both ends/i);
  });

  it("rejects a cyclic draft", () => {
    let s = hydrated();
    const a = at(s.tickets, 0).id;
    const b = at(s.tickets, 1).id;
    s = draftReducer(s, { type: "addEdge" });
    const e = last(s.edges);
    s = draftReducer(s, { type: "setEdgeFrom", id: e.id, fromId: b });
    s = draftReducer(s, { type: "setEdgeTo", id: e.id, toId: a });
    const r = validateDraft(s);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/cycle/i);
  });
});

describe("dependencyRoles + toDecompositionInput", () => {
  it("reports the producer roles a ticket waits on", () => {
    const s = hydrated();
    const backend = at(s.tickets, 0);
    const frontend = at(s.tickets, 1);
    const docs = at(s.tickets, 2);
    expect(dependencyRoles(s, backend.id)).toEqual([]); // runs first
    expect(dependencyRoles(s, frontend.id)).toEqual(["backend"]);
    expect(dependencyRoles(s, docs.id)).toEqual(["backend"]);
  });

  it("projects the draft onto the frozen gate shape, trimming roles/prompts", () => {
    let s = hydrated();
    const backendId = at(s.tickets, 0).id;
    s = draftReducer(s, { type: "setRole", id: backendId, role: "  backend  " });
    s = draftReducer(s, { type: "setPrompt", id: backendId, prompt: "  build  " });
    const input = toDecompositionInput(s, "repo-1", "  the goal  ");
    expect(input.repositoryId).toBe("repo-1");
    expect(input.parentPrompt).toBe("the goal");
    expect(at(input.subtasks, 0)).toEqual({ role: "backend", agent: "claude", prompt: "build" });
    expect(input.edges).toEqual([
      { fromRole: "backend", toRole: "frontend" },
      { fromRole: "backend", toRole: "docs" },
    ]);
  });
});
