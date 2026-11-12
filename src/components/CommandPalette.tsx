import { useNavigate } from "@tanstack/react-router";
import * as RadixDialog from "@radix-ui/react-dialog";
import { Command } from "cmdk";
import {
  FileText,
  FolderGit2,
  ListChecks,
  LogOut,
  NotebookPen,
  PanelRight,
  Play,
  Plus,
  Settings,
  SunMoon,
  Terminal as TerminalIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { parseQuery, scoreMatch, type PaletteMode } from "@/components/palette/parseQuery";
import { SETTINGS_SECTIONS, type SettingsSectionId } from "@/components/settings/sections";
import { useSettingsRoute } from "@/components/settings/useSettingsRoute";
import { LANE_STATUS } from "@/components/shell/TaskSidebar";
import { AGENT_META } from "@/components/ui/AgentMark";
import { Kbd } from "@/components/ui/Kbd";
import { StatusGlyph } from "@/components/ui/StatusBadge";
import { changeLetter } from "@/components/session/Inspector";
import { signOutDesktopSession } from "@/lib/desktopAuth";
import { useBoardTasks } from "@/lib/hooks/useBoardTasks";
import { useGitStatus } from "@/lib/hooks/useGit";
import { useRepoFiles } from "@/lib/hooks/useRepoFiles";
import { useRunCommands } from "@/lib/hooks/useRunCommands";
import { useWorkspace } from "@/lib/hooks/useWorkspaces";
import { matchShortcut, SHORTCUTS, type Shortcut } from "@/lib/shortcuts";
import { useUiStore } from "@/lib/store";

interface Entry {
  id: string;
  group: "Tasks" | "Files" | "Actions" | "Settings" | "Repositories";
  label: string;
  /** Extra text that matches but isn't the label (branch, path, keywords). */
  keywords?: string;
  icon: ReactNode;
  meta?: ReactNode;
  shortcut?: readonly string[];
  /** Highlight matches in this (defaults to label). */
  mono?: boolean;
  disabled?: boolean;
  run: () => void;
}

const GROUP_ORDER: Entry["group"][] = ["Tasks", "Files", "Actions", "Settings", "Repositories"];
const MODE_GROUPS: Record<PaletteMode, Entry["group"][] | null> = {
  all: null,
  commands: ["Actions", "Settings"],
  tasks: ["Tasks"],
  files: ["Files"],
  help: [],
};

/**
 * ⌘K (A-Palette): one palette for everything. No prefix searches tasks,
 * files, actions and settings at once; `>` `#` `@` `?` narrow. Scoped to the
 * current repository; Tab widens to all. Files come from the focused task's
 * worktree; settings rows show their value and jump to that row.
 */
export function CommandPalette() {
  const open = useUiStore((s) => s.commandPaletteOpen);
  const openPalette = useUiStore((s) => s.openCommandPalette);
  const closePalette = useUiStore((s) => s.closeCommandPalette);
  const togglePalette = useUiStore((s) => s.toggleCommandPalette);
  const ctx = useUiStore((s) => s.activeWorkspaceContext);
  const repoFilter = useUiStore((s) => s.repoFilter);
  const theme = useUiStore((s) => s.theme);
  const accent = useUiStore((s) => s.accent);
  const [query, setQuery] = useState("");
  const [allRepos, setAllRepos] = useState(false);
  const navigate = useNavigate();
  const settingsRoute = useSettingsRoute();
  const lastFocus = useRef<HTMLElement | null>(null);

  const canScope = !!(ctx?.repositoryId ?? repoFilter);
  const scopeRepoId = allRepos ? null : (ctx?.repositoryId ?? repoFilter);
  const { tasks, repositories } = useBoardTasks(null);
  const scopeRepo = repositories.find((r) => r.id === scopeRepoId) ?? null;
  const { data: workspace } = useWorkspace(open ? ctx?.workspaceId : null);
  const worktree = workspace?.worktreePath ?? null;
  const { data: files } = useRepoFiles(open ? worktree : null);
  const { data: changes } = useGitStatus(open && worktree ? ctx?.workspaceId : null);
  const { data: runCommands } = useRunCommands(open ? (ctx?.repositoryId ?? scopeRepoId) : null);

  useEffect(() => {
    const handler = (e: globalThis.KeyboardEvent) => {
      if (matchShortcut(e, SHORTCUTS.togglePalette)) {
        e.preventDefault();
        if (!useUiStore.getState().commandPaletteOpen) {
          lastFocus.current = document.activeElement as HTMLElement | null;
        }
        togglePalette();
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [togglePalette]);

  const close = () => {
    closePalette();
    setQuery("");
    setAllRepos(false);
    // Esc / select returns focus to where you were (a terminal keeps typing).
    const el = lastFocus.current;
    window.setTimeout(() => el?.isConnected && el.focus(), 0);
  };
  const go = (fn: () => void) => {
    close();
    fn();
  };

  const entries = useMemo<Entry[]>(() => {
    const out: Entry[] = [];
    // Tasks — most recent first.
    for (const t of tasks) {
      if (scopeRepoId && t.workspace.repositoryId !== scopeRepoId) continue;
      const ws = t.workspace;
      out.push({
        id: `task:${ws.id}`,
        group: "Tasks",
        label: ws.name,
        keywords: `${ws.branch ?? ""} ${ws.prompt ?? ""} ${t.repository?.name ?? ""}`,
        icon: <StatusGlyph kind={LANE_STATUS[t.lane]} halo={t.lane === "running"} />,
        meta: (
          <span className="truncate text-[12px] text-(--color-text-muted)">
            {ws.agent ? AGENT_META[ws.agent].label : "Agent"} · {LANE_STATUS[t.lane].replace("-", " ")}
            {ws.branch ? (
              <>
                {" · "}
                <span className="font-mono">{ws.branch}</span>
              </>
            ) : null}
          </span>
        ),
        run: () =>
          void navigate({
            to: "/repositories/$repositoryId/workspaces/$workspaceId",
            params: { repositoryId: ws.repositoryId, workspaceId: ws.id },
          }),
      });
    }
    // Files — the focused task's worktree; changed files first.
    if (ctx && files) {
      const changed = new Map((changes ?? []).map((c) => [c.path, c]));
      const ordered = [...files].sort((a, b) => Number(changed.has(b)) - Number(changed.has(a)));
      for (const path of ordered.slice(0, 4000)) {
        const c = changed.get(path);
        const badge = c ? changeLetter(c) : null;
        out.push({
          id: `file:${path}`,
          group: "Files",
          label: path,
          mono: true,
          icon: <FileText className="size-3.5 text-(--color-text-muted)" aria-hidden />,
          meta: (
            <span className="flex items-center gap-2 text-[12px] text-(--color-text-muted)">
              {badge ? <span style={{ color: badge.color }}>{badge.letter}</span> : null}
              Open in Files
            </span>
          ),
          run: () => useUiStore.getState().openSessionFile(ctx.workspaceId, path),
        });
      }
    }
    // Actions.
    const newTaskRepo = scopeRepo ?? repositories[0] ?? null;
    if (newTaskRepo) {
      out.push({
        id: "action:new-task",
        group: "Actions",
        label: `New task in ${newTaskRepo.name}…`,
        keywords: "create start agent",
        icon: <Plus className="size-3.5 text-(--color-text-muted)" aria-hidden />,
        shortcut: SHORTCUTS.newWorkspace.display,
        run: () => useUiStore.getState().requestNewWorkspace(newTaskRepo.id),
      });
    }
    if (ctx) {
      out.push(
        {
          id: "action:new-terminal",
          group: "Actions",
          label: "New terminal pane",
          keywords: "shell",
          icon: <TerminalIcon className="size-3.5 text-(--color-text-muted)" aria-hidden />,
          shortcut: SHORTCUTS.newTerminal.display,
          run: () => useUiStore.getState().openInnerTerminalTab(ctx.workspaceId),
        },
        {
          id: "action:review",
          group: "Actions",
          label: "Review changes in this task",
          keywords: "diff",
          icon: <ListChecks className="size-3.5 text-(--color-text-muted)" aria-hidden />,
          shortcut: SHORTCUTS.reviewChanges.display,
          run: () => useUiStore.getState().setSessionPane(ctx.workspaceId, "changes"),
        },
        {
          id: "action:note",
          group: "Actions",
          label: workspace ? `New note on ${workspace.name}` : "New note",
          icon: <NotebookPen className="size-3.5 text-(--color-text-muted)" aria-hidden />,
          shortcut: SHORTCUTS.openNotes.display,
          run: () => {
            const s = useUiStore.getState();
            s.setSessionPane(ctx.workspaceId, "notes");
            s.openNotesComposer();
          },
        },
        {
          id: "action:inspector",
          group: "Actions",
          label: "Toggle inspector",
          icon: <PanelRight className="size-3.5 text-(--color-text-muted)" aria-hidden />,
          shortcut: SHORTCUTS.toggleRightPanel.display,
          run: () => useUiStore.getState().toggleRightPanel(),
        },
      );
    }
    // Run commands open as a tab in the task on screen; the board has no
    // run pane, so they're offered only inside a task.
    for (const rc of ctx ? (runCommands ?? []) : []) {
      out.push({
        id: `run:${rc.id}`,
        group: "Actions",
        label: `Run: ${rc.name}`,
        keywords: rc.command,
        icon: <Play className="size-3.5 text-(--color-success)" fill="currentColor" aria-hidden />,
        meta: <span className="font-mono text-[11px] text-(--color-text-muted)">{rc.command}</span>,
        run: () => useUiStore.getState().runPanel.openTab(rc.id, ctx?.workspaceId ?? null),
      });
    }
    out.push(
      {
        id: "action:add-repo",
        group: "Actions",
        label: "Add repository…",
        keywords: "open clone folder new project",
        icon: <FolderGit2 className="size-3.5 text-(--color-text-muted)" aria-hidden />,
        run: () => useUiStore.getState().openAddRepositoryPicker(),
      },
      ...(["dark", "light", "system"] as const)
        .filter((t) => t !== theme)
        .map((t) => ({
          id: `action:theme-${t}`,
          group: "Actions" as const,
          label: `Switch to ${t} theme`,
          keywords: "appearance mode",
          icon: <SunMoon className="size-3.5 text-(--color-text-muted)" aria-hidden />,
          run: () => useUiStore.getState().setTheme(t),
        })),
      {
        id: "action:sign-out",
        group: "Actions",
        label: "Sign out",
        keywords: "log out session",
        icon: <LogOut className="size-3.5 text-(--color-text-muted)" aria-hidden />,
        run: () =>
          void signOutDesktopSession().then(() => {
            window.location.href = "/sign-in";
          }),
      },
    );
    // Settings — sections and their rows, value inline where we know it.
    const valueOf = (section: SettingsSectionId, row: string): string | undefined => {
      if (section === "appearance" && row === "theme") return theme;
      if (section === "appearance" && row === "accent") return accent;
      return undefined;
    };
    for (const section of SETTINGS_SECTIONS) {
      out.push({
        id: `settings:${section.id}`,
        group: "Settings",
        label: section.label,
        keywords: "settings preferences",
        icon: <Settings className="size-3.5 text-(--color-text-muted)" aria-hidden />,
        ...(section.id === "appearance" ? { shortcut: SHORTCUTS.openSettings.display } : {}),
        run: () => settingsRoute.open(section.id, scopeRepoId ? { repositoryId: scopeRepoId } : {}),
      });
      for (const row of section.rows) {
        if (row.label === section.label) continue;
        const value = valueOf(section.id, row.id);
        out.push({
          id: `settings:${section.id}:${row.id}`,
          group: "Settings",
          label: `${section.label} › ${row.label}`,
          keywords: `settings ${row.keywords ?? ""}`,
          icon: <Settings className="size-3.5 text-(--color-text-muted)" aria-hidden />,
          ...(value ? { meta: <span className="text-[12px] capitalize text-(--color-text-muted)">{value}</span> } : {}),
          run: () =>
            settingsRoute.open(section.id, { row: row.id, ...(scopeRepoId ? { repositoryId: scopeRepoId } : {}) }),
        });
      }
    }
    // Repositories — switch the board's scope.
    for (const r of repositories) {
      out.push({
        id: `repo:${r.id}`,
        group: "Repositories",
        label: r.name,
        keywords: r.localPath ?? "",
        icon: <FolderGit2 className="size-3.5 text-(--color-text-muted)" aria-hidden />,
        meta: <span className="truncate font-mono text-[11px] text-(--color-text-muted)">{r.localPath}</span>,
        run: () => {
          useUiStore.getState().setRepoFilter(r.id);
          void navigate({ to: "/" });
        },
      });
    }
    return out;
  }, [tasks, scopeRepoId, scopeRepo, repositories, ctx, files, changes, runCommands, workspace, theme, accent, navigate, settingsRoute]);

  const { mode, text } = parseQuery(query);
  const { groups, count, ms } = useMemo(() => {
    const t0 = performance.now();
    const allowed = MODE_GROUPS[mode];
    const scored: { e: Entry; score: number; range: [number, number] | null }[] = [];
    for (const e of entries) {
      if (allowed && !allowed.includes(e.group)) continue;
      // With no query, show a short list per group rather than 4,000 files.
      const m = scoreMatch(text, e.label) ?? (e.keywords ? scoreMatch(text, e.keywords) : null);
      if (!m) continue;
      const labelHit = scoreMatch(text, e.label);
      scored.push({ e, score: m.score + (labelHit ? 50 : 0), range: labelHit?.range ?? null });
    }
    const groups = GROUP_ORDER.map((g) => {
      const rows = scored.filter((s) => s.e.group === g);
      if (text) rows.sort((a, b) => b.score - a.score);
      const cap = text ? (g === "Files" ? 12 : 8) : g === "Files" ? 5 : g === "Tasks" ? 8 : 6;
      return { group: g, rows: rows.slice(0, mode === "all" ? cap : 50) };
    }).filter((g) => g.rows.length > 0);
    return { groups, count: groups.reduce((n, g) => n + g.rows.length, 0), ms: Math.round(performance.now() - t0) };
  }, [entries, mode, text]);

  const onInputKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Tab" && canScope) {
      e.preventDefault();
      setAllRepos((v) => !v);
    }
  };

  return (
    <Command.Dialog
      open={open}
      onOpenChange={(o) => (o ? openPalette() : close())}
      label="Command palette"
      shouldFilter={false}
      loop
      overlayClassName="fixed inset-0 z-(--z-overlay) bg-(--color-bg-overlay)"
      contentClassName="fixed left-1/2 top-[120px] z-(--z-modal) w-[min(680px,calc(100vw-32px))] -translate-x-1/2 outline-none"
    >
      <RadixDialog.Title className="sr-only">Command palette</RadixDialog.Title>
      <div className="flex flex-col overflow-hidden glass-modal animate-modal-in">
        {/* Input row and list separate by spacing; the footer by tone. */}
        <div className="flex h-[52px] items-center gap-2.5 px-4">
          <span className="flex h-[22px] shrink-0 items-center rounded-(--radius-chip) bg-(--color-bg-elevated) px-[7px] text-[12px] text-(--color-text-muted)">
            {scopeRepo?.name ?? "all repos"}
          </span>
          <Command.Input
            autoFocus
            value={query}
            onValueChange={setQuery}
            onKeyDown={onInputKeyDown}
            placeholder="Search tasks, files, commands, settings…"
            className="h-full flex-1 border-0 bg-transparent p-0 text-[15px] text-(--color-text-primary) shadow-none! outline-none placeholder:text-(--color-text-muted) focus:shadow-none!"
          />
          <span className="hidden shrink-0 font-mono text-[11px] text-(--color-text-faint) sm:block">
            &gt; cmd · # task · @ file · ? help
          </span>
        </div>

        <Command.List className="max-h-[min(520px,60vh)] overflow-y-auto px-1.5 pb-1.5">
          {mode === "help" ? (
            <HelpList />
          ) : (
            <>
              <Command.Empty className="px-3 py-6 text-center text-[13px] text-(--color-text-muted)">
                No matches{scopeRepo && !allRepos ? ` in ${scopeRepo.name} — Tab searches all repositories` : ""}.
              </Command.Empty>
              {groups.map(({ group, rows }) => (
                <Command.Group
                  key={group}
                  heading={group === "Files" && workspace ? `Files · in ${workspace.name}` : group}
                  className="[&_[cmdk-group-heading]]:group-header [&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-2"
                >
                  {rows.map(({ e, range }) => (
                    <Command.Item
                      key={e.id}
                      value={e.id}
                      disabled={!!e.disabled}
                      onSelect={() => go(e.run)}
                      // Selected = a background step (A-Polish), no outline.
                      className="flex h-9 cursor-pointer items-center gap-2.5 rounded-(--radius-control) px-2.5 text-(--color-text-primary) transition-colors duration-(--dur-1) aria-selected:bg-(--color-bg-elevated) data-[disabled=true]:opacity-40"
                    >
                      <span className="grid size-3.5 shrink-0 place-items-center">{e.icon}</span>
                      <span className={e.mono ? "min-w-0 flex-1 truncate font-mono text-[12px]" : "min-w-0 flex-1 truncate"}>
                        <Highlighted text={e.label} range={range} />
                      </span>
                      {e.meta ? <span className="flex min-w-0 max-w-[45%] shrink justify-end">{e.meta}</span> : null}
                      {e.shortcut ? <Kbd>{e.shortcut.join("")}</Kbd> : null}
                    </Command.Item>
                  ))}
                </Command.Group>
              ))}
            </>
          )}
        </Command.List>

        <div className="flex h-9 items-center gap-3.5 bg-(--color-bg-sidebar) px-3.5 text-[12px] text-(--color-text-muted)">
          <span>
            <Kbd>↑↓</Kbd> move
          </span>
          <span>
            <Kbd>↵</Kbd> open
          </span>
          {canScope ? (
            <span>
              <Kbd>tab</Kbd> scope: {allRepos ? "this repo" : "all repos"}
            </span>
          ) : null}
          <span className="flex-1" />
          <span className="tabular-nums">
            {count} {count === 1 ? "result" : "results"} · {ms} ms
          </span>
        </div>
      </div>
    </Command.Dialog>
  );
}

function Highlighted({ text, range }: { text: string; range: [number, number] | null }) {
  if (!range) return <>{text}</>;
  return (
    <>
      {text.slice(0, range[0])}
      <mark className="bg-transparent font-semibold text-(--color-accent-text)">{text.slice(range[0], range[1])}</mark>
      {text.slice(range[1])}
    </>
  );
}

const HELP: (keyof typeof SHORTCUTS)[] = [
  "togglePalette",
  "newWorkspace",
  "newTerminal",
  "reviewChanges",
  "stopAgent",
  "toggleRightPanel",
  "toggleSidebarPin",
  "openNotes",
  "openSettings",
  "searchFiles",
  "closeActiveTab",
];

function HelpList() {
  return (
    <Command.Group heading="Shortcuts" className="[&_[cmdk-group-heading]]:group-header [&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-2">
      {HELP.map((id) => {
        const s = SHORTCUTS[id] as Shortcut;
        return (
          <Command.Item
            key={id}
            value={id}
            className="flex h-8 items-center gap-2.5 rounded-(--radius-control) px-2.5 aria-selected:bg-(--color-bg-elevated)"
          >
            <span className="flex-1">{s.label}</span>
            <Kbd>{s.display.join("")}</Kbd>
          </Command.Item>
        );
      })}
      <Command.Item value="pane-focus" className="flex h-8 items-center gap-2.5 rounded-(--radius-control) px-2.5 aria-selected:bg-(--color-bg-elevated)">
        <span className="flex-1">Focus pane 1–9</span>
        <Kbd>⌘⌥1–9</Kbd>
      </Command.Item>
    </Command.Group>
  );
}
