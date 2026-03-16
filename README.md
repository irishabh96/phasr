# Staq (Go MVP)

Staq is a Go-first reconstruction of the Superset-style coding-agent workspace: run multiple CLI agents in parallel, isolate each task in a git worktree, and monitor logs/diffs from a single dashboard.

## What This MVP Includes

- Multi-agent dashboard (running/completed/archived tasks)
- Workspace + tag metadata for task organization/filtering (workspace stores repo path)
- Workspace sidebar with active highlight + create workspace action
- Per-task git worktree + branch isolation
- Concurrent CLI agent runner with PTY-backed terminal sessions + real-time streaming (SSE)
- Interactive ANSI terminal pane (`xterm`) with tabbed task sessions
- Git sidebar with staged/unstaged changes, line counts, stage/unstage, and commit action
- Task lifecycle: create, stop, resume, archive, delete
- Editor launcher integration (`code`, `cursor`, `zed`, `vim`, `open`, custom command)
- Presets/templates for setup commands before agent execution
- Local persistence (`tasks.json`, per-task logs)
- Interactive terminal input per running task (including `Ctrl+C`)

## Superset Concepts Translated to Go Services

This implementation mirrors the product concepts, not the JavaScript code:

- `task manager` -> `internal/task`
  - Task lifecycle, persistence orchestration, status transitions
- `process manager` -> `internal/process`
  - Runs arbitrary shell commands, tracks PID/exit, publishes events
- `git worktree manager` -> `internal/gitops`
  - Creates/removes isolated worktrees + branches per task
- `diff service` -> `internal/diff`
  - `git status --porcelain` parsing + patch generation
- `preset/template manager` -> `internal/preset`
  - Built-in presets plus optional `~/.staq/presets.json`
- `editor launcher` -> `internal/editor`
  - Open task worktree in your preferred editor command
- `config/settings manager` -> `internal/config`
  - Env + flags + derived storage paths
- `dashboard/api` -> `internal/api`
  - Server-rendered UI + JSON API + SSE stream

## Architecture

```
cmd/staq/main.go            # app bootstrap
internal/config             # env + runtime settings
internal/domain             # core task model
internal/store              # JSON task persistence
internal/preset             # preset loading and defaults
internal/gitops             # git worktree orchestration
internal/process            # process runtime + events
internal/diff               # git diff/status inspection
internal/task               # orchestration layer
internal/api                # HTTP API + dashboard template
```

## Requirements (macOS-first)

- Go 1.25+
- `git`
- `zsh`
- At least one editor CLI if using open-editor actions (`code`, `cursor`, etc.)
- For desktop mode: Xcode Command Line Tools (for CGO) + macOS WebKit runtime

## Quick Start

1. Build and run CLI server:

```bash
make build
./bin/staq
# or: make run
```

`make build` and `make run` compile a fresh React frontend bundle every time.
`make run`/`make desktop-run` also stop any existing process listening on `127.0.0.1:7777` before launching the newly built binary, so you do not stay on stale assets.
Each UI build writes version metadata to `internal/api/static/dist/build-meta.json`.

Check the embedded UI build version:

```bash
make ui-version
```

Startup guard: if frontend sources are newer than `internal/api/static/dist/*`, the app refuses to open and asks you to run `make ui-build` first.

2. Open dashboard:

- `http://127.0.0.1:7777`

3. Create a task:

- `Repo Path`: absolute path to an existing local git repository
- `Agent Command`: any CLI coding agent command
- Optional `Workspace`, `Tags`, preset, and prompt

## Desktop App Mode (macOS)

Run Staq in a native desktop window (webview shell over the same Go backend):

```bash
make desktop-run
```

Build desktop binary:

```bash
make desktop-build
./bin/staq-desktop
```

If you are working on UI only:

```bash
make ui-install
make ui-dev
```

Common desktop flags:

- `-addr 127.0.0.1:7777`
- `-data-dir ~/.staq`
- `-editor code`
- `-width 1500 -height 980`
- `-debug`

## API Surface (MVP)

- `GET /api/tasks`
- `POST /api/tasks`
- `GET /api/tasks/{id}`
- `POST /api/tasks/{id}/stop`
- `POST /api/tasks/{id}/resume`
- `POST /api/tasks/{id}/archive`
- `DELETE /api/tasks/{id}`
- `GET /api/tasks/{id}/logs?tail=200`
- `GET /api/tasks/{id}/diff?file=<path>`
- `GET /api/tasks/{id}/events` (SSE)
- `POST /api/tasks/{id}/open-editor`
- `POST /api/tasks/{id}/terminal/input`
- `POST /api/tasks/{id}/terminal/resize`
- `GET /api/presets`
- `GET /api/workspaces`
- `POST /api/workspaces`
- `POST /api/local/browse-directory` (macOS folder picker)
- `GET /api/tasks/{id}/git/status`
- `POST /api/tasks/{id}/git/stage`
- `POST /api/tasks/{id}/git/unstage`
- `POST /api/tasks/{id}/git/commit`

## Presets File (Optional)

Create `~/.staq/presets.json` to define custom setup templates:

```json
{
  "presets": [
    {
      "name": "python-bootstrap",
      "description": "Prepare virtualenv and deps",
      "setup_commands": [
        "python3 -m venv .venv",
        "source .venv/bin/activate && pip install -r requirements.txt"
      ]
    }
  ]
}
```

## Data Layout

Default directory: `~/.staq`

- `tasks.json`
- `workspaces.json`
- `logs/<task-id>.log`
- `worktrees/<task-id>-<name>/`
- `presets.json` (optional)

## Known Limitations (MVP)

- No auth/multi-user model (local workstation only)
- No remote runners
- Desktop/web UI currently attaches one live terminal stream at a time (selected task)
- Restart does not reattach running processes; tasks marked `stopped`
- Diff view uses standard `git diff` output only

## Next Improvements

1. Add websocket multiplexing + richer terminal stream metadata
2. Add multi-task split terminal view with synchronized terminal tabs
3. Add workspace snapshot/export and task sharing
4. Add policy controls for repo allow-lists and command safelists
5. Add unit/integration tests around task + worktree lifecycle
