/** Shared timestamp formatting (extracted from CommitCard). */

export function formatRelative(iso: string): string {
  const date = Date.parse(iso);
  if (Number.isNaN(date)) return iso;
  const seconds = Math.floor((Date.now() - date) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 7 * 86_400) return `${Math.floor(seconds / 86_400)}d ago`;
  const d = new Date(date);
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: d.getFullYear() === new Date().getFullYear() ? undefined : "numeric",
  });
}

export interface DayBucket {
  /** Group header text. */
  label: string;
  /**
   * True when the bucket can hold more than one calendar day (month and
   * year buckets). Rows in those carry their own day stamp; rows in a
   * single-day bucket don't need one — the header already says the day.
   */
  spansDays: boolean;
}

/**
 * Bucket for grouping a list by recency: "Today", "Yesterday", a
 * weekday+date for the last fortnight, then month, then year. Gives a
 * long list constant orientation without a timestamp on every row.
 */
export function dayBucket(iso: string): DayBucket {
  const then = new Date(Date.parse(iso));
  if (Number.isNaN(then.getTime()))
    return { label: "Earlier", spansDays: true };
  const startOfDay = (d: Date) =>
    new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const now = new Date();
  const days = Math.round((startOfDay(now) - startOfDay(then)) / 86_400_000);

  if (days <= 0) return { label: "Today", spansDays: false };
  if (days === 1) return { label: "Yesterday", spansDays: false };
  if (days < 14)
    return {
      label: then.toLocaleDateString(undefined, {
        weekday: "short",
        day: "numeric",
        month: "short",
      }),
      spansDays: false,
    };
  if (then.getFullYear() === now.getFullYear())
    return {
      label: then.toLocaleDateString(undefined, { month: "long" }),
      spansDays: true,
    };
  return { label: String(then.getFullYear()), spansDays: true };
}

/** Compact day stamp ("12 Jul") for rows inside multi-day buckets. */
export function formatDayStamp(iso: string): string {
  const date = Date.parse(iso);
  if (Number.isNaN(date)) return "";
  return new Date(date).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
  });
}

/**
 * The stamp shown on every note. `mode` follows the group header: a
 * bucket that names one exact day (Today / Yesterday / "Mon 12 Jul")
 * already tells you the date, so the row adds clock precision; a bucket
 * that spans days (a month, a year) needs the date instead.
 *
 * 24h on purpose — it matches `git log`, `journalctl`, and terminal
 * output, and gives a fixed 5-char column so the right edge stays
 * straight next to "12 Jun".
 */
export function formatNoteStamp(iso: string, mode: "time" | "date"): string {
  const date = Date.parse(iso);
  if (Number.isNaN(date)) return "—";
  if (mode === "date") return formatDayStamp(iso);
  return new Date(date).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
}

/**
 * Full local date-time, for tooltips over relative timestamps. Pinned to
 * 24h so the tooltip can't contradict the row it explains (`timeStyle`
 * is locale-driven and would render 00:30 as "12:30 AM" on en-US).
 */
export function formatAbsolute(iso: string): string {
  const date = Date.parse(iso);
  if (Number.isNaN(date)) return iso;
  // Explicit components, not dateStyle: Intl forbids combining
  // dateStyle/timeStyle with hour/minute, and we need the 24h pin.
  return new Date(date).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
}

/**
 * Ultra-compact stamp for a completed note ("now", "12m", "5h", "Tue",
 * "12 Jul"). Max ~6 chars so it fits the fixed right slot on a
 * single-line done row without pushing the body.
 */
export function formatCompactStamp(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "—";
  const mins = Math.floor((Date.now() - t) / 60_000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const d = new Date(t);
  const days = Math.floor(hours / 24);
  if (days < 7) return d.toLocaleDateString(undefined, { weekday: "short" });
  return formatDayStamp(iso);
}
