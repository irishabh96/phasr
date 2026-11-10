import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import * as Popover from "@radix-ui/react-popover";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ChevronDown, Folder, GitBranch, Play, ShieldCheck } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AttachChip, AttachmentChips } from "@/components/attachments/Attachments";
import { AGENT_META, AgentMark } from "@/components/ui/AgentMark";
import { BaseBranchField } from "@/components/ui/BaseBranchField";
import { Button } from "@/components/ui/Button";
import { PropertyChip } from "@/components/ui/Chip";
import { ConfirmDialog } from "@/components/ui/Dialog";
import { GlassTooltip } from "@/components/ui/GlassTooltip";
import { Kbd } from "@/components/ui/Kbd";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/Menu";
import { nameFromAttachments, withAttachmentBlock } from "@/lib/attachments";
import { useAgentDetection, useAgents } from "@/lib/hooks/useAgents";
import { useAttachments } from "@/lib/hooks/useAttachments";
import { usePromptDropTarget } from "@/lib/hooks/usePromptDropTarget";
import { useRepository } from "@/lib/hooks/useRepositories";
import { useRepositoryConfig } from "@/lib/hooks/useRepositoryConfig";
import { useRunCommands } from "@/lib/hooks/useRunCommands";
import { useUserSettings } from "@/lib/hooks/useUserSettings";
import { useWorkspaces, workspaceKeys } from "@/lib/hooks/useWorkspaces";
import { useCreateTaskDraft } from "@/lib/hooks/useTaskCards";
import { humanizeError } from "@/lib/humanizeError";
import {
  buildPlanPreview,
  nameFromPrompt,
  PERMISSION_HINT,
  PERMISSION_LABEL,
  RUN_IN_HINT,
  RUN_IN_LABEL,
  taskBranch,
} from "@/lib/planPreview";
import { reportP0Error } from "@/lib/sentry";
import { matchShortcut, SHORTCUTS } from "@/lib/shortcuts";
import { tauri } from "@/lib/tauri";
import type { Agent, AgentDetection, PermissionMode, RunIn, Workspace } from "@/lib/types";
import { cn } from "@/lib/utils";

interface NewTaskFormProps {
  repositoryId: string;
  onCreated?: (task: Workspace) => void;
  onCancel?: () => void;
  /** Defaults to "Start task". */
  submitLabel?: string;
  autoFocus?: boolean;
  /** "dialog" pads itself to the modal's edges; "inline" is the first-task card. */
  variant?: "dialog" | "inline";
}

/** RadioGroup value for "no run command" (values must be strings). */
const NO_RUN = "__none__";

/**
 * New task (A-NewTask): a title, a prompt and one row of property chips.
 * The prompt comes first (focus and tab order); the title above it shows
 * the name derived from the prompt until you type your own. Each chip
 * opens a popover: agent, base branch, where it runs, permissions (with
 * the notify switch), and a run command to start alongside (D5). The
 * footer names the branch it will create; "Show commands" lists exactly
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
  const { data: runCommands } = useRunCommands(repositoryId);
  // Synced commands not yet allowed on this Mac. Unknown (loading or a
  // failed lookup) reads as untrusted; the backend refuses them anyway.
  const untrusted = useQuery({
    queryKey: ["runCommands", "untrusted", repositoryId],
    queryFn: () => tauri.listUntrustedRunCommands(repositoryId),
    retry: false,
  });
  const queryClient = useQueryClient();
  const createDraft = useCreateTaskDraft();

  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const promptDrop = usePromptDropTarget(prompt, setPrompt);
  // Files to hand the agent (Attach chip, pasted screenshots, drops). The
  // dialog is modal, so any drop while it's open is an attachment.
  const formRef = useRef<HTMLFormElement>(null);
  const attachments = useAttachments({ dropRef: formRef, modal: variant === "dialog" });
  const [agent, setAgent] = useState<Agent | null>(null);
  const [baseBranch, setBaseBranch] = useState("");
  const [runIn, setRunIn] = useState<RunIn>("worktree");
  /** null = the user's default mode (not sent; the backend applies it). */
  const [mode, setMode] = useState<PermissionMode | null>(null);
  const [notify, setNotify] = useState(true);
  const [runCommandId, setRunCommandId] = useState<string | null>(null);
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

  const untrustedIds = useMemo(
    () => (untrusted.isSuccess ? new Set(untrusted.data ?? []) : null),
    [untrusted.isSuccess, untrusted.data],
  );
  const isTrusted = (id: string) => untrustedIds !== null && !untrustedIds.has(id);
  const runCommand = runCommands?.find((rc) => rc.id === runCommandId) ?? null;
  // A pick that later turns out untrusted (or was deleted) is dropped, not run.
  const pickedRun = runCommand && isTrusted(runCommand.id) ? runCommand : null;

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

  // The prompt as sent and saved: attachments ride along as a path list.
  const trimmedPrompt = withAttachmentBlock(prompt.trim(), attachments.items, [repository?.localPath]);
  const autoName = nameFromPrompt(prompt) || nameFromAttachments(attachments.items);
  const finalName = name.trim() || autoName;
  const trimmedBaseBranch = baseBranch.trim();
  const canSubmit = finalName.length > 0 && !!activeAgent && submitting === null;
  const plan = useMemo(
    () =>
      buildPlanPreview({
        name: finalName,
        baseBranch: trimmedBaseBranch,
        runIn,
        agentCommand,
        runCommand: pickedRun?.command ?? null,
      }),
    [finalName, trimmedBaseBranch, runIn, agentCommand, pickedRun?.command],
  );

  const afterCreate = (ws: Workspace) => {
    queryClient.setQueryData(workspaceKeys.detail(ws.id), ws);
    void queryClient.invalidateQueries({ queryKey: workspaceKeys.byRepository(ws.repositoryId) });
    setName("");
    setPrompt("");
    attachments.clear();
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
        // Started by the backend once the agent is up: `start_task` returns
        // before the worktree exists. A failure there is an inbox entry
        // (+ toast), never a failed start.
        ...(pickedRun ? { runCommandId: pickedRun.id } : {}),
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
    const native = e.nativeEvent as KeyboardEvent;
    if (matchShortcut(native, SHORTCUTS.saveDraft)) {
      e.preventDefault();
      void submit("draft");
    } else if (matchShortcut(native, SHORTCUTS.submitForm)) {
      e.preventDefault();
      void submit("start");
    }
  };

  const detectionFor = (a: Agent) => detection?.find((d) => d.agent === a) ?? null;
  const pad = variant === "dialog" ? "px-[18px]" : "";

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void submit("start");
      }}
      onKeyDown={handleKeyDown}
      ref={formRef}
      className="flex flex-col"
    >
      {/* Title over prompt, no boxes. The prompt is first in the DOM (focus
          and tab order: prompt, then name); `order-first` lifts the title
          above it visually. */}
      <div className={cn("flex flex-col gap-[6px]", pad, variant === "dialog" && "pt-[12px]")}>
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
          onPaste={attachments.onPaste}
          placeholder="What should the agent do?"
          rows={variant === "inline" ? 3 : 5}
          autoFocus={autoFocus}
          className="w-full resize-none rounded-none bg-transparent p-0 text-[13.5px] leading-[1.6] text-(--color-text-secondary) shadow-none placeholder:text-(--color-text-muted) focus:shadow-none"
        />
        <AttachmentChips items={attachments.items} onRemove={attachments.remove} className="pt-[4px]" />
        <div className="order-first">
          <label htmlFor="new-task-name" className="sr-only">
            Task name
          </label>
          <input
            id="new-task-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={autoName || "Task name"}
            autoComplete="off"
            spellCheck={false}
            className="w-full rounded-none bg-transparent p-0 text-[17px] font-medium leading-[1.45] tracking-[-0.01em] text-(--color-text-primary) shadow-none placeholder:text-(--color-text-muted) focus:shadow-none"
          />
        </div>
      </div>

      {/* One row of property chips. */}
      <div className={cn("flex flex-wrap items-center gap-[6px] pb-[16px] pt-[14px]", pad)}>
        <AgentChip
          agents={allAgents}
          value={activeAgentValue}
          detectionFor={detectionFor}
          onChange={(a) => {
            setAgent(a);
            setMode(null);
          }}
        />
        <BaseBranchChip
          repoPath={repository?.localPath ?? null}
          defaultBranch={repository?.defaultBranch}
          value={baseBranch}
          onChange={setBaseBranch}
          inPlace={runIn === "in-place"}
          disabled={!repository || submitting !== null}
        />
        <ChipMenu<RunIn>
          label="Runs in"
          icon={<Folder />}
          value={runIn}
          onChange={setRunIn}
          options={[
            { value: "worktree", label: RUN_IN_LABEL.worktree, hint: RUN_IN_HINT.worktree },
            {
              value: "in-place",
              label: RUN_IN_LABEL["in-place"],
              hint: localBusy
                ? "In your checkout. Replaces the shell open in the local workspace."
                : RUN_IN_HINT["in-place"],
              disabled: !localWs,
            },
          ]}
        />
        <ChipMenu<PermissionMode>
          label="Permissions"
          icon={<ShieldCheck />}
          value={effectiveMode}
          onChange={setMode}
          warn={effectiveMode === "skip-all"}
          width={300}
          options={supportedModes.map((m) => ({
            value: m,
            label: PERMISSION_LABEL[m],
            hint: PERMISSION_HINT[m],
            warn: m === "skip-all",
          }))}
          footer={
            <>
            <DropdownMenu.Separator className="mx-[4px] my-[4px] h-px bg-(--color-border-default)" />
            <DropdownMenu.CheckboxItem
              checked={notify}
              onCheckedChange={setNotify}
              // Keep the popover open: it's a setting, not a pick.
              onSelect={(e) => e.preventDefault()}
              className={cn(ROW, "h-[32px] gap-[10px]")}
            >
              <span className="min-w-0 flex-1 truncate text-(--color-text-primary)">Notify me when it needs you</span>
              <SwitchMark checked={notify} />
            </DropdownMenu.CheckboxItem>
            </>
          }
        />
        {runCommands && runCommands.length > 0 ? (
          <ChipMenu<string>
            label="Run command"
            icon={
              <Play
                className={pickedRun ? "fill-(--color-success) text-(--color-success)" : "fill-current"}
              />
            }
            value={pickedRun?.id ?? NO_RUN}
            valueLabel={pickedRun ? pickedRun.name : "None"}
            chipText={pickedRun ? pickedRun.name : "Run"}
            onChange={(v) => setRunCommandId(v === NO_RUN ? null : v)}
            width={280}
            options={[
              { value: NO_RUN, label: "None", hint: "Start only the agent." },
              ...runCommands.map((rc) => {
                const trusted = isTrusted(rc.id);
                return {
                  value: rc.id,
                  label: rc.name,
                  hint: trusted ? rc.command : "Allow on this Mac first",
                  mono: trusted,
                  disabled: !trusted,
                };
              }),
            ]}
          />
        ) : null}
        <AttachChip disabled={submitting !== null} onClick={() => void attachments.pick()} />
      </div>

      {showPlan ? (
        <div className={cn("pb-[12px]", pad)}>
          <ol
            aria-label="What Phasr will run"
            className="m-0 flex list-none flex-col gap-[6px] rounded-(--radius-card) bg-(--color-bg-input) px-[12px] py-[10px] font-mono text-[11.5px] leading-[1.6] text-(--color-text-muted)"
          >
            {plan.map((p, i) => (
              <li key={i} className="flex min-w-0 gap-[12px]">
                <span className="text-(--color-text-faint)">{i + 1}</span>
                <span className="min-w-0 break-all text-(--color-text-secondary)">{p.line}</span>
                {p.note ? <span className="shrink-0 font-sans text-(--color-text-muted)">· {p.note}</span> : null}
              </li>
            ))}
          </ol>
        </div>
      ) : null}

      {error ? (
        <p role="alert" className={cn("m-0 pb-[8px] text-[12px] text-(--color-danger-text)", pad)} title={error}>
          {error}
        </p>
      ) : null}

      {/* Footer: no divider; spacing does the work. */}
      <div className={cn("flex items-center gap-[8px]", variant === "dialog" ? "px-[18px] pb-[16px] pt-[8px]" : "pt-[8px]")}>
        {finalName ? (
          runIn === "worktree" ? (
            <span className="min-w-0 truncate font-mono text-[12px] text-(--color-text-muted)" title="The branch this task creates">
              {taskBranch(finalName)}
            </span>
          ) : (
            <span className="min-w-0 truncate text-[12px] text-(--color-text-muted)">Current branch</span>
          )
        ) : null}
        <button
          type="button"
          aria-expanded={showPlan}
          onClick={() => setShowPlan((v) => !v)}
          className="shrink-0 rounded-(--radius-chip) text-[12px] text-(--color-text-muted) transition-colors duration-(--dur-1) hover:text-(--color-text-primary) focus-visible:outline-none focus-visible:shadow-(--ring-focus)"
        >
          {showPlan ? "Hide commands" : "Show commands"}
        </button>
        <span className="flex-1" />
        {onCancel ? (
          <Button variant="ghost" type="button" className="h-[30px] px-[12px]" onClick={onCancel}>
            Cancel
          </Button>
        ) : null}
        {/* Start task, with "Save as draft" (⌘⇧↵) behind its caret. */}
        <div className="flex items-center">
          <Button
            variant="primary"
            type="submit"
            disabled={!canSubmit}
            className="h-[30px] gap-[8px] rounded-r-none px-[12px]"
          >
            {submitting === "start" ? "Starting…" : submitting === "draft" ? "Saving…" : submitLabel}
            <Kbd decorative tone="onfill" className="text-[11px] font-normal">
              {SHORTCUTS.submitForm.display.join("")}
            </Kbd>
          </Button>
          <Menu>
            <MenuTrigger asChild>
              <Button
                variant="primary"
                type="button"
                aria-label="More start options"
                disabled={!canSubmit}
                className="h-[30px] w-[22px] rounded-l-none px-0 shadow-[inset_1px_0_0_rgba(0,0,0,0.18)]"
              >
                <ChevronDown aria-hidden className="size-[12px]" strokeWidth={2.25} />
              </Button>
            </MenuTrigger>
            <MenuContent align="end" width={220} className="z-(--z-popover)">
              <MenuItem
                onSelect={() => void submit("draft")}
                trailing={<Kbd tone="bare">{SHORTCUTS.saveDraft.display.join("")}</Kbd>}
              >
                Save as draft
              </MenuItem>
            </MenuContent>
          </Menu>
        </div>
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

// Sizes are px, not rem: the root font is 13px, so rem utilities would
// shrink every A-NewTask measurement by 13/16.

/** A popover row (A-NewTask agent picker): 32px, radius 6, raised on hover. */
const ROW =
  "flex cursor-pointer select-none items-center rounded-(--radius-control) px-[10px] outline-none data-[highlighted]:bg-(--color-bg-hover) data-[disabled]:cursor-default";

/** The popover surface every chip opens (A-NewTask: 10px radius, 6px pad). */
const POPOVER = "z-(--z-popover) rounded-[10px] p-[6px] text-[12.5px]";

/**
 * A-NewTask chip metrics on top of PropertyChip: 0 8px padding, 6px gap,
 * 12px icons and an 11px caret (the caret is the chip's only direct svg).
 */
const CHIP = "gap-[6px] px-[8px] [&_span_svg]:size-[12px]! [&>svg]:size-[11px]!";

/** Agent monogram at the design's 14px with an 8px letter. */
const MONOGRAM = "size-[14px] text-[8px]";

function SwitchMark({ checked }: { checked: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "relative inline-flex h-[16px] w-[28px] shrink-0 rounded-full transition-colors duration-(--dur-1)",
        checked ? "bg-(--color-accent-500)" : "bg-(--color-border-strong)",
      )}
    >
      <span
        className={cn(
          "absolute left-[2px] top-[2px] size-[12px] rounded-full transition-transform duration-(--dur-1)",
          checked ? "translate-x-[12px] bg-(--color-accent-onfill)" : "bg-(--color-text-secondary)",
        )}
      />
    </span>
  );
}

/**
 * `[C Claude ▾]`: every agent with its version and a check on the chosen
 * one; agents that aren't installed sit muted below with "Install…", which
 * reveals the install hint. The picker stays a radiogroup (`#new-task-agent`).
 */
function AgentChip({
  agents,
  value,
  detectionFor,
  onChange,
}: {
  agents: { agent: Agent; label: string }[];
  value: Agent | null;
  detectionFor: (a: Agent) => AgentDetection | null;
  onChange: (a: Agent) => void;
}) {
  const [hintFor, setHintFor] = useState<Agent | null>(null);
  const installed = agents.filter((a) => detectionFor(a.agent)?.status !== "missing");
  const missing = agents.filter((a) => detectionFor(a.agent)?.status === "missing");
  const current = agents.find((a) => a.agent === value);
  return (
    <Menu onOpenChange={(o) => !o && setHintFor(null)}>
      <MenuTrigger asChild>
        <PropertyChip
          aria-label={`Agent: ${current?.label ?? "none"}`}
          icon={<AgentMark agent={value} className={MONOGRAM} />}
          className={CHIP}
        >
          {current?.label ?? "Agent"}
        </PropertyChip>
      </MenuTrigger>
      <MenuContent width={260} className={POPOVER}>
        <DropdownMenu.RadioGroup
          id="new-task-agent"
          role="radiogroup"
          aria-label="Agent"
          value={value ?? ""}
          onValueChange={(v) => onChange(v as Agent)}
          className="flex flex-col gap-px"
        >
          {installed.map((a) => {
            const version = detectionFor(a.agent)?.version;
            return (
              <DropdownMenu.RadioItem
                key={a.agent}
                value={a.agent}
                aria-label={a.label}
                className={cn(ROW, "h-[32px] gap-[10px] text-(--color-text-primary)")}
              >
                <AgentMark agent={a.agent} className={MONOGRAM} />
                <span className="min-w-0 flex-1 truncate">{a.label}</span>
                {version ? <span className="shrink-0 text-[11.5px] text-(--color-text-muted)">{version}</span> : null}
                <span className="grid size-[12px] shrink-0 place-items-center">
                  <DropdownMenu.ItemIndicator>
                    <Check aria-hidden className="size-[12px]" strokeWidth={2.5} />
                  </DropdownMenu.ItemIndicator>
                </span>
              </DropdownMenu.RadioItem>
            );
          })}
        </DropdownMenu.RadioGroup>
        {missing.length > 0 ? (
          <div className="mt-px flex flex-col gap-px">
            {missing.map((a) => {
              const hint = detectionFor(a.agent)?.installHint ?? "Not installed";
              const open = hintFor === a.agent;
              return (
                <div key={a.agent}>
                  <DropdownMenu.Item
                    aria-label={`${a.label}: not installed`}
                    aria-expanded={open}
                    // Not a pick: reveal how to install it, keep the menu open.
                    onSelect={(e) => {
                      e.preventDefault();
                      setHintFor(open ? null : a.agent);
                    }}
                    className={cn(ROW, "h-[32px] gap-[10px] text-(--color-text-muted)")}
                  >
                    <span
                      aria-hidden
                      className="grid size-[14px] shrink-0 place-items-center rounded-[3px] bg-(--color-border-strong) text-[8px] font-semibold leading-none text-(--color-text-inverse)"
                    >
                      {AGENT_META[a.agent].letter}
                    </span>
                    <span className="min-w-0 flex-1 truncate">{a.label}</span>
                    <span className="shrink-0 text-[11.5px]">Install…</span>
                    <span className="size-[12px] shrink-0" />
                  </DropdownMenu.Item>
                  {open ? (
                    <p className="m-0 select-text break-all px-[10px] pb-[6px] pl-[34px] font-mono text-[11px] leading-[1.5] text-(--color-text-secondary)">
                      {hint}
                    </p>
                  ) : null}
                </div>
              );
            })}
          </div>
        ) : null}
      </MenuContent>
    </Menu>
  );
}

/**
 * `[⎇ main ▾]`: the branch search in a popover. In-place runs use the
 * checkout's own branch, so the chip is disabled (with a tooltip) there.
 */
function BaseBranchChip({
  repoPath,
  defaultBranch,
  value,
  onChange,
  inPlace,
  disabled,
}: {
  repoPath: string | null;
  defaultBranch: string | undefined;
  value: string;
  onChange: (v: string) => void;
  inPlace: boolean;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const chipRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLDivElement>(null);
  // Inside the modal Dialog a body-portalled popover is pointer-dead and
  // can't wheel-scroll (the dialog's scroll lock); portal into the dialog
  // itself, as BaseBranchField's own list does.
  const [container, setContainer] = useState<HTMLElement | undefined>(undefined);
  const shown = value.trim() || defaultBranch || "main";
  const chip = (
    <Popover.Root
      open={open}
      onOpenChange={(o) => {
        if (o) setContainer((chipRef.current?.closest('[role="dialog"]') as HTMLElement | null) ?? undefined);
        setOpen(o);
      }}
    >
      <Popover.Trigger asChild>
        <PropertyChip
          ref={chipRef}
          mono
          icon={<GitBranch />}
          aria-label={`Base branch: ${inPlace ? "current branch" : shown}`}
          disabled={disabled || inPlace}
          className={CHIP}
        >
          <span className="text-[11.5px]">{inPlace ? "current" : shown}</span>
        </PropertyChip>
      </Popover.Trigger>
      <Popover.Portal container={container}>
        <Popover.Content
          aria-label="Base branch"
          side="bottom"
          align="start"
          sideOffset={6}
          collisionPadding={12}
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            const input = inputRef.current?.querySelector("input");
            input?.focus();
            input?.select();
          }}
          className={cn(
            POPOVER,
            "surface-floating pointer-events-auto w-[300px]",
            "data-[state=open]:animate-popover-in data-[state=closed]:animate-popover-out",
          )}
        >
          <div ref={inputRef}>
            <label htmlFor="new-task-base-branch" className="sr-only">
              Base branch
            </label>
            <BaseBranchField
              inline
              id="new-task-base-branch"
              repoPath={repoPath}
              defaultBranch={defaultBranch}
              value={value}
              onChange={onChange}
              onDone={() => setOpen(false)}
              disabled={disabled}
              placeholder="Search branches or type a ref"
              className="h-[32px] px-[10px] text-[12px]"
            />
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
  if (!inPlace) return chip;
  return (
    <GlassTooltip content="In place runs on your checkout's current branch" side="top">
      {/* A disabled button gets no pointer events; the span takes the hover. */}
      <span className="inline-flex" tabIndex={0}>
        {chip}
      </span>
    </GlassTooltip>
  );
}

interface Choice<T extends string> {
  value: T;
  label: string;
  hint?: string;
  disabled?: boolean;
  /** Hint in mono (a command line). */
  mono?: boolean;
  warn?: boolean;
}

/**
 * A property chip that opens a one-choice menu ("Worktree ▾", "Ask for
 * shell ▾"): the chip shows the current value, the menu explains each
 * option. Items are radios so screen readers hear the group and the
 * checked one.
 */
function ChipMenu<T extends string>({
  label,
  icon,
  value,
  valueLabel,
  chipText,
  onChange,
  options,
  warn = false,
  width = 260,
  footer,
}: {
  label: string;
  icon: ReactNode;
  value: T;
  /** The value's name for the chip's accessible label. */
  valueLabel?: string;
  /** What the chip shows; defaults to the option label. */
  chipText?: string;
  onChange: (value: T) => void;
  options: Choice<T>[];
  warn?: boolean;
  width?: number;
  footer?: ReactNode;
}) {
  const current = options.find((o) => o.value === value);
  const name = valueLabel ?? current?.label ?? value;
  return (
    <Menu>
      <MenuTrigger asChild>
        <PropertyChip
          aria-label={`${label}: ${name}`}
          icon={icon}
          className={cn(CHIP, warn && "text-(--color-warning)")}
        >
          {chipText ?? name}
        </PropertyChip>
      </MenuTrigger>
      <MenuContent width={width} className={POPOVER}>
        <DropdownMenu.RadioGroup
          value={value}
          onValueChange={(v) => onChange(v as T)}
          aria-label={label}
          className="flex flex-col gap-px"
        >
          {options.map((o) => (
            <DropdownMenu.RadioItem
              key={o.value}
              value={o.value}
              disabled={o.disabled ?? false}
              className={cn(ROW, "min-h-[32px] gap-[10px] py-[6px]", "data-[disabled]:text-(--color-text-muted)")}
            >
              <span className="flex min-w-0 flex-1 flex-col gap-[2px]">
                <span
                  className={cn(
                    "truncate",
                    o.disabled
                      ? "text-(--color-text-muted)"
                      : o.warn
                        ? "text-(--color-warning)"
                        : "text-(--color-text-primary)",
                  )}
                >
                  {o.label}
                </span>
                {o.hint ? (
                  <span
                    className={cn(
                      "text-[11.5px] leading-[1.4] text-(--color-text-muted)",
                      o.mono && "truncate font-mono text-[11px]",
                    )}
                    title={o.mono ? o.hint : undefined}
                  >
                    {o.hint}
                  </span>
                ) : null}
              </span>
              <span className="grid size-[12px] shrink-0 place-items-center text-(--color-text-primary)">
                <DropdownMenu.ItemIndicator>
                  <Check aria-hidden className="size-[12px]" strokeWidth={2.5} />
                </DropdownMenu.ItemIndicator>
              </span>
            </DropdownMenu.RadioItem>
          ))}
        </DropdownMenu.RadioGroup>
        {footer}
      </MenuContent>
    </Menu>
  );
}
