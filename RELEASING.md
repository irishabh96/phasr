# Releasing Phasr

Releases are built by GitHub Actions when a `v*` tag lands on the repo. A macos-14 (Apple Silicon) runner produces the `aarch64` DMG and uploads it to a draft Release. The maintainer writes notes and publishes. Intel Mac support is out of scope for pre-1.0.

This doc is maintainer-only — contributors do not need to do any of this to develop or open PRs.

## One-time setup

Create a GitHub Environment named `release` under **Settings → Environments**.
Add these values under **Settings → Environments → release → Secrets and variables**:

- `VITE_CLERK_PUBLISHABLE_KEY` — production Clerk publishable key
- `VITE_SUPABASE_URL` — production Supabase project URL
- `VITE_SUPABASE_ANON_KEY` — production Supabase anon key

Use environment **secrets** if you want GitHub to mask the values in logs. Environment **variables** also work for these public client-side values, and the workflow reads secrets first, then variables. The repo itself never stores them. `GITHUB_TOKEN` is provided automatically.

The release workflow declares `environment: release`, so GitHub only exposes these values to tagged release builds. Add required reviewers or wait timers on the environment if releases should require approval before keys are made available to the runner.

> **Note on key exposure.** Vite inlines `VITE_*` env vars into the JS bundle. Anyone with the DMG can recover the literal strings (`strings`, `grep`). The Clerk publishable key and Supabase anon key are both designed for client-side use — Clerk auth is enforced server-side; Supabase access is gated by RLS policies on the database. The build does not need any private keys.

## Cutting a release

1. **Bump the version** in all three places (they must match — they're not derived from each other):
   - `package.json` → `"version"`
   - `src-tauri/tauri.conf.json` → `"version"`
   - `src-tauri/Cargo.toml` → `[package].version`

2. **Commit** the bump on `master`:
   ```sh
   git commit -am "v0.1.0"
   ```

3. **Tag and push:**
   ```sh
   git tag v0.1.0
   git push origin master --tags
   ```

4. **Watch the workflow.** Open Actions → Release. One job runs:
   - `macos-14` builds `aarch64-apple-darwin` → `Phasr_<version>_aarch64.dmg`

   Cold-cache build: ~10 min. Warm: ~3 min.

5. **Inspect the draft Release.** When the job finishes, open the draft on the Releases page. Confirm the DMG is attached plus its `.app.tar.gz` sibling (Tauri uploads both for users who prefer extraction over DMG mount).

6. **Write release notes** in the draft. Highlights, breaking changes, known issues. Reference notable PRs.

7. **Publish.**

## Versioning

Pre-1.0 we use SemVer loosely:

- Patch (`v0.1.1`) — bug fixes only
- Minor (`v0.2.0`) — new features or behavior changes
- Major (`v1.0.0`) — TBD when the API/UX is stable

## Artifact naming

Tauri's default naming:

- `Phasr_<version>_aarch64.dmg` — Apple Silicon
- `Phasr.app.tar.gz` sibling — same .app, just zipped

Intel (`x86_64`) DMGs aren't built. Adding them is a single matrix entry in `release.yml` when there's demand — either a `macos-14` cross-build (`rustup target add x86_64-apple-darwin`, no queue wait) or a native `macos-13` runner (subject to the public-runner pool).

## Code signing (future)

The builds are currently unsigned. To upgrade to signed + notarized builds:

1. Acquire a Developer ID Application certificate via the Apple Developer Program.
2. Add five more secrets:
   - `APPLE_CERTIFICATE` — base64-encoded `.p12` of the cert
   - `APPLE_CERTIFICATE_PASSWORD` — password for the `.p12`
   - `APPLE_SIGNING_IDENTITY` — the cert's display name (e.g. `Developer ID Application: …`)
   - `APPLE_ID` — your Apple ID email
   - `APPLE_PASSWORD` — an app-specific password from appleid.apple.com
   - `APPLE_TEAM_ID` — your team ID
3. `tauri-apps/tauri-action` reads these env vars automatically — no workflow rewrite required.
4. Remove the Gatekeeper-bypass section from `README.md`.

## Dry run

To test the workflow without producing a real release, push a throwaway tag:

```sh
git tag v0.0.1-test
git push origin v0.0.1-test
```

When the draft appears, inspect it, then delete the draft + delete the tag:

```sh
git push --delete origin v0.0.1-test
git tag -d v0.0.1-test
```
