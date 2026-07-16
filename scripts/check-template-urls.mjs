#!/usr/bin/env node
/**
 * Validates that every hardcoded template `gitUrl` in src/lib/templates.ts is a
 * reachable public repo. This catches the class of bug that mocked-IPC e2e is
 * structurally blind to: a guessed/rotted external URL that 404s only at REAL
 * clone time (e.g. `lapce/tauri-react-template`, which never existed).
 *
 * Needs network — run on demand / in a release check / CI-nightly, NOT in the
 * offline unit suite:  pnpm check:templates
 *
 * Exit: 0 = all reachable · 1 = one or more unreachable · 2 = usage/parse error.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = readFileSync(join(root, "src/lib/templates.ts"), "utf8");
const urls = [...src.matchAll(/gitUrl:\s*"([^"]+)"/g)].map((m) => m[1]);

if (urls.length === 0) {
  console.error("No template gitUrls found in src/lib/templates.ts");
  process.exit(2);
}

async function status(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "follow", // follows repo renames (301) → still resolves
      headers: { "User-Agent": "phasr-template-check" },
      signal: ctrl.signal,
    });
    return res.status;
  } catch (e) {
    return `ERR ${e.name === "AbortError" ? "timeout" : e.message}`;
  } finally {
    clearTimeout(timer);
  }
}

let bad = 0;
for (const url of urls) {
  const s = await status(url);
  const ok = s === 200;
  if (!ok) bad++;
  console.log(`${ok ? "OK  " : "BAD "} ${String(s).padEnd(6)} ${url}`);
}
console.log(`\n${urls.length} template URL(s), ${bad} unreachable`);
process.exit(bad ? 1 : 0);
