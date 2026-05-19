import { createFileRoute } from "@tanstack/react-router";
import { Check } from "lucide-react";
import { useUserSettings, useUpdateUserSettings } from "@/lib/hooks/useUserSettings";
import { useUiStore } from "@/lib/store";
import type { Theme } from "@/lib/theme";

interface AccentChoice {
  id: string;
  /** What we write to `user_settings.accent_color`. */
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
    <div className="space-y-8">
      <header>
        <h2 className="text-base font-semibold tracking-tight">Appearance</h2>
        <p className="mt-1 text-xs text-(--color-text-muted)">
          Theme and accent color apply across devices once cloud sync runs.
        </p>
      </header>

      <section className="space-y-3">
        <div className="text-xs font-medium uppercase tracking-wide text-(--color-text-muted)">
          Theme
        </div>
        <div className="flex gap-2">
          {THEMES.map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => setTheme(option)}
              data-active={theme === option}
              className="rounded-md border border-(--color-border-default) bg-(--color-bg-input) px-3 py-1.5 text-sm capitalize text-(--color-text-primary) transition-colors hover:border-(--color-border-strong) data-[active=true]:border-(--color-accent-500) data-[active=true]:bg-(--color-accent-600) data-[active=true]:text-white"
            >
              {option}
            </button>
          ))}
        </div>
      </section>

      <section className="space-y-3">
        <div className="text-xs font-medium uppercase tracking-wide text-(--color-text-muted)">
          Accent
        </div>
        <div className="flex flex-wrap gap-2">
          {ACCENTS.map((choice) => (
            <button
              key={choice.id}
              type="button"
              title={choice.id}
              onClick={() => setAccent(choice.id)}
              className="flex h-8 w-8 items-center justify-center rounded-full border-2 transition-transform hover:scale-110"
              style={{
                background: choice.swatch,
                borderColor: accent === choice.id ? "var(--color-text-primary)" : "transparent",
              }}
            >
              {accent === choice.id && <Check size={14} color="white" />}
            </button>
          ))}
        </div>
        <p className="text-xs text-(--color-text-muted)">
          Saved to your user settings. (Live re-theming of the accent CSS
          tokens lands next pass; the value is persisted now.)
        </p>
      </section>
    </div>
  );
}

export const Route = createFileRoute("/_app/settings/appearance")({
  component: AppearancePage,
});
