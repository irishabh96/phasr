import { createFileRoute, Navigate } from "@tanstack/react-router";
import { useState } from "react";
import { FolderGit2 } from "lucide-react";
import { GlassButton } from "@/components/ui/GlassButton";
import { GlassSelect } from "@/components/ui/GlassSelect";
import { PanelState } from "@/components/ui/PanelState";
import { TerminalStatus } from "@/components/TerminalStatus";
import { Dialog, ConfirmDialog } from "@/components/ui/Dialog";
import { DiffList } from "@/components/diff/DiffList";
import { SAMPLE_DIFF_LIST } from "@/components/diff/sampleDiffs";
import { AgentStatusBadgeView } from "@/components/AgentStatusBadge";
import {
  AgentStatusIndicator,
  AgentStatusMetaLine,
} from "@/components/ui/AgentStatusIndicator";
import { BoardView } from "@/components/board/BoardView";
import { NextGateButton } from "@/components/board/NextGateButton";
import {
  ChangesRequestedChip,
  ValidateChip,
} from "@/components/board/GateChips";
import { deriveNextGate, type NextGate } from "@/lib/deriveNextGate";
import { DecomposeForm } from "@/components/DecomposeForm";
import { AgentWorkingBanner } from "@/components/brief/AgentWorkingBanner";
import { AssetsSection } from "@/components/brief/AssetsSection";
import { CommentThread } from "@/components/brief/CommentThread";
import { FigmaSection } from "@/components/brief/FigmaSection";
import { Markdown } from "@/components/brief/Markdown";
import { OnDiskChangePrompt } from "@/components/brief/OnDiskChangePrompt";
import { SectionCard } from "@/components/brief/SectionCard";
import { SectionEditor } from "@/components/brief/SectionEditor";
import { GlassTextarea } from "@/components/ui/GlassInput";
import type { AgentUiState } from "@/lib/deriveAgentState";
import { showToast } from "@/lib/toast";
import { useUiStore } from "@/lib/store";
import type {
  BoardGates,
  BoardState,
  BriefSectionContent,
  FigmaLink,
  ReviewRecord,
  TicketAsset,
  TicketComment,
  ValidateResult,
  Workspace,
} from "@/lib/types";

/**
 * Every honest-status state (Step 0 — S0.1/S0.2), driven by mocked
 * `{ state, since }` so `/design-test` renders them with no Tauri IPC. Order
 * follows the escalation the founder chose: quiet grey Idle → amber Wedged,
 * NO coral (that's a P1 state).
 */
const AGENT_STATES: ReadonlyArray<{
  state: AgentUiState;
  since: number | null;
}> = [
  { state: "resolving", since: null },
  { state: "working", since: 2_000 },
  { state: "idle", since: 180_000 },
  { state: "wedged", since: 840_000 },
  { state: "done", since: 360_000 },
  { state: "failed", since: 60_000 },
  { state: "interrupted", since: null },
  { state: "stopped", since: 120_000 },
];

// ── task-board mock fixtures (S1/S2) ────────────────────────────────────────
// Two board snapshots exercising all four derived lanes: a FRESH board (backend
// working → In progress, frontend blocked → Backlog) and a post-HANDOFF board
// (backend contract published → Review, frontend working → In progress). Rows
// carry a real `startedAt` so `deriveBoardState` renders honest status with no
// liveness IPC.
const BOARD_T0 = Date.now();
const isoAgo = (ms: number) => new Date(BOARD_T0 - ms).toISOString();

function mockWs(overrides: Partial<Workspace> & { id: string }): Workspace {
  return {
    repositoryId: "repo-1",
    workspaceKind: "subtask",
    name: overrides.id,
    prompt: null,
    agent: "claude",
    command: "claude",
    status: "pending",
    branch: null,
    worktreePath: null,
    exitCode: null,
    createdAt: isoAgo(600_000),
    startedAt: null,
    finishedAt: null,
    archivedAt: null,
    interruptedAt: null,
    parentId: "parent-1",
    role: null,
    autopilotEnabled: false,
    updatedAt: isoAgo(0),
    ...overrides,
  };
}

const MOCK_PARENT = mockWs({
  id: "parent-1",
  workspaceKind: "parent",
  name: "task-comments",
  prompt: "Add a task-comments API and wire the comments UI",
  agent: null,
  parentId: null,
  role: null,
});

const MOCK_EDGE = {
  id: "edge-1",
  parentId: "parent-1",
  fromSubtaskId: "sub-backend",
  toSubtaskId: "sub-frontend",
  createdAt: isoAgo(600_000),
};

// Fresh: backend running (→ working), frontend pending + unsatisfied edge (→ blocked).
const BOARD_FRESH: BoardState = {
  parent: MOCK_PARENT,
  subtasks: [
    mockWs({
      id: "sub-backend",
      role: "backend",
      name: "comments API",
      status: "running",
      startedAt: isoAgo(60_000),
    }),
    mockWs({
      id: "sub-frontend",
      role: "frontend",
      name: "comments UI",
      status: "pending",
    }),
  ],
  dependencies: [MOCK_EDGE],
  contracts: [],
};

// Integrable: BOTH subtasks published their contracts (→ needs-review), so the
// board is ready for the human's "Integrate & review". Distinct parent id so the
// Playwright IPC mock can key the integration/diff responses on it.
const BOARD_INTEGRABLE: BoardState = {
  parent: mockWs({
    id: "parent-clean",
    workspaceKind: "parent",
    name: "task-comments",
    prompt: "Add a task-comments API and wire the comments UI",
    agent: null,
    parentId: null,
    role: null,
  }),
  subtasks: [
    mockWs({
      id: "sub-backend",
      parentId: "parent-clean",
      role: "backend",
      name: "comments API",
      status: "completed",
      startedAt: isoAgo(300_000),
      finishedAt: isoAgo(30_000),
    }),
    mockWs({
      id: "sub-frontend",
      parentId: "parent-clean",
      role: "frontend",
      name: "comments UI",
      status: "completed",
      startedAt: isoAgo(200_000),
      finishedAt: isoAgo(8_000),
    }),
  ],
  dependencies: [{ ...MOCK_EDGE, parentId: "parent-clean" }],
  contracts: [
    {
      id: "contract-backend-clean",
      parentId: "parent-clean",
      subtaskId: "sub-backend",
      role: "backend",
      contractPath: "~/.phasr/tasks/parent-clean/contracts/backend.md",
      publishedAt: isoAgo(25_000),
      createdAt: isoAgo(30_000),
    },
    {
      id: "contract-frontend-clean",
      parentId: "parent-clean",
      subtaskId: "sub-frontend",
      role: "frontend",
      contractPath: "~/.phasr/tasks/parent-clean/contracts/frontend.md",
      publishedAt: isoAgo(6_000),
      createdAt: isoAgo(10_000),
    },
  ],
};

// Handoff: backend published its contract (→ needs-review), frontend now
// running (→ working).
const BOARD_HANDOFF: BoardState = {
  parent: MOCK_PARENT,
  subtasks: [
    mockWs({
      id: "sub-backend",
      role: "backend",
      name: "comments API",
      status: "running",
      startedAt: isoAgo(300_000),
    }),
    mockWs({
      id: "sub-frontend",
      role: "frontend",
      name: "comments UI",
      status: "running",
      startedAt: isoAgo(45_000),
    }),
  ],
  dependencies: [MOCK_EDGE],
  contracts: [
    {
      id: "contract-backend",
      parentId: "parent-1",
      subtaskId: "sub-backend",
      role: "backend",
      contractPath: "~/.phasr/tasks/parent-1/contracts/backend.md",
      publishedAt: isoAgo(20_000),
      createdAt: isoAgo(25_000),
    },
  ],
};

// ── Phase 3 gate fixtures (Validate + Review/QAS) ───────────────────────────
// A board that exercises the review-lane + validate chips + the per-card gates
// with NO IPC: backend is IN REVIEW (review requested → Review lane → Approve +
// Bounce gate, validate passed chip); frontend is WORKING with checks configured
// but not yet validated (→ Validate primary gate, "Not validated" chip).
const BOARD_GATES: BoardState = {
  parent: mockWs({
    id: "parent-gates",
    workspaceKind: "parent",
    name: "task-comments",
    prompt: "Add a task-comments API and wire the comments UI",
    agent: null,
    parentId: null,
    role: null,
  }),
  subtasks: [
    mockWs({
      id: "sub-backend",
      parentId: "parent-gates",
      role: "backend",
      name: "comments API",
      status: "running",
      startedAt: isoAgo(300_000),
    }),
    mockWs({
      id: "sub-frontend",
      parentId: "parent-gates",
      role: "frontend",
      name: "comments UI",
      status: "running",
      startedAt: isoAgo(45_000),
    }),
  ],
  dependencies: [{ ...MOCK_EDGE, parentId: "parent-gates" }],
  contracts: [],
};

const GATES_FIXTURE: BoardGates = {
  reviews: [
    {
      subtaskId: "sub-backend",
      state: "requested",
      by: "you",
      comment: null,
      atMs: BOARD_T0 - 20_000,
      validatePassed: true,
    } satisfies ReviewRecord,
  ],
  validations: [
    {
      subtaskId: "sub-backend",
      checks: [
        {
          name: "typecheck",
          command: "pnpm typecheck",
          passed: true,
          exitCode: 0,
          tailOutput: "",
        },
        {
          name: "test",
          command: "pnpm test",
          passed: true,
          exitCode: 0,
          tailOutput: "ok",
        },
      ],
      passed: true,
      ranAtMs: BOARD_T0 - 30_000,
    } satisfies ValidateResult,
    // frontend has no validate.json yet → the "Not validated" chip + Validate gate.
  ],
};

// A failing validate result for the standalone Validate-chip + ladder showcase.
const VALIDATE_FAILED: ValidateResult = {
  subtaskId: "sub-x",
  checks: [
    {
      name: "lint",
      command: "pnpm lint",
      passed: true,
      exitCode: 0,
      tailOutput: "",
    },
    {
      name: "test",
      command: "pnpm test",
      passed: false,
      exitCode: 1,
      tailOutput: "1 failing",
    },
    {
      name: "typecheck",
      command: "pnpm typecheck",
      passed: false,
      exitCode: 2,
      tailOutput: "TS2322",
    },
  ],
  passed: false,
  ranAtMs: BOARD_T0 - 5_000,
};

// The NextGate ladder, rendered as pure gates for the disabled-with-reason +
// intent assertions (no IPC — onRun is a no-op here).
const GATE_LADDER: ReadonlyArray<{ id: string; gate: NextGate }> = [
  {
    id: "validate",
    gate: deriveNextGate({
      kind: "ticket",
      state: "working",
      validate: null,
      review: null,
      checksConfigured: true,
    }),
  },
  {
    id: "request-review-blocked",
    gate: deriveNextGate({
      kind: "ticket",
      state: "working",
      validate: VALIDATE_FAILED,
      review: null,
      checksConfigured: true,
    }),
  },
  {
    id: "approve",
    gate: deriveNextGate({
      kind: "ticket",
      state: "in-review",
      validate: null,
      review: {
        subtaskId: "sub-x",
        state: "requested",
        by: "you",
        comment: null,
        atMs: 0,
        validatePassed: true,
      },
      checksConfigured: true,
    }),
  },
  {
    id: "approved",
    gate: deriveNextGate({
      kind: "ticket",
      state: "needs-review",
      validate: null,
      review: {
        subtaskId: "sub-x",
        state: "approved",
        by: "you",
        comment: null,
        atMs: 0,
        validatePassed: true,
      },
      checksConfigured: true,
    }),
  },
  {
    id: "integrate-locked",
    gate: deriveNextGate({
      kind: "epic",
      ticketCount: 3,
      integrable: false,
      integrated: false,
      shipped: false,
    }),
  },
  {
    id: "integrate",
    gate: deriveNextGate({
      kind: "epic",
      ticketCount: 3,
      integrable: true,
      integrated: false,
      shipped: false,
    }),
  },
  {
    id: "ship",
    gate: deriveNextGate({
      kind: "epic",
      ticketCount: 3,
      integrable: true,
      integrated: true,
      shipped: false,
      baseBranch: "main",
    }),
  },
  {
    id: "shipped",
    gate: deriveNextGate({
      kind: "epic",
      ticketCount: 3,
      integrable: true,
      integrated: true,
      shipped: true,
      baseBranch: "main",
    }),
  },
];

// ── Brief tab fixtures (Phase 2 — mockup Page 04) ───────────────────────────
// Presentational-only brief pieces, driven by fixtures so `/design-test`
// exercises every Brief state with NO Tauri IPC (read markdown, editing,
// on-disk conflict, empty section, assets, figma, comments, agent-live banner).
const BRIEF_NOW = Date.now();
const briefSection = (
  content: string,
  editedAgoMs: number | null,
): BriefSectionContent => ({
  content,
  mtimeMs: 1000,
  lastEditedBy: "you",
  lastEditedAtMs: editedAgoMs == null ? null : BRIEF_NOW - editedAgoMs,
});

const BRIEF_PRD = briefSection(
  "## Goal\n\nA collaborator can leave, read, and remove comments on a ticket " +
    "without leaving the panel.\n\n## Requirements\n\n" +
    "- Optimistic add; roll back on failure with a humanized error.\n" +
    '- Empty state: "No comments yet — leave the first note."\n' +
    "- Delete is author-only; confirm before removing.\n\n" +
    "See the [safe external link](https://example.com).",
  1_200_000,
);
const BRIEF_EMPTY = briefSection("", null);

const BRIEF_ASSETS: TicketAsset[] = [
  {
    id: "panel-mock.png",
    name: "panel-mock.png",
    storage: "in-repo",
    path: "/tmp/panel-mock.png",
    sizeBytes: 20480,
    kind: "image",
    addedAtMs: BRIEF_NOW,
  },
  {
    id: "spec-v2.pdf",
    name: "spec-v2.pdf",
    storage: "in-repo",
    path: "/tmp/spec-v2.pdf",
    sizeBytes: 51200,
    kind: "pdf",
    addedAtMs: BRIEF_NOW,
  },
];
const BRIEF_FIGMA: FigmaLink[] = [
  {
    id: "figma-1",
    url: "https://figma.com/file/checkout-comments",
    label: "Panel",
    addedBy: "you",
    addedAtMs: BRIEF_NOW,
  },
];
const BRIEF_COMMENTS: TicketComment[] = [
  {
    id: "c-1",
    author: "Ronak",
    authorKind: "you",
    role: null,
    body: "Match the login panel spacing — 12px gaps, not 8. Delete needs the confirm dialog.",
    createdAtMs: BRIEF_NOW - 1_200_000,
  },
  {
    id: "c-2",
    author: "claude",
    authorKind: "agent",
    role: "frontend",
    body: "Adopted 12px gaps and wired ConfirmDialog on delete. Blocked on the API contract.",
    createdAtMs: BRIEF_NOW - 360_000,
  },
];

/**
 * Dev-only Playwright harness. Renders the design-fix surfaces with NO Tauri
 * IPC and NO auth (top-level route, outside `_app`), so a browser can drive
 * them directly. Gated behind `import.meta.env.DEV` — never ships.
 */
function DesignTest() {
  if (!import.meta.env.DEV) return <Navigate to="/" />;

  const theme = useUiStore((s) => s.theme);
  const setTheme = useUiStore((s) => s.setTheme);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  return (
    <div className="min-h-screen bg-(--color-bg-base) p-6 text-(--color-text-primary)">
      <div className="mx-auto flex max-w-[720px] flex-col gap-6">
        <div className="flex items-center justify-between">
          <h1 className="text-lg font-semibold">Design test harness</h1>
          <button
            type="button"
            data-testid="theme-toggle"
            data-theme-value={theme}
            onClick={() => setTheme(theme === "light" ? "dark" : "light")}
            className="rounded-(--radius-control) border border-(--color-border-default) bg-(--color-bg-input) px-3 py-1.5 text-[13px] focus-visible:outline-none focus-visible:shadow-[var(--ring-focus)]"
          >
            Theme: {theme}
          </button>
        </div>

        {/* Buttons — Batch 0 T1/T2 AA fixes live in these variants */}
        <section data-testid="buttons" className="flex flex-wrap gap-2">
          <GlassButton variant="primary" data-testid="btn-primary">
            Primary
          </GlassButton>
          <GlassButton variant="danger" data-testid="btn-danger">
            Delete
          </GlassButton>
          <GlassButton variant="outline" data-testid="btn-outline">
            Outline
          </GlassButton>
          <GlassButton variant="ghost" data-testid="btn-ghost">
            Ghost
          </GlassButton>
        </section>

        <section data-testid="select">
          <GlassSelect
            aria-label="Sample select"
            options={[
              { label: "Claude", value: "claude" },
              { label: "Codex", value: "codex" },
            ]}
            placeholder="Pick an agent"
          />
        </section>

        {/* Toasts — Batch 3 rebuild (glass, icons, roles, no-auto-dismiss) */}
        <section data-testid="toasts" className="flex flex-wrap gap-2">
          <GlassButton
            variant="outline"
            data-testid="toast-success"
            onClick={() =>
              showToast({
                title: "Saved",
                intent: "success",
                message: "All good.",
              })
            }
          >
            Toast: success
          </GlassButton>
          <GlassButton
            variant="outline"
            data-testid="toast-error"
            onClick={() =>
              showToast({
                title: "Failed to push",
                intent: "error",
                message: "Remote rejected the push.",
              })
            }
          >
            Toast: error
          </GlassButton>
          <GlassButton
            variant="outline"
            data-testid="toast-action"
            onClick={() =>
              showToast({
                title: "PR opened",
                intent: "success",
                action: { label: "View PR", url: "https://example.com" },
              })
            }
          >
            Toast: action
          </GlassButton>
        </section>

        {/* Dialogs — Batch 4 shared shell */}
        <section data-testid="dialogs" className="flex flex-wrap gap-2">
          <GlassButton
            data-testid="open-dialog"
            onClick={() => setDialogOpen(true)}
          >
            Open dialog
          </GlassButton>
          <GlassButton
            variant="danger"
            data-testid="open-confirm"
            onClick={() => setConfirmOpen(true)}
          >
            Open confirm
          </GlassButton>
          <Dialog
            open={dialogOpen}
            onOpenChange={setDialogOpen}
            title="Example dialog"
            description="This dialog uses the shared Radix shell."
            footer={
              <GlassButton
                variant="primary"
                data-testid="dialog-primary"
                onClick={() => setDialogOpen(false)}
              >
                Confirm
              </GlassButton>
            }
          >
            <p className="text-[13px] text-(--color-text-secondary)">
              Dialog body content.
            </p>
          </Dialog>
          <ConfirmDialog
            open={confirmOpen}
            onOpenChange={setConfirmOpen}
            title="Delete workspace?"
            description="This permanently deletes the branch and worktree."
            confirmLabel="Delete"
            destructive
            onConfirm={() => setConfirmOpen(false)}
          />
        </section>

        {/* Panel states — Batch 2 */}
        <section data-testid="panelstates" className="grid grid-cols-3 gap-3">
          <div className="rounded-(--radius-panel) border border-(--color-border-default)">
            <PanelState kind="loading" rows={3} />
          </div>
          <div
            data-testid="panel-empty"
            className="rounded-(--radius-panel) border border-(--color-border-default)"
          >
            <PanelState
              kind="empty"
              icon={<FolderGit2 />}
              title="No repositories yet"
              description="Add a repository to start."
              action={
                <GlassButton variant="primary" size="sm">
                  Add repository
                </GlassButton>
              }
            />
          </div>
          <div
            data-testid="panel-error"
            className="rounded-(--radius-panel) border border-(--color-border-default)"
          >
            <PanelState
              kind="error"
              title="Couldn't load"
              error={new Error("Network request failed")}
              onRetry={() => {}}
            />
          </div>
        </section>

        {/* Terminal status — Batch 3 */}
        <section
          data-testid="terminalstatus"
          className="grid grid-cols-2 gap-3"
        >
          <div className="relative h-32 rounded-(--radius-panel) border border-(--color-border-default) bg-(--color-bg-terminal)">
            <TerminalStatus
              state="failed"
              error="pty error: spawn failed"
              onRetry={() => {}}
            />
          </div>
          <div className="relative h-32 rounded-(--radius-panel) border border-(--color-border-default) bg-(--color-bg-terminal)">
            <TerminalStatus state="exited" exitCode={1} onRestart={() => {}} />
          </div>
        </section>

        {/* Agent honest status — Step 0 (S0.1 sidebar indicator + header badge) */}
        <section data-testid="agentstatus" className="flex flex-col gap-2">
          {AGENT_STATES.map(({ state, since }) => {
            const exitCode = state === "failed" ? 1 : null;
            const changeCount = state === "done" ? 8 : null;
            return (
              <div
                key={state}
                data-testid={`agent-state-${state}`}
                data-agent-state={state}
                className="flex flex-wrap items-center gap-4 rounded-(--radius-panel) border border-(--color-border-default) p-3"
              >
                {/* Sidebar mock: indicator + honest meta line */}
                <div className="flex min-w-[220px] items-center gap-2 rounded-[8px] bg-(--color-bg-sidebar) px-2 py-1">
                  <AgentStatusIndicator state={state} />
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="text-[13px] leading-none text-(--color-text-primary)">
                      migrate-db
                    </span>
                    <AgentStatusMetaLine
                      state={state}
                      since={since}
                      exitCode={exitCode}
                      changeCount={changeCount}
                    />
                  </span>
                </div>
                {/* Header badge */}
                <AgentStatusBadgeView
                  state={state}
                  since={since}
                  exitCode={exitCode}
                  changeCount={changeCount}
                  onRestart={() => {}}
                />
              </div>
            );
          })}
        </section>

        {/* Task board — decompose form (S1-T2) + read-only board (S2-T1) */}
        <section data-testid="decompose" className="flex flex-col gap-3">
          <h2 className="text-[13px] font-semibold text-(--color-text-secondary)">
            Decompose form
          </h2>
          <DecomposeForm
            repositoryId="repo-1"
            onStarted={(board) =>
              showToast({
                title: "Started (mock)",
                intent: "success",
                message: `parent ${board.parent.id}`,
              })
            }
          />
        </section>

        <section data-testid="board-fresh" className="flex flex-col gap-3">
          <h2 className="text-[13px] font-semibold text-(--color-text-secondary)">
            Board · fresh (backend working, frontend blocked)
          </h2>
          <BoardView board={BOARD_FRESH} />
        </section>

        <section data-testid="board-handoff" className="flex flex-col gap-3">
          <h2 className="text-[13px] font-semibold text-(--color-text-secondary)">
            Board · handoff (backend in review, frontend working)
          </h2>
          <BoardView board={BOARD_HANDOFF} />
        </section>

        <section data-testid="board-integrable" className="flex flex-col gap-3">
          <h2 className="text-[13px] font-semibold text-(--color-text-secondary)">
            Board · integrable (both subtasks in review → Integrate &amp;
            review)
          </h2>
          <BoardView board={BOARD_INTEGRABLE} />
        </section>

        {/* Phase 3 — the NextGate ladder (G1). Each gate is a pure
            deriveNextGate result rendered by the shared NextGateButton, so the
            disabled-with-reason + intent contract is assertable with no IPC. */}
        <section data-testid="gate-ladder" className="flex flex-col gap-3">
          <h2 className="text-[13px] font-semibold text-(--color-text-secondary)">
            NextGate ladder (disabled-with-reason, never hidden)
          </h2>
          <div className="flex flex-wrap items-center gap-3">
            {GATE_LADDER.map(({ id, gate }) => (
              <div
                key={id}
                data-testid={`gate-${id}`}
                className="flex flex-col items-start gap-1 rounded-(--radius-panel) border border-(--color-border-default) p-3"
              >
                <span className="text-[11px] text-(--color-text-muted)">
                  {id}
                </span>
                <NextGateButton
                  gate={gate}
                  onRun={() => {}}
                  onBounce={() => {}}
                />
              </div>
            ))}
          </div>
        </section>

        {/* Phase 3 — the Validate chip states (V2) + the bounce chip (R2). */}
        <section
          data-testid="gate-chips"
          className="flex flex-wrap items-center gap-3"
        >
          <ValidateChip validate={null} checksConfigured={false} />
          <ValidateChip validate={null} checksConfigured={true} />
          <ValidateChip
            validate={{
              subtaskId: "sub-x",
              checks: [
                {
                  name: "test",
                  command: "pnpm test",
                  passed: true,
                  exitCode: 0,
                  tailOutput: "",
                },
              ],
              passed: true,
              ranAtMs: BOARD_T0,
            }}
            checksConfigured={true}
          />
          <ValidateChip validate={VALIDATE_FAILED} checksConfigured={true} />
          <ChangesRequestedChip comment="Match the login panel spacing — 12px gaps." />
        </section>

        {/* Phase 3 — a board wired with gates: backend IN REVIEW (Approve +
            Bounce), frontend WORKING with checks configured (Validate). */}
        <section data-testid="board-gates" className="flex flex-col gap-3">
          <h2 className="text-[13px] font-semibold text-(--color-text-secondary)">
            Board · gates (backend in review, frontend to validate)
          </h2>
          <BoardView
            board={BOARD_GATES}
            gates={GATES_FIXTURE}
            checksConfigured
          />
        </section>

        {/* Brief tab — Phase 2 (mockup Page 04): banner, sections (read/edit/
            conflict/empty), assets, figma, comments */}
        <section data-testid="brief" className="flex flex-col gap-3.5">
          <h2 className="text-[13px] font-semibold text-(--color-text-secondary)">
            Brief tab (Page 04)
          </h2>

          <AgentWorkingBanner />

          {/* Read-first section with per-section edit (real reducer-backed). */}
          <SectionEditor
            repositoryId="repo-1"
            ticketId="ticket-1"
            sectionKey="prd"
            label="PRD"
            section={BRIEF_PRD}
            onSaved={() => {}}
          />

          {/* Editing state + on-disk conflict prompt (static demo). */}
          <SectionCard
            title="TRD · editing"
            editing
            action={
              <span className="text-[11px] text-(--color-accent-text)">
                Markdown
              </span>
            }
          >
            <GlassTextarea
              readOnly
              rows={4}
              value={"## Data\nGET/POST/DELETE /api/tickets/:id/comments"}
              className="min-h-[96px] border-(--color-accent-500) font-mono text-[12px]"
            />
            <OnDiskChangePrompt onReload={() => {}} onKeepMine={() => {}} />
          </SectionCard>

          {/* Empty section → "Write …" CTA. */}
          <SectionEditor
            repositoryId="repo-1"
            ticketId="ticket-1"
            sectionKey="description"
            label="Description"
            section={BRIEF_EMPTY}
            onSaved={() => {}}
          />

          {/* Markdown must NOT execute raw HTML. */}
          <div
            data-testid="brief-md-safe"
            className="rounded-(--radius-panel) border border-(--color-border-default) p-3"
          >
            <Markdown>
              {"Inline `code`, a [safe link](https://example.com), and an inert " +
                '<img src=x onerror="window.__XSS__=1"> tag.'}
            </Markdown>
          </div>

          <AssetsSection
            assets={BRIEF_ASSETS}
            onPick={() => {}}
            onRemove={() => {}}
          />

          <FigmaSection
            links={BRIEF_FIGMA}
            onAdd={() => {}}
            onRemove={() => {}}
          />

          <SectionCard title="Comments" testId="brief-comments-demo">
            <CommentThread comments={BRIEF_COMMENTS} now={BRIEF_NOW} />
          </SectionCard>
        </section>

        {/* Diff — Batch 0 T5 palette + diff a11y */}
        <section data-testid="diff" className="h-[420px]">
          <DiffList files={SAMPLE_DIFF_LIST} />
        </section>
      </div>
    </div>
  );
}

export const Route = createFileRoute("/design-test")({
  component: DesignTest,
});
