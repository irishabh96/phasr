import { createFileRoute } from "@tanstack/react-router";
import { Check } from "lucide-react";
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
          Theme syncs across your devices.
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
                aria-pressed={active}
                aria-label={`${option} theme${active ? " (current)" : ""}`}
                onClick={() => setTheme(option)}
                className={cn(
                  "glass-panel relative flex h-24 items-end justify-between p-5 text-left capitalize",
                  "transition-transform duration-150 hover:-translate-y-px",
                  "focus-visible:outline-none focus-visible:shadow-[var(--ring-focus)]",
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
    </div>
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
