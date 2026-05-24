import { Link, Outlet, createRootRoute } from "@tanstack/react-router";
import { useEffect } from "react";
import { AppToaster } from "@/components/AppToaster";
import { AuthCallbackHandler } from "@/components/AuthCallbackHandler";
import { useUiStore } from "@/lib/store";
import { applyTheme } from "@/lib/theme";

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
    <>
      <AuthCallbackHandler />
      <Outlet />
      <AppToaster />
    </>
  );
}

function NotFound() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-3 bg-(--color-bg-base) px-4 text-center">
      <h1 className="text-lg font-semibold">Page not found</h1>
      <p className="text-sm text-(--color-text-secondary)">
        The page you were trying to reach doesn't exist.
      </p>
      <Link
        to="/"
        className="rounded-md border border-(--color-border-default) bg-(--color-bg-input) px-3 py-1.5 text-sm hover:border-(--color-border-strong)"
      >
        Back to home
      </Link>
    </div>
  );
}

export const Route = createRootRoute({
  component: RootLayout,
  notFoundComponent: NotFound,
});
