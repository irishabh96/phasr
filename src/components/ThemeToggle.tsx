import { Monitor, Moon, Sun } from "lucide-react";
import { useUiStore } from "@/lib/store";
import type { Theme } from "@/lib/theme";

const ORDER: Theme[] = ["dark", "light", "system"];
const ICONS: Record<Theme, typeof Sun> = {
  dark: Moon,
  light: Sun,
  system: Monitor,
};

export function ThemeToggle({ className = "" }: { className?: string }) {
  const { theme, setTheme } = useUiStore();

  const cycle = () => {
    const next = ORDER[(ORDER.indexOf(theme) + 1) % ORDER.length] ?? "dark";
    setTheme(next);
  };

  const Icon = ICONS[theme];

  return (
    <button
      type="button"
      onClick={cycle}
      title={`Theme: ${theme} (click to cycle)`}
      aria-label={`Theme: ${theme}. Click to cycle.`}
      className={`flex h-7 w-7 items-center justify-center rounded-md border border-(--color-border-default) bg-(--color-bg-input) text-(--color-text-secondary) transition-colors hover:border-(--color-border-strong) hover:text-(--color-text-primary) ${className}`}
    >
      <Icon size={14} />
    </button>
  );
}
