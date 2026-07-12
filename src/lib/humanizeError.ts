/**
 * Maps raw backend/git error strings to friendly, actionable copy for
 * form/error surfaces. Falls back to the raw message when the failure
 * isn't recognized, so nothing is ever swallowed.
 */
export function humanizeError(err: unknown): string {
  const raw = (err instanceof Error ? err.message : String(err)).trim();
  const s = raw.toLowerCase();

  if (s.includes("already exists"))
    return "That destination already exists — pick a different name or location.";
  if (s.includes("not a git repository") || s.includes("not a git repo"))
    return "This folder isn't a git repository.";
  if (
    s.includes("could not read username") ||
    s.includes("authentication failed") ||
    s.includes("permission denied (publickey)") ||
    s.includes("403 forbidden")
  )
    return "Git authentication failed — check your credentials or SSH key.";
  if (
    s.includes("couldn't find remote ref") ||
    s.includes("unknown revision") ||
    s.includes("invalid reference") ||
    s.includes("did not match any file(s) known to git")
  )
    return "That branch or ref doesn't exist.";
  if (s.includes("is a directory"))
    return "That path is a folder, not a file.";
  if (s.includes("no such file") || s.includes("does not exist"))
    return "That path doesn't exist.";
  if (
    s.includes("could not resolve host") ||
    s.includes("failed to connect") ||
    s.includes("timed out") ||
    s.includes("network is unreachable")
  )
    return "Network error — check your connection and try again.";

  return raw || "Something went wrong.";
}
