# Staq (Go MVP)

Staq is a Go-first reconstruction of the Superset-style coding-agent workspace: run multiple CLI agents in parallel, isolate each task in a git worktree, and monitor logs/diffs from a single dashboard.

## What This MVP Includes

- Multi-agent dashboard (running/completed/archived tasks)
- Per-task git worktree + branch isolation
- Concurrent CLI agent runner with PTY-backed terminal sessions + real-time streaming (SSE)
- Git diff viewer with changed-file summary + patch rendering
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

## Quick Start

1. Configure env (optional):

```bash
cp .env.example .env
```

2. Build and run:

```bash
make build
./bin/staq
# or: make run
```

3. Open dashboard:

- `http://127.0.0.1:7777`

4. Create a task:

- `Repo Path`: absolute path to an existing local git repository
- `Agent Command`: any CLI coding agent command
- Optional preset/prompt

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
- `logs/<task-id>.log`
- `worktrees/<task-id>-<name>/`
- `presets.json` (optional)

## Known Limitations (MVP)

- No auth/multi-user model (local workstation only)
- No remote runners
- Browser UI provides lightweight terminal I/O; no full ANSI terminal renderer yet
- Restart does not reattach running processes; tasks marked `stopped`
- Diff view uses standard `git diff` output only

## Next Improvements

1. Add websocket multiplexing + richer terminal stream metadata
2. Add full ANSI terminal rendering in UI with scrollback controls
3. Add workspace snapshot/export and task sharing
4. Add policy controls for repo allow-lists and command safelists
5. Add unit/integration tests around task + worktree lifecycle
