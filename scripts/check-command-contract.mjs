#!/usr/bin/env node
// Tauri IPC command-contract checker — deterministic, dependency-free.
// It is the poka-yoke for phasr's #1 backend mistake: a command wired in
// only 2 of the 3 places it must appear. Committed here (`pnpm
// check:commands`) so CI and reviewers can run it; the copy bundled with the
// `tauri-backend` skill lives under the gitignored `.claude/`.
// (Per Anthropic's Agent Skills guidance: prefer code for deterministic
// operations better suited to algorithms than token generation.)
//
// A Tauri command name must be present, identically, in THREE places:
//   1. src/lib/tauri.ts          — invoke<T>("<snake_case>", …)   [frontend call]
//   2. src-tauri/src/**/*.rs      — #[tauri::command] pub async fn <snake_case>
//   3. src-tauri/src/lib.rs       — inside tauri::generate_handler![ … ]  (module::path::<snake_case>)
//
// Usage (run from the repo root):
//   node scripts/check-command-contract.mjs <command>
//   node scripts/check-command-contract.mjs git_status
//   node scripts/check-command-contract.mjs --all
//
// Exit codes (match check-contrast.mjs so callers can gate):
//   0 = present & consistent in all 3 places
//   1 = drift / missing in at least one place
//   2 = usage error (no arg, or a source file/handler block not found)
//
// SCOPE / LIMITS (be honest): this verifies command-NAME wiring only. It does
// NOT check arg names, return-shape fields, or serde enum casing — those need a
// real Rust+TS type parser and stay on the tauri-engineer agent's manual IPC
// checklist. Names are the thing that silently drifts; shapes fail louder.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const TAURI_TS = "src/lib/tauri.ts";
const LIB_RS = "src-tauri/src/lib.rs";
const RS_ROOT = "src-tauri/src";

function read(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function walkRs(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) walkRs(p, out);
    else if (name.endsWith(".rs")) out.push(p);
  }
  return out;
}

function collect() {
  const errors = [];

  // (1) tauri.ts invoke names
  const ts = read(TAURI_TS);
  if (ts == null) errors.push(`cannot read ${TAURI_TS}`);
  const tsNames = new Set();
  if (ts) {
    const re = /invoke\s*(?:<[^>]*>)?\s*\(\s*["'`]([a-z0-9_]+)["'`]/g;
    let m;
    while ((m = re.exec(ts))) tsNames.add(m[1]);
  }

  // (2) #[tauri::command] fns across all .rs files
  const fnNames = new Set();
  const rsFiles = walkRs(RS_ROOT);
  const cmdRe =
    /#\[tauri::command\][\s\S]{0,200}?\bfn\s+([a-z0-9_]+)\s*\(/g;
  for (const f of rsFiles) {
    const src = read(f);
    if (!src) continue;
    let m;
    cmdRe.lastIndex = 0;
    while ((m = cmdRe.exec(src))) fnNames.add(m[1]);
  }

  // (3) generate_handler! entries in lib.rs → last :: segment
  const lib = read(LIB_RS);
  if (lib == null) errors.push(`cannot read ${LIB_RS}`);
  const handlerNames = new Set();
  if (lib) {
    const start = lib.indexOf("generate_handler![");
    if (start === -1) {
      errors.push(`generate_handler! block not found in ${LIB_RS}`);
    } else {
      // Balance brackets from the "[" of generate_handler![ to its close.
      const open = lib.indexOf("[", start);
      let depth = 0;
      let end = -1;
      for (let i = open; i < lib.length; i++) {
        if (lib[i] === "[") depth++;
        else if (lib[i] === "]") {
          depth--;
          if (depth === 0) {
            end = i;
            break;
          }
        }
      }
      const block = lib.slice(open + 1, end === -1 ? lib.length : end);
      for (const raw of block.split(",")) {
        const entry = raw.trim();
        if (!entry) continue;
        const seg = entry.split("::").pop().trim();
        if (/^[a-z0-9_]+$/.test(seg)) handlerNames.add(seg);
      }
    }
  }

  return { tsNames, fnNames, handlerNames, errors };
}

function row(present) {
  return present ? "✓" : "✗";
}

function reportOne(name, { tsNames, fnNames, handlerNames }) {
  const inTs = tsNames.has(name);
  const inFn = fnNames.has(name);
  const inHandler = handlerNames.has(name);
  const ok = inTs && inFn && inHandler;

  console.log(`Command contract: ${name}`);
  console.log(`  ${row(inTs)}  tauri.ts        invoke("${name}")`);
  console.log(`  ${row(inFn)}  #[tauri::command] fn ${name}`);
  console.log(`  ${row(inHandler)}  lib.rs          generate_handler![ … ::${name} ]`);

  if (ok) {
    console.log(`  → OK: wired in all 3 places.`);
  } else {
    const missing = [];
    if (!inTs) missing.push("tauri.ts invoke");
    if (!inFn) missing.push("#[tauri::command] fn");
    if (!inHandler) missing.push("generate_handler!");
    console.log(`  → DRIFT: missing in ${missing.join(", ")}.`);
  }
  return ok;
}

function reportAll(data) {
  const { tsNames, fnNames, handlerNames } = data;
  const all = [...new Set([...tsNames, ...fnNames, ...handlerNames])].sort();
  let bad = 0;
  console.log(`Command contract — all ${all.length} names (✓=present, ✗=missing)\n`);
  console.log(`  ts  fn  reg   command`);
  for (const name of all) {
    const inTs = tsNames.has(name);
    const inFn = fnNames.has(name);
    const inHandler = handlerNames.has(name);
    const consistent = inTs && inFn && inHandler;
    if (!consistent) bad++;
    const flag = consistent ? "  " : "⚠ ";
    console.log(
      `${flag}${row(inTs)}   ${row(inFn)}   ${row(inHandler)}    ${name}`,
    );
  }
  console.log(
    `\n${bad === 0 ? "OK" : "DRIFT"}: ${all.length - bad}/${all.length} commands wired in all 3 places` +
      (bad ? ` — ${bad} need attention (⚠).` : "."),
  );
  return bad === 0;
}

// ── main ──────────────────────────────────────────────────────────────
const arg = process.argv[2];
if (!arg) {
  console.error(
    "usage: node check-command-contract.mjs <snake_case_command> | --all",
  );
  process.exit(2);
}

const data = collect();
if (data.errors.length) {
  for (const e of data.errors) console.error(`error: ${e}`);
  process.exit(2);
}

const ok = arg === "--all" ? reportAll(data) : reportOne(arg, data);
process.exit(ok ? 0 : 1);
