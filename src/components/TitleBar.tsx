import { UserButton } from "@clerk/react";
import { useNavigate } from "@tanstack/react-router";
import { Search, Settings as SettingsIcon } from "lucide-react";
import { ThemeToggle } from "@/components/ThemeToggle";
import { GlassButton } from "@/components/ui/GlassButton";
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
          onClick={() => {
            window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true }));
          }}
          title="Search (⌘K)"
        >
          <Search size={13} />
        </GlassButton>
        <ThemeToggle />
        <GlassButton
          variant="ghost"
          size="icon"
          onClick={() => navigate({ to: "/settings" })}
          title="Settings"
        >
          <SettingsIcon size={13} />
        </GlassButton>
        <div className="ml-1 flex items-center">
          <UserButton
            appearance={{
              elements: {
                avatarBox: { width: 24, height: 24 },
              },
            }}
          />
        </div>
      </div>
    </div>
  );
}
