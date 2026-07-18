/**
 * Compact elapsed-time formatter for the honest-status "Ns ago" counters
 * (Step 0 — Honest Status). Coarse on purpose: a glance-value, not a stopwatch.
 * `1500 → "1s"`, `65_000 → "1m"`, `3_600_000 → "1h"`, `172_800_000 → "2d"`.
 */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}
