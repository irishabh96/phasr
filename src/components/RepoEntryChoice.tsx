import { ArrowRight, Bot, GitFork, Terminal as TerminalIcon } from "lucide-react";
import type { ComponentType } from "react";
import { useUiStore } from "@/lib/store";
import type { Repository } from "@/lib/types";
import { cn } from "@/lib/utils";

interface RepoEntryChoiceProps {
  repo: Repository;
  /**
   * Reveal the in-pane single-agent task form (the existing two-step
   * "Create your first workspace" flow). Kept as a callback so the choice
   * surface stays presentational and the parent owns the mode switch.
   */
  onNewTask: () => void;
}

/**
 * First-run entry point shown on a freshly-added / empty repository. Instead
 * of dropping the user straight into a form, it offers the three things they
 * can do next as a calm, equal-weight choice — never a dead end:
 *
 *   1. New task     — one agent in an isolated worktree (`onNewTask` reveals
 *                     the existing two-step form → `tauri.startTask`).
 *   2. New epic     — the multi-agent decomposition (`requestDecompose` opens
 *                     the shell-mounted DecomposeModal). Marked optional —
 *                     it's the richer path for a bigger goal.
 *   3. Open terminal — a plain shell in the repo with no agent
 *                     (`openRepoInnerTerminalTab` → SessionTerminalTab).
 *
 * Design: neutral glass cards; coral is spent only on the recommended
 * "New task" icon so the accent stays scarce. The recommended path ALSO
 * carries a neutral "Recommended" badge (mirroring "Optional" on the epic) so
 * the cue never rides hue alone (L5).
 */
export function RepoEntryChoice({ repo, onNewTask }: RepoEntryChoiceProps) {
  const requestDecompose = useUiStore((s) => s.requestDecompose);
  const openTerminal = useUiStore((s) => s.openRepoInnerTerminalTab);

  return (
    <div className="w-full">
      <header>
        <h1 className="text-[24px] font-semibold leading-tight tracking-tight text-(--color-text-primary)">
          {repo.name} is ready
        </h1>
        <p className="mt-2 text-[13px] text-(--color-text-secondary)">
          Pick how you'd like to start. You can do any of these later, too.
        </p>
      </header>

      <div className="mt-7 flex flex-col gap-3">
        <ChoiceCard
          icon={Bot}
          accent
          badge="Recommended"
          title="New task"
          description="Hand one agent a task in an isolated git worktree."
          aria-label={`New task in ${repo.name}`}
          onClick={onNewTask}
        />
        <ChoiceCard
          icon={GitFork}
          badge="Optional"
          title="New epic"
          description="Split a bigger goal across agents that hand off through a shared contract."
          aria-label={`New epic in ${repo.name}`}
          onClick={() => requestDecompose(repo.id)}
        />
        <ChoiceCard
          icon={TerminalIcon}
          title="Open terminal"
          description="Drop into a plain shell in this repo — no agent, no worktree."
          aria-label={`Open terminal in ${repo.name}`}
          onClick={() => openTerminal(repo.id)}
        />
      </div>
    </div>
  );
}

function ChoiceCard({
  icon: Icon,
  title,
  description,
  badge,
  accent = false,
  onClick,
  "aria-label": ariaLabel,
}: {
  icon: ComponentType<{ size?: number | string; className?: string }>;
  title: string;
  description: string;
  badge?: string;
  accent?: boolean;
  onClick: () => void;
  "aria-label": string;
}) {
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      onClick={onClick}
      className="glass-panel group flex w-full items-center gap-4 p-4 text-left transition-all duration-150 hover:border-(--glass-border-strong) hover:bg-(--color-bg-hover) focus-visible:outline-none focus-visible:border-(--color-accent-500) focus-visible:shadow-[0_0_0_2px_var(--color-accent-300)]"
    >
      <span
        className={cn(
          "flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px] border border-(--glass-border-hairline) bg-(--color-bg-input)",
          accent
            ? "text-(--color-accent-text)"
            : "text-(--color-text-secondary)",
        )}
      >
        <Icon size={17} />
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-[13.5px] font-medium text-(--color-text-primary)">
            {title}
          </span>
          {badge && (
            <span className="inline-flex h-[18px] items-center rounded-full border border-(--glass-border-hairline) px-2 text-[10.5px] font-medium uppercase tracking-[0.08em] text-(--color-text-muted)">
              {badge}
            </span>
          )}
        </div>
        <p className="mt-1 text-[12px] leading-snug text-(--color-text-secondary)">
          {description}
        </p>
      </div>

      <ArrowRight
        size={15}
        className="shrink-0 text-(--color-text-muted) opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
      />
    </button>
  );
}
