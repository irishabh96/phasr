import { createFileRoute } from "@tanstack/react-router";
import { Check } from "lucide-react";
import { useUserSettings, useUpdateUserSettings } from "@/lib/hooks/useUserSettings";
import { useUiStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import type { Theme } from "@/lib/theme";

interface AccentChoice {
  id: string;
  swatch: string;
}

const ACCENTS: AccentChoice[] = [
  { id: "indigo", swatch: "#6366f1" },
  { id: "blue", swatch: "#3b82f6" },
  { id: "violet", swatch: "#8b5cf6" },
  { id: "fuchsia", swatch: "#d946ef" },
  { id: "rose", swatch: "#f43f5e" },
  { id: "amber", swatch: "#f59e0b" },
  { id: "emerald", swatch: "#10b981" },
  { id: "slate", swatch: "#64748b" },
];

const THEMES: Theme[] = ["dark", "light", "system"];

function AppearancePage() {
  const { data: settings } = useUserSettings();
  const updateSettings = useUpdateUserSettings();
  const { theme, setTheme } = useUiStore();

  const accent = settings?.accentColor ?? "indigo";

  const setAccent = (id: string) => {
    if (!settings) return;
    void updateSettings.mutateAsync({ ...settings, accentColor: id });
  };

  return (
    <div className="space-y-6">
      <header>
        <h2 className="text-[15px] font-semibold tracking-tight leading-none">Appearance</h2>
        <p className="mt-1.5 text-[12px] text-(--color-text-muted)">
          Theme and accent color apply across devices once cloud sync runs.
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
                  "glass-panel relative flex h-20 items-end justify-between p-3 text-left capitalize",
                  "transition-all duration-150",
                  active
                    ? "border-(--color-accent-500) shadow-[var(--shadow-glow)]"
                    : "hover:border-(--glass-border-strong)",
                )}
              >
                <ThemePreview option={option} />
                <span className="relative text-[13px] font-medium">{option}</span>
                {active && (
                  <span className="absolute right-2 top-2 flex h-4 w-4 items-center justify-center rounded-full bg-(--color-accent-500) text-white">
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
          Accent
        </div>
        <div className="flex flex-wrap gap-2.5">
          {ACCENTS.map((choice) => {
            const active = accent === choice.id;
            return (
              <button
                key={choice.id}
                type="button"
                title={choice.id}
                onClick={() => setAccent(choice.id)}
                className={cn(
                  "relative flex h-9 w-9 items-center justify-center rounded-full",
                  "transition-all duration-150",
                  "hover:scale-105",
                  active && "ring-2 ring-(--color-text-primary) ring-offset-2 ring-offset-(--color-bg-base)",
                )}
                style={{
                  background: choice.swatch,
                  boxShadow: active ? `0 0 24px -4px ${choice.swatch}` : undefined,
                }}
              >
                {active && <Check size={14} color="white" />}
              </button>
            );
          })}
        </div>
        <p className="text-[11px] text-(--color-text-muted)">
          Saved to your user settings. Live re-theming of the accent CSS tokens lands next pass.
        </p>
      </section>
    </div>
  );
}

function ThemePreview({ option }: { option: Theme }) {
  const bg = option === "light" ? "#fafafb" : option === "system" ? "linear-gradient(135deg, #0a0a0b 50%, #fafafb 50%)" : "#0a0a0b";
  const fg = option === "light" ? "#0a0a0b" : "#e8e8ec";
  return (
    <div
      aria-hidden
      className="absolute inset-2 rounded-[8px] border border-(--glass-border-hairline) opacity-70"
      style={{ background: bg }}
    >
      <div className="absolute left-2 top-2 h-1 w-6 rounded-full" style={{ background: fg }} />
      <div className="absolute left-2 top-4 h-1 w-3 rounded-full opacity-50" style={{ background: fg }} />
    </div>
  );
}

export const Route = createFileRoute("/_app/settings/appearance")({
  component: AppearancePage,
});
