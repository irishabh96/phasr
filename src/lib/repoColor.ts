/**
 * A stable mark colour per repository (A: the coloured square beside a repo
 * name). Hashing the id keeps the colour fixed across renames and devices.
 * Hues avoid the status colours' exact values so a repo mark never reads as
 * a status.
 */
const REPO_COLORS = ["#4F8CFF", "#9B7CFF", "#39C5CF", "#E08A4A", "#7CD4A8", "#D97FB0", "#C8B24A"];

export function repoColor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return REPO_COLORS[Math.abs(h) % REPO_COLORS.length]!;
}

export function repoInitial(name: string): string {
  return ([...name][0] ?? "?").toUpperCase();
}
