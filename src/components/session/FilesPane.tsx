import { ChevronDown, ChevronRight, FileText, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { FileEditor } from "@/components/files/FileEditor";
import { ConfirmDialog } from "@/components/ui/Dialog";
import { useWorkspaceTree } from "@/lib/hooks/useWorkspaceFiles";
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
const NO_TABS: string[] = [];

export function FilesPane({ workspace, visible }: { workspace: Workspace; visible: boolean }) {
  const workspaceId = workspace.id;
  const root = workspace.worktreePath;
  // The backend tree (tracked + untracked, with status); the repo file list
  // when the backend doesn't answer.
  const wsTree = useWorkspaceTree(visible ? workspaceId : null);
  const fallback = useRepoFiles(visible && !Array.isArray(wsTree.data?.files) ? root : null);
  const files = wsTree.data?.files ? wsTree.data.files.map((f) => f.path) : fallback.data;
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
                "flex h-6 w-full items-center gap-1.5 rounded-(--radius-chip) pr-2 text-left font-mono text-[12px]",
                "focus-visible:outline-none focus-visible:shadow-(--ring-focus-inset)",
                selected === child.path
                  ? "bg-(--color-bg-elevated) text-(--color-text-primary)"
                  : "text-(--color-text-secondary) hover:bg-(--color-bg-hover)",
              )}
            >
              <FileText className="size-3 shrink-0 text-(--color-text-muted)" aria-hidden />
              <span className="min-w-0 flex-1 truncate">{child.name}</span>
              {badge ? (
                <span className="text-[11px]" style={{ color: badge.color }}>
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
            className="flex h-6 w-full items-center gap-1 rounded-(--radius-chip) pr-2 text-left font-mono text-[12px] text-(--color-text-secondary) hover:bg-(--color-bg-hover) focus-visible:outline-none focus-visible:shadow-(--ring-focus-inset)"
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
        <GroupHeader as="h2" className="px-3 pb-2 pt-3">
          Worktree
        </GroupHeader>
        <label className="mx-2 mb-2 flex h-7 items-center gap-1.5 rounded-(--radius-control) border border-(--color-border-default) bg-(--color-bg-base) px-2 text-(--color-text-muted) focus-within:border-(--color-focus-ring)">
          <Search className="size-3 shrink-0" aria-hidden />
          <input
            aria-label="Filter files"
            placeholder="Filter files"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="w-full border-0 bg-transparent p-0 text-[12px] text-(--color-text-primary) shadow-none outline-none focus:shadow-none"
          />
        </label>
        <div className="min-h-0 flex-1 overflow-y-auto px-1 pb-2">
          {isLoading ? <PanelState kind="loading" rows={6} /> : null}
          {error ? <PanelState kind="error" title="Couldn't list files" error={error} /> : null}
          <ul className="m-0 list-none p-0">{renderNode(tree, 0)}</ul>
        </div>
      </nav>
      <div className="relative flex min-h-0 flex-col">
        {openTabs.length > 0 ? (
          <div role="tablist" aria-label="Open files" className="flex h-8 shrink-0 items-stretch overflow-x-auto border-b border-(--color-border-subtle) bg-(--color-bg-sidebar)">
            {openTabs.map((p) => {
              const change = changeByPath.get(p);
              const badge = change ? changeLetter(change as FileChange) : null;
              const active = p === selected;
              return (
                <div
                  key={p}
                  className={cn(
                    "group/ftab flex items-center gap-1.5 border-r border-(--color-border-subtle) pl-3 pr-1.5 font-mono text-[12px]",
                    active ? "bg-(--color-bg-base) text-(--color-text-primary)" : "text-(--color-text-muted)",
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
                  {dirtyPaths.includes(p) ? <span aria-label="unsaved" className="size-1.5 rounded-full bg-(--color-warning)" /> : null}
                  <button
                    type="button"
                    aria-label={`Close ${p}`}
                    onClick={() => (dirtyPaths.includes(p) ? setConfirmClose(p) : closeTab(p))}
                    className="grid size-4 place-items-center rounded-(--radius-chip) opacity-0 hover:bg-(--color-bg-hover) group-hover/ftab:opacity-100 focus-visible:opacity-100 focus-visible:outline-none"
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
