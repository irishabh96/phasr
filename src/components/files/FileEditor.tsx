import { ChevronRight, GitCompare, Loader2 } from "lucide-react";
import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { DiffViewer } from "@/components/diff/DiffViewer";
import { DiffAnnotationsContext } from "@/components/diff/DiffView";
import { AGENT_META, AgentMark } from "@/components/ui/AgentMark";
import { Button } from "@/components/ui/Button";
import { PanelState } from "@/components/ui/PanelState";
import { formatAgo } from "@/lib/board";
import { useNow } from "@/lib/hooks/useNow";
import {
  isFileChangedOnDisk,
  isHunkNoLongerMatching,
  useRevertHunk,
  useWorkspaceFile,
  useWriteWorkspaceFile,
} from "@/lib/hooks/useWorkspaceFiles";
import { humanizeError } from "@/lib/humanizeError";
import { showToast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { languageLabel } from "./language";

const CodeEditor = lazy(() => import("./CodeEditor"));

function detectIndent(text: string): string {
  const lines = text.split("\n").slice(0, 400);
  if (lines.some((l) => l.startsWith("\t"))) return "Tabs";
  const widths = lines.map((l) => /^( +)\S/.exec(l)?.[1]?.length ?? 0).filter((n) => n > 0);
  if (widths.length === 0) return "2 spaces";
  return `${Math.min(...widths) >= 4 ? 4 : 2} spaces`;
}

/**
 * One open file in the Files tab (A-Editor): breadcrumb, the agent's last
 * edit, Edit ↔ Diff, CodeMirror, and a status line. ⌘S saves against the
 * hash it loaded, so it never overwrites an edit the agent made meanwhile.
 */
export function FileEditor({
  workspaceId,
  path,
  onDirtyChange,
}: {
  workspaceId: string;
  path: string;
  onDirtyChange: (path: string, dirty: boolean) => void;
}) {
  const file = useWorkspaceFile(workspaceId, path);
  const write = useWriteWorkspaceFile(workspaceId);
  const revert = useRevertHunk(workspaceId);
  const [buffer, setBuffer] = useState<string | null>(null);
  /** The disk version the editor's document is based on. */
  const [base, setBase] = useState<{ hash: string; contents: string } | null>(null);
  /** The file changed on disk under unsaved edits (agent write). */
  const [diskChanged, setDiskChanged] = useState(false);
  const [mode, setMode] = useState<"edit" | "diff">("edit");
  const [cursor, setCursor] = useState({ line: 1, col: 1 });
  const now = useNow(false);

  const loaded = base?.contents ?? "";
  const dirty = buffer !== null && buffer !== loaded;
  useEffect(() => onDirtyChange(path, dirty), [path, dirty, onDirtyChange]);

  // A new disk version: adopt it when there's nothing to lose (or it IS what
  // we just saved); otherwise keep the user's buffer and say the file moved.
  useEffect(() => {
    const d = file.data;
    if (!d) return;
    if (base && d.hash === base.hash) return;
    if (!base || !dirty || d.contents === buffer) {
      setBase({ hash: d.hash, contents: d.contents });
      if (d.contents === buffer) setBuffer(null);
      setDiskChanged(false);
    } else {
      setDiskChanged(true);
    }
    // Only a new disk version should trigger this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file.data?.hash]);

  const reloadFromDisk = () => {
    if (!file.data) return;
    setBase({ hash: file.data.hash, contents: file.data.contents });
    setBuffer(null);
    setDiskChanged(false);
  };

  const save = (overwrite = false) => {
    if (!base || buffer === null || !dirty) return;
    // After the disk moved under us, saving means "keep mine" explicitly.
    const expectedHash = overwrite || diskChanged ? null : base.hash;
    if (diskChanged && !overwrite) {
      showToast({
        intent: "warning",
        title: "This file changed on disk",
        message: "Reload to take the agent's version, or keep yours.",
        action: { label: "Keep mine", onClick: () => save(true) },
      });
      return;
    }
    write.mutate(
      { path, contents: buffer, expectedHash },
      {
        onSuccess: () => setDiskChanged(false),
        onError: (err) =>
          isFileChangedOnDisk(err)
            ? (setDiskChanged(true),
              showToast({
                intent: "warning",
                title: "The agent changed this file since you opened it",
                message: "Your edits are still in the editor.",
                action: { label: "Keep mine", onClick: () => save(true) },
              }))
            : showToast({ intent: "error", title: "Couldn't save", message: humanizeError(err) }),
      },
    );
  };

  const crumbs = path.split("/");
  const lang = languageLabel(path);
  const indent = useMemo(() => detectIndent(loaded), [loaded]);
  const eol = loaded.includes("\r\n") ? "CRLF" : "LF";
  const edit = file.data?.lastAgentEdit ?? null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-(--color-border-subtle) px-3 text-[12px]">
        <nav aria-label="File path" className="flex min-w-0 items-center gap-1 font-mono text-[11px] text-(--color-text-muted)">
          {crumbs.map((c, i) => (
            <span key={i} className="flex min-w-0 items-center gap-1">
              {i > 0 ? <ChevronRight className="size-3 shrink-0" aria-hidden /> : null}
              <span className={cn("truncate", i === crumbs.length - 1 && "text-(--color-text-primary)")}>{c}</span>
            </span>
          ))}
        </nav>
        <span className="flex-1" />
        {edit ? (
          <span className="flex shrink-0 items-center gap-1.5 text-[11px] text-(--color-text-muted)">
            <AgentMark agent={edit.agent} size="xs" />
            {AGENT_META[edit.agent].label} edited this file {formatAgo(edit.at, now)}
          </span>
        ) : null}
        <div role="radiogroup" aria-label="File view" className="flex overflow-hidden rounded-(--radius-control) border border-(--color-border-default)">
          {(["edit", "diff"] as const).map((m) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={mode === m}
              onClick={() => setMode(m)}
              className={cn(
                "flex h-6 items-center gap-1 px-2 text-[11px] focus-visible:outline-none focus-visible:shadow-(--ring-focus-inset)",
                mode === m ? "bg-(--color-bg-elevated) text-(--color-text-primary)" : "text-(--color-text-muted)",
              )}
            >
              {m === "diff" ? <GitCompare className="size-3" aria-hidden /> : null}
              {m === "edit" ? "Edit" : "Diff"}
            </button>
          ))}
        </div>
      </div>

      {diskChanged ? (
        <div role="status" className="flex shrink-0 items-center gap-2 border-b border-(--color-border-subtle) bg-(--color-warning-tint) px-3 py-1.5 text-[12px]">
          <span className="flex-1 text-(--color-text-secondary)">
            {edit ? AGENT_META[edit.agent].label : "Something"} changed this file on disk while you had unsaved edits.
          </span>
          <Button size="sm" className="h-6" onClick={reloadFromDisk}>
            Reload theirs
          </Button>
          <Button size="sm" className="h-6" variant="primary" onClick={() => save(true)}>
            Keep mine
          </Button>
        </div>
      ) : null}
      <div className="relative min-h-0 flex-1">
        {file.isLoading ? (
          <PanelState kind="loading" rows={8} className="p-4" />
        ) : file.isError ? (
          <PanelState kind="error" title="Can't open this file" error={file.error} />
        ) : mode === "diff" ? (
          <div className="h-full overflow-auto p-3">
            <DiffAnnotationsContext.Provider
              value={{
                onRevertHunk: (header) =>
                  revert.mutate(
                    { path, hunkHeader: header, scope: "Base" },
                    {
                      onError: (err) =>
                        showToast(
                          isHunkNoLongerMatching(err)
                            ? { intent: "info", title: "That hunk changed — the diff is refreshed" }
                            : { intent: "error", title: "Couldn't revert the hunk", message: humanizeError(err) },
                        ),
                    },
                  ),
              }}
            >
              <DiffViewer workspaceId={workspaceId} scope={"Base" as never} filePath={path} noHeader />
            </DiffAnnotationsContext.Provider>
          </div>
        ) : (
          <Suspense
            fallback={
              <div className="grid h-full place-items-center text-(--color-text-muted)">
                <Loader2 className="size-4 animate-spin" aria-label="Loading editor" />
              </div>
            }
          >
            <CodeEditor
              docKey={`${path}@${base?.hash ?? ""}`}
              value={loaded}
              path={path}
              onChange={setBuffer}
              onSave={() => save(false)}
              onCursor={setCursor}
            />
          </Suspense>
        )}
      </div>

      <footer className="flex h-7 shrink-0 items-center gap-4 border-t border-(--color-border-subtle) bg-(--color-bg-sidebar) px-3 font-mono text-[11px] text-(--color-text-muted)">
        {dirty ? (
          <span className="flex items-center gap-1.5 text-(--color-warning)">
            <span aria-hidden className="size-1.5 rounded-full bg-(--color-warning)" />
            unsaved · ⌘S
          </span>
        ) : write.isPending ? (
          <span>saving…</span>
        ) : (
          <span>saved</span>
        )}
        {dirty ? (
          <Button size="sm" className="h-5 px-2 font-sans text-[11px]" onClick={() => save(false)}>
            Save
          </Button>
        ) : null}
        <span className="flex-1" />
        <span>
          Ln {cursor.line}, Col {cursor.col}
        </span>
        <span>{lang}</span>
        <span>UTF-8 · {eol} · {indent}</span>
      </footer>
    </div>
  );
}
