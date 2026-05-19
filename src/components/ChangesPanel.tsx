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

  // HEAD scope shows both staged + unstaged changes against the last
  // commit — covers tracked files in one query. Untracked files are
  // synthesised on the Rust side.
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
    <div className="flex h-full min-h-0 flex-col gap-2">
      <div className="flex items-center justify-between px-2 pt-2 text-xs uppercase tracking-wide text-(--color-text-muted)">
        <span>Changes ({changes?.length ?? 0})</span>
        {stagedFiles.length > 0 && (
          <button
            type="button"
            onClick={() => unstage.mutate([])}
            className="rounded px-1.5 py-0.5 hover:bg-(--color-bg-elevated)"
          >
            Unstage all
          </button>
        )}
      </div>

      <ul className="max-h-[35%] min-h-0 flex-1 overflow-y-auto border-y border-(--color-border-subtle)">
        {!changes?.length && (
          <li className="px-3 py-2 text-xs text-(--color-text-muted)">
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

      <div className="min-h-0 flex-1 overflow-auto px-3 py-2 font-mono text-xs">
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

      <div className="border-t border-(--color-border-subtle) bg-(--color-bg-surface) p-3">
        <textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          rows={2}
          placeholder="Commit message"
          className="w-full resize-y"
        />
        <div className="mt-2 flex items-center gap-2">
          <button
            type="button"
            onClick={() => stage.mutate([])}
            disabled={stage.isPending}
            className="rounded-md border border-(--color-border-default) px-2 py-1 text-xs hover:border-(--color-border-strong)"
          >
            Stage all
          </button>
          <button
            type="button"
            onClick={handleCommit}
            disabled={commit.isPending || !message.trim() || stagedFiles.length === 0}
            className="flex items-center gap-1 rounded-md border border-(--color-accent-600) bg-(--color-accent-600) px-2 py-1 text-xs text-white hover:bg-(--color-accent-500) disabled:opacity-50"
          >
            <Check size={12} />
            Commit ({stagedFiles.length})
          </button>
          <button
            type="button"
            onClick={() => push.mutate()}
            disabled={push.isPending}
            className="ml-auto flex items-center gap-1 rounded-md border border-(--color-border-default) px-2 py-1 text-xs hover:border-(--color-border-strong)"
          >
            <GitBranch size={12} />
            {push.isPending ? "Pushing…" : "Push"}
          </button>
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
      className="group flex cursor-pointer items-center gap-2 px-3 py-1.5 text-xs hover:bg-(--color-bg-elevated) data-[active=true]:bg-(--color-bg-elevated)"
    >
      <span className="w-7 font-mono text-(--color-text-muted)">
        <span style={{ color: stagedMarker.color }}>{stagedMarker.glyph}</span>
        <span style={{ color: unstagedMarker.color }}>{unstagedMarker.glyph}</span>
      </span>
      <span className="flex-1 truncate">{change.path}</span>
      <div className="hidden gap-1 group-hover:flex">
        {change.unstaged !== "other" && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onStage();
            }}
            className="rounded px-1 hover:bg-(--color-bg-base)"
            title="Stage"
          >
            +
          </button>
        )}
        {change.staged !== "other" && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onUnstage();
            }}
            className="rounded px-1 hover:bg-(--color-bg-base)"
            title="Unstage"
          >
            −
          </button>
        )}
        {change.unstaged !== "other" && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              if (window.confirm(`Discard changes to ${change.path}?`)) {
                onDiscard();
              }
            }}
            className="rounded px-1 text-(--color-danger) hover:bg-(--color-bg-base)"
            title="Discard"
          >
            <Trash2 size={11} />
          </button>
        )}
      </div>
    </li>
  );
}

function renderDiff(diff: string) {
  return diff.split("\n").map((line, i) => {
    let style: React.CSSProperties = {};
    if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff ") || line.startsWith("@@") || line.startsWith("new file") || line.startsWith("index ")) {
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
