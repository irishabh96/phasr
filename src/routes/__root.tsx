import { Outlet, createRootRoute } from "@tanstack/react-router";
import { useEffect } from "react";
import { useUiStore } from "@/lib/store";
import { applyTheme, resolveTheme } from "@/lib/theme";

function RootLayout() {
  const theme = useUiStore((state) => state.theme);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  useEffect(() => {
    if (theme !== "system") return;
    const media = window.matchMedia("(prefers-color-scheme: light)");
    const listener = () => applyTheme("system");
    media.addEventListener("change", listener);
    return () => media.removeEventListener("change", listener);
  }, [theme]);

  return (
    <div className="min-h-screen bg-(--color-bg-base) text-(--color-text-primary)">
      <Outlet />
      <ThemeBadge resolved={resolveTheme(theme)} />
    </div>
  );
}

function ThemeBadge({ resolved }: { resolved: "dark" | "light" }) {
  return (
    <div className="pointer-events-none fixed bottom-3 right-3 rounded-md border border-(--color-border-subtle) bg-(--color-bg-elevated) px-2 py-1 text-xs text-(--color-text-muted)">
      theme: {resolved}
    </div>
  );
}

export const Route = createRootRoute({
  component: RootLayout,
});
