import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { AgentMark } from "@/components/ui/AgentMark";
import { BaseBranchField } from "@/components/ui/BaseBranchField";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/Dialog";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { useAgentDetection, useAgents } from "@/lib/hooks/useAgents";
import { usePromptDropTarget } from "@/lib/hooks/usePromptDropTarget";
import { useRepository } from "@/lib/hooks/useRepositories";
import { useUserSettings } from "@/lib/hooks/useUserSettings";
import { useWorkspaces, workspaceKeys } from "@/lib/hooks/useWorkspaces";
import { humanizeError } from "@/lib/humanizeError";
import { buildPlanPreview, nameFromPrompt, PERMISSION_LABEL } from "@/lib/planPreview";
import { reportP0Error } from "@/lib/sentry";
import { matchShortcut, SHORTCUTS } from "@/lib/shortcuts";
import { tauri } from "@/lib/tauri";
import type { Agent, PermissionMode, RunIn, Workspace } from "@/lib/types";
import { cn } from "@/lib/utils";

interface NewTaskFormProps {
  repositoryId: string;
  onCreated?: (task: Workspace) => void;
  onCancel?: () => void;
  /** Defaults to "Start task". */
  submitLabel?: string;
  autoFocus?: boolean;
  /** "dialog" renders its own footer bar; "inline" is the first-task card. */
  variant?: "dialog" | "inline";
}

const LABEL = "text-[11px] font-semibold uppercase tracking-[0.04em] text-(--color-text-muted)";

/**
 * New task (A-NewTask). Prompt first — the name derives from it unless you
 * type one — then the agent, where it runs, and how much it may do without
 * asking. The plan box shows exactly what Phasr will run.
 */
export function NewTaskForm({
  repositoryId,
  onCreated,
  onCancel,
  submitLabel = "Start task",
  autoFocus = true,
  variant = "dialog",
}: NewTaskFormProps) {
  const { data: agents } = useAgents();
  const { data: detection } = useAgentDetection();
  const { data: repository } = useRepository(repositoryId);
  const { data: settings } = useUserSettings();
  const { data: workspaces } = useWorkspaces(repositoryId);
  const queryClient = useQueryClient();

  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const promptDrop = usePromptDropTarget(prompt, setPrompt);
  const [agent, setAgent] = useState<Agent | null>(null);
  const [baseBranch, setBaseBranch] = useState("");
  const [runIn, setRunIn] = useState<RunIn>("worktree");
  /** null = the user's default mode (not sent; the backend applies it). */
  const [mode, setMode] = useState<PermissionMode | null>(null);
  const [notify, setNotify] = useState(true);
  const [submitting, setSubmitting] = useState<"start" | "draft" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmInPlace, setConfirmInPlace] = useState(false);

  // Synchronous re-entrancy guard: React state commits a tick late, so two
  // submits in one task would both pass `!submitting` and start twice.
  const inFlightRef = useRef(false);

  const allAgents = agents ?? [];
  const defaultAgent = allAgents.find((a) => a.isDefault) ?? allAgents[0];
  const activeAgentValue = agent ?? defaultAgent?.agent ?? null;
  const activeAgent = allAgents.find((a) => a.agent === activeAgentValue);
  const defaultMode = settings?.defaultPermissionMode ?? "ask-shell";
  const supportedModes = activeAgent?.permissionModes ?? (["ask-edits", "ask-shell", "skip-all"] as PermissionMode[]);
  const effectiveMode: PermissionMode = mode ?? (supportedModes.includes(defaultMode) ? defaultMode : supportedModes[supportedModes.length - 1]!);
  const localWs = workspaces?.find((w) => w.workspaceKind === "local") ?? null;
  const localBusy = localWs?.status === "running";

  // Seed the base branch once (not value-guarded, so the user can clear it).
  const seededBaseBranchRef = useRef(false);
  useEffect(() => {
    if (repository && !seededBaseBranchRef.current) {
      seededBaseBranchRef.current = true;
      setBaseBranch(repository.defaultBranch);
    }
  }, [repository]);

  // The agent command for the chosen mode. When the mode is the default,
  // `list_agents` already rendered it; otherwise ask the backend.
  const preview = useQuery({
    queryKey: ["agentCommandPreview", activeAgentValue, mode],
    queryFn: () => tauri.previewAgentCommand(activeAgentValue!, mode!),
    enabled: !!activeAgentValue && mode !== null,
    retry: false,
  });
  const agentCommand = (mode !== null ? preview.data : undefined) ?? activeAgent?.command ?? "";

  const trimmedPrompt = prompt.trim();
  const autoName = nameFromPrompt(prompt);
  const finalName = name.trim() || autoName;
  const trimmedBaseBranch = baseBranch.trim();
  const canSubmit = finalName.length > 0 && !!activeAgent && submitting === null;
  const plan = useMemo(
    () => buildPlanPreview({ name: finalName, baseBranch: trimmedBaseBranch, runIn, agentCommand }),
    [finalName, trimmedBaseBranch, runIn, agentCommand],
  );

  const afterCreate = (ws: Workspace) => {
    queryClient.setQueryData(workspaceKeys.detail(ws.id), ws);
    void queryClient.invalidateQueries({ queryKey: workspaceKeys.byRepository(ws.repositoryId) });
    setName("");
    setPrompt("");
    onCreated?.(ws);
  };

  const submit = async (kind: "start" | "draft") => {
    if (!canSubmit || !activeAgent || inFlightRef.current) return;
    if (kind === "start" && runIn === "in-place" && localBusy && !confirmInPlace) {
      setConfirmInPlace(true);
      return;
    }
    inFlightRef.current = true;
    setSubmitting(kind);
    setError(null);
    try {
      if (kind === "draft") {
        const ws = await tauri.createTaskDraft({
          repositoryId,
          name: finalName,
          agent: activeAgent.agent,
          queue: false,
          ...(trimmedPrompt ? { prompt: trimmedPrompt } : {}),
          ...(mode !== null ? { permissionMode: mode } : {}),
          ...(trimmedBaseBranch && runIn === "worktree" ? { baseBranch: trimmedBaseBranch } : {}),
        });
        void queryClient.invalidateQueries({ queryKey: ["task-cards"] });
        afterCreate(ws);
        return;
      }
      const started = await tauri.startTask({
        repositoryId,
        agent: activeAgent.agent,
        name: finalName,
        ...(trimmedPrompt ? { prompt: trimmedPrompt } : {}),
        ...(trimmedBaseBranch && runIn === "worktree" ? { baseBranch: trimmedBaseBranch } : {}),
        ...(mode !== null ? { permissionMode: mode } : {}),
        ...(!notify ? { notifyOnAttention: false } : {}),
        ...(runIn === "in-place" ? { runIn } : {}),
      });
      afterCreate(started.workspace);
    } catch (err) {
      reportP0Error(kind === "draft" ? "Save task draft failed" : "Start task failed", err, {
        area: "task",
        operation: kind === "draft" ? "create_workspace" : "start_task",
        repositoryId,
        agentId: activeAgent.agent,
      });
      setError(humanizeError(err));
    } finally {
      setSubmitting(null);
      inFlightRef.current = false;
      setConfirmInPlace(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLFormElement>) => {
    if (!matchShortcut(e.nativeEvent as KeyboardEvent, SHORTCUTS.submitForm)) return;
    e.preventDefault();
    void submit("start");
  };

  const detectionFor = (a: Agent) => detection?.find((d) => d.agent === a) ?? null;

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void submit("start");
      }}
      onKeyDown={handleKeyDown}
      className="flex flex-col"
    >
      <div className={cn("flex flex-col gap-4", variant === "dialog" && "p-[18px]")}>
        {/* Prompt first */}
        <div className="flex flex-col gap-1.5">
          <label htmlFor="new-task-prompt" className={LABEL}>
            Prompt
          </label>
          <textarea
            id="new-task-prompt"
            ref={promptDrop.ref}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onFocus={promptDrop.onFocus}
            onBlur={promptDrop.onBlur}
            placeholder="What should the agent do?"
            rows={variant === "inline" ? 3 : 5}
            autoFocus={autoFocus}
            className="resize-none rounded-(--radius-card) border border-(--color-border-default) bg-(--color-bg-base) p-3 text-[13px] leading-[1.55] text-(--color-text-primary) focus:border-(--color-accent-700)"
          />
          <div className="flex items-center gap-2 text-[11px] text-(--color-text-muted)">
            <label htmlFor="new-task-name" className="shrink-0">
              Name
            </label>
            <input
              id="new-task-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={autoName || "e.g. fix login redirect bug"}
              className="h-6 min-w-0 flex-1 rounded-(--radius-chip) border border-transparent bg-transparent px-1.5 py-0 text-[12px] text-(--color-text-primary) shadow-none hover:border-(--color-border-default) focus:border-(--color-focus-ring)"
            />
            {!name.trim() && autoName ? <span>auto from prompt</span> : null}
          </div>
        </div>

        {/* Agent */}
        <div className="flex flex-col gap-1.5">
          <span id="new-task-agent-label" className={LABEL}>
            Agent
          </span>
          <div
            id="new-task-agent"
            role="radiogroup"
            aria-labelledby="new-task-agent-label"
            className="grid grid-cols-5 gap-2"
          >
            {allAgents.map((a) => {
              const det = detectionFor(a.agent);
              const missing = det?.status === "missing";
              const selected = a.agent === activeAgentValue;
              return (
                <button
                  key={a.agent}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  aria-label={a.label}
                  disabled={missing}
                  title={missing ? det?.installHint : undefined}
                  onClick={() => {
                    setAgent(a.agent);
                    setMode(null);
                  }}
                  className={cn(
                    "flex flex-col items-start gap-1.5 rounded-(--radius-card) border p-2.5 text-left transition-colors duration-100",
                    "focus-visible:outline-none focus-visible:shadow-(--ring-focus)",
                    "disabled:cursor-not-allowed disabled:opacity-50",
                    selected
                      ? "border-(--color-accent-500) bg-(--color-accent-950)"
                      : "border-(--color-border-default) bg-(--color-bg-surface) hover:border-(--color-border-strong)",
                  )}
                >
                  <AgentMark agent={a.agent} size="lg" />
                  <span className="text-[12px] font-medium">{a.label}</span>
                  <span className="truncate text-[11px] text-(--color-text-muted)">
                    {missing ? "not installed" : (det?.version ?? "\u00a0")}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Where & how */}
        <div className="grid grid-cols-3 gap-3">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="new-task-base-branch" className={LABEL}>
              Base branch
            </label>
            <BaseBranchField
              id="new-task-base-branch"
              repoPath={repository?.localPath ?? null}
              defaultBranch={repository?.defaultBranch}
              value={baseBranch}
              onChange={setBaseBranch}
              disabled={!repository || submitting !== null || runIn === "in-place"}
              placeholder={repository?.defaultBranch ?? "main"}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <span className={LABEL}>Runs in</span>
            <SegmentedControl<RunIn>
              label="Runs in"
              size="md"
              fill
              value={runIn}
              onChange={setRunIn}
              options={[
                { value: "worktree", label: "Worktree" },
                {
                  value: "in-place",
                  label: "In place",
                  disabled: !localWs,
                  title: localBusy ? "Replaces the shell open in the local workspace" : "Runs in your checkout",
                },
              ]}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <span className={LABEL}>Permissions</span>
            <SegmentedControl<PermissionMode>
              label="Permissions"
              size="md"
              fill
              value={effectiveMode}
              onChange={setMode}
              options={supportedModes.map((m) => ({
                value: m,
                label: PERMISSION_LABEL[m],
                ...(m === "skip-all" ? { tone: "warning" as const } : {}),
              }))}
            />
          </div>
        </div>

        {/* Plan */}
        <ol
          aria-label="What Phasr will run"
          className="m-0 flex list-none flex-col gap-1.5 rounded-(--radius-card) border border-(--color-border-subtle) bg-(--color-bg-sidebar) px-3 py-2.5 font-mono text-[11.5px] leading-[1.6] text-(--color-text-muted)"
        >
          {plan.map((p, i) => (
            <li key={i} className="flex min-w-0 gap-3">
              <span className="text-(--color-text-faint)">{i + 1}</span>
              <span className="min-w-0 break-all text-(--color-text-secondary)">{p.line}</span>
              {p.note ? <span className="shrink-0 text-(--color-text-faint)">· {p.note}</span> : null}
            </li>
          ))}
        </ol>

        {error ? (
          <p role="alert" className="m-0 text-[12px] text-(--color-danger-text)" title={error}>
            {error}
          </p>
        ) : null}
      </div>

      <div
        className={cn(
          "flex items-center gap-2.5",
          variant === "dialog"
            ? "border-t border-(--color-border-subtle) bg-(--color-bg-sidebar) px-[18px] py-3"
            : "pt-4",
        )}
      >
        <label className="flex items-center gap-2 text-[12px] text-(--color-text-secondary)">
          <input
            type="checkbox"
            checked={notify}
            onChange={(e) => setNotify(e.target.checked)}
            className="size-3.5 p-0 accent-(--color-accent-500)"
          />
          Notify me when it needs input
        </label>
        <span className="flex-1" />
        {onCancel ? (
          <Button size="md" type="button" onClick={onCancel}>
            Cancel
          </Button>
        ) : null}
        <Button size="md" type="button" disabled={!canSubmit} onClick={() => void submit("draft")}>
          {submitting === "draft" ? "Saving…" : "Save as draft"}
        </Button>
        <Button
          variant="primary"
          size="md"
          type="submit"
          disabled={!canSubmit}
          shortcut={SHORTCUTS.submitForm.display.join("")}
        >
          {submitting === "start" ? "Starting…" : submitLabel}
        </Button>
      </div>

      <ConfirmDialog
        open={confirmInPlace}
        onOpenChange={setConfirmInPlace}
        title="Replace the local shell?"
        description="The repository's local workspace has a terminal running. Starting this task in place ends that terminal (and anything running in it, like a dev server) and runs the agent there."
        confirmLabel="Replace and start"
        destructive
        onConfirm={() => void submit("start")}
      />
    </form>
  );
}
