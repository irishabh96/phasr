import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { useNavigate } from "@tanstack/react-router";
import { LogOut, Search, Settings as SettingsIcon, UserRound } from "lucide-react";
import { GlassButton } from "@/components/ui/GlassButton";
import {
  type DesktopSession,
  readDesktopSession,
  signOutDesktopSession,
} from "@/lib/desktopAuth";
import { useUiStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import type { ReactNode } from "react";

type TitleBarProps = {
  /** Center content — typically a breadcrumb. */
  breadcrumb?: ReactNode;
};

const isMac =
  typeof navigator !== "undefined" && /Mac/i.test(navigator.platform ?? navigator.userAgent);

/**
 * Transparent overlay titlebar. On macOS the native traffic lights stick out
 * the top-left, so we leave them ~92px of clearance. The whole bar is a
 * Tauri drag region — interactive children stop the drag automatically.
 */
export function TitleBar({ breadcrumb }: TitleBarProps) {
  const navigate = useNavigate();
  const openCommandPalette = useUiStore((s) => s.openCommandPalette);
  const session = readDesktopSession();

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
        className="flex min-w-0 items-center gap-2 text-[13px] leading-none text-(--color-text-secondary)"
      >
        {breadcrumb ?? (
          <span className="font-medium leading-none text-(--color-text-primary)">Phasr</span>
        )}
      </div>

      <div className="flex items-center gap-0.5">
        <GlassButton
          variant="ghost"
          size="icon"
          onClick={openCommandPalette}
          title="Search (⌘K)"
        >
          <Search size={13} />
        </GlassButton>
        <ProfileMenu
          session={session}
          onSettings={() => void navigate({ to: "/settings" })}
        />
      </div>
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
        <GlassButton variant="ghost" size="icon" title="Account menu" aria-label="Account menu">
          <ProfileAvatar session={session} />
        </GlassButton>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={6}
          className="z-50 min-w-44 overflow-hidden glass-modal p-1 text-[12.5px] animate-[modal-in_180ms_var(--ease-glass)]"
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
        className="h-5 w-5 rounded-full object-cover"
      />
    );
  }

  const initials = session ? accountInitials(session) : null;
  if (initials) {
    return (
      <span className="flex h-5 w-5 items-center justify-center rounded-full bg-(--color-bg-hover) text-[10px] font-semibold uppercase leading-none">
        {initials}
      </span>
    );
  }

  return <UserRound size={13} />;
}

function accountInitials(session: DesktopSession) {
  const label = session.profile.name || session.profile.email || "Phasr";
  const parts = label
    .replace(/@.*/, "")
    .split(/\s+/)
    .map((part) => part.trim())
    .filter(Boolean);

  if (parts.length >= 2) {
    return `${parts[0]?.[0] ?? ""}${parts[1]?.[0] ?? ""}`.toUpperCase();
  }

  return (parts[0]?.slice(0, 2) || "P").toUpperCase();
}

function menuItemClassName(className?: string) {
  return cn(
    "flex cursor-pointer select-none items-center gap-2 rounded-[8px] px-2 py-1.5",
    "text-(--color-text-primary) outline-none transition-colors duration-100",
    "data-[highlighted]:bg-(--color-bg-hover)",
    className,
  );
}
