import * as Popover from "@radix-ui/react-popover";
import { useNavigate } from "@tanstack/react-router";
import { Bell } from "lucide-react";
import { formatAgo } from "@/lib/board";
import { useClearNotifications, useMarkRead, useNotifications, useUnreadCount } from "@/lib/hooks/useInbox";
import { useNow } from "@/lib/hooks/useNow";
import { useRemoveWorktrees } from "@/lib/hooks/useRepositoryConfig";
import type { AppNotification, NotificationKind } from "@/lib/types";
import { cn } from "@/lib/utils";

const KIND_COLOR: Record<NotificationKind, string> = {
  needs_approval: "var(--color-status-attention)",
  task_finished: "var(--color-status-success)",
  task_failed: "var(--color-status-danger)",
  checks_finished: "var(--color-status-running)",
  run_command_failed: "var(--color-status-danger)",
};

/** Title-bar bell (A Main): unread dot + the recent inbox in a popover. */
export function InboxBell() {
  const { data: unread } = useUnreadCount();
  const { data: items } = useNotifications({ limit: 40 });
  const markRead = useMarkRead();
  const clear = useClearNotifications();
  const navigate = useNavigate();
  const now = useNow(false);
  const count = typeof unread === "number" ? unread : 0;

  const open = (n: AppNotification) => {
    if (!n.readAt) markRead.mutate([n.id]);
    const taskId = (n.payload.taskId as string | undefined) ?? n.workspaceId;
    const repositoryId = (n.payload.repositoryId as string | undefined) ?? n.repositoryId;
    if (taskId && repositoryId) {
      void navigate({
        to: "/repositories/$repositoryId/workspaces/$workspaceId",
        params: { repositoryId, workspaceId: taskId },
        ...(n.kind === "checks_finished" ? { search: { pane: "changes" } as never } : {}),
      });
    }
  };

  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-label={count > 0 ? `Notifications, ${count} unread` : "Notifications"}
          className="relative grid size-7 place-items-center rounded-(--radius-control) border border-(--color-border-default) bg-(--color-bg-surface) text-(--color-text-muted) hover:text-(--color-text-primary) focus-visible:outline-none focus-visible:shadow-(--ring-focus) data-[state=open]:border-(--color-border-strong)"
        >
          <Bell className="size-3.5" aria-hidden />
          {count > 0 ? (
            <span aria-hidden className="absolute right-[5px] top-[5px] size-1.5 rounded-full bg-(--color-warning)" />
          ) : null}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={6}
          className="z-(--z-dropdown) flex max-h-[480px] w-[360px] flex-col overflow-hidden surface-floating data-[state=open]:animate-popover-in data-[state=closed]:animate-popover-out"
        >
          <header className="flex items-center gap-2 border-b border-(--color-border-subtle) px-3 py-2.5">
            <span className="group-header">Inbox</span>
            {count > 0 ? <span className="font-mono text-[11px] text-(--color-text-muted)">{count} unread</span> : null}
            <span className="flex-1" />
            <button
              type="button"
              disabled={count === 0}
              onClick={() => markRead.mutate(null)}
              className="text-[11px] text-(--color-text-muted) hover:text-(--color-text-primary) disabled:opacity-40 focus-visible:outline-none focus-visible:underline"
            >
              Mark all read
            </button>
            <button
              type="button"
              disabled={!items || items.length === 0}
              onClick={() => clear.mutate()}
              className="text-[11px] text-(--color-text-muted) hover:text-(--color-text-primary) disabled:opacity-40 focus-visible:outline-none focus-visible:underline"
            >
              Clear
            </button>
          </header>
          <ul className="m-0 min-h-0 flex-1 list-none overflow-y-auto p-1">
            {!items || items.length === 0 ? (
              <li className="px-3 py-6 text-center text-[12px] text-(--color-text-muted)">
                Nothing yet. Approvals, finished tasks and failures land here.
              </li>
            ) : (
              items.map((n) => (
                <li key={n.id}>
                  <button
                    type="button"
                    onClick={() => open(n)}
                    className={cn(
                      "flex w-full items-start gap-2.5 rounded-(--radius-control) px-2.5 py-2 text-left hover:bg-(--color-bg-hover) focus-visible:outline-none focus-visible:shadow-(--ring-focus-inset)",
                      n.readAt && "opacity-70",
                    )}
                  >
                    <span aria-hidden className="mt-1.5 size-2 shrink-0 rounded-full" style={{ background: KIND_COLOR[n.kind] }} />
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className={cn("truncate text-[12px]", !n.readAt && "font-medium")}>{n.title}</span>
                      {n.body ? <span className="line-clamp-2 text-[11px] text-(--color-text-muted)">{n.body}</span> : null}
                    </span>
                    <span className="shrink-0 text-[11px] text-(--color-text-faint)">{formatAgo(n.createdAt, now)}</span>
                  </button>
                  {n.payload.suggestion === "cleanup" && typeof n.payload.worktreePath === "string" && n.repositoryId ? (
                    <CleanupAction repositoryId={n.repositoryId} path={n.payload.worktreePath} onDone={() => markRead.mutate([n.id])} />
                  ) : null}
                </li>
              ))
            )}
          </ul>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** Merged task, cleanup set to "Ask": offer removing its worktree right here. */
function CleanupAction({ repositoryId, path, onDone }: { repositoryId: string; path: string; onDone: () => void }) {
  const remove = useRemoveWorktrees(repositoryId);
  return (
    <div className="flex justify-end px-2.5 pb-2">
      <button
        type="button"
        disabled={remove.isPending || remove.isSuccess}
        onClick={() => remove.mutate({ paths: [path] }, { onSuccess: onDone })}
        className="rounded-(--radius-control) border border-(--color-border-default) px-2 py-0.5 text-[11px] text-(--color-text-secondary) hover:border-(--color-border-strong) disabled:opacity-50 focus-visible:outline-none focus-visible:shadow-(--ring-focus)"
      >
        {remove.isSuccess ? "Worktree removed" : remove.isPending ? "Removing…" : "Remove worktree"}
      </button>
    </div>
  );
}
