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

/** Full local date-time, for tooltips over relative timestamps. */
export function formatAbsolute(iso: string): string {
  const date = Date.parse(iso);
  if (Number.isNaN(date)) return iso;
  return new Date(date).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}
