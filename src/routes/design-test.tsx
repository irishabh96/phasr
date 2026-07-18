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
import type { AgentUiState } from "@/lib/deriveAgentState";
import { showToast } from "@/lib/toast";
import { useUiStore } from "@/lib/store";

/**
 * Every honest-status state (Step 0 — S0.1/S0.2), driven by mocked
 * `{ state, since }` so `/design-test` renders them with no Tauri IPC. Order
 * follows the escalation the founder chose: quiet grey Idle → amber Wedged,
 * NO coral (that's a P1 state).
 */
const AGENT_STATES: ReadonlyArray<{ state: AgentUiState; since: number | null }> =
  [
    { state: "resolving", since: null },
    { state: "working", since: 2_000 },
    { state: "idle", since: 180_000 },
    { state: "wedged", since: 840_000 },
    { state: "done", since: 360_000 },
    { state: "failed", since: 60_000 },
    { state: "interrupted", since: null },
    { state: "stopped", since: 120_000 },
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
              showToast({ title: "Saved", intent: "success", message: "All good." })
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
          <GlassButton data-testid="open-dialog" onClick={() => setDialogOpen(true)}>
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
            <p className="text-[13px] text-(--color-text-secondary)">Dialog body content.</p>
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
        <section data-testid="terminalstatus" className="grid grid-cols-2 gap-3">
          <div className="relative h-32 rounded-(--radius-panel) border border-(--color-border-default) bg-(--color-bg-terminal)">
            <TerminalStatus state="failed" error="pty error: spawn failed" onRetry={() => {}} />
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
