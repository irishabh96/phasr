import { createFileRoute } from "@tanstack/react-router";
import { Check, Minus, Plus } from "lucide-react";
import { GlassButton } from "@/components/ui/GlassButton";
import {
  TERMINAL_FONT_SIZE,
  clampTerminalFontSize,
  useAdjustTerminalFontSize,
  useUserSettings,
} from "@/lib/hooks/useUserSettings";
import { SHORTCUTS } from "@/lib/shortcuts";
import { useUiStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import type { Theme } from "@/lib/theme";

const THEMES: Theme[] = ["dark", "light", "system"];

function AppearancePage() {
  const { theme, setTheme } = useUiStore();

  return (
    <div className="space-y-6">
      <header>
        <h2 className="text-[15px] font-semibold tracking-tight leading-none">
          Appearance
        </h2>
        <p className="mt-1.5 text-[12px] text-(--color-text-muted)">
          Theme applies across devices once cloud sync runs.
        </p>
      </header>

      <section className="space-y-3">
        <div className="text-[11px] font-medium uppercase tracking-[0.14em] text-(--color-text-muted)">
          Theme
        </div>
        <div className="grid grid-cols-3 gap-3">
          {THEMES.map((option) => {
            const active = theme === option;
            return (
              <button
                key={option}
                type="button"
                onClick={() => setTheme(option)}
                className={cn(
                  "glass-panel relative flex h-24 items-end justify-between p-5 text-left capitalize",
                  "transition-transform duration-150 hover:-translate-y-px",
                  active
                    ? "border-(--color-accent-500)"
                    : "hover:border-(--glass-border-strong)",
                )}
              >
                <ThemePreview option={option} />
                <span className="relative text-[13px] font-medium">
                  {option}
                </span>
                {active && (
                  <span className="absolute right-2 top-2 flex h-4 w-4 items-center justify-center rounded-full bg-(--color-accent-500) text-(--color-accent-onfill)">
                    <Check size={10} />
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </section>

      <section className="space-y-3">
        <div className="text-[11px] font-medium uppercase tracking-[0.14em] text-(--color-text-muted)">
          Terminal
        </div>
        <TerminalFontSizeRow />
      </section>
    </div>
  );
}

function TerminalFontSizeRow() {
  const { data: settings } = useUserSettings();
  const adjust = useAdjustTerminalFontSize();
  // null until the query resolves (readout shows a placeholder, not a guessed
  // 13). Clamped so a synced out-of-range value reads as the bound the
  // terminals actually render.
  const size = settings ? clampTerminalFontSize(settings.baseFontSize) : null;

  return (
    <div className="glass-panel flex items-center justify-between gap-4 p-4">
      <div className="min-w-0">
        <div className="text-[13px] font-medium">Font size</div>
        <p className="mt-1 text-[12px] text-(--color-text-muted)">
          Applies to every terminal —{" "}
          <ShortcutChips keys={SHORTCUTS.increaseFontSize.display} />{" "}
          <ShortcutChips keys={SHORTCUTS.decreaseFontSize.display} /> anywhere,{" "}
          <ShortcutChips keys={SHORTCUTS.resetFontSize.display} /> to reset.
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <GlassButton
          size="icon"
          variant="outline"
          aria-label={SHORTCUTS.decreaseFontSize.label}
          disabled={size === null || size <= TERMINAL_FONT_SIZE.min}
          onClick={() => adjust(-1)}
        >
          <Minus size={13} />
        </GlassButton>
        {/* role="status" = polite live region: a screen reader hears the new
            value after a press instead of silence. */}
        <span
          role="status"
          aria-atomic="true"
          className="w-14 text-center text-[13px] font-medium tabular-nums"
        >
          {size === null ? "—" : `${size} px`}
        </span>
        <GlassButton
          size="icon"
          variant="outline"
          aria-label={SHORTCUTS.increaseFontSize.label}
          disabled={size === null || size >= TERMINAL_FONT_SIZE.max}
          onClick={() => adjust(1)}
        >
          <Plus size={13} />
        </GlassButton>
        <GlassButton
          size="sm"
          variant="ghost"
          className="ml-1 text-[12px] text-(--color-text-muted)"
          disabled={size === null || size === TERMINAL_FONT_SIZE.default}
          onClick={() => adjust("reset")}
        >
          Reset
        </GlassButton>
      </div>
    </div>
  );
}

function ShortcutChips({ keys }: { keys: readonly string[] }) {
  return (
    <span className="inline-flex items-center gap-0.5 align-middle">
      {keys.map((k) => (
        <kbd
          key={k}
          className="rounded border border-(--glass-border-hairline) bg-(--color-bg-elevated) px-1 py-0.5 font-mono text-[9.5px] text-(--color-text-muted)"
        >
          {k}
        </kbd>
      ))}
    </span>
  );
}

function ThemePreview({ option }: { option: Theme }) {
  const bg =
    option === "light"
      ? "#fafafb"
      : option === "system"
        ? "linear-gradient(135deg, #010409 50%, #fafafb 50%)"
        : "#010409";
  const fg = option === "light" ? "#010409" : "#e6edf3";
  return (
    <div
      aria-hidden
      className="absolute inset-2 rounded-[8px] border border-(--glass-border-hairline) opacity-70"
      style={{ background: bg }}
    >
      <div
        className="absolute left-2 top-2 h-1 w-6 rounded-full"
        style={{ background: fg }}
      />
      <div
        className="absolute left-2 top-4 h-1 w-3 rounded-full opacity-50"
        style={{ background: fg }}
      />
    </div>
  );
}

export const Route = createFileRoute("/_app/settings/appearance")({
  component: AppearancePage,
});
