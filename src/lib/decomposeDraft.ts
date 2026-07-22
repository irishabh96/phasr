// The editable decomposition draft that backs the Planner review surface
// (`DecomposeForm`). Kept OUT of the component so the reducer + client-side
// validation are unit-testable in isolation (spec §G / FE-1).
//
// Key design (D-OQ7): tickets AND edges are addressed by a stable INTERNAL
// client id, never by role string. Edges reference `fromId`/`toId`; the role is
// projected onto `{ fromRole, toRole }` only at submit. So renaming a ticket's
// role — or removing a ticket — can never silently orphan an edge.

import type {
  Agent,
  DecompositionInput,
  FigmaLinkInput,
  ProposedPlan,
} from "./types";

/**
 * Hard cap on tickets in a single decomposition, mirroring the backend
 * `MAX_SUBTASKS` (spec D-OQ1). Kept in lockstep with `commands/board.rs`.
 */
export const MAX_SUBTASKS = 12;

export interface DraftTicket {
  /** Stable client id (`t<seq>`). Never leaves the form. */
  id: string;
  role: string;
  agent: Agent;
  prompt: string;
}

export interface DraftEdge {
  /** Stable client id (`e<seq>`). */
  id: string;
  /** References a `DraftTicket.id` (the producer). Empty until picked. */
  fromId: string;
  /** References a `DraftTicket.id` (the consumer). Empty until picked. */
  toId: string;
}

export interface DraftState {
  tickets: DraftTicket[];
  edges: DraftEdge[];
  /**
   * Monotonic counter backing the stable client ids. Living in state keeps the
   * reducer pure (no module-level mutation / `crypto.randomUUID` side effects),
   * so tests get deterministic ids.
   */
  seq: number;
}

export type DraftAction =
  | { type: "hydrate"; plan: ProposedPlan }
  | { type: "seedManual"; fallbackAgent: Agent }
  | { type: "addTicket"; fallbackAgent: Agent }
  | { type: "removeTicket"; id: string }
  | { type: "setRole"; id: string; role: string }
  | { type: "setAgent"; id: string; agent: Agent }
  | { type: "setPrompt"; id: string; prompt: string }
  | { type: "addEdge" }
  | { type: "addDependency"; fromId: string; toId: string }
  | { type: "removeEdge"; id: string }
  | { type: "setEdgeFrom"; id: string; fromId: string }
  | { type: "setEdgeTo"; id: string; toId: string };

export function emptyDraft(): DraftState {
  return { tickets: [], edges: [], seq: 0 };
}

/** Next unused `role-N` label so a fresh ticket never collides. */
function nextRoleName(tickets: DraftTicket[]): string {
  const taken = new Set(tickets.map((t) => t.role.trim()));
  let n = tickets.length + 1;
  while (taken.has(`role-${n}`)) n++;
  return `role-${n}`;
}

export function draftReducer(
  state: DraftState,
  action: DraftAction,
): DraftState {
  switch (action.type) {
    case "hydrate": {
      // Rebuild the draft from a proposed plan. Edges arrive keyed by role;
      // resolve each to the freshly-minted client id and DROP any edge whose
      // endpoints the plan didn't actually name (defensive — the planner should
      // never emit those, but a dangling edge must not survive into the draft).
      let seq = state.seq;
      const idByRole = new Map<string, string>();
      const tickets: DraftTicket[] = action.plan.subtasks.map((s) => {
        const id = `t${seq++}`;
        idByRole.set(s.role, id);
        return { id, role: s.role, agent: s.agent, prompt: s.prompt };
      });
      const edges: DraftEdge[] = [];
      for (const e of action.plan.edges) {
        const fromId = idByRole.get(e.fromRole);
        const toId = idByRole.get(e.toRole);
        if (fromId == null || toId == null) continue;
        edges.push({ id: `e${seq++}`, fromId, toId });
      }
      return { tickets, edges, seq };
    }

    case "seedManual": {
      // Planner failed / skipped → drop the user into hand-editing with a single
      // blank row so the surface is never a dead end.
      let seq = state.seq;
      const id = `t${seq++}`;
      return {
        tickets: [
          { id, role: "role-1", agent: action.fallbackAgent, prompt: "" },
        ],
        edges: [],
        seq,
      };
    }

    case "addTicket": {
      if (state.tickets.length >= MAX_SUBTASKS) return state; // cap guard
      let seq = state.seq;
      const id = `t${seq++}`;
      return {
        ...state,
        tickets: [
          ...state.tickets,
          {
            id,
            role: nextRoleName(state.tickets),
            agent: action.fallbackAgent,
            prompt: "",
          },
        ],
        seq,
      };
    }

    case "removeTicket":
      return {
        ...state,
        tickets: state.tickets.filter((t) => t.id !== action.id),
        // Client-id indirection: pruning a ticket prunes every edge that touched
        // it, so no edge is ever left pointing at a ghost.
        edges: state.edges.filter(
          (e) => e.fromId !== action.id && e.toId !== action.id,
        ),
      };

    case "setRole":
      return {
        ...state,
        tickets: state.tickets.map((t) =>
          t.id === action.id ? { ...t, role: action.role } : t,
        ),
      };

    case "setAgent":
      return {
        ...state,
        tickets: state.tickets.map((t) =>
          t.id === action.id ? { ...t, agent: action.agent } : t,
        ),
      };

    case "setPrompt":
      return {
        ...state,
        tickets: state.tickets.map((t) =>
          t.id === action.id ? { ...t, prompt: action.prompt } : t,
        ),
      };

    case "addEdge": {
      let seq = state.seq;
      const id = `e${seq++}`;
      return {
        ...state,
        edges: [...state.edges, { id, fromId: "", toId: "" }],
        seq,
      };
    }

    case "addDependency": {
      // One-shot, fully-formed edge for the INLINE per-ticket dependency editor
      // (the "waits for X" picker on each ticket card). Same edge model as
      // `addEdge` + setEdgeFrom/To, but atomic so a single `selectOption` wires a
      // complete handoff. Idempotent: never duplicates an existing edge.
      const exists = state.edges.some(
        (e) => e.fromId === action.fromId && e.toId === action.toId,
      );
      if (exists || action.fromId === "" || action.toId === "") return state;
      let seq = state.seq;
      const id = `e${seq++}`;
      return {
        ...state,
        edges: [
          ...state.edges,
          { id, fromId: action.fromId, toId: action.toId },
        ],
        seq,
      };
    }

    case "removeEdge":
      return {
        ...state,
        edges: state.edges.filter((e) => e.id !== action.id),
      };

    case "setEdgeFrom":
      return {
        ...state,
        edges: state.edges.map((e) =>
          e.id === action.id ? { ...e, fromId: action.fromId } : e,
        ),
      };

    case "setEdgeTo":
      return {
        ...state,
        edges: state.edges.map((e) =>
          e.id === action.id ? { ...e, toId: action.toId } : e,
        ),
      };

    default:
      return state;
  }
}

// ── validation ──────────────────────────────────────────────────────────────

export interface DraftValidation {
  ok: boolean;
  /** Inline, human reason the plan can't start yet. `null` when `ok`. */
  reason: string | null;
}

const fail = (reason: string): DraftValidation => ({ ok: false, reason });

/**
 * Role-keyed Kahn cycle detection over the draft's client ids — the client
 * mirror of the backend's `topological_subtask_order` guard (spec BE-1). Returns
 * true when the edges form a cycle (so `Start` can be blocked before submit).
 * Self-edges and edges with an unset/dangling endpoint are ignored here (they
 * are caught by their own dedicated checks in `validateDraft`).
 */
export function hasCycle(tickets: DraftTicket[], edges: DraftEdge[]): boolean {
  const ids = new Set(tickets.map((t) => t.id));
  const indegree = new Map<string, number>();
  const adj = new Map<string, string[]>();
  for (const id of ids) indegree.set(id, 0);

  for (const e of edges) {
    if (e.fromId === e.toId) continue;
    if (!ids.has(e.fromId) || !ids.has(e.toId)) continue;
    adj.set(e.fromId, [...(adj.get(e.fromId) ?? []), e.toId]);
    indegree.set(e.toId, (indegree.get(e.toId) ?? 0) + 1);
  }

  const queue: string[] = [];
  for (const id of ids) if ((indegree.get(id) ?? 0) === 0) queue.push(id);

  let visited = 0;
  while (queue.length > 0) {
    const n = queue.shift() as string;
    visited++;
    for (const m of adj.get(n) ?? []) {
      const next = (indegree.get(m) ?? 0) - 1;
      indegree.set(m, next);
      if (next === 0) queue.push(m);
    }
  }
  return visited !== ids.size;
}

/**
 * Client-side well-formedness check that MIRRORS the hardened backend gate
 * (`validate_decomposition` + the BE-1 cycle/cap additions): at least one
 * ticket, ≤ `MAX_SUBTASKS`, unique non-empty roles, a prompt per ticket, edges
 * with both ends set that reference real tickets, no self-edge, and no cycle.
 * The first failing rule wins, so `Start` shows exactly one legible reason.
 */
export function validateDraft(state: DraftState): DraftValidation {
  const { tickets, edges } = state;

  if (tickets.length === 0) return fail("Add at least one ticket.");
  if (tickets.length > MAX_SUBTASKS)
    return fail(`A plan can have at most ${MAX_SUBTASKS} tickets.`);

  const seen = new Set<string>();
  for (const t of tickets) {
    const role = t.role.trim();
    if (role === "") return fail("Every ticket needs a role.");
    if (seen.has(role)) return fail(`Two tickets share the role "${role}".`);
    seen.add(role);
  }
  for (const t of tickets) {
    if (t.prompt.trim() === "")
      return fail(`"${t.role.trim()}" needs a prompt.`);
  }

  const ids = new Set(tickets.map((t) => t.id));
  for (const e of edges) {
    if (e.fromId === "" || e.toId === "")
      return fail("Every dependency needs both ends set.");
    if (e.fromId === e.toId) return fail("A ticket can't depend on itself.");
    if (!ids.has(e.fromId) || !ids.has(e.toId))
      return fail("A dependency points at a removed ticket.");
  }
  if (hasCycle(tickets, edges))
    return fail("Remove the dependency cycle before starting.");

  return { ok: true, reason: null };
}

/**
 * The roles a ticket waits on (the `fromRole` of every edge into it), used for
 * the per-row "waits for X" / "runs first · no deps" hint (Page 02).
 */
export function dependencyRoles(
  state: DraftState,
  ticketId: string,
): string[] {
  const roleById = new Map(state.tickets.map((t) => [t.id, t.role.trim()]));
  return state.edges
    .filter((e) => e.toId === ticketId && e.fromId !== "")
    .map((e) => roleById.get(e.fromId) ?? "")
    .filter((r) => r !== "");
}

/**
 * The optional EPIC-brief draft (Phase 2b, E2) held in `DecomposeForm` state:
 * shared PRD/TRD markdown, Figma links, and staged asset SOURCE paths that every
 * task inherits. Lives entirely in the form — the B2 no-persist gate means none
 * of it is written until the "Start N agents" click fires `startDecomposition`.
 */
export interface EpicBriefDraft {
  /** PRD markdown, as typed (trimmed at projection; omitted when blank). */
  prd: string;
  /** TRD markdown, as typed (trimmed at projection; omitted when blank). */
  trd: string;
  /** Draft Figma links. A blank `url` row is dropped; `label` → null when blank. */
  figma: Array<{ url: string; label?: string | null }>;
  /** Absolute source paths of staged assets (blank entries dropped). */
  assetPaths: string[];
}

/**
 * Project the draft onto the FROZEN gate shape (`DecompositionInput`). Roles and
 * prompts are trimmed; edges are resolved from client id → role and any edge
 * with an unset end is dropped (validation blocks Start before this runs, but
 * the projection stays defensive).
 *
 * The optional `brief` threads the Phase 2b epic-brief fields onto the wire.
 * Every field is OMITTED when empty (trimmed markdown blank, no links, no
 * paths), so a doc-less epic — or a pre-2b caller that passes no `brief` at all —
 * produces exactly the same input as before (backward compatible).
 */
export function toDecompositionInput(
  state: DraftState,
  repositoryId: string,
  goal: string,
  brief?: EpicBriefDraft,
): DecompositionInput {
  const roleById = new Map(state.tickets.map((t) => [t.id, t.role.trim()]));

  const prd = brief?.prd.trim() ?? "";
  const trd = brief?.trd.trim() ?? "";
  const figma: FigmaLinkInput[] = (brief?.figma ?? [])
    .map((f) => ({
      url: f.url.trim(),
      label: f.label?.trim() ? f.label.trim() : null,
    }))
    .filter((f) => f.url !== "");
  const assetPaths = (brief?.assetPaths ?? []).filter((p) => p.trim() !== "");

  return {
    repositoryId,
    parentPrompt: goal.trim(),
    subtasks: state.tickets.map((t) => ({
      role: t.role.trim(),
      agent: t.agent,
      prompt: t.prompt.trim(),
    })),
    edges: state.edges
      .filter((e) => e.fromId !== "" && e.toId !== "")
      .map((e) => ({
        fromRole: roleById.get(e.fromId) ?? "",
        toRole: roleById.get(e.toId) ?? "",
      })),
    // Omit-when-empty keeps a doc-less / pre-2b decomposition byte-identical.
    ...(prd ? { epicPrd: prd } : {}),
    ...(trd ? { epicTrd: trd } : {}),
    ...(figma.length > 0 ? { epicFigma: figma } : {}),
    ...(assetPaths.length > 0 ? { epicAssetPaths: assetPaths } : {}),
  };
}
