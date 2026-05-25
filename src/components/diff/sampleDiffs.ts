/**
 * Sample diffs used by the dev preview route and unit tests. Real
 * `git diff` output, just trimmed for readability. New entries should
 * exercise a previously-uncovered shape (binary, rename, lots of
 * hunks, etc.) — not just be more JS/TS examples.
 */

export interface SampleDiff {
  id: string;
  label: string;
  filePath: string;
  raw: string;
}

const TS_MODIFY = `diff --git a/src/auth/redirect.ts b/src/auth/redirect.ts
index 8a9c1b2..d4ee2c1 100644
--- a/src/auth/redirect.ts
+++ b/src/auth/redirect.ts
@@ -1,12 +1,14 @@
 import { z } from "zod";

-export function buildRedirect(params: { returnTo: string }) {
-  return \`/\${params.returnTo}\`;
+export function buildRedirect(params: { returnTo: string | null }) {
+  // Treat null / empty as "send the user home" rather than producing
+  // a URL that ends in a stray slash.
+  return params.returnTo ?? "/";
 }

 export const schema = z.object({
   returnTo: z.string().nullable(),
 });

-export type RedirectParams = { returnTo: string };
+export type RedirectParams = z.infer<typeof schema>;
`;

const RS_NEW = `diff --git a/src-tauri/src/git/cherry.rs b/src-tauri/src/git/cherry.rs
new file mode 100644
index 0000000..f17e0a3
--- /dev/null
+++ b/src-tauri/src/git/cherry.rs
@@ -0,0 +1,18 @@
+use std::path::Path;
+
+use super::error::{run_git, GitError};
+
+/// Compare HEAD against an upstream ref and return the SHAs that are
+/// "unique" to HEAD — the ones we would need to push.
+pub fn cherry(cwd: &Path, upstream: &str) -> Result<Vec<String>, GitError> {
+    let out = run_git(cwd, &["cherry", upstream])?;
+    Ok(out
+        .lines()
+        .filter_map(|line| {
+            let mut parts = line.split_whitespace();
+            let sign = parts.next()?;
+            let sha = parts.next()?;
+            (sign == "+").then(|| sha.to_string())
+        })
+        .collect())
+}
`;

const PY_DELETE = `diff --git a/scripts/cleanup.py b/scripts/cleanup.py
deleted file mode 100644
index 65b6d7e..0000000
--- a/scripts/cleanup.py
+++ /dev/null
@@ -1,10 +0,0 @@
-#!/usr/bin/env python3
-"""Garbage collector — superseded by the Rust crate."""
-import shutil
-import sys
-from pathlib import Path
-
-def main(root: str) -> None:
-    shutil.rmtree(Path(root) / ".cache", ignore_errors=True)
-
-if __name__ == "__main__":
-    main(sys.argv[1])
`;

const BINARY = `diff --git a/public/logo.png b/public/logo.png
index 8b3a01f..2b6db66 100644
Binary files a/public/logo.png and b/public/logo.png differ
`;

const RENAME = `diff --git a/src/old-name.ts b/src/new-name.ts
similarity index 96%
rename from src/old-name.ts
rename to src/new-name.ts
index 7a8b9cd..3e4f5a6 100644
--- a/src/old-name.ts
+++ b/src/new-name.ts
@@ -1,5 +1,5 @@
-// old name
+// new name
 export const value = 42;
 export function compute(x: number): number {
   return x * 2;
 }
`;

const EMPTY = ``;

const MANY_HUNKS = (() => {
  let out = `diff --git a/big.txt b/big.txt\nindex 0000000..1111111 100644\n--- a/big.txt\n+++ b/big.txt\n`;
  for (let i = 0; i < 75; i++) {
    const line = i * 10 + 1;
    out += `@@ -${line},2 +${line},2 @@\n alpha-${i}\n-beta-${i}\n+gamma-${i}\n`;
  }
  return out;
})();

export const SAMPLE_DIFFS: SampleDiff[] = [
  {
    id: "ts-modify",
    label: "TypeScript — modify",
    filePath: "src/auth/redirect.ts",
    raw: TS_MODIFY,
  },
  { id: "rs-new", label: "Rust — new file", filePath: "src-tauri/src/git/cherry.rs", raw: RS_NEW },
  { id: "py-delete", label: "Python — deleted", filePath: "scripts/cleanup.py", raw: PY_DELETE },
  { id: "rename", label: "Rename", filePath: "src/new-name.ts", raw: RENAME },
  { id: "binary", label: "Binary file", filePath: "public/logo.png", raw: BINARY },
  { id: "empty", label: "Empty diff (no changes)", filePath: "src/auth/redirect.ts", raw: EMPTY },
  {
    id: "many-hunks",
    label: "Many hunks (paging)",
    filePath: "big.txt",
    raw: MANY_HUNKS,
  },
];

/**
 * Worktree-style file set used by the DiffList preview: one file of
 * each status shape (modify / new / rename / delete / binary), ordered
 * roughly how a reviewer would see them.
 */
export const SAMPLE_DIFF_LIST: { path: string; raw: string }[] = [
  { path: "src/auth/redirect.ts", raw: TS_MODIFY },
  { path: "src-tauri/src/git/cherry.rs", raw: RS_NEW },
  { path: "src/new-name.ts", raw: RENAME },
  { path: "scripts/cleanup.py", raw: PY_DELETE },
  { path: "public/logo.png", raw: BINARY },
];
