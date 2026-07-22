import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { useNavigate } from "@tanstack/react-router";
import {
  LogOut,
  Search,
  Settings as SettingsIcon,
  UserRound,
} from "lucide-react";
import { useSyncExternalStore } from "react";
import { GlassButton } from "@/components/ui/GlassButton";
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
  typeof navigator !== "undefined" &&
  /Mac/i.test(navigator.platform ?? navigator.userAgent);

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
 * Transparent overlay titlebar. On macOS the native traffic lights stick out
 * the top-left, so we leave them ~92px of clearance. The whole bar is a
 * Tauri drag region — interactive children stop the drag automatically.
 *
 * Three balanced zones: the wordmark (left), an absolutely-centered command
 * trigger (a discoverable ⌘K affordance — the app is keyboard-first, so the
 * bar hands the user its single global "search or jump to" entry point instead
 * of a bare, unexplained magnifier), and the account menu (right).
 */
export function TitleBar() {
  const navigate = useNavigate();
  const openCommandPalette = useUiStore((s) => s.openCommandPalette);
  const session = useDesktopSession();

  return (
    <div
      data-tauri-drag-region
      className="relative z-20 flex h-[var(--layout-header-height)] shrink-0 items-center justify-between border-b border-(--color-border-subtle)"
      style={{
        paddingLeft: isMac ? 92 : 14,
        paddingRight: 10,
      }}
    >
      <div
        data-tauri-drag-region
        className="flex min-w-0 items-center leading-none"
      >
        <span className="text-[13px] font-semibold leading-none tracking-[-0.01em] text-(--color-text-primary)">
          Phasr
        </span>
      </div>

      <CommandTrigger onOpen={openCommandPalette} />

      <div className="flex items-center">
        <ProfileMenu
          session={session}
          onSettings={() => void navigate({ to: "/settings" })}
        />
      </div>
    </div>
  );
}

/**
 * The centered global command/search affordance. Reads as a field but is a
 * button — it opens the ⌘K command palette (honest: there is no separate
 * search index). Kept deliberately quiet (glass + hairline, muted copy, no
 * coral) so it balances the sparse bar without competing with the work below.
 */
function CommandTrigger({ onOpen }: { onOpen: () => void }) {
  return (
    <div className="pointer-events-none absolute left-1/2 top-1/2 w-[min(400px,42vw)] -translate-x-1/2 -translate-y-1/2">
      <button
        type="button"
        onClick={onOpen}
        aria-label="Search or run a command"
        className={cn(
          "pointer-events-auto group flex h-7 w-full items-center gap-2 rounded-full px-3",
          "border border-(--glass-border-hairline) bg-(--glass-panel) backdrop-blur-md",
          "text-(--color-text-muted) transition-colors duration-150",
          "hover:border-(--color-border-strong) hover:text-(--color-text-secondary)",
          "focus-visible:outline-none focus-visible:border-(--color-accent-500) focus-visible:shadow-[var(--ring-focus)]",
        )}
      >
        <Search size={13} className="shrink-0" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate text-left text-[12.5px] leading-none">
          Search or jump to…
        </span>
        <span className="flex shrink-0 items-center gap-0.5" aria-hidden="true">
          {SHORTCUTS.togglePalette.display.map((seg, i) => (
            <kbd
              key={i}
              className="inline-flex h-[17px] min-w-[17px] items-center justify-center rounded-[5px] bg-(--color-bg-hover) px-1 text-[10.5px] font-semibold leading-none text-(--color-text-muted)"
            >
              {seg}
            </kbd>
          ))}
        </span>
      </button>
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
        <GlassButton
          variant="ghost"
          size="icon"
          title="Account menu"
          aria-label="Account menu"
        >
          <ProfileAvatar session={session} />
        </GlassButton>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={6}
          className="z-(--z-dropdown) min-w-44 origin-top-right overflow-hidden glass-modal p-1 text-[12.5px] animate-[modal-in_180ms_var(--ease-glass)]"
        >
          <DropdownMenu.Item
            onSelect={onSettings}
            className={menuItemClassName()}
          >
            <SettingsIcon size={13} />
            <span>Settings</span>
          </DropdownMenu.Item>
          <DropdownMenu.Separator className="my-1 h-px bg-(--glass-border-hairline)" />
          <DropdownMenu.Item
            onSelect={signOut}
            className={menuItemClassName("text-(--color-danger)")}
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
        className="h-[22px] w-[22px] rounded-full object-cover"
      />
    );
  }

  const initials = session ? accountInitials(session) : null;
  if (initials) {
    return (
      <span className="flex h-[22px] w-[22px] items-center justify-center rounded-full bg-(--color-bg-hover) text-[11px] font-semibold uppercase leading-none">
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
    "flex cursor-pointer select-none items-center gap-2 rounded-[8px] px-2 py-1.5",
    "text-(--color-text-primary) outline-none transition-colors duration-100",
    "data-[highlighted]:bg-(--color-bg-hover)",
    className,
  );
}
