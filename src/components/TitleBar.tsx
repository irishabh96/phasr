import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Link, useLocation, useNavigate, useParams } from "@tanstack/react-router";
import { Check, ChevronDown, Layers, LogOut, Plus, Search, Settings as SettingsIcon, UserRound } from "lucide-react";
import { useSyncExternalStore } from "react";
import { useSettingsRoute } from "@/components/settings/useSettingsRoute";
import { InboxBell } from "@/components/shell/InboxBell";
import { Button } from "@/components/ui/Button";
import { Chip } from "@/components/ui/Chip";
import { Kbd } from "@/components/ui/Kbd";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/components/ui/Menu";
import { RepoMark } from "@/components/ui/RepoMark";
import { StatusGlyph } from "@/components/ui/StatusBadge";
import { useRepositories, useRepository } from "@/lib/hooks/useRepositories";
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
 * Title bar (A: 44px). Traffic-light inset, repository switcher, breadcrumb
 * to the open task, primary nav, ⌘K search field, settings, account. The
 * whole bar is a Tauri drag region — interactive children stop the drag.
 */
export function TitleBar() {
  const settingsRoute = useSettingsRoute();
  const openCommandPalette = useUiStore((s) => s.openCommandPalette);
  const session = useDesktopSession();
  const params = useParams({ strict: false }) as { repositoryId?: string; workspaceId?: string };
  const inSession = !!params.workspaceId;
  const location = useLocation();
  const onBoard = location.pathname === "/";

  return (
    <header
      data-tauri-drag-region
      className="relative z-20 flex h-(--layout-header-height) shrink-0 items-center gap-4 border-b border-(--color-border-subtle) bg-(--color-bg-sidebar)"
      style={{ paddingLeft: isMac ? 92 : 16, paddingRight: 16 }}
    >
      <RepoSwitcher />
      {inSession ? <TaskBreadcrumb workspaceId={params.workspaceId!} /> : null}
      <nav aria-label="Primary" className="flex gap-0.5" data-tauri-drag-region>
        <Link
          to="/"
          aria-current={onBoard ? "page" : undefined}
          className={cn(
            "rounded-(--radius-control) px-2.5 py-1.5 text-[13px] no-underline transition-colors duration-100",
            "focus-visible:outline-none focus-visible:shadow-(--ring-focus)",
            onBoard
              ? "bg-(--color-bg-elevated) font-medium text-(--color-text-primary)"
              : "text-(--color-text-muted) hover:text-(--color-text-secondary)",
          )}
        >
          Board
        </Link>
      </nav>
      <div className="flex-1 self-stretch" data-tauri-drag-region />
      <button
        type="button"
        onClick={openCommandPalette}
        className={cn(
          "flex h-7 items-center gap-2 rounded-(--radius-control) border border-(--color-border-default) bg-(--color-bg-base) px-2.5 text-left text-[13px] text-(--color-text-muted)",
          "transition-colors duration-100 hover:border-(--color-border-strong)",
          "focus-visible:outline-none focus-visible:shadow-(--ring-focus)",
          inSession ? "w-[200px]" : "w-[320px]",
        )}
      >
        <Search className="size-3.5 shrink-0" aria-hidden />
        <span className="flex-1 truncate">{inSession ? "Search…" : "Search tasks, files, commands…"}</span>
        <Kbd>{SHORTCUTS.togglePalette.display.join("")}</Kbd>
      </button>
      <InboxBell />
      <Button
        variant="secondary"
        size="icon"
        aria-label="Settings"
        title={`Settings (${SHORTCUTS.openSettings.display.join("")})`}
        onClick={() => settingsRoute.open()}
        className="text-(--color-text-muted)"
      >
        <SettingsIcon className="size-3.5" aria-hidden />
      </Button>
      <ProfileMenu session={session} onSettings={() => settingsRoute.open()} />
    </header>
  );
}

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
          className="flex h-7 items-center gap-2 rounded-(--radius-control) border border-(--color-border-default) bg-(--color-bg-surface) px-2.5 text-[13px] font-medium text-(--color-text-primary) transition-colors duration-100 hover:border-(--color-border-strong) focus-visible:outline-none focus-visible:shadow-(--ring-focus) data-[state=open]:border-(--color-border-strong)"
        >
          {current ? (
            <RepoMark id={current.id} name={current.name} size={16} />
          ) : (
            <span aria-hidden className="grid size-4 place-items-center rounded-(--radius-chip) bg-(--color-bg-elevated) text-(--color-text-muted)">
              <Layers className="size-2.5" />
            </span>
          )}
          <span className="max-w-[180px] truncate">{current?.name ?? "All repositories"}</span>
          <ChevronDown className="size-3 text-(--color-text-muted)" aria-hidden />
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

function TaskBreadcrumb({ workspaceId }: { workspaceId: string }) {
  const { data: ws } = useWorkspace(workspaceId);
  const { data: repo } = useRepository(ws?.repositoryId);
  if (!ws) return null;
  const base = ws.baseBranch ?? repo?.defaultBranch ?? null;
  return (
    <div className="flex min-w-0 items-center gap-3" data-tauri-drag-region>
      <span aria-hidden className="text-(--color-text-faint)">
        ›
      </span>
      <span className="flex min-w-0 items-center gap-2 text-[13px] font-medium">
        {ws.workspaceKind === "agent" ? (
          <StatusGlyph kind={ws.status === "running" ? "running" : ws.status === "failed" ? "failed" : "queued"} halo={ws.status === "running"} />
        ) : null}
        <span className="truncate">{ws.workspaceKind === "local" ? "local" : ws.name}</span>
        {ws.branch ? (
          <Chip tone="outline" mono className="font-normal">
            {ws.branch}
            {base && ws.workspaceKind === "agent" ? ` ← ${base}` : ""}
          </Chip>
        ) : null}
      </span>
    </div>
  );
}

function ProfileMenu({
  session,
  onSettings,
}: {
  session: DesktopSession | null;
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
          className="grid size-7 place-items-center rounded-full focus-visible:outline-none focus-visible:shadow-(--ring-focus)"
        >
          <ProfileAvatar session={session} />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={6}
          className="z-(--z-dropdown) min-w-44 origin-top-right overflow-hidden rounded-(--radius-card) border border-(--color-border-strong) bg-(--color-bg-dropdown) p-1 text-[12px] shadow-(--shadow-dropdown) animate-[modal-in_120ms_var(--ease-glass)]"
        >
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

function ProfileAvatar({ session }: { session: DesktopSession | null }) {
  if (session?.profile.imageUrl) {
    return (
      <img
        src={session.profile.imageUrl}
        alt=""
        className="size-7 rounded-full object-cover"
      />
    );
  }

  const initials = session ? accountInitials(session) : null;
  if (initials) {
    return (
      <span className="flex size-7 items-center justify-center rounded-full bg-(--color-success) text-[12px] font-semibold uppercase leading-none text-white">
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
