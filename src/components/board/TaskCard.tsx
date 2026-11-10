import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowRight, Check, X } from "lucide-react";
import { memo, type ReactNode } from "react";
import { AGENT_META, AgentMark } from "@/components/ui/AgentMark";
import { Button } from "@/components/ui/Button";
import { RepoMark } from "@/components/ui/RepoMark";
import { formatAgo, formatElapsed } from "@/lib/board";
import { useRespondToAttention } from "@/lib/hooks/useAgentSignals";
import type { BoardTask } from "@/lib/hooks/useBoardTasks";
import { useNow } from "@/lib/hooks/useNow";
import { useChecks } from "@/lib/hooks/useReview";
import { useStartQueuedTask } from "@/lib/hooks/useTaskCards";
import { humanizeError } from "@/lib/humanizeError";
import { showToast } from "@/lib/toast";
import type { Attention, AttentionResponse, CheckSummary, Workspace } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * Board card (A-Polish Main): surface + hairline ring, radius 8, 12×14.
 * Title (500) · the lane's detail · footer (agent, then the right-aligned
 * time in Inter tabular-nums). The whole card opens the task through a
 * stretched title link, so the approval buttons can sit inside the card
 * without nesting interactive elements in an <a>. Review opens on Changes.
 *
 * Memoised: the board re-renders when the card list changes, and each
 * card's clock lives in its own leaf (`Elapsed`/`Ago`), so a ticking timer
 * re-renders a few characters, not the card.
 */
export const TaskCard = memo(function TaskCard({
  task,
  showRepo = false,
}: {
  task: BoardTask;
  /** Viewing every repository: queued cards name theirs in the footer. */
  showRepo?: boolean;
}) {
  const ws = task.workspace;
  if (task.notStarted) return <QueuedCard task={task} showRepo={showRepo} />;

  const finished = task.finishedAt ?? ws.finishedAt ?? ws.updatedAt;
  let middle: ReactNode = null;
  let right: ReactNode = null;
  switch (task.lane) {
    case "needs-you":
      middle = <ApprovalBlock workspace={ws} attention={task.attention} />;
      right = (
        <>
          waiting <Elapsed iso={task.attention?.since ?? ws.startedAt} />
        </>
      );
      break;
    case "failed":
      middle = <FailedLine exitCode={ws.exitCode} />;
      right = <Ago iso={finished} />;
      break;
    case "running":
      middle = task.activity ? (
        <span className="line-clamp-2 break-words rounded-(--radius-control) bg-(--color-bg-input) px-[10px] py-[8px] font-mono text-[12px] leading-[1.6] text-(--color-text-secondary)">
          › {task.activity}
        </span>
      ) : null;
      right = (
        <>
          <Elapsed iso={ws.startedAt} />
          {task.diff && task.diff.files > 0 ? (
            <>
              {" · "}
              <DiffStat adds={task.diff.adds} removes={task.diff.removes} />
            </>
          ) : null}
        </>
      );
      break;
    case "review":
      middle = <ReviewMeta workspaceId={ws.id} diff={task.diff} />;
      right = <Ago iso={finished} />;
      break;
    default:
      right = <Ago iso={finished} />;
  }

  return (
    <CardShell workspace={ws} lane={task.lane}>
      <Link
        to="/repositories/$repositoryId/workspaces/$workspaceId"
        params={{ repositoryId: ws.repositoryId, workspaceId: ws.id }}
        {...(task.lane === "review" ? { search: { pane: "changes" } as never } : {})}
        data-board-card
        className={cn(
          "font-medium leading-[1.4] text-(--color-text-primary) no-underline [overflow-wrap:anywhere] focus-visible:outline-none",
          // Stretched link: the whole card is the hit target.
          "after:absolute after:inset-0 after:rounded-[inherit] after:content-['']",
        )}
      >
        {ws.name}
      </Link>
      {middle}
      <CardFooter
        left={
          <>
            <AgentMark agent={ws.agent} className="size-[14px] text-[8px]" />
            <span className="truncate">{ws.agent ? AGENT_META[ws.agent].label : "Agent"}</span>
          </>
        }
        right={right}
      />
    </CardShell>
  );
});

function CardShell({
  workspace,
  lane,
  interactive = true,
  children,
}: {
  workspace: Workspace;
  lane: string;
  interactive?: boolean;
  children: ReactNode;
}) {
  // The task context menu is shared by the board (`BoardContextMenu`), which
  // finds the card under a right-click by `data-workspace-id`.
  return (
    <div
      data-lane={lane}
      data-workspace-id={workspace.id}
      className={cn(
        "group/card relative flex flex-col px-[14px] py-[12px] text-[13px] text-(--color-text-primary)",
        // A queued card is title + footer only, set a touch tighter (as drawn).
        interactive ? "card-interactive gap-[10px]" : "card gap-[8px]",
        // The ring moves to the card while its title link has keyboard focus.
        "has-[a:focus-visible]:shadow-(--ring-focus)",
      )}
    >
      {children}
    </div>
  );
}

function CardFooter({
  left,
  right,
  squeezeRight = false,
}: {
  left: ReactNode;
  right: ReactNode;
  /** Queued: the right side ("after <task>") gives way before the repo name. */
  squeezeRight?: boolean;
}) {
  return (
    <span className="flex min-w-0 items-center gap-[8px] text-[12px] text-(--color-text-muted)">
      <span className={cn("flex min-w-0 items-center gap-[8px]", squeezeRight && "max-w-[60%] shrink-0")}>{left}</span>
      <span className="flex-1" />
      <span
        className={cn(
          "flex items-center gap-[8px] whitespace-nowrap tabular-nums",
          squeezeRight ? "min-w-0" : "shrink-0",
        )}
      >
        {right}
      </span>
    </span>
  );
}

/** Live "4m 12s": the only part of a card that ticks each second. */
function Elapsed({ iso }: { iso: string | null | undefined }) {
  const now = useNow(true);
  return <>{formatElapsed(iso ?? null, now)}</>;
}

/** "18m ago", on the minute clock. */
function Ago({ iso }: { iso: string | null | undefined }) {
  const now = useNow(false);
  return <>{formatAgo(iso ?? null, now)}</>;
}

/** `+212 −48`: mono (a code-ish value, A-Polish rule 6), in the line's tone. */
function DiffStat({ adds, removes }: { adds: number; removes: number }) {
  return (
    <span className="font-mono text-[11.5px]">
      +{adds}
      {removes > 0 ? ` −${removes}` : ""}
    </span>
  );
}

const ASKS: Partial<Record<Attention["kind"], string>> = {
  shell: "Wants to run",
  edit: "Wants to edit",
  tool: "Wants to use",
};

/**
 * Needs you: what the agent is blocked on, answered from the board. The
 * answer carries the attention id, so a click on a card that went stale
 * can't answer the agent's next dialog (the backend rejects it and the
 * snapshot refetches).
 */
function ApprovalBlock({ workspace, attention }: { workspace: Workspace; attention: Attention | null }) {
  const respond = useRespondToAttention();
  if (!attention) {
    return <span className="text-[12px] text-(--color-text-secondary)">Waiting for you</span>;
  }
  const ask = ASKS[attention.kind];
  const isTrust = attention.kind === "trust";
  const answer = (response: AttentionResponse) =>
    respond.mutate(
      { taskId: workspace.id, attentionId: attention.id, response },
      {
        onError: (err) =>
          showToast(
            String(err).includes("stale attention")
              ? {
                  intent: "info",
                  title: "That prompt already changed",
                  message: "Open the task to see the agent's current request.",
                }
              : { intent: "error", title: "Couldn't answer the agent", message: humanizeError(err) },
          ),
      },
    );
  return (
    // The stretched title link covers this block, so a click on the text
    // opens the task; the (positioned) buttons sit above it.
    <div
      aria-label="Approval"
      role="group"
      className="flex flex-col gap-[8px] rounded-(--radius-control) bg-(--color-bg-elevated) px-[12px] py-[10px] text-[12.5px] transition-colors duration-(--dur-1) group-hover/card:bg-(--color-bg-hover)"
    >
      <span className="min-w-0 break-words text-(--color-text-secondary)">
        {ask && attention.detail ? (
          <>
            {ask} <span className="font-mono text-[11.5px] text-(--color-text-primary)">{attention.detail}</span>
          </>
        ) : (
          <>
            {attention.title}
            {attention.detail ? (
              <>
                {": "}
                <span className="font-mono text-[11.5px] text-(--color-text-primary)">{attention.detail}</span>
              </>
            ) : null}
          </>
        )}
      </span>
      {attention.canRespond ? (
        <span className="relative flex gap-[6px]">
          <Button
            size="sm"
            disabled={respond.isPending}
            onClick={() => answer("allow-once")}
            className="h-[26px] rounded-[5px] bg-(--color-text-primary) px-[10px] text-[12px] font-medium text-(--color-text-inverse) hover:bg-(--color-text-secondary) active:bg-(--color-text-secondary)"
          >
            {isTrust ? "Trust folder" : "Allow"}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={respond.isPending}
            onClick={() => answer("deny")}
            className="h-[26px] rounded-[5px] px-[10px] text-[12px]"
          >
            {isTrust ? "Exit agent" : "Deny"}
          </Button>
        </span>
      ) : (
        <span className="text-[12px] text-(--color-text-muted)">Answer in the terminal</span>
      )}
    </div>
  );
}

/** A-States: a failed task waits in Needs you with a red dot. */
function FailedLine({ exitCode, label = "Failed" }: { exitCode: number | null; label?: string }) {
  return (
    <span className="flex items-center gap-[8px] text-[12px] text-(--color-text-muted)">
      <span aria-hidden className="size-[6px] shrink-0 rounded-full bg-(--color-status-danger)" />
      <span className="text-(--color-danger-text)">{label}</span>
      {exitCode !== null && exitCode !== undefined ? <span>· exit {exitCode}</span> : null}
      <span className="flex-1" />
      <span aria-hidden className="text-(--color-text-secondary)">
        Open
      </span>
    </span>
  );
}

/** Review: `✓ checks · 7 files · +212 −48`. Checks show only once some ran. */
function ReviewMeta({ workspaceId, diff }: { workspaceId: string; diff: BoardTask["diff"] }) {
  const { data: checks } = useChecks(workspaceId);
  const verdict = checksVerdict(checks);
  if (!verdict && !diff) return null;
  return (
    <span className="flex min-w-0 items-center gap-[10px] text-[12px] text-(--color-text-secondary)">
      {verdict === "passed" ? (
        <span className="flex items-center gap-[4px]">
          <Check aria-hidden className="size-[12px] text-(--color-status-success)" strokeWidth={2.5} />
          checks
        </span>
      ) : verdict === "failed" ? (
        <span className="flex items-center gap-[4px] text-(--color-danger-text)">
          <X aria-hidden className="size-[12px]" strokeWidth={2.5} />
          checks
        </span>
      ) : verdict === "running" ? (
        <span>checks running</span>
      ) : null}
      {diff ? (
        <>
          <span className="whitespace-nowrap">
            {diff.files} {diff.files === 1 ? "file" : "files"}
          </span>
          <DiffStat adds={diff.adds} removes={diff.removes} />
        </>
      ) : null}
    </span>
  );
}

/** The latest run of each check, summed up; `null` = none ran yet. */
export function checksVerdict(summary: CheckSummary | null | undefined): "passed" | "failed" | "running" | null {
  const runs = summary?.runs ?? [];
  if (runs.length === 0) return null;
  if (runs.some((r) => r.status === "failed" || r.status === "error" || r.status === "timeout")) return "failed";
  if (runs.some((r) => r.status === "queued" || r.status === "running")) return "running";
  return runs.every((r) => r.status === "passed") ? "passed" : null;
}

/**
 * Queued / draft card: never started, so it opens nothing yet. "Start now"
 * claims it and opens the session at once; the worktree + agent are set up
 * in the backend meanwhile (the card moves to Running, the terminal says
 * "Setting up the worktree…"). A task that couldn't start shows the failed
 * line and a retry.
 */
function QueuedCard({ task, showRepo }: { task: BoardTask; showRepo: boolean }) {
  const ws = task.workspace;
  const start = useStartQueuedTask();
  const navigate = useNavigate();
  const failed = ws.status === "failed";
  const after = task.dependsOnName;
  return (
    <CardShell workspace={ws} lane={failed ? "failed" : "queued"} interactive={false}>
      <span className="font-medium leading-[1.4] [overflow-wrap:anywhere]">{ws.name}</span>
      {failed ? <FailedLine exitCode={null} label="Couldn't start" /> : null}
      <CardFooter
        left={
          showRepo && task.repository ? (
            <>
              <RepoMark id={task.repository.id} name={task.repository.name} size={14} />
              <span className="truncate">{task.repository.name}</span>
            </>
          ) : (
            <>
              <AgentMark agent={ws.agent} className="size-[14px] text-[8px]" />
              <span className="truncate">{ws.agent ? AGENT_META[ws.agent].label : "Agent"}</span>
            </>
          )
        }
        squeezeRight
        right={
          <>
            {after && !failed ? <span className="min-w-0 truncate">after {after}</span> : null}
            <button
              type="button"
              disabled={start.isPending}
              onClick={() =>
                start.mutate(
                  { id: ws.id },
                  {
                    onSuccess: (started) =>
                      void navigate({
                        to: "/repositories/$repositoryId/workspaces/$workspaceId",
                        params: { repositoryId: started.workspace.repositoryId, workspaceId: started.workspace.id },
                      }),
                    onError: (err) =>
                      showToast({ intent: "error", title: "Couldn't start the task", message: humanizeError(err) }),
                  },
                )
              }
              className="-my-[4px] -mr-[4px] flex shrink-0 items-center gap-[4px] rounded-(--radius-chip) px-[4px] py-[4px] text-(--color-text-secondary) transition-colors duration-(--dur-1) hover:text-(--color-text-primary) disabled:opacity-50 focus-visible:outline-none focus-visible:shadow-(--ring-focus)"
            >
              {start.isPending ? "Starting…" : failed ? "Retry" : "Start now"}
              <ArrowRight className="size-[12px]" aria-hidden />
            </button>
          </>
        }
      />
    </CardShell>
  );
}
