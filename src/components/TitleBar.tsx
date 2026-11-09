import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Link, useLocation, useNavigate, useParams } from "@tanstack/react-router";
import { Check, ChevronDown, Layers, LogOut, Plus, Search, Settings as SettingsIcon, UserRound } from "lucide-react";
import { useSyncExternalStore } from "react";
import { useSettingsRoute } from "@/components/settings/useSettingsRoute";
import { InboxBell } from "@/components/shell/InboxBell";
import { GlassTooltip } from "@/components/ui/GlassTooltip";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/components/ui/Menu";
import { RepoMark } from "@/components/ui/RepoMark";
import type { TaskLane } from "@/lib/board";
import { useBoardTasks } from "@/lib/hooks/useBoardTasks";
import { useRepositories } from "@/lib/hooks/useRepositories";
import { type SyncState, useSyncState } from "@/lib/hooks/useSyncState";
import { useWorkspace } from "@/lib/hooks/useWorkspaces";
import {
  type DesktopSession,
  desktopSessionKey,
  onDesktopSessionChanged,
  readDesktopSession,
  signOutDesktopSession,
} from "@/lib/desktopAuth";
import { SHORTCUTS } from "@/lib/shortcuts";
import { useUiStore } from "@/lib/store";
import { cn } from "@/lib/utils";

const isMac =
  typeof navigator !== "undefined" && /Mac/i.test(navigator.platform ?? navigator.userAgent);

// Cache the session by its stable key so useSyncExternalStore's getSnapshot
// returns a referentially-stable value between changes (readDesktopSession()
// allocates a fresh object on every call otherwise).
let sessionSnapshot: DesktopSession | null = null;
let sessionSnapshotKey: string | null = null;
function getSessionSnapshot(): DesktopSession | null {
  const next = readDesktopSession();
  const key = desktopSessionKey(next);
  if (key !== sessionSnapshotKey) {
    sessionSnapshotKey = key;
    sessionSnapshot = next;
  }
  return sessionSnapshot;
}

/** Reactive desktop session — re-renders when sign-in/out changes it. */
function useDesktopSession(): DesktopSession | null {
  return useSyncExternalStore(
    onDesktopSessionChanged,
    getSessionSnapshot,
    () => null,
  );
}

/**
 * Title bar (A-Polish, spec §4.1): 44px, text only, no boxes. Traffic-light
 * inset, the repository switcher (ghost), `/ ● task` with its branch when a
 * task is open, then Board, the ⌘K search, the inbox bell, settings and the
 * account avatar. The whole bar is a Tauri drag region — interactive
 * children stop the drag.
 */
export function TitleBar() {
  const settingsRoute = useSettingsRoute();
  const openCommandPalette = useUiStore((s) => s.openCommandPalette);
  const session = useDesktopSession();
  const sync = useSyncState();
  const params = useParams({ strict: false }) as { repositoryId?: string; workspaceId?: string };
  const inSession = !!params.workspaceId;
  const location = useLocation();
  const onBoard = location.pathname === "/";

  return (
    <header
      data-tauri-drag-region
      className="relative z-20 flex h-(--layout-header-height) shrink-0 items-center gap-[6px] border-b border-(--color-border-subtle) bg-(--color-bg-sidebar)"
      style={{ paddingLeft: isMac ? 92 : 16, paddingRight: 16 }}
    >
      <RepoSwitcher />
      {inSession ? <TaskBreadcrumb workspaceId={params.workspaceId!} /> : null}
      <div className="flex-1 self-stretch" data-tauri-drag-region />
      <nav aria-label="Primary" className="flex gap-[2px]" data-tauri-drag-region>
        <Link
          to="/"
          aria-current={onBoard ? "page" : undefined}
          className={cn(
            "flex h-[28px] items-center rounded-(--radius-control) px-[10px] text-[13px] no-underline transition-colors duration-(--dur-1)",
            "focus-visible:outline-none focus-visible:shadow-(--ring-focus)",
            onBoard
              ? "bg-(--color-bg-elevated) font-medium text-(--color-text-primary)"
              : "text-(--color-text-secondary) hover:bg-(--color-bg-surface) hover:text-(--color-text-primary)",
          )}
        >
          Board
        </Link>
      </nav>
      <GlassTooltip content={`Search (${SHORTCUTS.togglePalette.display.join("")})`} side="bottom">
        <button type="button" aria-label="Search" onClick={openCommandPalette} className={titleIconClass}>
          <Search className="size-[15px]" aria-hidden />
        </button>
      </GlassTooltip>
      <InboxBell sync={sync} className={titleIconClass} />
      <GlassTooltip content={`Settings (${SHORTCUTS.openSettings.display.join("")})`} side="bottom">
        <button type="button" aria-label="Settings" onClick={() => settingsRoute.open()} className={titleIconClass}>
          <SettingsIcon className="size-[15px]" aria-hidden />
        </button>
      </GlassTooltip>
      <ProfileMenu session={session} sync={sync} onSettings={() => settingsRoute.open()} />
    </header>
  );
}

/** 28px borderless icon button (A-Polish title bar). */
const titleIconClass = cn(
  "relative grid size-[28px] shrink-0 place-items-center rounded-(--radius-control) text-(--color-text-secondary)",
  "transition-colors duration-(--dur-1) hover:bg-(--color-bg-elevated) hover:text-(--color-text-primary)",
  "focus-visible:outline-none focus-visible:shadow-(--ring-focus) data-[state=open]:bg-(--color-bg-elevated)",
);

function RepoSwitcher() {
  const { data: repositories } = useRepositories();
  const repoFilter = useUiStore((s) => s.repoFilter);
  const setRepoFilter = useUiStore((s) => s.setRepoFilter);
  const openAddRepositoryPicker = useUiStore((s) => s.openAddRepositoryPicker);
  const params = useParams({ strict: false }) as { repositoryId?: string };
  const navigate = useNavigate();
  // In a task session the switcher names that task's repository; on the
  // board it names the filter.
  const currentId = params.repositoryId ?? repoFilter;
  const current = repositories?.find((r) => r.id === currentId) ?? null;

  return (
    <Menu>
      <MenuTrigger asChild>
        <button
          type="button"
          aria-label={`Repository: ${current?.name ?? "All repositories"}`}
          className={cn(
            "flex h-[28px] min-w-0 shrink-0 items-center gap-[6px] rounded-(--radius-control) px-[8px] text-[13px] font-medium text-(--color-text-primary)",
            "transition-colors duration-(--dur-1) hover:bg-(--color-bg-elevated) data-[state=open]:bg-(--color-bg-elevated)",
            "focus-visible:outline-none focus-visible:shadow-(--ring-focus)",
          )}
        >
          {current ? (
            <RepoMark id={current.id} name={current.name} size={16} />
          ) : (
            <span aria-hidden className="grid size-[16px] place-items-center rounded-[4px] bg-(--color-bg-elevated) text-(--color-text-muted)">
              <Layers className="size-2.5" />
            </span>
          )}
          <span className="max-w-[180px] truncate">{current?.name ?? "All repositories"}</span>
          <ChevronDown className="size-[12px] text-(--color-text-muted)" aria-hidden />
        </button>
      </MenuTrigger>
      <MenuContent width={240}>
        <MenuItem
          icon={<Layers className="size-3.5" />}
          trailing={!currentId ? <Check className="size-3.5 text-(--color-accent-text)" /> : null}
          onSelect={() => {
            setRepoFilter(null);
            void navigate({ to: "/" });
          }}
        >
          All repositories
        </MenuItem>
        {repositories && repositories.length > 0 ? <MenuSeparator /> : null}
        {repositories?.map((r) => (
          <MenuItem
            key={r.id}
            icon={<RepoMark id={r.id} name={r.name} />}
            trailing={r.id === currentId ? <Check className="size-3.5 text-(--color-accent-text)" /> : null}
            onSelect={() => {
              setRepoFilter(r.id);
              void navigate({ to: "/" });
            }}
          >
            {r.name}
          </MenuItem>
        ))}
        <MenuSeparator />
        <MenuItem icon={<Plus className="size-3.5" />} onSelect={openAddRepositoryPicker}>
          Add repository
        </MenuItem>
      </MenuContent>
    </Menu>
  );
}

const LANE_DOT: Record<TaskLane, string> = {
  queued: "var(--color-status-queued)",
  running: "var(--color-status-running)",
  "needs-you": "var(--color-status-attention)",
  review: "var(--color-status-review)",
  failed: "var(--color-status-danger)",
  done: "var(--color-status-success)",
};

/**
 * `/ ● task name  branch` — the dot carries a 3px glow in its status hue;
 * the branch is plain muted mono. The base branch lives in the inspector.
 */
function TaskBreadcrumb({ workspaceId }: { workspaceId: string }) {
  const { data: ws } = useWorkspace(workspaceId);
  const { tasks } = useBoardTasks(null);
  if (!ws) return null;
  const isAgent = ws.workspaceKind === "agent";
  const lane: TaskLane | null = isAgent
    ? (tasks.find((t) => t.workspace.id === ws.id)?.lane ??
      (ws.status === "running" ? "running" : ws.status === "failed" ? "failed" : "queued"))
    : null;
  return (
    <div className="flex min-w-0 items-center gap-[6px]" data-tauri-drag-region>
      <span aria-hidden className="text-(--color-text-faint)">
        /
      </span>
      <span className="flex h-[28px] min-w-0 items-center gap-[8px] px-[8px] text-[13px] font-medium text-(--color-text-primary)">
        {lane ? (
          <span
            aria-hidden
            className="size-[6px] shrink-0 rounded-full"
            style={{
              background: LANE_DOT[lane],
              boxShadow: `0 0 0 3px color-mix(in srgb, ${LANE_DOT[lane]} 18%, transparent)`,
            }}
          />
        ) : null}
        <span className="truncate">{isAgent ? ws.name : "local"}</span>
      </span>
      {ws.branch ? (
        <span className="min-w-0 shrink truncate font-mono text-[11px] text-(--color-text-muted)">{ws.branch}</span>
      ) : null}
    </div>
  );
}

function ProfileMenu({
  session,
  sync,
  onSettings,
}: {
  session: DesktopSession | null;
  sync: SyncState;
  onSettings: () => void;
}) {
  const signOut = () => {
    void signOutDesktopSession().then(() => {
      window.location.href = "/sign-in";
    });
  };

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          title="Account menu"
          aria-label="Account menu"
          className="ml-[6px] grid size-[24px] shrink-0 place-items-center rounded-full text-(--color-text-secondary) focus-visible:outline-none focus-visible:shadow-(--ring-focus)"
        >
          <ProfileAvatar session={session} />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={6}
          className="z-(--z-dropdown) min-w-44 origin-top-right overflow-hidden surface-floating p-1 text-[12px] data-[state=open]:animate-popover-in data-[state=closed]:animate-popover-out"
        >
          {/* Sync state (spec D1): the status bar's line, now here. */}
          <DropdownMenu.Label
            aria-live="polite"
            className="flex h-[32px] items-center gap-[8px] px-[8px] text-(--color-text-muted)"
            title={sync.reason ?? undefined}
          >
            <span aria-hidden className="size-[6px] shrink-0 rounded-full" style={{ background: SYNC_DOT[sync.phase] }} />
            <span className="min-w-0 max-w-[240px] truncate">{sync.label}</span>
          </DropdownMenu.Label>
          <DropdownMenu.Separator className="my-1 h-px bg-(--color-border-subtle)" />
          <DropdownMenu.Item
            onSelect={onSettings}
            className={menuItemClassName()}
          >
            <SettingsIcon size={13} />
            <span>Settings</span>
          </DropdownMenu.Item>
          <DropdownMenu.Separator className="my-1 h-px bg-(--color-border-subtle)" />
          <DropdownMenu.Item
            onSelect={signOut}
            className={menuItemClassName("text-(--color-danger-text)")}
          >
            <LogOut size={13} />
            <span>Log out</span>
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

const SYNC_DOT: Record<SyncState["phase"], string> = {
  idle: "var(--color-status-success)",
  syncing: "var(--color-status-running)",
  error: "var(--color-status-danger)",
  off: "var(--color-status-queued)",
  unknown: "var(--color-status-queued)",
};

function ProfileAvatar({ session }: { session: DesktopSession | null }) {
  if (session?.profile.imageUrl) {
    return (
      <img
        src={session.profile.imageUrl}
        alt=""
        className="size-[24px] rounded-full object-cover"
      />
    );
  }

  const initials = session ? accountInitials(session) : null;
  if (initials) {
    return (
      <span className="flex size-[24px] items-center justify-center rounded-full bg-[#2e7d5b] text-[11px] font-semibold uppercase leading-none text-white">
        {initials}
      </span>
    );
  }

  return <UserRound size={14} />;
}

function accountInitials(session: DesktopSession) {
  const label = session.profile.name || session.profile.email || "Phasr";
  const parts = label
    .replace(/@.*/, "")
    .split(/\s+/)
    .map((part) => part.trim())
    .filter(Boolean);

  // Spread-index so emoji / non-BMP characters aren't split into surrogate
  // halves.
  const firstChar = (word: string | undefined) =>
    word ? ([...word][0] ?? "") : "";

  if (parts.length >= 2) {
    return `${firstChar(parts[0])}${firstChar(parts[1])}`.toUpperCase();
  }

  const single = parts[0] ? [...parts[0]].slice(0, 2).join("") : "";
  return (single || "P").toUpperCase();
}

function menuItemClassName(className?: string) {
  return cn(
    "flex h-8 cursor-pointer select-none items-center gap-2 rounded-(--radius-control) px-2",
    "text-(--color-text-primary) outline-none transition-colors duration-100",
    "data-[highlighted]:bg-(--color-bg-hover)",
    className,
  );
}
