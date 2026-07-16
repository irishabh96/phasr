import {
  isPermissionGranted,
  requestPermission,
} from "@tauri-apps/plugin-notification";

/**
 * OS-notification permission handling for agent-completion notifications
 * (DDR-003 §7). Kept as a tiny standalone module — no React, no store — so
 * both the low-level IPC layer (`tauri.startTask`) and the notification hook
 * (`useCompletionNotifications`) can share one cached `granted` boolean
 * without a dependency cycle.
 *
 * Rules (DDR-003 §7):
 * - Never prompt on cold start (pre-value → reflexive deny).
 * - Prompt at most once, right after the first successful agent launch.
 * - On deny, degrade silently (in-app toasts still work) and never re-prompt.
 * - Guard every `sendNotification` with the cached `granted` flag so a denied
 *   user costs zero plugin round-trips.
 */

const ASKED_KEY = "phasr.notif.asked";

/** Cached permission state so `sendNotification` never round-trips the plugin. */
let granted = false;
let seeded = false;

/** Whether the OS has granted notification permission (cached). */
export function osNotificationsGranted(): boolean {
  return granted;
}

/**
 * Seed the cached `granted` flag from the OS without prompting. Called once on
 * hook mount so the guard is accurate for users who granted in a prior session.
 * Cold start never triggers a permission dialog here.
 */
export async function initNotificationPermissionState(): Promise<void> {
  if (seeded) return;
  seeded = true;
  try {
    granted = await isPermissionGranted();
  } catch {
    granted = false;
  }
}

/**
 * First-run permission prompt (DDR-003 §7). Invoked on the first successful
 * `start_task` in the app's lifetime; a `localStorage` flag makes it a no-op on
 * every subsequent call — including across relaunches — so we never re-prompt.
 * Safe to call on every task start.
 */
export async function maybeRequestNotificationPermission(): Promise<void> {
  if (typeof window === "undefined") return;
  if (window.localStorage.getItem(ASKED_KEY)) return;
  try {
    if (await isPermissionGranted()) {
      // Already granted/denied at the OS level — record the cached state and
      // don't pop a dialog.
      granted = true;
    } else {
      const result = await requestPermission();
      granted = result === "granted";
    }
  } catch {
    granted = false;
  } finally {
    // Persist regardless of outcome so we never ask again (respect the choice).
    window.localStorage.setItem(ASKED_KEY, "1");
  }
}
