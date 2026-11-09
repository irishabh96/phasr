import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell, BellOff, Check, ChevronDown, ChevronRight, GitBranch } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { AgentMark } from "@/components/ui/AgentMark";
import { BaseBranchField } from "@/components/ui/BaseBranchField";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/Dialog";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Menu, MenuContent, MenuTrigger } from "@/components/ui/Menu";
import { useAgentDetection, useAgents } from "@/lib/hooks/useAgents";
import { usePromptDropTarget } from "@/lib/hooks/usePromptDropTarget";
import { useRepository } from "@/lib/hooks/useRepositories";
import { useRepositoryConfig } from "@/lib/hooks/useRepositoryConfig";
import { useUserSettings } from "@/lib/hooks/useUserSettings";
import { useWorkspaces, workspaceKeys } from "@/lib/hooks/useWorkspaces";
import { useCreateTaskDraft } from "@/lib/hooks/useTaskCards";
import { humanizeError } from "@/lib/humanizeError";
import { buildPlanPreview, nameFromPrompt, PERMISSION_HINT, PERMISSION_LABEL } from "@/lib/planPreview";
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

/**
 * New task (A-NewTask). Prompt first — the name derives from it unless you
 * type one — then one compact row each for the agent and for where it runs
 * and how much it may do without asking. "Show commands" reveals exactly
 * what Phasr will run.
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
  const createDraft = useCreateTaskDraft();

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
  const [showPlan, setShowPlan] = useState(false);

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

  // Seed the base branch once (not value-guarded, so the user can clear it):
  // the repository's "Default base branch" rule when set, else its default
  // branch. Waits for the rule to load (or fail) so it isn't overwritten.
  const repoConfig = useRepositoryConfig(repositoryId);
  const seededBaseBranchRef = useRef(false);
  useEffect(() => {
    if (!repository || seededBaseBranchRef.current || repoConfig.isPending) return;
    seededBaseBranchRef.current = true;
    setBaseBranch(repoConfig.data?.defaultBaseBranch?.trim() || repository.defaultBranch);
  }, [repository, repoConfig.isPending, repoConfig.data]);

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
        const ws = await createDraft.mutateAsync({
          repositoryId,
          name: finalName,
          agent: activeAgent.agent,
          queue: false,
          ...(trimmedPrompt ? { prompt: trimmedPrompt } : {}),
          ...(mode !== null ? { permissionMode: mode } : {}),
          ...(trimmedBaseBranch && runIn === "worktree" ? { baseBranch: trimmedBaseBranch } : {}),
        });
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
  const missingCount = allAgents.filter((a) => detectionFor(a.agent)?.status === "missing").length;

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void submit("start");
      }}
      onKeyDown={handleKeyDown}
      className="flex flex-col"
    >
      <div className={cn("flex flex-col gap-3", variant === "dialog" && "p-[18px] pb-4")}>
        {/* Prompt first; everything else is one compact row of choices. */}
        <div className="flex flex-col gap-1">
          <label htmlFor="new-task-prompt" className="sr-only">
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
            rows={variant === "inline" ? 3 : 4}
            autoFocus={autoFocus}
            className="resize-none rounded-(--radius-card) border border-(--color-border-default) bg-(--color-bg-base) p-3 text-[13px] leading-[1.55] text-(--color-text-primary) focus:border-(--color-accent-700)"
          />
          <div className="flex items-center gap-1 text-[11px] text-(--color-text-muted)">
            <label htmlFor="new-task-name" className="shrink-0 pl-1">
              Name
            </label>
            <input
              id="new-task-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={autoName || "named from the prompt"}
              className="h-6 min-w-0 flex-1 rounded-(--radius-chip) border border-transparent bg-transparent px-1.5 py-0 text-[12px] text-(--color-text-primary) shadow-none hover:border-(--color-border-default) focus:border-(--color-focus-ring)"
            />
          </div>
        </div>

        {/* Agent: compact chips; versions live in the tooltip, and agents
            that aren't installed stay out of the way. */}
        <div
          id="new-task-agent"
          role="radiogroup"
          aria-label="Agent"
          className="flex flex-wrap items-center gap-1.5"
        >
          {allAgents.map((a) => {
            const det = detectionFor(a.agent);
            if (det?.status === "missing") return null;
            const selected = a.agent === activeAgentValue;
            const version = det?.version ? ` ${det.version}` : "";
            return (
              <button
                key={a.agent}
                type="button"
                role="radio"
                aria-checked={selected}
                aria-label={a.label}
                title={`${a.label}${version}`}
                onClick={() => {
                  setAgent(a.agent);
                  setMode(null);
                }}
                className={cn(
                  "flex h-7 items-center gap-1.5 rounded-(--radius-control) border px-2 text-[12px] transition-colors duration-100",
                  "focus-visible:outline-none focus-visible:shadow-(--ring-focus)",
                  selected
                    ? "border-(--color-accent-500) bg-(--color-accent-950) text-(--color-text-primary)"
                    : "border-(--color-border-default) text-(--color-text-secondary) hover:border-(--color-border-strong) hover:text-(--color-text-primary)",
                )}
              >
                <AgentMark agent={a.agent} />
                {a.label}
              </button>
            );
          })}
          {missingCount > 0 ? (
            <span
              className="pl-1 text-[11px] text-(--color-text-faint)"
              title={allAgents
                .filter((a) => detectionFor(a.agent)?.status === "missing")
                .map((a) => `${a.label}: ${detectionFor(a.agent)?.installHint ?? "not installed"}`)
                .join("\n")}
            >
              +{missingCount} not installed
            </span>
          ) : null}
        </div>

        {/* Where and how, on one line. */}
        <div className="flex flex-wrap items-center gap-1.5">
          <label htmlFor="new-task-base-branch" className="sr-only">
            Base branch
          </label>
          <div className="relative w-[210px]">
            <GitBranch
              size={13}
              aria-hidden
              className="pointer-events-none absolute left-2 top-1/2 z-10 -translate-y-1/2 text-(--color-text-muted)"
            />
            <BaseBranchField
              id="new-task-base-branch"
              repoPath={repository?.localPath ?? null}
              defaultBranch={repository?.defaultBranch}
              value={baseBranch}
              onChange={setBaseBranch}
              disabled={!repository || submitting !== null || runIn === "in-place"}
              placeholder={repository?.defaultBranch ?? "main"}
              className="h-7 pl-7 text-[12px]"
            />
          </div>
          <ChoiceMenu<RunIn>
            label="Runs in"
            value={runIn}
            onChange={setRunIn}
            options={[
              { value: "worktree", label: "Worktree", hint: "A fresh branch and folder; your checkout is untouched." },
              {
                value: "in-place",
                label: "In place",
                hint: localBusy
                  ? "In your checkout. Replaces the shell open in the local workspace."
                  : "In your checkout, on its current branch.",
                disabled: !localWs,
              },
            ]}
          />
          <ChoiceMenu<PermissionMode>
            label="Permissions"
            value={effectiveMode}
            onChange={setMode}
            warn={effectiveMode === "skip-all"}
            options={supportedModes.map((m) => ({
              value: m,
              label: PERMISSION_LABEL[m],
              hint: PERMISSION_HINT[m],
            }))}
          />
          <span className="flex-1" />
          <button
            type="button"
            aria-pressed={notify}
            aria-label="Notify me when it needs input"
            title={notify ? "Notifies you when it needs input" : "Won't notify you when it needs input"}
            onClick={() => setNotify((n) => !n)}
            className={cn(
              "grid size-7 place-items-center rounded-(--radius-control) transition-colors duration-100",
              "focus-visible:outline-none focus-visible:shadow-(--ring-focus) hover:bg-(--color-bg-hover)",
              notify ? "text-(--color-text-secondary)" : "text-(--color-text-faint)",
            )}
          >
            {notify ? <Bell size={14} aria-hidden /> : <BellOff size={14} aria-hidden />}
          </button>
        </div>

        {showPlan ? (
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
        ) : null}

        {error ? (
          <p role="alert" className="m-0 text-[12px] text-(--color-danger-text)" title={error}>
            {error}
          </p>
        ) : null}
      </div>

      <div
        className={cn(
          "flex items-center gap-2",
          variant === "dialog"
            ? "border-t border-(--color-border-subtle) bg-(--color-bg-sidebar) px-[18px] py-2.5"
            : "pt-3",
        )}
      >
        <button
          type="button"
          aria-expanded={showPlan}
          onClick={() => setShowPlan((v) => !v)}
          className="flex items-center gap-1 rounded-(--radius-chip) px-1 text-[12px] text-(--color-text-muted) hover:text-(--color-text-primary) focus-visible:outline-none focus-visible:shadow-(--ring-focus)"
        >
          <ChevronRight size={13} aria-hidden className={cn("transition-transform", showPlan && "rotate-90")} />
          {showPlan ? "Hide commands" : "Show commands"}
        </button>
        <span className="flex-1" />
        {onCancel && variant === "inline" ? (
          <Button size="md" variant="ghost" type="button" onClick={onCancel}>
            Cancel
          </Button>
        ) : null}
        <Button size="md" variant="ghost" type="button" disabled={!canSubmit} onClick={() => void submit("draft")}>
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

interface Choice<T extends string> {
  value: T;
  label: string;
  hint: string;
  disabled?: boolean;
}

/**
 * A compact dropdown for one choice ("Worktree ▾", "Ask for shell ▾"): the
 * trigger shows the current value, the menu explains each option. Items are
 * radios so screen readers hear the group and the checked one.
 */
function ChoiceMenu<T extends string>({
  label,
  value,
  onChange,
  options,
  warn = false,
}: {
  label: string;
  value: T;
  onChange: (value: T) => void;
  options: Choice<T>[];
  warn?: boolean;
}) {
  const current = options.find((o) => o.value === value);
  return (
    <Menu>
      <MenuTrigger asChild>
        <button
          type="button"
          aria-label={`${label}: ${current?.label ?? value}`}
          className={cn(
            "flex h-7 items-center gap-1 rounded-(--radius-control) border border-(--color-border-default) px-2 text-[12px] transition-colors duration-100",
            "hover:border-(--color-border-strong) focus-visible:outline-none focus-visible:shadow-(--ring-focus) data-[state=open]:border-(--color-border-strong)",
            warn ? "text-(--color-warning)" : "text-(--color-text-secondary)",
          )}
        >
          {current?.label ?? value}
          <ChevronDown size={12} aria-hidden className="text-(--color-text-muted)" />
        </button>
      </MenuTrigger>
      <MenuContent align="start" width={280} className="z-(--z-popover)">
        <DropdownMenu.RadioGroup value={value} onValueChange={(v) => onChange(v as T)} aria-label={label}>
          {options.map((o) => (
            <DropdownMenu.RadioItem
              key={o.value}
              value={o.value}
              disabled={o.disabled ?? false}
              className="flex cursor-pointer select-none items-start gap-2 rounded-(--radius-control) px-2 py-1.5 outline-none data-[highlighted]:bg-(--color-bg-hover) data-[disabled]:pointer-events-none data-[disabled]:opacity-40"
            >
              <span className="grid size-4 shrink-0 place-items-center pt-0.5 text-(--color-accent-text)">
                <DropdownMenu.ItemIndicator>
                  <Check size={13} aria-hidden />
                </DropdownMenu.ItemIndicator>
              </span>
              <span className="flex min-w-0 flex-col">
                <span className="text-[12px] text-(--color-text-primary)">{o.label}</span>
                <span className="text-[11px] leading-[1.4] text-(--color-text-muted)">{o.hint}</span>
              </span>
            </DropdownMenu.RadioItem>
          ))}
        </DropdownMenu.RadioGroup>
      </MenuContent>
    </Menu>
  );
}
