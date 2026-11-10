/** A token count as the inspector shows it: "950", "48.2k", "148k", "1.3M". */
export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  // "48.2k" (A-Workspace) — one decimal until it stops adding information.
  if (n < 100_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}
