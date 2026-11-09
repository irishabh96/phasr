import { ChevronRight, GitCompare, Loader2 } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { DiffViewer } from "@/components/diff/DiffViewer";
import { DiffAnnotationsContext } from "@/components/diff/DiffView";
import { AGENT_META, AgentMark } from "@/components/ui/AgentMark";
import { Button } from "@/components/ui/Button";
import { PanelState } from "@/components/ui/PanelState";
import { formatAgo } from "@/lib/board";
import { useNow } from "@/lib/hooks/useNow";
import { isHunkNoLongerMatching, useRevertHunk, useWorkspaceFile } from "@/lib/hooks/useWorkspaceFiles";
import { humanizeError } from "@/lib/humanizeError";
import { fileBufferKey, useUiStore } from "@/lib/store";
import { showToast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { reconcileDiskVersion, reloadFileBuffer, saveFileBuffer, setFileBufferText } from "./fileBuffers";
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
 *
 * The buffer lives in the store (`fileBuffers`), not here: unmounting this
 * component — Diff view, closing the pane, switching tasks — loses nothing.
 */
export function FileEditor({ workspaceId, path }: { workspaceId: string; path: string }) {
  const queryClient = useQueryClient();
  const file = useWorkspaceFile(workspaceId, path);
  const revert = useRevertHunk(workspaceId);
  const entry = useUiStore((s) => s.fileBuffers[fileBufferKey(workspaceId, path)]);
  const [mode, setMode] = useState<"edit" | "diff">("edit");
  const [cursor, setCursor] = useState({ line: 1, col: 1 });
  const now = useNow(false);

  // Every disk version (load, watcher refetch, pane shown again) goes
  // through the disk-changed check.
  useEffect(() => reconcileDiskVersion(workspaceId, path, file.data), [workspaceId, path, file.data]);

  const loaded = entry?.base.contents ?? "";
  const dirty = entry?.dirty ?? false;
  const diskChanged = entry?.diskChanged ?? false;
  const saving = entry ? entry.saving !== null : false;
  const save = (overwrite = false) => saveFileBuffer(queryClient, workspaceId, path, { overwrite });
  const reloadFromDisk = () => reloadFileBuffer(workspaceId, path, file.data);
  const onChange = useCallback((text: string) => setFileBufferText(workspaceId, path, text), [workspaceId, path]);

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
      {entry && file.isError ? (
        <div role="alert" className="flex shrink-0 items-center gap-2 border-b border-(--color-border-subtle) bg-(--color-warning-tint) px-3 py-1.5 text-[12px] text-(--color-text-secondary)">
          Can't re-read this file from disk: {humanizeError(file.error)}
        </div>
      ) : null}
      <div className="relative min-h-0 flex-1">
        {!entry ? (
          file.isError ? (
            <PanelState kind="error" title="Can't open this file" error={file.error} />
          ) : (
            <PanelState kind="loading" rows={8} className="p-4" />
          )
        ) : null}
        {entry && mode === "diff" ? (
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
        ) : null}
        {entry ? (
          // Stays mounted (hidden) in Diff view so cursor and undo history
          // survive; a remount restores the text from the store's buffer.
          <div className={cn("h-full", mode === "diff" && "hidden")}>
            <Suspense
              fallback={
                <div className="grid h-full place-items-center text-(--color-text-muted)">
                  <Loader2 className="size-4 animate-spin" aria-label="Loading editor" />
                </div>
              }
            >
              <CodeEditor
                // Changes only when the document must be replaced (a reload),
                // never for our own save.
                docKey={`${path}#${entry.rev}`}
                value={entry.buffer ?? entry.base.contents}
                path={path}
                onChange={onChange}
                onSave={() => save(false)}
                onCursor={setCursor}
              />
            </Suspense>
          </div>
        ) : null}
      </div>

      <footer className="flex h-7 shrink-0 items-center gap-4 border-t border-(--color-border-subtle) bg-(--color-bg-sidebar) px-3 font-mono text-[11px] text-(--color-text-muted)">
        {saving ? (
          <span>saving…</span>
        ) : dirty ? (
          <span className="flex items-center gap-1.5 text-(--color-warning)">
            <span aria-hidden className="size-1.5 rounded-full bg-(--color-warning)" />
            unsaved · ⌘S
          </span>
        ) : (
          <span>saved</span>
        )}
        {dirty && !saving ? (
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
