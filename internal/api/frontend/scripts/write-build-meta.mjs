import { execSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const frontendDir = resolve(__dirname, '..');
const repoRoot = resolve(frontendDir, '..', '..', '..');
const distDir = resolve(frontendDir, '..', 'static', 'dist');
const staticDir = resolve(frontendDir, '..', 'static');
const packageJSONPath = resolve(frontendDir, 'package.json');
const buildMetaJSONPath = resolve(distDir, 'build-meta.json');
const buildCounterPath = resolve(staticDir, 'ui-build-counter.json');

function readGitCommit(cwd) {
  try {
    return execSync('git rev-parse --short HEAD', {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
  } catch (_) {
    return 'unknown';
  }
}

function parseSemver(value) {
  const match = String(value || '')
    .trim()
    .match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

function readPackageVersion() {
  try {
    const pkg = JSON.parse(readFileSync(packageJSONPath, 'utf8'));
    const parsed = parseSemver(pkg.version);
    if (parsed) return parsed;
  } catch (_) {}
  return { major: 0, minor: 1, patch: 0 };
}

function readPreviousVersion() {
  try {
    const prior = JSON.parse(readFileSync(buildCounterPath, 'utf8'));
    const parsed = parseSemver(`${prior?.major}.${prior?.minor}.${prior?.patch}`);
    if (parsed) return parsed;
  } catch (_) {}

  try {
    const prior = JSON.parse(readFileSync(buildMetaJSONPath, 'utf8'));
    const parsed = parseSemver(prior?.version);
    if (parsed) return parsed;
  } catch (_) {}
  return null;
}

function nextSemanticVersion() {
  const base = readPackageVersion();
  const previous = readPreviousVersion();
  if (previous && previous.major === base.major && previous.minor === base.minor) {
    return `${base.major}.${base.minor}.${previous.patch + 1}`;
  }
  return `${base.major}.${base.minor}.${Math.max(base.patch, 0) + 1}`;
}

const builtAt = new Date().toISOString();
const commit = readGitCommit(repoRoot);
const version = nextSemanticVersion();

const buildMeta = {
  version,
  builtAt,
  commit,
};

mkdirSync(distDir, { recursive: true });
mkdirSync(staticDir, { recursive: true });

{
  const parsed = parseSemver(version);
  if (parsed) {
    writeFileSync(buildCounterPath, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
  }
}

writeFileSync(resolve(distDir, 'build-meta.json'), `${JSON.stringify(buildMeta, null, 2)}\n`, 'utf8');

writeFileSync(
  resolve(distDir, 'build-meta.js'),
  `window.__STAQ_UI_BUILD_META__ = ${JSON.stringify(buildMeta)};\nwindow.__STAQ_ASSET_VERSION__ = String(window.__STAQ_UI_BUILD_META__.version || "");\n`,
  'utf8',
);

writeFileSync(resolve(distDir, 'build-version.txt'), `${version}\n`, 'utf8');

console.log(`[ui-build-meta] version=${version}`);
