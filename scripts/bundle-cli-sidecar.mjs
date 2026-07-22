#!/usr/bin/env node
// Pre-bundle step for the `phasr` agent CLI sidecar (#29 part 1).
//
// Tauri's `bundle.externalBin: ["binaries/phasr-cli"]` does NOT build anything —
// at bundle time it looks for a file named `binaries/phasr-cli-<target-triple>`
// (e.g. `binaries/phasr-cli-aarch64-apple-darwin`) and copies it into the app
// next to the main executable (on macOS: `Phasr.app/Contents/MacOS/phasr-cli`).
// The sidecar base name is `phasr-cli` (NOT `phasr`): tauri-build rejects a
// sidecar sharing the Cargo package name `phasr`. This script builds the CLI in
// release and drops it at the triple-suffixed path the bundler expects. Wired
// into `beforeBuildCommand`, so it runs before Tauri packages the app.
// Idempotent: it just rebuilds + overwrites the copy.
//
// Why `TAURI_ENV_TARGET_TRIPLE` first, host triple as fallback: Tauri injects
// that env var into the beforeBuildCommand and it reflects `--target` (so cross
// builds get the right suffix + a matching `target/<triple>/release/` artifact).
// When run by hand (no Tauri) we fall back to the host triple from `rustc -vV`.

import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const BIN_NAME = "phasr-cli"; // cargo [[bin]] target name
const SIDECAR_BASENAME = "phasr-cli"; // must match `binaries/phasr-cli` in tauri.conf.json

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const srcTauri = join(repoRoot, "src-tauri");

function hostTriple() {
  // Parse the `host: <triple>` line from `rustc -vV` (portable; `--print
  // host-tuple` is a newer rustc and not everywhere yet).
  const out = execFileSync("rustc", ["-vV"], { encoding: "utf8" });
  const line = out.split("\n").find((l) => l.startsWith("host:"));
  if (!line) throw new Error("could not determine host triple from `rustc -vV`");
  return line.slice("host:".length).trim();
}

const triple = process.env.TAURI_ENV_TARGET_TRIPLE || hostTriple();
const host = hostTriple();
const isCross = triple !== host;

// Build the CLI. Cross builds need `--target` AND land in `target/<triple>/…`.
const cargoArgs = ["build", "--release", "--bin", BIN_NAME];
if (isCross) cargoArgs.push("--target", triple);
console.log(`[sidecar] cargo ${cargoArgs.join(" ")}`);
execFileSync("cargo", cargoArgs, { cwd: srcTauri, stdio: "inherit" });

const builtDir = isCross
  ? join(srcTauri, "target", triple, "release")
  : join(srcTauri, "target", "release");
const builtBin = join(builtDir, BIN_NAME);

const outDir = join(srcTauri, "binaries");
const outBin = join(outDir, `${SIDECAR_BASENAME}-${triple}`);

mkdirSync(outDir, { recursive: true });
copyFileSync(builtBin, outBin);
console.log(`[sidecar] copied ${builtBin} -> ${outBin}`);
