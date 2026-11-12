import { describe, expect, it } from "vitest";
import {
  attentionOnScreen,
  DEFAULT_NOTIFICATION_PREFS,
  inQuietHours,
  parseClock,
  shouldDeliver,
} from "./notificationPolicy";
import type { NotificationPrefs } from "./types";

/** Local wall-clock time on an arbitrary day. */
const at = (h: number, m = 0) => new Date(2026, 10, 9, h, m);

const quiet = (start: string, end: string, enabled = true): NotificationPrefs["quietHours"] => ({
  enabled,
  start,
  end,
});

describe("parseClock", () => {
  it("parses HH:MM and rejects garbage", () => {
    expect(parseClock("22:00")).toBe(22 * 60);
    expect(parseClock("8:05")).toBe(8 * 60 + 5);
    expect(parseClock("24:00")).toBeNull();
    expect(parseClock("12:60")).toBeNull();
    expect(parseClock("noon")).toBeNull();
  });
});

describe("inQuietHours", () => {
  it("wraps midnight (22:00 → 08:00)", () => {
    const q = quiet("22:00", "08:00");
    expect(inQuietHours(q, at(21, 59))).toBe(false);
    expect(inQuietHours(q, at(22, 0))).toBe(true);
    expect(inQuietHours(q, at(23, 30))).toBe(true);
    expect(inQuietHours(q, at(0, 0))).toBe(true);
    expect(inQuietHours(q, at(7, 59))).toBe(true);
    expect(inQuietHours(q, at(8, 0))).toBe(false);
    expect(inQuietHours(q, at(13, 0))).toBe(false);
  });

  it("handles a same-day window and degenerate ones", () => {
    const q = quiet("12:00", "13:30");
    expect(inQuietHours(q, at(11, 59))).toBe(false);
    expect(inQuietHours(q, at(12, 45))).toBe(true);
    expect(inQuietHours(q, at(13, 30))).toBe(false);
    expect(inQuietHours(quiet("22:00", "22:00"), at(22, 0))).toBe(false);
    expect(inQuietHours(quiet("bad", "08:00"), at(23, 0))).toBe(false);
    expect(inQuietHours(quiet("22:00", "08:00", false), at(23, 0))).toBe(false);
  });
});

describe("shouldDeliver", () => {
  it("uses the defaults when prefs aren't loaded", () => {
    expect(shouldDeliver(null, "needs_approval", { focused: false, now: at(12) })).toEqual({
      badge: true,
      system: true,
      sound: true,
    });
    expect(shouldDeliver(undefined, "checks_finished", { focused: false, now: at(12) })).toEqual({
      badge: true,
      system: false,
      sound: false,
    });
  });

  it("backgroundOnly mutes banners and sound while focused, never the badge", () => {
    const focused = shouldDeliver(DEFAULT_NOTIFICATION_PREFS, "task_failed", {
      focused: true,
      now: at(12),
    });
    expect(focused).toEqual({ badge: true, system: false, sound: false });
    const anyFocus = { ...DEFAULT_NOTIFICATION_PREFS, backgroundOnly: false };
    expect(shouldDeliver(anyFocus, "task_failed", { focused: true, now: at(12) }).system).toBe(true);
  });

  it("quiet hours across midnight mute banners and sound", () => {
    const prefs: NotificationPrefs = {
      ...DEFAULT_NOTIFICATION_PREFS,
      quietHours: quiet("22:00", "08:00"),
    };
    const night = shouldDeliver(prefs, "needs_approval", { focused: false, now: at(2, 30) });
    expect(night).toEqual({ badge: true, system: false, sound: false });
    const day = shouldDeliver(prefs, "needs_approval", { focused: false, now: at(9) });
    expect(day).toEqual({ badge: true, system: true, sound: true });
  });

  it("follows the matrix, falling back per kind", () => {
    const prefs: NotificationPrefs = {
      ...DEFAULT_NOTIFICATION_PREFS,
      matrix: { task_finished: { badge: false, system: false, sound: true } },
    };
    expect(shouldDeliver(prefs, "task_finished", { focused: false, now: at(12) })).toEqual({
      badge: false,
      system: false,
      sound: true,
    });
    // Missing from the stored matrix → that kind's default.
    expect(shouldDeliver(prefs, "needs_approval", { focused: false, now: at(12) }).sound).toBe(true);
  });
});

describe("attentionOnScreen", () => {
  it("is only the focused window on that task's agent pane", () => {
    expect(attentionOnScreen({ focused: true, viewingTask: true, onAgentPane: true })).toBe(true);
    // A shell tab of the same task: the card isn't there, so the banner is news.
    expect(attentionOnScreen({ focused: true, viewingTask: true, onAgentPane: false })).toBe(false);
    expect(attentionOnScreen({ focused: true, viewingTask: false, onAgentPane: true })).toBe(false);
    expect(attentionOnScreen({ focused: false, viewingTask: true, onAgentPane: true })).toBe(false);
  });
});
