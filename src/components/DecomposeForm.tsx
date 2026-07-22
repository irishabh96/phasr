import {
  AlertTriangle,
  ArrowRight,
  CornerDownRight,
  Loader2,
  Plus,
  Sparkles,
  X,
} from "lucide-react";
import { useReducer, useRef, useState } from "react";
import { GlassButton } from "@/components/ui/GlassButton";
import { GlassSelect } from "@/components/ui/GlassSelect";
import { GlassInput, GlassTextarea } from "@/components/ui/GlassInput";
import { ConfirmDialog } from "@/components/ui/Dialog";
import {
  MAX_SUBTASKS,
  draftReducer,
  emptyDraft,
  toDecompositionInput,
  validateDraft,
  type DraftAction,
  type DraftState,
  type DraftTicket,
} from "@/lib/decomposeDraft";
import { useAgents } from "@/lib/hooks/useAgents";
import { humanizeError } from "@/lib/humanizeError";
import { showToast } from "@/lib/toast";
import { tauri } from "@/lib/tauri";
import type { Agent, BoardState } from "@/lib/types";

interface DecomposeFormProps {
  repositoryId: string;
  /**
   * Fires with the freshly-created board once "Start N agents" succeeds. The
   * repository view wires this to navigate to the board route; `/design-test`
   * intercepts it so the harness stays put. NOTHING is persisted before this
   * fires — the draft lives entirely in this form (the B2 approval gate).
   */
  onStarted?: (board: BoardState) => void;
  onCancel?: () => void;
}

/** idle → planning → review. `review` covers both a planner draft AND the
 *  manual-editing fallback (planner reject / "skip AI"). */
type Phase = "idle" | "planning" | "review";

/**
 * The Planner review/edit surface (FE-1, mockup Page 02). The user types one
 * goal, the planner proposes N tickets + a dependency DAG, and every field is
 * editable — persona/role, agent-type, prompt, and the handoffs — before a
 * single "Start N agents" click submits the whole plan through the UNCHANGED
 * `start_decomposition` gate. Nothing persists before that click.
 *
 * Dependencies are edited INLINE on each ticket ("waits for X" chips + a
 * "Depends on…" picker), so the read view and the edit affordance are the same
 * object — there is no separate DAG editor. Every incoming handoff carries the
 * `decompose-edge` testid so the plan's edges stay assertable end-to-end.
 *
 * Never a dead end: a planner failure drops straight into manual editing (a
 * seeded blank ticket) so the user can still hand-build and Start a plan.
 *
 * The editable draft lives in a `useReducer` (`decomposeDraft.ts`) keyed by
 * stable client ids, so renaming/removing a ticket can never orphan an edge. A
 * synchronous `inFlightRef` (the D1 guard) makes a double-click fire the gate at
 * most once (React `submitting` state commits a tick late).
 */
export function DecomposeForm({
  repositoryId,
  onStarted,
  onCancel,
}: DecomposeFormProps) {
  const { data: agents } = useAgents();
  const allAgents = agents ?? [];
  const defaultAgent = allAgents.find((a) => a.isDefault) ?? allAgents[0];
  const fallbackAgent: Agent = defaultAgent?.agent ?? "claude";
  const agentOptions =
    allAgents.length > 0
      ? allAgents.map((a) => ({ label: a.label, value: a.agent }))
      : [{ label: "Claude", value: "claude" }];

  const [goal, setGoal] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [draft, dispatch] = useReducer(
    draftReducer,
    undefined,
    () => emptyDraft() as DraftState,
  );

  // "Planner proposed N tickets" count (null in manual mode).
  const [proposedCount, setProposedCount] = useState<number | null>(null);
  const [manualMode, setManualMode] = useState(false);
  // Humanized + raw planner error (raw shown under a "Details" disclosure).
  const [plannerError, setPlannerError] = useState<string | null>(null);
  const [plannerRawError, setPlannerRawError] = useState<string | null>(null);

  const [submitting, setSubmitting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  // Whether the review draft has been hand-edited since the last plan (drives
  // the Re-plan discard confirm — D-OQ6).
  const [dirty, setDirty] = useState(false);
  const [replanConfirm, setReplanConfirm] = useState(false);

  // Synchronous re-entrancy guard (D1). Belt AND suspenders with `disabled`.
  const inFlightRef = useRef(false);

  const trimmedGoal = goal.trim();
  const validation = validateDraft(draft);
  const canStart = phase === "review" && validation.ok && !submitting;
  const atCap = draft.tickets.length >= MAX_SUBTASKS;
  // Handoff-contract count = fully-wired edges (the footer's honest tally).
  const contractCount = draft.edges.filter((e) => e.fromId && e.toId).length;

  // Stable role label per client id, for the inline "waits for X" chips and the
  // "Depends on…" picker options (an unset role falls back to a positional name).
  const roleLabelById = new Map(
    draft.tickets.map((t, i) => [t.id, t.role.trim() || `ticket ${i + 1}`]),
  );

  // Edits go through this so the Re-plan confirm knows the draft is dirty.
  const edit = (action: DraftAction) => {
    setDirty(true);
    dispatch(action);
  };

  const runPlanner = async () => {
    const g = goal.trim();
    if (g === "") return;
    setPhase("planning");
    setPlannerError(null);
    setPlannerRawError(null);
    setStartError(null);
    try {
      const plan = await tauri.planDecomposition(repositoryId, g);
      dispatch({ type: "hydrate", plan });
      setProposedCount(plan.subtasks.length);
      setManualMode(false);
      setDirty(false);
      setPhase("review");
    } catch (err) {
      // Never a dead end — humanize, seed a manual draft, keep raw for Details.
      const message = humanizeError(err);
      setPlannerError(message);
      setPlannerRawError(err instanceof Error ? err.message : String(err));
      setProposedCount(null);
      setManualMode(true);
      dispatch({ type: "seedManual", fallbackAgent });
      setDirty(false);
      setPhase("review");
      showToast({
        title: "The planner couldn't draft a plan",
        intent: "error",
        message: `${message} You can build the plan by hand and start it.`,
      });
    }
  };

  // "Skip AI, edit manually" — go straight to a blank hand-built draft.
  const skipToManual = () => {
    setPlannerError(null);
    setPlannerRawError(null);
    setStartError(null);
    setProposedCount(null);
    setManualMode(true);
    dispatch({ type: "seedManual", fallbackAgent });
    setDirty(false);
    setPhase("review");
  };

  const requestReplan = () => {
    if (dirty) setReplanConfirm(true);
    else void runPlanner();
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canStart) return;
    if (inFlightRef.current) return; // D1: never fan out twice.
    inFlightRef.current = true;
    setSubmitting(true);
    setStartError(null);

    const input = toDecompositionInput(draft, repositoryId, goal);
    try {
      const board = await tauri.startDecomposition(input);
      showToast({
        title: "Decomposition started",
        intent: "success",
        message: `${input.subtasks.length} ${
          input.subtasks.length === 1 ? "agent" : "agents"
        } queued.`,
      });
      onStarted?.(board);
    } catch (err) {
      const message = humanizeError(err);
      setStartError(message);
      showToast({ title: "Couldn't start the agents", intent: "error", message });
    } finally {
      setSubmitting(false);
      inFlightRef.current = false;
    }
  };

  const n = draft.tickets.length;

  return (
    <form
      onSubmit={handleSubmit}
      className="flex flex-col gap-6"
      data-testid="decompose-form"
      aria-label="Plan and start a decomposition"
    >
      {/* ── Goal ─────────────────────────────────────────────────────────── */}
      <div className="flex flex-col gap-2">
        <label
          htmlFor="decompose-goal"
          className="text-[11px] font-semibold uppercase tracking-[0.08em] text-(--color-text-muted)"
        >
          Goal
        </label>
        <GlassInput
          id="decompose-goal"
          data-testid="decompose-goal"
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Enter") return;
            e.preventDefault(); // never let the goal input submit the Start gate
            if (phase !== "review" && phase !== "planning" && goal.trim())
              void runPlanner();
          }}
          placeholder="e.g. add task-comments to checkout: API, web UI, docs, and QA"
          className="h-10 text-[14px]"
        />

        {/* Planner status line — the mockup's `.planning` row. */}
        {phase === "idle" && (
          <div className="flex flex-wrap items-center gap-2.5 pt-0.5">
            <GlassButton
              variant="primary"
              size="sm"
              type="button"
              onClick={() => void runPlanner()}
              disabled={trimmedGoal.length === 0}
              data-testid="decompose-plan"
            >
              <Sparkles className="size-3.5" aria-hidden="true" />
              Decompose
            </GlassButton>
            <button
              type="button"
              onClick={skipToManual}
              data-testid="decompose-skip-ai"
              className="text-[12px] text-(--color-text-muted) underline-offset-2 hover:text-(--color-text-primary) hover:underline"
            >
              Skip AI, edit manually
            </button>
          </div>
        )}

        {phase === "planning" && (
          <div
            className="flex items-center gap-2 pt-0.5 text-[12px] text-(--color-text-muted)"
            data-testid="decompose-planning"
          >
            <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
            Planning… reading the repository and proposing tickets.
          </div>
        )}

        {phase === "review" && !manualMode && proposedCount != null && (
          <div className="flex flex-wrap items-center gap-1.5 pt-0.5 text-[12px] text-(--color-text-muted)">
            <Sparkles
              className="size-3.5 text-(--color-text-muted)"
              aria-hidden="true"
            />
            Planner proposed{" "}
            <span className="font-medium text-(--color-text-secondary)">
              {proposedCount} {proposedCount === 1 ? "ticket" : "tickets"}
            </span>
            <span aria-hidden="true">·</span>
            <button
              type="button"
              onClick={requestReplan}
              data-testid="decompose-replan"
              className="font-medium text-(--color-text-secondary) underline-offset-2 hover:text-(--color-text-primary) hover:underline"
            >
              Re-plan
            </button>
          </div>
        )}

        {phase === "review" && manualMode && (
          <div className="flex flex-col gap-1.5 pt-0.5" data-testid="decompose-manual-note">
            <div className="flex flex-wrap items-center gap-1.5 text-[12px] text-(--color-text-muted)">
              {plannerError ? (
                <>
                  <AlertTriangle
                    className="size-3.5 text-(--color-warning)"
                    aria-hidden="true"
                  />
                  {plannerError} Build the plan by hand ·{" "}
                </>
              ) : (
                <>Editing manually · </>
              )}
              <button
                type="button"
                onClick={requestReplan}
                data-testid="decompose-replan"
                className="font-medium text-(--color-text-secondary) underline-offset-2 hover:text-(--color-text-primary) hover:underline disabled:opacity-50"
                disabled={trimmedGoal.length === 0}
              >
                Try the planner again
              </button>
            </div>
            {plannerRawError && (
              <details
                className="text-[11.5px] text-(--color-text-muted)"
                data-testid="decompose-error-details"
              >
                <summary className="cursor-pointer select-none hover:text-(--color-text-primary)">
                  Details
                </summary>
                <pre className="mt-1.5 max-h-24 overflow-auto whitespace-pre-wrap rounded-[8px] border border-(--glass-border-hairline) bg-(--color-bg-input) p-2 font-mono text-[10.5px] text-(--color-text-secondary)">
                  {plannerRawError}
                </pre>
              </details>
            )}
          </div>
        )}
      </div>

      {/* ── Tickets (review only) ────────────────────────────────────────── */}
      {phase === "review" && (
        <div className="flex flex-col gap-2.5">
          {draft.tickets.map((ticket, index) => (
            <TicketRow
              key={ticket.id}
              ticket={ticket}
              index={index}
              agentOptions={agentOptions}
              incoming={draft.edges
                .filter((e) => e.toId === ticket.id && e.fromId !== "")
                .map((e) => ({
                  edgeId: e.id,
                  fromId: e.fromId,
                  label: roleLabelById.get(e.fromId) ?? "removed",
                }))}
              depOptions={draft.tickets
                .filter(
                  (t) =>
                    t.id !== ticket.id &&
                    !draft.edges.some(
                      (e) => e.toId === ticket.id && e.fromId === t.id,
                    ),
                )
                .map((t) => ({
                  label: roleLabelById.get(t.id) ?? t.id,
                  value: t.id,
                }))}
              onRole={(role) => edit({ type: "setRole", id: ticket.id, role })}
              onAgent={(agent) => edit({ type: "setAgent", id: ticket.id, agent })}
              onPrompt={(prompt) =>
                edit({ type: "setPrompt", id: ticket.id, prompt })
              }
              onAddDep={(fromId) =>
                edit({ type: "addDependency", fromId, toId: ticket.id })
              }
              onRemoveDep={(edgeId) => edit({ type: "removeEdge", id: edgeId })}
              onRemove={() => edit({ type: "removeTicket", id: ticket.id })}
            />
          ))}

          <div>
            <GlassButton
              variant="ghost"
              size="sm"
              type="button"
              onClick={() => edit({ type: "addTicket", fallbackAgent })}
              disabled={atCap}
              data-testid="decompose-add-ticket"
              title={atCap ? `At most ${MAX_SUBTASKS} tickets.` : undefined}
            >
              <Plus className="size-3.5" aria-hidden="true" />
              Add ticket
            </GlassButton>
          </div>
        </div>
      )}

      {startError && (
        <p
          className="truncate text-[12px] text-(--color-danger)"
          title={startError}
          data-testid="decompose-error"
        >
          {startError}
        </p>
      )}

      {/* ── Footer — the mockup's `.modal-f`. ────────────────────────────── */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-(--glass-border-hairline) pt-4">
        <span
          className="text-[12px] text-(--color-text-muted)"
          data-testid="decompose-hint"
        >
          Nothing is created until you start.
          {phase === "review" && contractCount > 0 && (
            <>
              {" "}
              {contractCount} {contractCount === 1 ? "handoff" : "handoffs"}.
            </>
          )}
        </span>

        <div className="flex items-center gap-2">
          {phase === "review" && !validation.ok && validation.reason && (
            <span
              className="max-w-[26ch] truncate text-[12px] text-(--color-warning)"
              title={validation.reason}
              data-testid="decompose-reason"
            >
              {validation.reason}
            </span>
          )}
          {onCancel && (
            <GlassButton variant="outline" size="sm" type="button" onClick={onCancel}>
              Cancel
            </GlassButton>
          )}
          <GlassButton
            variant="primary"
            size="sm"
            type="submit"
            disabled={!canStart}
            data-testid="decompose-submit"
            title={
              phase === "review" && !validation.ok
                ? validation.reason ?? undefined
                : undefined
            }
          >
            {submitting
              ? "Starting…"
              : phase === "planning"
                ? "Planning…"
                : phase === "review"
                  ? `Start ${n} ${n === 1 ? "agent" : "agents"}`
                  : "Start"}
            <ArrowRight className="size-3.5" aria-hidden="true" />
          </GlassButton>
        </div>
      </div>

      {/* Re-plan discards hand edits (D-OQ6: discard-and-rerun, confirm first). */}
      <ConfirmDialog
        open={replanConfirm}
        onOpenChange={setReplanConfirm}
        title="Re-plan from scratch?"
        description="Re-planning discards your edits and asks the planner for a fresh plan from the current goal."
        confirmLabel="Re-plan"
        cancelLabel="Keep editing"
        onConfirm={() => {
          setReplanConfirm(false);
          void runPlanner();
        }}
      />
    </form>
  );
}

interface IncomingDep {
  edgeId: string;
  fromId: string;
  label: string;
}

/** One editable ticket — the mockup's `.tickrow`, re-crafted: a calm card with a
 *  clean identity row (role · agent · inline "waits for" handoffs) over a
 *  flush-reading prompt body. */
function TicketRow({
  ticket,
  index,
  agentOptions,
  incoming,
  depOptions,
  onRole,
  onAgent,
  onPrompt,
  onAddDep,
  onRemoveDep,
  onRemove,
}: {
  ticket: DraftTicket;
  index: number;
  agentOptions: Array<{ label: string; value: string }>;
  incoming: IncomingDep[];
  depOptions: Array<{ label: string; value: string }>;
  onRole: (v: string) => void;
  onAgent: (v: Agent) => void;
  onPrompt: (v: string) => void;
  onAddDep: (fromId: string) => void;
  onRemoveDep: (edgeId: string) => void;
  onRemove: () => void;
}) {
  const label = ticket.role.trim() || `ticket ${index + 1}`;

  return (
    <div
      className="rounded-(--radius-panel) border border-(--color-border-subtle) bg-[color-mix(in_oklab,var(--color-bg-surface)_70%,transparent)] p-4"
      data-testid="decompose-ticket"
      data-role={ticket.role.trim()}
    >
      <div className="flex items-start gap-2">
        <div className="flex min-w-0 flex-1 flex-col gap-2.5">
          {/* Identity row: role (title) · agent · inline handoffs. */}
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
            {/* Neutral persona/role — an editable title, no semantic color. */}
            <input
              value={ticket.role}
              onChange={(e) => onRole(e.target.value)}
              data-testid="decompose-role"
              aria-label={`Role for ticket ${index + 1}`}
              spellCheck={false}
              style={{
                width: `calc(${Math.max(ticket.role.length, 4)}ch + 1.75rem)`,
              }}
              className="-ml-1.5 h-7 min-w-0 rounded-[6px] px-1.5 text-[13px] font-semibold text-(--color-text-primary) outline-none transition-colors !border-transparent !bg-transparent hover:!bg-[var(--color-bg-hover)] focus:!border-[var(--color-accent-500)] focus:!bg-[var(--color-bg-input)] focus:shadow-[0_0_0_3px_color-mix(in_oklab,var(--color-accent-500)_12%,transparent)]"
            />

            <GlassSelect
              value={ticket.agent}
              onChange={(e) => onAgent(e.target.value as Agent)}
              options={agentOptions}
              data-testid="decompose-agent"
              aria-label={`Agent for ${label}`}
              className="h-7 w-auto min-w-[104px] rounded-[8px] py-0 pl-2 pr-8 text-[12px] [-webkit-text-fill-color:transparent] !border-transparent !bg-transparent hover:!bg-[var(--color-bg-hover)]"
            />

            {/* Inline dependency editor: the read view (chips) IS the edit
                affordance. Each chip is an incoming handoff (`decompose-edge`). */}
            <span
              aria-hidden="true"
              className="mx-0.5 h-3.5 w-px shrink-0 bg-(--glass-border-hairline)"
            />
            <div className="flex flex-wrap items-center gap-1.5">
              {incoming.length === 0 ? (
                <span className="inline-flex items-center gap-1 text-[12px] text-(--color-text-muted)">
                  <CornerDownRight className="size-3" aria-hidden="true" />
                  runs first
                </span>
              ) : (
                <span className="text-[12px] text-(--color-text-muted)">
                  waits for
                </span>
              )}
              {incoming.map((dep) => (
                <span
                  key={dep.edgeId}
                  data-testid="decompose-edge"
                  className="inline-flex items-center gap-0.5 rounded-full border border-(--glass-border-hairline) bg-(--color-bg-input) py-0.5 pl-2 pr-0.5 text-[12px] text-(--color-text-secondary)"
                >
                  {dep.label}
                  <button
                    type="button"
                    onClick={() => onRemoveDep(dep.edgeId)}
                    data-testid="decompose-dep-remove"
                    aria-label={`Stop ${label} waiting for ${dep.label}`}
                    className="grid size-4 place-items-center rounded-full text-(--color-text-muted) transition-colors hover:bg-(--color-bg-hover) hover:text-(--color-danger)"
                  >
                    <X className="size-3" aria-hidden="true" />
                  </button>
                </span>
              ))}
              {depOptions.length > 0 && (
                <GlassSelect
                  // Always resets to the placeholder: picking a role ADDS a
                  // handoff, it never becomes the control's value.
                  value=""
                  onChange={(e) => {
                    if (e.target.value) onAddDep(e.target.value);
                  }}
                  options={depOptions}
                  placeholder="Depends on…"
                  data-testid="decompose-dep-add"
                  aria-label={`Add a dependency for ${label}`}
                  className="h-[26px] w-auto min-w-[128px] rounded-full py-0 pl-2.5 pr-8 text-[12px] [-webkit-text-fill-color:transparent] !border-transparent !bg-transparent hover:!bg-[var(--color-bg-hover)]"
                />
              )}
            </div>
          </div>

          {/* Prompt body — reads as flush copy at rest, boxes on focus. */}
          <GlassTextarea
            value={ticket.prompt}
            onChange={(e) => onPrompt(e.target.value)}
            data-testid="decompose-prompt"
            aria-label={`Prompt for ${label}`}
            placeholder={`What should the ${label} agent do?`}
            autoGrow
            rows={1}
            className="-mx-2 max-h-[40vh] rounded-[8px] px-2 py-1 text-[13px] leading-[1.55] text-(--color-text-secondary) !border-transparent !bg-transparent hover:!bg-[color-mix(in_oklab,var(--color-bg-hover)_45%,transparent)] focus:!border-[var(--color-accent-500)] focus:!bg-[var(--color-bg-input)] focus:text-(--color-text-primary)"
          />
        </div>

        <button
          type="button"
          onClick={onRemove}
          data-testid="decompose-remove-ticket"
          aria-label={`Remove ${label}`}
          className="-mr-1 -mt-0.5 grid size-7 shrink-0 place-items-center rounded-[6px] text-(--color-text-muted) transition-colors hover:bg-(--color-bg-hover) hover:text-(--color-danger) focus-visible:shadow-[var(--ring-focus)] focus-visible:outline-none"
        >
          <X className="size-4" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
