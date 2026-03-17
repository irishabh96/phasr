# Phasr

Phasr is a local workspace for running multiple coding agents in parallel. It provides a single dashboard to launch tasks, isolate each task in its own git worktree, stream terminal output, and manage changes through an integrated git workflow.

Website: https://phasr.sh

## What Phasr Does

Phasr is built for development workflows where multiple agent tasks run at the same time across one or more repositories. It helps you:

- run concurrent agent sessions without branch collisions
- isolate task execution in per-task worktrees
- monitor logs, status, and diffs in real time
- stage, commit, and publish changes from the same UI

## Core Features

### Workspace and Repository Management

- Create named workspaces mapped to local repository paths.
- Validate repository directories before task execution.
- Optionally initialize git for a workspace if a directory is not yet a repository.
- Persist workspace metadata locally for restart-safe operation.

### Parallel Task Orchestration

- Create and run many tasks concurrently from one dashboard.
- Track task lifecycle states: `pending`, `running`, `stopped`, `completed`, `failed`, and `archived`.
- Resume or stop tasks, archive finished work, and cleanly delete tasks.
- Restart recovery: tasks persisted as running are restored on app restart (best effort).

### Git Worktree Isolation

- Creates a dedicated branch and worktree for non-direct tasks.
- Uses branch naming based on task identity (for example `task/<name>` with collision-safe suffixes).
- Falls back to direct-repo execution when a repository has no commits yet.
- Removes managed worktree paths during task cleanup.

### Interactive Terminal Runtime

- Runs task commands in PTY-backed `zsh` sessions.
- Supports live output streaming, terminal input, resize, and interrupt (`SIGINT`).
- Persists logs per task under the local data directory.
- Streams task events over SSE for responsive UI updates.

### Built-In Git Operations

- Inspect staged and unstaged files.
- Stage, unstage, and discard file changes.
- View patch output and change statistics.
- Commit, push, pull, fetch, and inspect commit history from the UI.

### Agent and Preset Support

- Default command presets in UI for common agent CLIs (`claude`, `codex`, `copilot`, `opencode`, `gemini`).
- Startup presets for repository preparation (for example `go-bootstrap`, `js-bootstrap`, `verify-and-test`).
- Extend presets with a local `presets.json` in the Phasr data directory.

### Local Tooling Integration (Desktop Runtime)

- Open task or workspace paths directly in supported IDEs/editors.
- Open paths in Terminal and copy paths from the context menu.
- Generate repository metadata links (repo, branch, PR) for GitHub/GitLab/Bitbucket remotes.

## Runtime Modes

Phasr supports two runtime modes:

1. Desktop app (`cmd/phasr-desktop`, macOS only)
2. CLI-hosted web app (`cmd/phasr`, serves dashboard at `PHASR_ADDR`)

## Requirements

### General (all builds)

- Go `1.25+`
- Node.js `18+`
- `npm`
- `git`
- `zsh`

### macOS desktop build/install

- macOS (desktop runtime target)
- Xcode Command Line Tools (`xcode-select --install`)

## Installation

### 1. macOS One-Step Install (Recommended for Desktop Use)

From the repository root:

```bash
./scripts/install-macos.sh
```

What this does:

- builds the UI and desktop binary
- exports `phasr.sh.app` into `dist/`
- installs the app into `/Applications` (or falls back to `~/Applications`)
- attempts to create a `phasr-desktop` CLI symlink in a writable bin directory

Launch after install:

```bash
open "/Applications/phasr.sh.app"
```

If installed in `~/Applications`, update the path accordingly.

### 2. Or Run Desktop Runtime from Source (macOS)

```bash
make ui-install
make desktop-run
```

## Quick Start

1. Start Phasr (desktop or CLI runtime).
2. Create a workspace and select a local repository path.
3. Choose an agent command and optional preset.
4. Enter a prompt and run the task.
5. Monitor terminal output and status in real time.
6. Review diffs, stage changes, commit, and publish.

## Configuration

Phasr is configured through environment variables and optional CLI flags.

### Environment Variables

| Variable               | Default          | Description                               |
| ---------------------- | ---------------- | ----------------------------------------- |
| `PHASR_ADDR`           | `127.0.0.1:7777` | HTTP listen address for dashboard/API     |
| `PHASR_DATA_DIR`       | `~/.phasr`       | Root directory for local data             |
| `PHASR_DEFAULT_EDITOR` | `code`           | Default editor command for "Open" actions |

### CLI Flags (`cmd/phasr`)

- `-addr` HTTP listen address
- `-data-dir` local data directory
- `-editor` default editor command

### Desktop Flags (`cmd/phasr-desktop`)

- All CLI flags above
- `-title` desktop window title
- `-width` initial window width
- `-height` initial window height
- `-debug` enable webview devtools

## Data Storage

Phasr stores runtime data in `PHASR_DATA_DIR` (default `~/.phasr`):

- `tasks.json` task metadata/state
- `workspaces.json` workspace registry
- `presets.json` optional custom presets
- `logs/` per-task logs
- `worktrees/` managed git worktrees

## Development

### Common Commands

```bash
make ui-install
make ui-build
make build
go test ./...
```

### Desktop Development

```bash
make desktop-build
make desktop-run
```

### Notes

- The runtime validates that compiled UI assets are up to date. If frontend sources changed, run `make ui-build` before starting.
- `make run` and `make desktop-run` automatically free port `7777` if another process is listening.

## Project Structure

```text
cmd/phasr                 # CLI-hosted web runtime
cmd/phasr-desktop         # macOS desktop runtime
internal/api              # HTTP server, handlers, embedded UI
internal/task             # Task lifecycle and orchestration
internal/process          # PTY process runtime and event streaming
internal/gitops           # Git worktree management
internal/diff             # Git diff/status/commit operations
internal/store            # Local JSON persistence
scripts/                  # Build/export/install scripts
```

## Security, Contributing, and License

- Security policy: [SECURITY.md](SECURITY.md)
- Contributing guide: [CONTRIBUTING.md](CONTRIBUTING.md)
- Code of conduct: [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)
- License: [MIT](LICENSE)
