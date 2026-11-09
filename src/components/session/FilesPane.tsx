import { ChevronDown, ChevronRight, FileText, Search } from "lucide-react";
import { memo, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { FileEditor } from "@/components/files/FileEditor";
import { ConfirmDialog } from "@/components/ui/Dialog";
import { useRefreshWorkspaceFilesOnShow, useWorkspaceTree } from "@/lib/hooks/useWorkspaceFiles";
import { GroupHeader } from "@/components/ui/GroupHeader";
import { PanelState } from "@/components/ui/PanelState";
import { useGitStatus } from "@/lib/hooks/useGit";
import { useRepoFiles } from "@/lib/hooks/useRepoFiles";
import type { FileChange, Workspace } from "@/lib/types";
import { fileBufferKey, useUiStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { changeLetter } from "./Inspector";

interface TreeNode {
  name: string;
  path: string;
  children: Map<string, TreeNode>;
  isFile: boolean;
}

export function buildFileTree(paths: string[]): TreeNode {
  const root: TreeNode = { name: "", path: "", children: new Map(), isFile: false };
  for (const p of paths) {
    const parts = p.split("/");
    let node = root;
    parts.forEach((part, i) => {
      const path = parts.slice(0, i + 1).join("/");
      let child = node.children.get(part);
      if (!child) {
        child = { name: part, path, children: new Map(), isFile: i === parts.length - 1 };
        node.children.set(part, child);
      }
      node = child;
    });
  }
  return root;
}

function sortedChildren(node: TreeNode): TreeNode[] {
  return [...node.children.values()].sort((a, b) =>
    a.isFile === b.isFile ? a.name.localeCompare(b.name) : a.isFile ? 1 : -1,
  );
}

/**
 * Files pane tab (A-Editor): the worktree's file tree with git status
 * badges beside a viewer. Changed files' folders start expanded.
 */
export const FilesPane = memo(FilesPaneImpl, (a, b) =>
  // The route re-renders on every workspace refetch (agent-state events
  // from any task); only these fields matter here.
  a.visible === b.visible && a.workspace.id === b.workspace.id && a.workspace.worktreePath === b.workspace.worktreePath,
);

const NO_TABS: string[] = [];

function FilesPaneImpl({ workspace, visible }: { workspace: Workspace; visible: boolean }) {
  const workspaceId = workspace.id;
  const root = workspace.worktreePath;
  // The backend tree (tracked + untracked, with status); the repo file list
  // when the backend doesn't answer.
  const wsTree = useWorkspaceTree(visible ? workspaceId : null);
  useRefreshWorkspaceFilesOnShow(workspaceId, visible);
  const treeFiles = wsTree.data?.files;
  const fallback = useRepoFiles(visible && !Array.isArray(treeFiles) ? root : null);
  // Keyed on the query data's identity (structurally shared across
  // refetches), so the tree below is rebuilt only when the files change.
  const files = useMemo(() => (treeFiles ? treeFiles.map((f) => f.path) : fallback.data), [treeFiles, fallback.data]);
  const isLoading = wsTree.isLoading || fallback.isLoading;
  const error = wsTree.data ? null : fallback.error;
  const { data: changes } = useGitStatus(workspaceId);
  // Tabs and buffers live in the store: they survive task switches, and a
  // closed tab is really gone (so opening it again works).
  const openTabs = useUiStore((s) => s.openFiles[workspaceId] ?? NO_TABS);
  const dirtyPaths = useUiStore(
    useShallow((s) => openTabs.filter((p) => s.fileBuffers[fileBufferKey(workspaceId, p)]?.dirty)),
  );
  const closeSessionFile = useUiStore((s) => s.closeSessionFile);
  const [confirmClose, setConfirmClose] = useState<string | null>(null);
  const closeTab = (p: string) => closeSessionFile(workspaceId, p);
  const [filter, setFilter] = useState("");
  const selected = useUiStore((s) => s.sessionFile[workspaceId] ?? null);
  const openSessionFile = useUiStore((s) => s.openSessionFile);
  const setSelected = (path: string) => openSessionFile(workspaceId, path);
  const [open, setOpen] = useState<Set<string>>(new Set());

  const changeByPath = useMemo(() => new Map((changes ?? []).map((c) => [c.path, c])), [changes]);
  const tree = useMemo(() => {
    const all = files ?? [];
    const q = filter.trim().toLowerCase();
    return buildFileTree(q ? all.filter((f) => f.toLowerCase().includes(q)) : all);
  }, [files, filter]);
  const autoOpen = useMemo(() => {
    const s = new Set<string>();
    for (const c of changes ?? []) {
      const parts = c.path.split("/");
      for (let i = 1; i < parts.length; i++) s.add(parts.slice(0, i).join("/"));
    }
    return s;
  }, [changes]);
  const isOpen = (p: string) => filter.trim() !== "" || open.has(p) || (autoOpen.has(p) && !open.has(`!${p}`));
  const toggle = (p: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (isOpen(p)) {
        next.delete(p);
        next.add(`!${p}`);
      } else {
        next.add(p);
        next.delete(`!${p}`);
      }
      return next;
    });

  if (!root) return null;

  const renderNode = (node: TreeNode, depth: number) =>
    sortedChildren(node).map((child) => {
      if (child.isFile) {
        const change = changeByPath.get(child.path);
        const badge = change ? changeLetter(change as FileChange) : null;
        return (
          <li key={child.path}>
            <button
              type="button"
              onClick={() => setSelected(child.path)}
              aria-current={selected === child.path ? "true" : undefined}
              style={{ paddingLeft: 8 + depth * 12 }}
              className={cn(
                "flex h-6 w-full items-center gap-1.5 rounded-(--radius-control) pr-2 text-left text-[12px]",
                "transition-colors duration-(--dur-1) ease-(--ease-out)",
                "focus-visible:outline-none focus-visible:shadow-(--ring-focus-inset)",
                // Selected = a background step, never an outline.
                selected === child.path
                  ? "bg-(--color-bg-elevated) text-(--color-text-primary)"
                  : "text-(--color-text-secondary) hover:bg-(--color-bg-elevated)/60",
              )}
            >
              <FileText className="size-3 shrink-0 text-(--color-text-faint)" aria-hidden />
              <span className="min-w-0 flex-1 truncate">{child.name}</span>
              {badge ? (
                <span className="font-mono text-[10px]" style={{ color: badge.color }}>
                  {badge.letter}
                </span>
              ) : null}
            </button>
          </li>
        );
      }
      const expanded = isOpen(child.path);
      return (
        <li key={child.path}>
          <button
            type="button"
            aria-expanded={expanded}
            onClick={() => toggle(child.path)}
            style={{ paddingLeft: 4 + depth * 12 }}
            className="flex h-6 w-full items-center gap-1 rounded-(--radius-control) pr-2 text-left text-[12px] text-(--color-text-secondary) transition-colors duration-(--dur-1) ease-(--ease-out) hover:bg-(--color-bg-elevated)/60 focus-visible:outline-none focus-visible:shadow-(--ring-focus-inset)"
          >
            {expanded ? (
              <ChevronDown className="size-3 shrink-0 text-(--color-text-muted)" aria-hidden />
            ) : (
              <ChevronRight className="size-3 shrink-0 text-(--color-text-muted)" aria-hidden />
            )}
            <span className="truncate">{child.name}</span>
          </button>
          {expanded ? <ul className="m-0 list-none p-0">{renderNode(child, depth + 1)}</ul> : null}
        </li>
      );
    });

  return (
    <div className="grid h-full min-h-0 grid-cols-[240px_minmax(0,1fr)]">
      <nav aria-label="Worktree files" className="flex min-h-0 flex-col border-r border-(--color-border-subtle) bg-(--color-bg-sidebar)">
        <GroupHeader as="h2" className="h-[34px] shrink-0 px-3">
          Worktree
          {workspace.branch ? (
            <span className="font-normal">
              {" · "}
              <span className="font-mono text-[11px]">{workspace.branch.slice(workspace.branch.lastIndexOf("/") + 1)}</span>
            </span>
          ) : null}
        </GroupHeader>
        {/* A-Polish input: inset fill + hairline ring, accent ring on focus. */}
        <label className="mx-2.5 mb-1 flex h-[26px] shrink-0 items-center gap-1.5 rounded-(--radius-control) bg-(--color-bg-input) px-2 text-(--color-text-muted) shadow-(--ring-input) transition-shadow duration-(--dur-1) focus-within:shadow-(--ring-input-focus)">
          <Search className="size-3 shrink-0" aria-hidden />
          <input
            aria-label="Filter files"
            placeholder="Filter files"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="w-full border-0 bg-transparent p-0 text-[12px] text-(--color-text-primary) shadow-none outline-none focus:shadow-none"
          />
        </label>
        <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2 pt-1">
          {isLoading ? <PanelState kind="loading" rows={6} /> : null}
          {error ? <PanelState kind="error" title="Couldn't list files" error={error} /> : null}
          <ul className="m-0 list-none p-0">{renderNode(tree, 0)}</ul>
        </div>
      </nav>
      <div className="relative flex min-h-0 flex-col">
        {openTabs.length > 0 ? (
          <div role="tablist" aria-label="Open files" className="flex h-[34px] shrink-0 items-stretch gap-1 overflow-x-auto px-2">
            {openTabs.map((p) => {
              const change = changeByPath.get(p);
              const badge = change ? changeLetter(change as FileChange) : null;
              const active = p === selected;
              return (
                <div
                  key={p}
                  className={cn(
                    // Tabs are underlines: 2px in the text colour when active.
                    "group/ftab flex shrink-0 items-center gap-1.5 border-b-2 pl-2 pr-1 font-mono text-[11.5px]",
                    "transition-[color,border-color] duration-(--dur-1) ease-(--ease-out)",
                    active
                      ? "border-(--color-text-primary) text-(--color-text-primary)"
                      : "border-transparent text-(--color-text-muted) hover:text-(--color-text-secondary)",
                  )}
                >
                  <button
                    type="button"
                    role="tab"
                    aria-selected={active}
                    onClick={() => setSelected(p)}
                    className="flex items-center gap-1.5 focus-visible:outline-none focus-visible:underline"
                  >
                    {badge ? (
                      <span className="text-[11px]" style={{ color: badge.color }}>
                        {badge.letter}
                      </span>
                    ) : null}
                    {p.slice(p.lastIndexOf("/") + 1)}
                  </button>
                  {dirtyPaths.includes(p) ? <span aria-label="unsaved" className="size-1.5 rounded-full bg-(--color-text-primary)" /> : null}
                  <button
                    type="button"
                    aria-label={`Close ${p}`}
                    onClick={() => (dirtyPaths.includes(p) ? setConfirmClose(p) : closeTab(p))}
                    className="grid size-4 place-items-center rounded-(--radius-chip) opacity-0 transition-opacity duration-(--dur-1) hover:bg-(--color-bg-elevated) group-hover/ftab:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:shadow-(--ring-focus)"
                  >
                    ×
                  </button>
                </div>
              );
            })}
          </div>
        ) : null}
        {openTabs.length > 0 ? (
          <div className="relative min-h-0 flex-1">
            {/* Every open tab stays mounted (hidden) so its buffer, cursor and
                undo history survive switching tabs. */}
            {openTabs.map((p) => (
              <div key={p} className={cn("absolute inset-0", p !== selected && "hidden")}>
                <FileEditor workspaceId={workspaceId} path={p} />
              </div>
            ))}
          </div>
        ) : (
          <div className="flex h-full items-center justify-center text-[12px] text-(--color-text-muted)">
            Pick a file to view it.
          </div>
        )}
      </div>
      <ConfirmDialog
        open={confirmClose !== null}
        onOpenChange={(o) => !o && setConfirmClose(null)}
        title="Close without saving?"
        description={`${confirmClose ?? ""} has unsaved changes. Closing the tab discards them.`}
        confirmLabel="Discard changes"
        destructive
        onConfirm={() => {
          if (confirmClose) closeTab(confirmClose);
          setConfirmClose(null);
        }}
      />
    </div>
  );
}
