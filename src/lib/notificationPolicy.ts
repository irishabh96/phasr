import type {
  DeliveryChannels,
  NotificationKind,
  NotificationPrefs,
} from "@/lib/types";

/**
 * How an inbox entry is delivered, given the user's prefs and the moment.
 *
 * The backend always records the entry (`phasr://notification-created`);
 * this decides the rest, here rather than in Rust because only the
 * frontend knows whether the window is focused and the user's local time.
 *
 * - `badge`: counts on the inbox bell. Never suppressed by focus or quiet
 *   hours — it's silent.
 * - `system` / `sound`: an OS banner / a sound. Suppressed while focused
 *   when `backgroundOnly`, and during quiet hours (which may wrap midnight:
 *   22:00 → 08:00).
 */

/** Mirrors `NotificationPrefs::default()` in `domain/notification.rs`. */
export const DEFAULT_CHANNELS: Record<NotificationKind, DeliveryChannels> = {
  needs_approval: { badge: true, system: true, sound: true },
  task_finished: { badge: true, system: true, sound: false },
  task_failed: { badge: true, system: true, sound: false },
  checks_finished: { badge: true, system: false, sound: false },
  run_command_failed: { badge: true, system: true, sound: false },
};

export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = {
  matrix: { ...DEFAULT_CHANNELS },
  backgroundOnly: true,
  quietHours: { enabled: false, start: "22:00", end: "08:00" },
};

/** "HH:MM" → minutes since midnight; `null` if malformed. */
export function parseClock(value: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/**
 * Whether `now` (local time) falls in [start, end). A window whose start
 * is after its end wraps midnight. Equal or malformed bounds = never quiet.
 */
export function inQuietHours(
  quiet: NotificationPrefs["quietHours"],
  now: Date,
): boolean {
  if (!quiet.enabled) return false;
  const start = parseClock(quiet.start);
  const end = parseClock(quiet.end);
  if (start === null || end === null || start === end) return false;
  const minute = now.getHours() * 60 + now.getMinutes();
  return start < end
    ? minute >= start && minute < end
    : minute >= start || minute < end;
}

export function shouldDeliver(
  prefs: NotificationPrefs | null | undefined,
  kind: NotificationKind,
  context: { focused: boolean; now: Date },
): DeliveryChannels {
  const p = prefs ?? DEFAULT_NOTIFICATION_PREFS;
  const channels = p.matrix[kind] ?? DEFAULT_CHANNELS[kind];
  const interrupting =
    !(p.backgroundOnly && context.focused) && !inQuietHours(p.quietHours, context.now);
  return {
    badge: channels.badge,
    system: channels.system && interrupting,
    sound: channels.sound && interrupting,
  };
}

/**
 * A needs-you entry's dialog is already on screen — the window focused on
 * that task's agent pane, where the approval card is — so no OS banner,
 * whatever the prefs say. Anywhere else (another app, another task, a shell
 * tab of the same task) the card isn't in view and the banner is the news.
 */
export function attentionOnScreen(context: {
  focused: boolean;
  viewingTask: boolean;
  onAgentPane: boolean;
}): boolean {
  return context.focused && context.viewingTask && context.onAgentPane;
}
