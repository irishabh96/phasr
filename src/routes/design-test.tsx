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
import { showToast } from "@/lib/toast";
import { useUiStore } from "@/lib/store";
import { ACCENTS, ACCENT_SWATCH } from "@/lib/theme";
import { Button } from "@/components/ui/Button";
import { AgentMark } from "@/components/ui/AgentMark";
import { Chip, DiffCount } from "@/components/ui/Chip";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { Switch } from "@/components/ui/Switch";
import { Kbd } from "@/components/ui/Kbd";
import { GroupHeader } from "@/components/ui/GroupHeader";
import { SettingsCard, SettingsRow } from "@/components/ui/SettingsRow";

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
  const accent = useUiStore((s) => s.accent);
  const setAccent = useUiStore((s) => s.setAccent);
  const [view, setView] = useState<"board" | "list">("board");
  const [on, setOn] = useState(true);

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
          <Button variant="danger-solid" data-testid="btn-danger-solid">
            Delete forever
          </Button>
          <Button variant="secondary" shortcut="⌘N" data-testid="btn-shortcut">
            Shortcut
          </Button>
          <Button variant="secondary" menu>
            With menu
          </Button>
          <Button variant="dashed">+ Add</Button>
          <Button disabled>Disabled</Button>
        </section>

        {/* A-System primitives */}
        <section data-testid="accent-picker" className="flex items-center gap-2">
          <GroupHeader>Accent</GroupHeader>
          {ACCENTS.map((a) => (
            <button
              key={a}
              type="button"
              aria-label={a}
              aria-pressed={accent === a}
              data-testid={`accent-${a}`}
              onClick={() => setAccent(a)}
              className="size-[22px] rounded-full border-2 focus-visible:outline-none focus-visible:shadow-(--ring-focus)"
              style={{
                background: ACCENT_SWATCH[a],
                borderColor: accent === a ? "var(--color-text-primary)" : "transparent",
              }}
            />
          ))}
        </section>

        <section data-testid="status" className="flex flex-wrap items-center gap-3 text-[12px]">
          <StatusBadge kind="queued" />
          <StatusBadge kind="running" halo />
          <StatusBadge kind="needs-you" />
          <StatusBadge kind="done" />
          <StatusBadge kind="failed" />
          <Chip tone="success">tests ✓</Chip>
          <Chip tone="warning">approval</Chip>
          <Chip>7 files</Chip>
          <Chip tone="outline" mono>
            phasr/branch
          </Chip>
          <DiffCount adds={212} removes={48} />
          <Kbd>⌘K</Kbd>
        </section>

        <section data-testid="agents" className="flex flex-wrap items-center gap-3 text-[12px]">
          {(["claude", "codex", "copilot", "gemini", "opencode"] as const).map((a) => (
            <AgentMark key={a} agent={a} withLabel />
          ))}
        </section>

        <section className="flex items-center gap-3">
          <SegmentedControl
            label="View"
            value={view}
            onChange={setView}
            options={[
              { value: "board", label: "Board" },
              { value: "list", label: "List" },
            ]}
          />
          <Switch checked={on} onChange={setOn} label="Example switch" />
        </section>

        <SettingsCard title="Terminal">
          <SettingsRow label="Font" help="Monospace faces found on this machine">
            <span className="font-mono text-[12px]">JetBrains Mono</span>
          </SettingsRow>
          <SettingsRow label="Blink" help="Cursor blink">
            <Switch checked={on} onChange={setOn} label="Blink" />
          </SettingsRow>
        </SettingsCard>

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
