import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  GitBranch,
  GitFork,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useAgents } from "@/lib/hooks/useAgents";
import { humanizeError } from "@/lib/humanizeError";
import { useGitBranches } from "@/lib/hooks/useGit";
import { usePromptDropTarget } from "@/lib/hooks/usePromptDropTarget";
import { workspaceKeys } from "@/lib/hooks/useWorkspaces";
import { matchShortcut, SHORTCUTS } from "@/lib/shortcuts";
import { reportP0Error } from "@/lib/sentry";
import { slugify } from "@/lib/slug";
import { useUiStore } from "@/lib/store";
import { tauri } from "@/lib/tauri";
import type { Agent, AgentOption, Repository } from "@/lib/types";
import { GlassButton } from "@/components/ui/GlassButton";
import { GlassInput, GlassTextarea } from "@/components/ui/GlassInput";
import { GlassSelect } from "@/components/ui/GlassSelect";

interface CreateFirstWorkspacePaneProps {
  repo: Repository;
}

/**
 * Two-step center-pane shown on the repo's home when the repo has zero
 * non-archived workspaces. Submits via `tauri.startTask` (same backend
 * path as NewTaskForm). Once a workspace exists, RepoTabContent flips
 * back to the action list for subsequent visits.
 *
 * If the repo isn't a git repository (Cancel was clicked on the
 * GitInitConfirmModal during onboarding), a banner above STEP 1 OF 2
 * offers to re-initialize.
 */
export function CreateFirstWorkspacePane({
  repo,
}: CreateFirstWorkspacePaneProps) {
  const { data: agents } = useAgents();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const requestGitInit = useUiStore((s) => s.requestGitInit);
  const requestDecompose = useUiStore((s) => s.requestDecompose);

  const isGitQuery = useQuery({
    queryKey: ["pathIsGit", repo.localPath ?? ""],
    queryFn: () =>
      repo.localPath
        ? tauri.validateRepositoryPath(repo.localPath)
        : Promise.resolve(null),
    enabled: !!repo.localPath,
    staleTime: 5_000,
  });
  // Optimistic for chrome (banner / branch list) so the "not a git repo"
  // banner doesn't flash while the check is in flight.
  const isGit = isGitQuery.data?.isGitRepo ?? true;
  // Gate the CTAs on a *resolved, confirmed* git repo — never the
  // optimistic default — so the user can't advance before the check
  // actually lands (E3).
  const isGitConfirmed =
    isGitQuery.isSuccess && (isGitQuery.data?.isGitRepo ?? false);

  const branchesQuery = useGitBranches(isGit ? repo.localPath : null);
  const branches = branchesQuery.data ?? [];

  const [step, setStep] = useState<1 | 2>(1);
  const [name, setName] = useState("");
  const [baseBranch, setBaseBranch] = useState(repo.defaultBranch);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [agent, setAgent] = useState<Agent | null>(null);
  const [prompt, setPrompt] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Synchronous re-entrancy guard (D1). `submitting` state lags a tick, so two
  // submits within one JS task both pass the guard and fire start_task TWICE.
  // This ref flips synchronously — belt AND suspenders with the disabled UI.
  const inFlightRef = useRef(false);

  useEffect(() => {
    setBaseBranch(repo.defaultBranch);
  }, [repo.defaultBranch]);

  const allAgents = agents ?? [];
  const defaultAgent = allAgents.find((a) => a.isDefault) ?? allAgents[0];
  const activeAgentValue = agent ?? defaultAgent?.agent ?? null;
  const activeAgent = allAgents.find((a) => a.agent === activeAgentValue);

  const trimmedName = name.trim();
  const previewSlug = useMemo(() => slugify(trimmedName), [trimmedName]);
  const previewBranch =
    previewSlug.length > 0 ? `phasr/${previewSlug}` : "branch-name";

  const handleStart = async () => {
    if (!trimmedName || !activeAgent || !isGitConfirmed) return;
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setSubmitting(true);
    setError(null);
    try {
      const started = await tauri.startTask({
        repositoryId: repo.id,
        agent: activeAgent.agent,
        name: trimmedName,
        ...(prompt.trim() ? { prompt: prompt.trim() } : {}),
        ...(baseBranch.trim() ? { baseBranch: baseBranch.trim() } : {}),
      });
      queryClient.setQueryData(
        workspaceKeys.detail(started.workspace.id),
        started.workspace,
      );
      queryClient.invalidateQueries({
        queryKey: workspaceKeys.byRepository(started.workspace.repositoryId),
      });
      await navigate({
        to: "/repositories/$repositoryId/workspaces/$workspaceId",
        params: { repositoryId: repo.id, workspaceId: started.workspace.id },
      });
    } catch (err) {
      reportP0Error("Start first workspace task failed", err, {
        area: "task",
        operation: "start_first_workspace_task",
        repositoryId: repo.id,
        agentId: activeAgent.agent,
      });
      setError(humanizeError(err));
    } finally {
      setSubmitting(false);
      inFlightRef.current = false;
    }
  };

  // ⌘+Enter advances Step 1 → Step 2 (when the task name is set) and
  // submits on Step 2 (when an agent is picked and the repo is git).
  // Skips when the target gate isn't satisfied so the user can't
  // accidentally fire an incomplete form. Esc on Step 2 steps back (E4).
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && step === 2) {
        e.preventDefault();
        setStep(1);
        return;
      }
      if (!matchShortcut(e, SHORTCUTS.submitForm)) return;
      if (step === 1) {
        if (trimmedName.length > 0 && isGitConfirmed) {
          e.preventDefault();
          setStep(2);
        }
      } else if (activeAgent && !submitting && isGitConfirmed) {
        e.preventDefault();
        void handleStart();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
    // handleStart is reconstructed each render but the effect re-binds
    // cheaply; the alternative (a ref dance) buys nothing here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, trimmedName, isGitConfirmed, activeAgent, submitting]);

  return (
    <div className="flex h-full min-h-0 items-center justify-center overflow-y-auto px-6 py-10">
      <div className="w-full max-w-2xl">
        {!isGit && repo.localPath && (
          <div className="mb-6 flex items-center gap-3 rounded-[10px] border border-(--color-warning)/40 bg-(--color-warning)/10 px-3 py-2 text-[12.5px] text-(--color-text-secondary)">
            <AlertTriangle
              size={14}
              className="shrink-0 text-(--color-warning)"
            />
            <span className="flex-1">
              This repo isn't a git repository — workspaces require git.
            </span>
            <GlassButton
              variant="outline"
              size="sm"
              onClick={() => requestGitInit(repo.id)}
            >
              Initialize git
            </GlassButton>
          </div>
        )}

        <div className="mb-2 text-[11px] font-medium uppercase tracking-[0.16em] text-(--color-text-muted)">
          Step {step} of 2
        </div>

        {step === 1 ? (
          <Step1
            name={name}
            setName={setName}
            previewBranch={previewBranch}
            baseBranch={baseBranch}
            setBaseBranch={setBaseBranch}
            branches={branches}
            advancedOpen={advancedOpen}
            setAdvancedOpen={setAdvancedOpen}
            canContinue={trimmedName.length > 0 && isGitConfirmed}
            onContinue={() => setStep(2)}
          />
        ) : (
          <Step2
            agents={allAgents}
            activeAgentValue={activeAgentValue}
            setAgent={setAgent}
            activeCommand={activeAgent?.command}
            prompt={prompt}
            setPrompt={setPrompt}
            canStart={!!activeAgent && !submitting && isGitConfirmed}
            submitting={submitting}
            error={error}
            onBack={() => setStep(1)}
            onStart={handleStart}
          />
        )}

        {/*
          Progressive disclosure: a clearly-SEPARATE second path for a bigger
          job, kept out of the single-agent flow above. Shown only on step 1 so
          it never interrupts the agent/prompt step. Opens the shell-mounted
          DecomposeModal (the "Start 2 agents" gate) via `requestDecompose`.
        */}
        {step === 1 && (
          <div className="mt-8 flex items-center justify-between gap-4 border-t border-(--glass-border-hairline) pt-5">
            <div className="min-w-0">
              <p className="text-[13px] font-medium text-(--color-text-primary)">
                Working on something bigger?
              </p>
              <p className="mt-0.5 text-[12px] text-(--color-text-secondary)">
                Split a goal across two agents — a backend and a frontend that
                hand off through a contract.
              </p>
            </div>
            <GlassButton
              variant="outline"
              size="md"
              type="button"
              onClick={() => requestDecompose(repo.id)}
              aria-label={`New epic in ${repo.name}`}
              className="shrink-0"
            >
              <GitFork size={13} />
              New epic
            </GlassButton>
          </div>
        )}
      </div>
    </div>
  );
}

function Step1({
  name,
  setName,
  previewBranch,
  baseBranch,
  setBaseBranch,
  branches,
  advancedOpen,
  setAdvancedOpen,
  canContinue,
  onContinue,
}: {
  name: string;
  setName: (v: string) => void;
  previewBranch: string;
  baseBranch: string;
  setBaseBranch: (v: string) => void;
  branches: string[];
  advancedOpen: boolean;
  setAdvancedOpen: (v: boolean) => void;
  canContinue: boolean;
  onContinue: () => void;
}) {
  return (
    <form
      className="space-y-5"
      onSubmit={(e) => {
        e.preventDefault();
        if (canContinue) onContinue();
      }}
    >
      <header>
        <h1 className="text-[24px] font-semibold leading-tight tracking-tight text-(--color-text-primary)">
          Create your first workspace
        </h1>
        <p className="mt-2 text-[13px] text-(--color-text-secondary)">
          Workspaces are isolated task environments backed by git worktrees.
        </p>
      </header>

      <div className="space-y-2">
        <label
          htmlFor="first-task-name"
          className="block text-[12px] font-medium text-(--color-text-primary)"
        >
          Task
        </label>
        <GlassInput
          id="first-task-name"
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Add dark mode, Fix checkout bug"
          className="h-11"
        />

        <div className="flex items-center gap-2 rounded-[10px] border border-(--glass-border-hairline) bg-(--color-bg-input) px-3 py-2.5 font-mono text-[12.5px]">
          <GitBranch size={13} className="shrink-0 text-(--color-text-muted)" />
          <span className="text-(--color-text-primary)">{previewBranch}</span>
          <span className="text-(--color-text-muted)">from</span>
          <span className="text-(--color-text-primary)">{baseBranch}</span>
        </div>
      </div>

      <div>
        <button
          type="button"
          onClick={() => setAdvancedOpen(!advancedOpen)}
          className="flex items-center gap-1 text-[12.5px] text-(--color-text-secondary) transition-colors hover:text-(--color-text-primary)"
        >
          {advancedOpen ? (
            <ChevronDown size={13} />
          ) : (
            <ChevronRight size={13} />
          )}
          Advanced options
        </button>
        {advancedOpen && (
          <div className="mt-3 space-y-2">
            <label
              htmlFor="first-task-base-branch"
              className="block text-[12px] font-medium text-(--color-text-primary)"
            >
              Base branch
            </label>
            {branches.length > 0 ? (
              <GlassSelect
                id="first-task-base-branch"
                value={branches.includes(baseBranch) ? baseBranch : branches[0]}
                onChange={(e) => setBaseBranch(e.target.value)}
                options={branches.map((b) => ({ label: b, value: b }))}
                className="h-10 font-mono text-[12.5px]"
              />
            ) : (
              // Fall back to a free-text field if the branch list isn't
              // available (e.g. newly-init'd repo before the initial
              // commit lands or a path that isn't a git repo yet).
              <GlassInput
                id="first-task-base-branch"
                value={baseBranch}
                onChange={(e) => setBaseBranch(e.target.value)}
                placeholder="main"
                className="h-10 font-mono"
              />
            )}
          </div>
        )}
      </div>

      <div className="flex justify-end">
        <GlassButton
          variant="primary"
          size="md"
          type="submit"
          disabled={!canContinue}
        >
          Continue →
        </GlassButton>
      </div>
    </form>
  );
}

function Step2({
  agents,
  activeAgentValue,
  setAgent,
  activeCommand,
  prompt,
  setPrompt,
  canStart,
  submitting,
  error,
  onBack,
  onStart,
}: {
  agents: AgentOption[];
  activeAgentValue: Agent | null;
  setAgent: (agent: Agent) => void;
  activeCommand: string | undefined;
  prompt: string;
  setPrompt: (v: string) => void;
  canStart: boolean;
  submitting: boolean;
  error: string | null;
  onBack: () => void;
  onStart: () => void;
}) {
  const promptDrop = usePromptDropTarget(prompt, setPrompt);
  return (
    <form
      className="space-y-5"
      onSubmit={(e) => {
        e.preventDefault();
        if (canStart) onStart();
      }}
    >
      <header>
        <h1 className="text-[24px] font-semibold leading-tight tracking-tight text-(--color-text-primary)">
          Pick an agent and prompt
        </h1>
        <p className="mt-2 text-[13px] text-(--color-text-secondary)">
          The task runs in an isolated worktree.
        </p>
      </header>

      <div className="space-y-2">
        <label
          htmlFor="first-task-agent"
          className="block text-[12px] font-medium text-(--color-text-primary)"
        >
          Agent
        </label>
        <GlassSelect
          id="first-task-agent"
          autoFocus
          value={activeAgentValue ?? ""}
          onChange={(e) => setAgent(e.target.value as Agent)}
          options={agents.map((a) => ({ label: a.label, value: a.agent }))}
          className="h-10"
        />
        {activeCommand && (
          <code className="block truncate text-[11.5px] text-(--color-text-muted)">
            {activeCommand}
          </code>
        )}
      </div>

      <div className="space-y-2">
        <label
          htmlFor="first-task-prompt"
          className="block text-[12px] font-medium text-(--color-text-primary)"
        >
          Prompt
        </label>
        <GlassTextarea
          ref={promptDrop.ref}
          id="first-task-prompt"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onFocus={promptDrop.onFocus}
          onBlur={promptDrop.onBlur}
          placeholder={
            "e.g. Add a dark mode toggle to the settings page and " +
            "persist the choice in user preferences."
          }
          rows={6}
        />
      </div>

      <div className="flex items-center justify-between gap-2">
        {error ? (
          <span className="truncate text-[12px] text-(--color-danger)">
            {error}
          </span>
        ) : (
          <span />
        )}
        <div className="flex items-center gap-2">
          <GlassButton
            variant="outline"
            size="md"
            type="button"
            onClick={onBack}
          >
            ← Back
          </GlassButton>
          <GlassButton
            variant="primary"
            size="md"
            type="submit"
            disabled={!canStart}
          >
            {submitting ? "Starting…" : "Start task"}
          </GlassButton>
        </div>
      </div>
    </form>
  );
}
