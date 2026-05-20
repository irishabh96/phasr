export type Theme = "dark" | "light" | "system";

const STORAGE_KEY = "phasr.theme";

export function readStoredTheme(): Theme {
  const raw = typeof localStorage !== "undefined" ? localStorage.getItem(STORAGE_KEY) : null;
  if (raw === "dark" || raw === "light" || raw === "system") return raw;
  return "dark";
}

export function writeStoredTheme(theme: Theme) {
  localStorage.setItem(STORAGE_KEY, theme);
}

export function resolveTheme(theme: Theme): "dark" | "light" {
  if (theme === "system") {
    return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  }
  return theme;
}

export function applyTheme(theme: Theme) {
  const resolved = resolveTheme(theme);
  document.documentElement.setAttribute("data-theme", resolved);
}
