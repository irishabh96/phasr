import { ArrowRight } from "lucide-react";
import { useRef, useState } from "react";
import { GlassButton } from "@/components/ui/GlassButton";
import { GlassInput, GlassTextarea } from "@/components/ui/GlassInput";
import { humanizeError } from "@/lib/humanizeError";
import { showToast } from "@/lib/toast";
import { tauri } from "@/lib/tauri";
import type { BoardState, DecompositionInput } from "@/lib/types";

interface DecomposeFormProps {
  repositoryId: string;
  /**
   * Called with the freshly-created board once "Start 2 agents" succeeds. The
   * repository view wires this to navigate to the board route; `/design-test`
   * intercepts it so the harness stays put. NOTHING is persisted before this
   * fires — the draft lives entirely in this form (the B2 approval gate).
   */
  onStarted?: (board: BoardState) => void;
  onCancel?: () => void;
}

// The fixed PoC topology (spec §H F-1): two subtasks, both Claude, one edge.
// `frontend` waits for `backend`'s published contract before it can start.
const FIXED_EDGE = { fromRole: "backend", toRole: "frontend" } as const;

/**
 * The decomposition form — the "Start 2 agents" approval gate (S1-T2 / spec
 * F1). The user reviews an editable plan (a shared goal + two role prompts) and
 * the FIXED read-only `backend → frontend` edge, then clicks once. Only then
 * does `start_decomposition` persist a `parent` + 2 `subtask` rows + the edge —
 * there is NO auto-fan-out and nothing is written before the click.
 *
 * A synchronous in-flight ref (the D1 guard) makes a double-click fire the gate
 * at most once (React `submitting` state commits a tick late).
 */
export function DecomposeForm({
  repositoryId,
  onStarted,
  onCancel,
}: DecomposeFormProps) {
  const [goal, setGoal] = useState("");
  const [backendPrompt, setBackendPrompt] = useState("");
  const [frontendPrompt, setFrontendPrompt] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Synchronous re-entrancy guard (D1). Belt AND suspenders with `disabled`.
  const inFlightRef = useRef(false);

  const trimmedGoal = goal.trim();
  const trimmedBackend = backendPrompt.trim();
  const trimmedFrontend = frontendPrompt.trim();

  // The gate holds on BOTH subtask prompts (plus the shared goal): a plan with
  // an empty role prompt is not startable.
  const canSubmit =
    trimmedGoal.length > 0 &&
    trimmedBackend.length > 0 &&
    trimmedFrontend.length > 0 &&
    !submitting;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    if (inFlightRef.current) return; // D1: never fan out twice.
    inFlightRef.current = true;
    setSubmitting(true);
    setError(null);

    const input: DecompositionInput = {
      repositoryId,
      parentPrompt: trimmedGoal,
      subtasks: [
        { role: "backend", agent: "claude", prompt: trimmedBackend },
        { role: "frontend", agent: "claude", prompt: trimmedFrontend },
      ],
      edges: [{ fromRole: FIXED_EDGE.fromRole, toRole: FIXED_EDGE.toRole }],
    };

    try {
      const board = await tauri.startDecomposition(input);
      showToast({
        title: "Decomposition started",
        intent: "success",
        message: "2 agents queued. Backend runs first; frontend waits for its contract.",
      });
      onStarted?.(board);
    } catch (err) {
      const message = humanizeError(err);
      setError(message);
      showToast({
        title: "Couldn't start the agents",
        intent: "error",
        message,
      });
    } finally {
      setSubmitting(false);
      inFlightRef.current = false;
    }
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="space-y-4"
      data-testid="decompose-form"
      aria-label="Decompose into 2 agents"
    >
      <div className="flex flex-col gap-1.5">
        <label
          htmlFor="decompose-goal"
          className="text-[11px] font-medium uppercase tracking-[0.1em] text-(--color-text-muted)"
        >
          Goal
        </label>
        <GlassInput
          id="decompose-goal"
          data-testid="decompose-goal"
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          placeholder="e.g. add a task-comments API and wire the UI"
        />
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <RolePrompt
          id="decompose-backend"
          testId="decompose-backend"
          role="backend"
          value={backendPrompt}
          onChange={setBackendPrompt}
          hint="Runs first — no dependencies."
        />
        <RolePrompt
          id="decompose-frontend"
          testId="decompose-frontend"
          role="frontend"
          value={frontendPrompt}
          onChange={setFrontendPrompt}
          hint="Waits for backend's contract."
        />
      </div>

      {/* The FIXED, read-only edge the user is approving. */}
      <div
        data-testid="decompose-edge"
        className="flex items-center justify-center gap-2 rounded-[10px] border border-(--glass-border-hairline) bg-[color-mix(in_oklab,var(--color-bg-input)_50%,transparent)] px-3 py-2 text-[12px] text-(--color-text-secondary)"
      >
        <RoleChip role="backend" />
        <ArrowRight className="size-3.5 text-(--color-text-muted)" aria-hidden="true" />
        <RoleChip role="frontend" />
        <span className="ml-1 text-(--color-text-muted)">
          frontend starts only after backend publishes its contract
        </span>
      </div>

      {error && (
        <p
          className="truncate text-[11px] text-(--color-danger)"
          title={error}
          data-testid="decompose-error"
        >
          {error}
        </p>
      )}

      <div className="flex items-center justify-end gap-2 pt-1">
        {onCancel && (
          <GlassButton variant="outline" size="sm" type="button" onClick={onCancel}>
            Cancel
          </GlassButton>
        )}
        <GlassButton
          variant="primary"
          size="sm"
          type="submit"
          disabled={!canSubmit}
          data-testid="decompose-submit"
        >
          {submitting ? "Starting…" : "Start 2 agents"}
        </GlassButton>
      </div>
    </form>
  );
}

function RolePrompt({
  id,
  testId,
  role,
  value,
  onChange,
  hint,
}: {
  id: string;
  testId: string;
  role: string;
  value: string;
  onChange: (v: string) => void;
  hint: string;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label
        htmlFor={id}
        className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.1em] text-(--color-text-muted)"
      >
        <RoleChip role={role} />
        <span className="normal-case tracking-normal text-(--color-text-muted)">
          · claude
        </span>
      </label>
      <GlassTextarea
        id={id}
        data-testid={testId}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={`What should the ${role} agent do?`}
        rows={4}
      />
      <span className="text-[11px] text-(--color-text-muted)">{hint}</span>
    </div>
  );
}

function RoleChip({ role }: { role: string }) {
  return (
    <span className="rounded-full border border-(--glass-border-hairline) bg-(--color-bg-surface) px-2 py-0.5 text-[11px] font-medium normal-case tracking-normal text-(--color-text-primary)">
      {role}
    </span>
  );
}
