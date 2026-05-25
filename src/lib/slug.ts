/**
 * Mirror of the Rust `slugify` in src-tauri/src/git/naming.rs.
 * Used by the UI to preview the branch name the orchestrator will create.
 *
 * Keep these two in sync — if you change one, change the other plus the
 * tests on both sides.
 */
export function slugify(name: string): string {
  let out = "";
  let prevDash = true;
  for (const c of name) {
    if (/[a-z0-9]/i.test(c)) {
      out += c.toLowerCase();
      prevDash = false;
    } else if (!prevDash) {
      out += "-";
      prevDash = true;
    }
  }
  while (out.endsWith("-")) out = out.slice(0, -1);
  return out;
}
