# Phasr

Phasr is a desktop workspace for running multiple coding agents in parallel, each in its own isolated git worktree.

Website: https://phasr.sh

## Why Phasr

Most agent workflows break down when you need multiple streams of work at once. Phasr gives you one place to launch, track, and ship parallel agent tasks without branch collisions.

## Highlights

- Parallel agent runs from one dashboard
- Per-task git worktree and branch isolation
- Live terminal streaming with interactive input
- Staged/unstaged git view with commit flow
- Open worktrees quickly in your editor
- Local-first storage (`~/.phasr`)
- Native macOS desktop mode

## Install (macOS)

One-step install:

```bash
./scripts/install-macos.sh
```

This builds and installs `phasr.sh.app` to `/Applications` (or `~/Applications` fallback) and creates a `phasr-desktop` CLI symlink when possible.

## Run From Source

```bash
make ui-install
make desktop-run
```

CLI mode is also available:

```bash
make run
```

## Requirements

- macOS
- Go 1.25+
- Node.js 18+
- npm
- git
- zsh
- Xcode Command Line Tools

## Quick Start

1. Launch the app.
2. Add a local repository path.
3. Pick an agent command.
4. Start tasks and monitor logs/diffs in parallel.

## Production Release (macOS)

For distributable builds (Gatekeeper-safe), use Developer ID signing + notarization:

```bash
export PHASR_CODESIGN_IDENTITY="Developer ID Application: Your Name (TEAMID)"
export PHASR_NOTARY_PROFILE="phasr-notary-profile"
make desktop-production-dmg
```

The target prints `DMG_PATH=...` on success.

## Project Layout

```text
cmd/phasr                 # CLI app
cmd/phasr-desktop         # macOS desktop app
internal/task             # task lifecycle orchestration
internal/gitops           # git worktree management
internal/process          # process + PTY runtime
internal/api              # dashboard + HTTP server
scripts/                  # build/export/install scripts
```

## Open Source

- License: [MIT](LICENSE)
- Contributing: [CONTRIBUTING.md](CONTRIBUTING.md)
- Security: [SECURITY.md](SECURITY.md)
- Code of Conduct: [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)
