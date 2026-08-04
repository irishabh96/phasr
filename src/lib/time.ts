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
 * The stamp shown on every note. Within today the useful precision is
 * the clock ("14:32" — which agent run was this?); older than that the
 * day is what you're orienting by, and the group header already carries
 * the coarse bucket.
 */
export function formatNoteStamp(iso: string): string {
  const date = Date.parse(iso);
  if (Number.isNaN(date)) return "";
  const d = new Date(date);
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (sameDay)
    return d.toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  return formatDayStamp(iso);
}

/** Full local date-time, for tooltips over relative timestamps. */
export function formatAbsolute(iso: string): string {
  const date = Date.parse(iso);
  if (Number.isNaN(date)) return iso;
  return new Date(date).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}
