import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { GlassButton } from "@/components/ui/GlassButton";
import { GlassInput, GlassTextarea } from "@/components/ui/GlassInput";
import { useAgents } from "@/lib/hooks/useAgents";
import { useRepository } from "@/lib/hooks/useRepositories";
import { workspaceKeys } from "@/lib/hooks/useWorkspaces";
import { tauri } from "@/lib/tauri";
import type { Workspace } from "@/lib/types";

interface NewTaskFormProps {
  repositoryId: string;
  onCreated?: (task: Workspace) => void;
  onCancel?: () => void;
  /** Defaults to "Start task". */
  submitLabel?: string;
  autoFocus?: boolean;
}

/**
 * The "new task" form (plan section 8). One screen, four fields:
 *
 *   - Name        — human label for the task row
 *   - Agent       — preset picker (defaults to user's default preset)
 *   - Prompt      — multi-line; interpolated into the agent's command template
 *   - Base branch — defaults to the repo's default branch
 *
 * On submit, calls the orchestrator's `start_task` Tauri command.
 * That command creates the workspace row, the worktree on
 * `phasr/<short-id>`, spawns the PTY, and flips status to running —
 * one round-trip. The caller usually navigates to the resulting task
 * via `onCreated` so the user lands directly on the live terminal.
 */
export function NewTaskForm({
  repositoryId,
  onCreated,
  onCancel,
  submitLabel = "Start task",
  autoFocus = true,
}: NewTaskFormProps) {
  const { data: agents } = useAgents();
  const { data: repository } = useRepository(repositoryId);
  const queryClient = useQueryClient();

  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [agentId, setAgentId] = useState<string | null>(null);
  const [baseBranch, setBaseBranch] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const enabledAgents = agents?.filter((a) => a.isEnabled) ?? [];
  const defaultAgent = enabledAgents.find((a) => a.isDefault) ?? enabledAgents[0];
  const activeAgentId = agentId ?? defaultAgent?.id ?? null;
  const activeAgent = enabledAgents.find((a) => a.id === activeAgentId);

  // Seed the base-branch field once the repository row has loaded so
  // the field shows "main" / "master" by default. The user can edit if
  // they want to branch off something else.
  useEffect(() => {
    if (repository && baseBranch === "") {
      setBaseBranch(repository.defaultBranch);
    }
  }, [repository, baseBranch]);

  const trimmedName = name.trim();
  const trimmedPrompt = prompt.trim();
  const trimmedBaseBranch = baseBranch.trim();
  const canSubmit = trimmedName.length > 0 && !!activeAgent && !submitting;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit || !activeAgent) return;
    setSubmitting(true);
    setError(null);
    try {
      const started = await tauri.startTask({
        repositoryId,
        agentId: activeAgent.id,
        name: trimmedName,
        ...(trimmedPrompt ? { prompt: trimmedPrompt } : {}),
        ...(trimmedBaseBranch ? { baseBranch: trimmedBaseBranch } : {}),
      });
      // Prime the cache so the detail route shows the row immediately
      // without an extra refetch.
      queryClient.setQueryData(
        workspaceKeys.detail(started.workspace.id),
        started.workspace,
      );
      queryClient.invalidateQueries({
        queryKey: workspaceKeys.byRepository(started.workspace.repositoryId),
      });
      setName("");
      setPrompt("");
      onCreated?.(started.workspace);
    } catch (err) {
      console.error("start_task failed", err);
      setError(String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <div className="flex flex-col gap-1.5">
        <label className="text-[11px] font-medium uppercase tracking-[0.1em] text-(--color-text-muted)">
          Name
        </label>
        <GlassInput
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. fix login redirect bug"
          autoFocus={autoFocus}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <label className="text-[11px] font-medium uppercase tracking-[0.1em] text-(--color-text-muted)">
          Agent
        </label>
        <select
          value={activeAgentId ?? ""}
          onChange={(e) => setAgentId(e.target.value)}
          className="h-9 w-full rounded-[10px] border border-(--glass-border-hairline) bg-[color-mix(in_oklab,var(--color-bg-input)_70%,transparent)] px-3 text-[13px] backdrop-blur-md focus:border-(--color-accent-500) focus:outline-none focus:shadow-[0_0_0_3px_color-mix(in_oklab,var(--color-accent-500)_25%,transparent)]"
        >
          {enabledAgents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
        {activeAgent && (
          <code className="block truncate text-[11px] text-(--color-text-muted)">
            {activeAgent.command}
          </code>
        )}
      </div>

      <div className="flex flex-col gap-1.5">
        <label className="text-[11px] font-medium uppercase tracking-[0.1em] text-(--color-text-muted)">
          Prompt
        </label>
        <GlassTextarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="What should the agent do?"
          rows={4}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <label className="text-[11px] font-medium uppercase tracking-[0.1em] text-(--color-text-muted)">
          Base branch
        </label>
        <GlassInput
          value={baseBranch}
          onChange={(e) => setBaseBranch(e.target.value)}
          placeholder={repository?.defaultBranch ?? "main"}
        />
        <span className="text-[11px] text-(--color-text-muted)">
          Worktree will branch off this ref onto a new <code>phasr/…</code> branch.
        </span>
      </div>

      <div className="flex items-center justify-end gap-2 pt-1">
        {error && (
          <span className="mr-auto truncate text-[11px] text-(--color-danger)">{error}</span>
        )}
        {onCancel && (
          <GlassButton variant="ghost" size="sm" type="button" onClick={onCancel}>
            Cancel
          </GlassButton>
        )}
        <GlassButton variant="primary" size="sm" type="submit" disabled={!canSubmit}>
          {submitting ? "Starting…" : submitLabel}
        </GlassButton>
      </div>
    </form>
  );
}
