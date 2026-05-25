import { StatusDot } from "@/components/ui/StatusDot";
import type { WorkspaceStatus } from "@/lib/types";
import { cn } from "@/lib/utils";

const LABEL: Record<WorkspaceStatus, string> = {
  pending: "Pending",
  running: "Running",
  completed: "Completed",
  failed: "Failed",
  stopped: "Stopped",
  archived: "Archived",
};

interface TaskStatusPillProps {
  status: WorkspaceStatus;
  className?: string;
}

/**
 * Small read-only pill used in the task detail header (plan section 6).
 * Pairs the existing <StatusDot> with the status label so the header
 * also reads well at a glance even with the dot's color alone.
 *
 * Per the project memory in
 * `~/.claude/projects/-Users-rishabh-code-phasr/memory/project_pty_exit_for_interactive_agents.md`,
 * interactive agents (Claude / Codex / Cursor) sit in a REPL — they
 * almost never trigger a real PTY exit, so `completed` / `failed` are
 * rare in practice. The pill just reflects whatever the row says; we
 * don't try to overinterpret "agent finished a turn" from this signal.
 */
export function TaskStatusPill({ status, className }: TaskStatusPillProps) {
  return (
    <span
      aria-label={`Status: ${LABEL[status]}`}
      className={cn(
        "inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full px-2",
        "border border-(--glass-border-hairline)",
        "bg-[color-mix(in_oklab,var(--color-bg-elevated)_70%,transparent)]",
        "text-[11px] font-medium leading-none text-(--color-text-secondary)",
        className,
      )}
    >
      <StatusDot status={status} />
      <span>{LABEL[status]}</span>
    </span>
  );
}
