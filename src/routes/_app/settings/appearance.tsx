import { createFileRoute } from "@tanstack/react-router";
import { Check, Minus, Plus } from "lucide-react";
import { GlassButton } from "@/components/ui/GlassButton";
import {
  TERMINAL_FONT_SIZE,
  clampTerminalFontSize,
  useAdjustTerminalFontSize,
  useUpdateUserSettings,
  useUserSettings,
} from "@/lib/hooks/useUserSettings";
import { normalizeCursorStyle } from "@/lib/terminal/options";
import type { TerminalCursorStyle } from "@/lib/terminal/surface";
import { SHORTCUTS } from "@/lib/shortcuts";
import { useUiStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import type { Theme } from "@/lib/theme";

const THEMES: Theme[] = ["dark", "light", "system"];

const CURSOR_STYLES: { value: TerminalCursorStyle; label: string }[] = [
  { value: "block", label: "Block" },
  { value: "bar", label: "Bar" },
  { value: "underline", label: "Underline" },
];

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
        <TerminalCursorRow />
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

/**
 * Cursor shape + blink. Both fields already existed on `user_settings` and
 * already reached the emulator; they simply had no control, so the only way
 * to change them was a hand-edited sqlite row or a synced value from another
 * device. Defaults are unchanged (block, blinking) so nobody's terminal
 * moves under them just because the setting became visible.
 */
function TerminalCursorRow() {
  const { data: settings } = useUserSettings();
  const { mutate } = useUpdateUserSettings();
  // null until the query resolves — the controls disable rather than render
  // a guessed selection that then jumps when the real value arrives.
  const style = settings ? normalizeCursorStyle(settings.cursorStyle) : null;
  const blink = settings ? settings.cursorBlink : null;

  return (
    <div className="glass-panel flex items-center justify-between gap-4 p-4">
      <div className="min-w-0">
        <div className="text-[13px] font-medium">Cursor</div>
        <p className="mt-1 text-[12px] text-(--color-text-muted)">
          Shape and blink, applied to every terminal immediately.
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <div
          role="radiogroup"
          aria-label="Cursor shape"
          className="flex items-center gap-1"
        >
          {CURSOR_STYLES.map((option) => {
            const active = style === option.value;
            return (
              <GlassButton
                key={option.value}
                size="sm"
                variant={active ? "outline" : "ghost"}
                role="radio"
                aria-checked={active}
                disabled={style === null}
                onClick={() =>
                  settings && mutate({ ...settings, cursorStyle: option.value })
                }
                className={cn(
                  "text-[12px]",
                  active && "border-(--color-accent-500)",
                )}
              >
                <CursorGlyph style={option.value} />
                {option.label}
              </GlassButton>
            );
          })}
        </div>
        <GlassButton
          size="sm"
          variant={blink ? "outline" : "ghost"}
          aria-pressed={blink === true}
          disabled={blink === null}
          onClick={() =>
            settings && mutate({ ...settings, cursorBlink: !settings.cursorBlink })
          }
          className={cn("text-[12px]", blink && "border-(--color-accent-500)")}
        >
          Blink
        </GlassButton>
      </div>
    </div>
  );
}

/** Tiny preview of the shape, so the labels aren't the only cue. */
function CursorGlyph({ style }: { style: TerminalCursorStyle }) {
  const box =
    style === "block"
      ? "h-[11px] w-[6px]"
      : style === "bar"
        ? "h-[11px] w-[2px]"
        : "h-[2px] w-[6px] self-end";
  return (
    <span
      aria-hidden
      className={cn(
        "inline-flex shrink-0 items-end rounded-[1px] bg-(--color-accent-500)",
        box,
      )}
      style={style === "underline" ? { marginBottom: 2 } : undefined}
    />
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
