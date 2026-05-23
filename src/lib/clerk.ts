export const CLERK_PUBLISHABLE_KEY = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as
  | string
  | undefined;

/**
 * Auth is required for every build. If this is missing, the app renders
 * a configuration error instead of mounting routes or Tauri-backed data
 * hooks.
 */
export const isClerkConfigured = Boolean(CLERK_PUBLISHABLE_KEY);

export const CLERK_CONFIG_ERROR =
  "Missing VITE_CLERK_PUBLISHABLE_KEY. Phasr requires Clerk auth and will not run in a keyless local mode.";

/**
 * Clerk appearance tuned to match Phasr's design tokens. Re-reads CSS
 * variables at component-instantiation time so a theme toggle re-renders
 * Clerk's UI with the new palette.
 */
export function clerkAppearance() {
  const style = typeof window !== "undefined" ? getComputedStyle(document.documentElement) : null;
  const read = (name: string, fallback: string) =>
    style?.getPropertyValue(name).trim() || fallback;

  return {
    variables: {
      colorPrimary: read("--color-accent-600", "#4f46e5"),
      colorBackground: read("--color-bg-surface", "#111114"),
      colorInputBackground: read("--color-bg-input", "#0e0e11"),
      colorInputText: read("--color-text-primary", "#e8e8ec"),
      colorText: read("--color-text-primary", "#e8e8ec"),
      colorTextSecondary: read("--color-text-secondary", "#a0a0ab"),
      colorNeutral: read("--color-text-primary", "#e8e8ec"),
      colorDanger: read("--color-danger", "#ef4444"),
      colorSuccess: read("--color-success", "#22c55e"),
      colorWarning: read("--color-warning", "#f59e0b"),
      fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif",
      fontFamilyButtons: "Inter, ui-sans-serif, system-ui, sans-serif",
      borderRadius: "8px",
    },
    elements: {
      card: { boxShadow: "0 8px 24px rgba(0, 0, 0, 0.4)" },
      formButtonPrimary: { textTransform: "none" as const, fontWeight: 500 },
      footer: { display: "none" },
    },
  };
}
