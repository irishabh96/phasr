import { Monitor, Moon, Sun } from "lucide-react";
import { GlassButton } from "@/components/ui/GlassButton";
import { useUiStore } from "@/lib/store";
import type { Theme } from "@/lib/theme";

const ORDER: Theme[] = ["dark", "light", "system"];
const ICONS: Record<Theme, typeof Sun> = {
  dark: Moon,
  light: Sun,
  system: Monitor,
};

export function ThemeToggle() {
  const { theme, setTheme } = useUiStore();

  const cycle = () => {
    const next = ORDER[(ORDER.indexOf(theme) + 1) % ORDER.length] ?? "dark";
    setTheme(next);
  };

  const Icon = ICONS[theme];

  return (
    <GlassButton
      variant="ghost"
      size="icon"
      onClick={cycle}
      title={`Theme: ${theme} (click to cycle)`}
      aria-label={`Theme: ${theme}. Click to cycle.`}
    >
      <Icon size={13} />
    </GlassButton>
  );
}
