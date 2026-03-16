import crypto from "node:crypto";
import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const frontendDir = resolve(__dirname, "..");
const repoRoot = resolve(frontendDir, "..", "..", "..");
const distDir = resolve(frontendDir, "..", "static", "dist");

function readGitCommit(cwd) {
  try {
    return execSync("git rev-parse --short HEAD", {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
    }).toString().trim();
  } catch (_) {
    return "unknown";
  }
}

const builtAt = new Date().toISOString();
const stamp = builtAt.replace(/[-:.TZ]/g, "").slice(0, 14);
const commit = readGitCommit(repoRoot);
const nonce = crypto.randomBytes(3).toString("hex");
const version = `${stamp}-${commit}-${nonce}`;

const buildMeta = {
  version,
  builtAt,
  commit,
};

mkdirSync(distDir, { recursive: true });

writeFileSync(
  resolve(distDir, "build-meta.json"),
  `${JSON.stringify(buildMeta, null, 2)}\n`,
  "utf8",
);

writeFileSync(
  resolve(distDir, "build-meta.js"),
  `window.__STAQ_UI_BUILD_META__ = ${JSON.stringify(buildMeta)};\nwindow.__STAQ_ASSET_VERSION__ = String(window.__STAQ_UI_BUILD_META__.version || "");\n`,
  "utf8",
);

writeFileSync(resolve(distDir, "build-version.txt"), `${version}\n`, "utf8");

console.log(`[ui-build-meta] version=${version}`);
