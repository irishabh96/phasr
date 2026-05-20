import { Check, GitBranch, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import {
  useGitCommit,
  useGitDiff,
  useGitDiscard,
  useGitPush,
  useGitStage,
  useGitStatus,
  useGitUnstage,
} from "@/lib/hooks/useGit";
import type { FileChange, FileStatus } from "@/lib/types";
import { GlassButton } from "@/components/ui/GlassButton";
import { GlassTextarea } from "@/components/ui/GlassInput";
import { cn } from "@/lib/utils";

interface ChangesPanelProps {
  workspaceId: string;
}

export function ChangesPanel({ workspaceId }: ChangesPanelProps) {
  const { data: changes } = useGitStatus(workspaceId);
  const stage = useGitStage(workspaceId);
  const unstage = useGitUnstage(workspaceId);
  const discard = useGitDiscard(workspaceId);
  const commit = useGitCommit(workspaceId);
  const push = useGitPush(workspaceId);

  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [message, setMessage] = useState("");

  const stagedFiles = (changes ?? []).filter((c) => c.staged !== "other");

  const { data: diff, error: diffError } = useGitDiff(workspaceId, "Head", selectedPath);

  useEffect(() => {
    if (!selectedPath && changes?.length) {
      setSelectedPath(changes[0]?.path ?? null);
    }
  }, [selectedPath, changes]);

  const handleCommit = async () => {
    if (!message.trim() || stagedFiles.length === 0) return;
    await commit.mutateAsync(message.trim());
    setMessage("");
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-(--color-border-subtle) px-3">
        <span className="text-[11px] font-medium uppercase tracking-[0.12em] text-(--color-text-muted)">
          Changes <span className="text-(--color-text-secondary)">{changes?.length ?? 0}</span>
        </span>
        {stagedFiles.length > 0 && (
          <GlassButton variant="ghost" size="sm" onClick={() => unstage.mutate([])}>
            Unstage all
          </GlassButton>
        )}
      </div>

      <ul className="max-h-[36%] min-h-0 shrink-0 overflow-y-auto">
        {!changes?.length && (
          <li className="px-3 py-2.5 text-[12px] text-(--color-text-muted)">
            No changes in this worktree yet.
          </li>
        )}
        {changes?.map((change) => (
          <FileRow
            key={change.path}
            change={change}
            selected={change.path === selectedPath}
            onSelect={() => setSelectedPath(change.path)}
            onStage={() => stage.mutate([change.path])}
            onUnstage={() => unstage.mutate([change.path])}
            onDiscard={() => discard.mutate([change.path])}
          />
        ))}
      </ul>

      <div className="min-h-0 flex-1 overflow-auto border-y border-(--color-border-subtle) px-3 py-2 font-mono text-[11.5px]">
        {selectedPath ? (
          diffError ? (
            <p className="text-(--color-danger)">{String(diffError)}</p>
          ) : diff && diff.length > 0 ? (
            <pre className="whitespace-pre-wrap leading-relaxed">{renderDiff(diff)}</pre>
          ) : (
            <p className="text-(--color-text-muted)">No diff to show for {selectedPath}.</p>
          )
        ) : (
          <p className="text-(--color-text-muted)">Select a file to see its diff.</p>
        )}
      </div>

      <div className="shrink-0 p-3">
        <GlassTextarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          rows={2}
          placeholder="Commit message"
        />
        <div className="mt-2 flex items-center gap-1">
          <GlassButton
            variant="ghost"
            size="sm"
            onClick={() => stage.mutate([])}
            disabled={stage.isPending}
          >
            Stage all
          </GlassButton>
          <GlassButton
            variant="primary"
            size="sm"
            onClick={handleCommit}
            disabled={commit.isPending || !message.trim() || stagedFiles.length === 0}
          >
            <Check size={12} />
            Commit {stagedFiles.length > 0 && `(${stagedFiles.length})`}
          </GlassButton>
          <GlassButton
            variant="outline"
            size="sm"
            onClick={() => push.mutate()}
            disabled={push.isPending}
            className="ml-auto"
          >
            <GitBranch size={12} />
            {push.isPending ? "Pushing…" : "Push"}
          </GlassButton>
        </div>
        {push.error && (
          <p className="mt-2 text-[11px] text-(--color-danger)">{String(push.error)}</p>
        )}
        {push.isSuccess && (
          <p className="mt-2 text-[11px] text-(--color-success)">Pushed.</p>
        )}
      </div>
    </div>
  );
}

interface FileRowProps {
  change: FileChange;
  selected: boolean;
  onSelect(): void;
  onStage(): void;
  onUnstage(): void;
  onDiscard(): void;
}

function FileRow({ change, selected, onSelect, onStage, onUnstage, onDiscard }: FileRowProps) {
  const stagedMarker = statusMark(change.staged);
  const unstagedMarker = statusMark(change.unstaged);
  return (
    <li
      onClick={onSelect}
      data-active={selected}
      className={cn(
        "group flex cursor-pointer items-center gap-2 px-3 py-1.5 text-[12px]",
        "transition-colors duration-150",
        "hover:bg-(--color-bg-hover)",
        "data-[active=true]:bg-[color-mix(in_oklab,var(--color-accent-500)_10%,transparent)]",
        "data-[active=true]:text-(--color-text-primary)",
      )}
    >
      <span className="w-7 shrink-0 font-mono text-[11px] text-(--color-text-muted)">
        <span style={{ color: stagedMarker.color }}>{stagedMarker.glyph}</span>
        <span style={{ color: unstagedMarker.color }}>{unstagedMarker.glyph}</span>
      </span>
      <span className="min-w-0 flex-1 truncate">{change.path}</span>
      <div className="hidden shrink-0 gap-0.5 group-hover:flex">
        {change.unstaged !== "other" && (
          <RowIconButton
            label="Stage"
            onClick={(e) => {
              e.stopPropagation();
              onStage();
            }}
          >
            +
          </RowIconButton>
        )}
        {change.staged !== "other" && (
          <RowIconButton
            label="Unstage"
            onClick={(e) => {
              e.stopPropagation();
              onUnstage();
            }}
          >
            −
          </RowIconButton>
        )}
        {change.unstaged !== "other" && (
          <RowIconButton
            label="Discard"
            danger
            onClick={(e) => {
              e.stopPropagation();
              if (window.confirm(`Discard changes to ${change.path}?`)) {
                onDiscard();
              }
            }}
          >
            <Trash2 size={11} />
          </RowIconButton>
        )}
      </div>
    </li>
  );
}

function RowIconButton({
  children,
  label,
  onClick,
  danger,
}: {
  children: React.ReactNode;
  label: string;
  onClick: (e: React.MouseEvent<HTMLButtonElement>) => void;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className={cn(
        "flex h-5 w-5 items-center justify-center rounded-[5px] text-[11px]",
        "transition-colors",
        "hover:bg-(--color-bg-hover)",
        danger && "text-(--color-danger)",
      )}
    >
      {children}
    </button>
  );
}

function renderDiff(diff: string) {
  return diff.split("\n").map((line, i) => {
    let style: React.CSSProperties = {};
    if (
      line.startsWith("+++") ||
      line.startsWith("---") ||
      line.startsWith("diff ") ||
      line.startsWith("@@") ||
      line.startsWith("new file") ||
      line.startsWith("index ")
    ) {
      style = { color: "var(--color-text-muted)" };
    } else if (line.startsWith("+")) {
      style = { color: "var(--color-success)" };
    } else if (line.startsWith("-")) {
      style = { color: "var(--color-danger)" };
    }
    return (
      <span key={i} style={style}>
        {line}
        {"\n"}
      </span>
    );
  });
}

function statusMark(status: FileStatus): { glyph: string; color: string } {
  switch (status) {
    case "added":
      return { glyph: "A", color: "var(--color-success)" };
    case "modified":
      return { glyph: "M", color: "var(--color-warning)" };
    case "deleted":
      return { glyph: "D", color: "var(--color-danger)" };
    case "renamed":
      return { glyph: "R", color: "var(--color-info)" };
    case "untracked":
      return { glyph: "?", color: "var(--color-text-muted)" };
    case "conflicted":
      return { glyph: "U", color: "var(--color-danger)" };
    case "other":
    default:
      return { glyph: " ", color: "var(--color-text-muted)" };
  }
}
