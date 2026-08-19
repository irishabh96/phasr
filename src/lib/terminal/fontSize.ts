/**
 * Terminal font-size bounds, shared by the terminal factory and the settings
 * UI. Its own module so the settings page can bounds-check a value without
 * importing a terminal library.
 */

// `default` mirrors the sqlite column default for user_settings.base_font_size
// (migrations/0001_initial.sql) and domain/settings.rs — keep the three in
// agreement.
export const TERMINAL_FONT_SIZE = {
  min: 9,
  max: 24,
  default: 13,
} as const;

/**
 * Bounds-clamp a stored font size. The UI can only produce values inside the
 * bounds, but `base_font_size` isn't validated by the backend — a row written
 * by cloud sync from another client must never render verbatim. Garbage (NaN,
 * zero, negative) falls back to the default rather than the minimum.
 */
export function clampTerminalFontSize(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0)
    return TERMINAL_FONT_SIZE.default;
  return Math.min(
    TERMINAL_FONT_SIZE.max,
    Math.max(TERMINAL_FONT_SIZE.min, Math.round(value)),
  );
}
