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
    s.includes("repository not found") ||
    s.includes("does not appear to be a git repository")
  )
    return "That repository couldn't be found — check the URL; it may be private, renamed, or removed.";
  if (
    s.includes("couldn't find remote ref") ||
    s.includes("unknown revision") ||
    s.includes("invalid reference") ||
    s.includes("did not match any file(s) known to git")
  )
    return "That branch or ref doesn't exist.";
  if (s.includes("is a directory")) return "That path is a folder, not a file.";
  if (s.includes("no such file") || s.includes("does not exist"))
    return "That path doesn't exist.";
  if (
    s.includes("could not resolve host") ||
    s.includes("failed to connect") ||
    s.includes("timed out") ||
    s.includes("network is unreachable")
  )
    return "Network error — check your connection and try again.";
  // Push rejected because the remote has commits the local branch doesn't —
  // the user needs to pull / sync first. Checked before the generic
  // "failed to push" so the actionable message wins.
  if (
    s.includes("non-fast-forward") ||
    s.includes("fetch first") ||
    s.includes("updates were rejected") ||
    s.includes("tip of your current branch is behind")
  )
    return "The remote has commits you don't have yet — pull or sync first, then push again.";
  // Push blocked by a branch-protection rule or a server-side hook.
  if (
    s.includes("pre-receive hook declined") ||
    s.includes("remote rejected") ||
    s.includes("protected branch") ||
    s.includes("push declined")
  )
    return "The remote rejected the push — a branch protection rule or server-side hook blocked it.";
  // Generic push failure (kept after the two specific cases above).
  if (s.includes("failed to push some refs"))
    return "Couldn't push some changes to the remote. Pull the latest changes, then try again.";
  // Git's index / ref lock — another git process is mid-operation, or a crashed
  // one left a stale `index.lock`. (The raw reason is still useful to a dev, so
  // callers that want it — e.g. ChangesPanel — surface it behind a disclosure.)
  if (
    s.includes("unable to lock file") ||
    s.includes("index.lock") ||
    s.includes("could not read index")
  )
    return "Git's index is locked — another git process may still be running. Wait for it to finish, then try again.";
  // App data store (SQLite) contention — transient; a retry usually clears it.
  if (
    s.includes("database is locked") ||
    s.includes("db locked") ||
    s.includes("database table is locked")
  )
    return "The app is busy saving data — give it a moment and try again.";
  // Generic filesystem permission failure. Kept AFTER the git-auth publickey
  // check above so an SSH-auth failure still maps to the credentials message.
  if (
    s.includes("permission denied") ||
    s.includes("access is denied") ||
    s.includes("operation not permitted")
  )
    return "Permission denied — check that you have access to this file or folder.";

  return raw || "Something went wrong.";
}
