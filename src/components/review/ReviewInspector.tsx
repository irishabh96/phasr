import { useNavigate } from "@tanstack/react-router";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ChevronsRight, CircleCheck, CircleDashed, CircleX, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { MergeToMainDialog } from "@/components/MergeToMainDialog";
import { AGENT_META } from "@/components/ui/AgentMark";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/Dialog";
import { GroupHeader } from "@/components/ui/GroupHeader";
import { useAgentSummary } from "@/lib/hooks/useAgentSignals";
import {
  useApproveAndCreatePr,
  useCancelChecks,
  useCheckOutput,
  useChecks,
  useDiscardWorkspace,
  useRequestChanges,
  useReviewComments,
  useRunChecks,
  useSendReviewComments,
} from "@/lib/hooks/useReview";
import { humanizeError } from "@/lib/humanizeError";
import { useUiStore } from "@/lib/store";
import { showToast } from "@/lib/toast";
import type { CheckRun, Workspace } from "@/lib/types";
import { cn } from "@/lib/utils";

function CheckIcon({ run, stale }: { run: CheckRun; stale: boolean }) {
  if (run.status === "running" || run.status === "queued")
    return <Loader2 className="size-3.5 animate-spin text-(--color-info)" aria-label="running" />;
  if (run.status === "passed")
    return stale ? (
      <CircleDashed className="size-3.5 text-(--color-warning)" aria-label="passed before the latest edits" />
    ) : (
      <CircleCheck className="size-3.5 text-(--color-success)" aria-label="passed" />
    );
  return <CircleX className="size-3.5 text-(--color-danger)" aria-label={run.status} />;
}

function Section({ title, aside, children }: { title: string; aside?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section aria-label={title} className="flex flex-col gap-2.5 border-b border-(--color-border-subtle) px-4 py-3.5">
      <GroupHeader as="h3" action={aside}>
        {title}
      </GroupHeader>
      {children}
    </section>
  );
}

/**
 * The inspector while reviewing (A-Review): checks gate Approve, the agent's
 * own summary, pending comments, and the ways to close the task out.
 */
export function ReviewInspector({ workspace }: { workspace: Workspace }) {
  const wsId = workspace.id;
  const width = useUiStore((s) => s.rightPanelWidth);
  const collapse = useUiStore((s) => s.toggleRightPanel);
  const navigate = useNavigate();
  const { data: checks } = useChecks(wsId);
  const runChecks = useRunChecks(wsId);
  const cancelChecks = useCancelChecks(wsId);
  const [openRun, setOpenRun] = useState<string | null>(null);
  const anyRunning = !!checks?.runs.some((r) => r.status === "running" || r.status === "queued");
  const { data: summary } = useAgentSummary(wsId);
  const { data: comments } = useReviewComments(wsId);
  const send = useSendReviewComments(wsId);
  const requestChanges = useRequestChanges(wsId);
  const approve = useApproveAndCreatePr(wsId);
  const discard = useDiscardWorkspace(wsId);
  const [mergeOpen, setMergeOpen] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [overrideOpen, setOverrideOpen] = useState(false);
  const [dirtyOpen, setDirtyOpen] = useState(false);
  const agent = workspace.agent ? AGENT_META[workspace.agent].label : "the agent";
  const pending = (comments ?? []).filter((c) => c.status === "pending");
  const stale = new Set(checks?.staleIds ?? []);
  const required = new Set(checks?.required ?? []);
  const gated = !!checks && checks.required.length > 0 && !checks.requiredSatisfied;

  const doApprove = (overrideChecks = false, commitDirty = false) =>
    approve.mutate(
      { ...(overrideChecks ? { overrideChecks: true } : {}), ...(commitDirty ? { commitDirty: true } : {}) },
      {
        onSuccess: (pr) => {
          if (pr.viaGh) {
            showToast({
              intent: "success",
              title: pr.number ? `PR #${pr.number} opened${pr.draft ? " as draft" : ""}` : "PR opened",
              action: { label: "View PR", url: pr.url },
            });
          } else {
            void openUrl(pr.url).catch(() => {});
            showToast({ intent: "info", title: "Finish the pull request in your browser", action: { label: "Open", url: pr.url } });
          }
        },
        onError: (err) => {
          if (String(err).startsWith("required checks not passing")) setOverrideOpen(true);
          else if (String(err) === "worktree has uncommitted changes") setDirtyOpen(true);
          else showToast({ intent: "error", title: "Couldn't create the PR", message: humanizeError(err) });
        },
      },
    );

  // ⌘⇧↵ approves while reviewing (the Stage & commit view binds it to
  // commit & push instead; the two never mount together).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || !e.shiftKey || e.key !== "Enter") return;
      if ((e.target as HTMLElement | null)?.closest("textarea, input")) return;
      if (approve.isPending || workspace.outcome != null) return;
      e.preventDefault();
      doApprove(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const sendError = (err: unknown) =>
    showToast(
      String(err).includes("agent not running")
        ? { intent: "warning", title: `${agent} isn't running`, message: "Open the agent tab to resume it, then send again." }
        : { intent: "error", title: "Couldn't send to the agent", message: humanizeError(err) },
    );

  return (
    <aside
      aria-label="Inspector"
      style={{ width }}
      className="flex shrink-0 flex-col overflow-y-auto border-l border-(--color-border-subtle) bg-(--color-bg-sidebar)"
    >
      <Section
        title="Checks"
        aside={
          <span className="flex items-center gap-2">
            {checks && checks.required.length > 0 ? (
              <span className="text-[11px] text-(--color-text-muted)">required for approve</span>
            ) : null}
            <button
              type="button"
              aria-label="Collapse inspector"
              onClick={collapse}
              className="grid size-[22px] place-items-center rounded-(--radius-chip) border border-(--color-border-default) text-(--color-text-muted) hover:text-(--color-text-primary) focus-visible:outline-none focus-visible:shadow-(--ring-focus)"
            >
              <ChevronsRight className="size-3.5" aria-hidden />
            </button>
          </span>
        }
      >
        {checks && checks.runs.length > 0 ? (
          <ul className="m-0 flex list-none flex-col gap-1.5 p-0 text-[12px]">
            {checks.runs.map((r) => (
              <li key={r.id} className="flex flex-col gap-1">
                <span className="flex items-center gap-2">
                <CheckIcon run={r} stale={stale.has(r.id)} />
                <button
                  type="button"
                  aria-expanded={openRun === r.id}
                  onClick={() => setOpenRun(openRun === r.id ? null : r.id)}
                  className="min-w-0 flex-1 truncate text-left focus-visible:outline-none focus-visible:underline"
                >
                  {r.name}
                  {r.runCommandId && required.has(r.runCommandId) ? (
                    <span className="ml-1 text-[11px] text-(--color-text-muted)">required</span>
                  ) : null}
                </button>
                <span className="font-mono text-[11px] text-(--color-text-muted)">
                  {r.status === "running" || r.status === "queued"
                    ? r.status
                    : stale.has(r.id)
                      ? "stale"
                      : r.durationMs !== null
                        ? `${(r.durationMs / 1000).toFixed(1)}s`
                        : r.status}
                </span>
                </span>
                {openRun === r.id ? <CheckOutput runId={r.id} /> : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="m-0 text-[12px] text-(--color-text-muted)">
            No checks yet. Mark run commands “before review” in settings to run them here.
          </p>
        )}
        {checks && checks.needsConfirmation.length > 0 ? (
          <p className="m-0 text-[11px] text-(--color-warning)">
            {checks.needsConfirmation.length} synced command{checks.needsConfirmation.length === 1 ? "" : "s"} need
            confirming on this Mac before they auto-run.
          </p>
        ) : null}
        {anyRunning ? (
          <Button size="sm" disabled={cancelChecks.isPending} onClick={() => cancelChecks.mutate()}>
            Cancel checks
          </Button>
        ) : (
        <Button
          size="sm"
          disabled={runChecks.isPending}
          onClick={() =>
            runChecks.mutate(undefined, {
              onError: (err) => showToast({ intent: "error", title: "Couldn't run checks", message: humanizeError(err) }),
            })
          }
        >
          {runChecks.isPending ? "Starting…" : "Run checks"}
        </Button>
        )}
      </Section>

      {summary ? (
        <Section title="Agent summary">
          <p className="m-0 line-clamp-[12] whitespace-pre-wrap text-[12px] leading-[1.55] text-(--color-text-secondary)">
            {summary.text}
          </p>
        </Section>
      ) : null}

      <Section
        title="Comments"
        aside={pending.length > 0 ? <span className="text-[11px] text-(--color-text-muted)">{pending.length} pending</span> : null}
      >
        {comments && comments.length > 0 ? (
          <ul className="m-0 flex list-none flex-col gap-1.5 p-0 text-[12px]">
            {comments.map((c) => (
              <li key={c.id} className={cn("flex gap-2", c.status !== "pending" && "text-(--color-text-muted)")}>
                <span className="shrink-0 font-mono text-[11px] text-(--color-text-muted)">L{c.line}</span>
                <span className="min-w-0 truncate" title={`${c.path}: ${c.body}`}>
                  {c.body}
                </span>
                {c.status !== "pending" ? <span className="ml-auto shrink-0 text-[11px]">{c.status}</span> : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="m-0 text-[12px] text-(--color-text-muted)">Hover a diff line and press + to comment.</p>
        )}
        {pending.length > 0 ? (
          <Button size="sm" disabled={send.isPending} onClick={() => send.mutate(undefined, { onError: sendError })}>
            Send all comments to {agent}
          </Button>
        ) : null}
      </Section>

      <div className="flex flex-col gap-1.5 px-4 py-3.5">
        <Button
          variant="primary"
          size="md"
          shortcut="⌘⇧↵"
          disabled={approve.isPending || workspace.outcome != null}
          title={gated ? "Required checks aren't passing yet" : undefined}
          onClick={() => doApprove(false)}
        >
          {approve.isPending ? "Creating PR…" : workspace.prNumber ? `PR #${workspace.prNumber} open` : "Approve & create PR"}
        </Button>
        <Button
          size="md"
          disabled={requestChanges.isPending}
          onClick={() => requestChanges.mutate(undefined, { onError: sendError })}
        >
          Request changes
        </Button>
        <span className="flex gap-1.5">
          <Button size="md" className="flex-1" disabled={workspace.outcome != null} onClick={() => setMergeOpen(true)}>
            Merge locally
          </Button>
          <Button variant="danger" size="md" className="flex-1" disabled={workspace.outcome != null} onClick={() => setDiscardOpen(true)}>
            Discard worktree
          </Button>
        </span>
      </div>

      <MergeToMainDialog workspace={workspace} open={mergeOpen} onClose={() => setMergeOpen(false)} />
      <ConfirmDialog
        open={discardOpen}
        onOpenChange={setDiscardOpen}
        title="Discard this worktree?"
        description={`The worktree and the ${workspace.branch ?? "task"} branch are deleted. The task stays on the board as closed, with its notes.`}
        confirmLabel="Discard"
        destructive
        pending={discard.isPending}
        onConfirm={() =>
          discard.mutate(undefined, {
            onSuccess: () => {
              setDiscardOpen(false);
              void navigate({ to: "/" });
            },
            onError: (err) => showToast({ intent: "error", title: "Couldn't discard", message: humanizeError(err) }),
          })
        }
      />
      <ConfirmDialog
        open={dirtyOpen}
        onOpenChange={setDirtyOpen}
        title="The worktree has uncommitted changes"
        description={`The pull request would leave them out, though the review and checks included them. Commit everything as “${workspace.name}” and push?`}
        confirmLabel="Commit & push"
        onConfirm={() => {
          setDirtyOpen(false);
          doApprove(false, true);
        }}
      />
      <ConfirmDialog
        open={overrideOpen}
        onOpenChange={setOverrideOpen}
        title="Required checks aren't passing"
        description="Open the pull request anyway? The PR body will list the failing checks."
        confirmLabel="Create PR anyway"
        onConfirm={() => {
          setOverrideOpen(false);
          doApprove(true);
        }}
      />
    </aside>
  );
}

/** The tail of a check's output (live while it runs). */
function CheckOutput({ runId }: { runId: string }) {
  const { data, isLoading } = useCheckOutput(runId);
  return (
    <pre className="m-0 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-(--radius-control) border border-(--color-border-subtle) bg-(--color-bg-base) p-2 font-mono text-[11px] leading-[1.5] text-(--color-text-secondary)">
      {isLoading ? "Loading…" : data?.trim() ? data.slice(-6000) : "No output."}
    </pre>
  );
}
