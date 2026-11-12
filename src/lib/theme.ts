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

/* ---------- Accent (A-System: user-selectable, coral by default) ---------- */

export const ACCENTS = ["coral", "blue", "green", "violet", "amber"] as const;
export type Accent = (typeof ACCENTS)[number];

/** Swatch colours for the picker (the dark-theme 500 step of each block). */
export const ACCENT_SWATCH: Record<Accent, string> = {
  coral: "#E0674A",
  blue: "#4F8CFF",
  green: "#3DCF8E",
  violet: "#9B7CFF",
  amber: "#F5B548",
};

const ACCENT_KEY = "phasr.accent";

export function isAccent(v: unknown): v is Accent {
  return typeof v === "string" && (ACCENTS as readonly string[]).includes(v);
}

export function readStoredAccent(): Accent {
  try {
    const raw = localStorage.getItem(ACCENT_KEY);
    return isAccent(raw) ? raw : "coral";
  } catch {
    return "coral";
  }
}

export function writeStoredAccent(accent: Accent) {
  try {
    localStorage.setItem(ACCENT_KEY, accent);
  } catch {
    /* storage unavailable: the in-memory value still applies */
  }
}

export function applyAccent(accent: Accent) {
  document.documentElement.setAttribute("data-accent", accent);
}

/* ---------- Interface density ---------- */

export type Density = "compact" | "comfortable";
const DENSITY_KEY = "phasr.density";

export function readStoredDensity(): Density {
  try {
    return localStorage.getItem(DENSITY_KEY) === "comfortable" ? "comfortable" : "compact";
  } catch {
    return "compact";
  }
}

export function writeStoredDensity(density: Density) {
  try {
    localStorage.setItem(DENSITY_KEY, density);
  } catch {
    /* ignore */
  }
}

export function applyDensity(density: Density) {
  document.documentElement.setAttribute("data-density", density);
}
