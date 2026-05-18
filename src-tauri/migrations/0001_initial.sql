-- Initial schema. Mirrors the cloud (Supabase) schema 1:1 plus per-row
-- sync metadata (dirty + synced_at) used by the sync worker we'll add
-- in Phase 6. All IDs are UUIDv4 strings. All timestamps are ISO 8601
-- strings — SQLite has no native timestamp, and storing as text keeps
-- queries human-readable without sacrificing sortability.

PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

CREATE TABLE workspaces (
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    remote_url      TEXT,
    local_path      TEXT,
    default_branch  TEXT NOT NULL DEFAULT 'main',
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL,
    synced_at       TEXT,
    dirty           INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX idx_workspaces_dirty   ON workspaces(dirty) WHERE dirty = 1;
CREATE INDEX idx_workspaces_updated ON workspaces(updated_at);

CREATE TABLE presets (
    id           TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    command      TEXT NOT NULL,
    icon         TEXT,
    is_default   INTEGER NOT NULL DEFAULT 0,
    is_enabled   INTEGER NOT NULL DEFAULT 1,
    is_seed      INTEGER NOT NULL DEFAULT 0,
    sort_order   INTEGER NOT NULL DEFAULT 0,
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL,
    synced_at    TEXT,
    dirty        INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX idx_presets_dirty ON presets(dirty) WHERE dirty = 1;

CREATE TABLE tasks (
    id             TEXT PRIMARY KEY,
    workspace_id   TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    name           TEXT NOT NULL,
    prompt         TEXT,
    preset_id      TEXT REFERENCES presets(id) ON DELETE SET NULL,
    command        TEXT NOT NULL,
    status         TEXT NOT NULL,
    branch         TEXT,
    worktree_path  TEXT,
    exit_code      INTEGER,
    created_at     TEXT NOT NULL,
    started_at     TEXT,
    finished_at    TEXT,
    archived_at    TEXT,
    updated_at     TEXT NOT NULL,
    synced_at      TEXT,
    dirty          INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX idx_tasks_workspace  ON tasks(workspace_id);
CREATE INDEX idx_tasks_status     ON tasks(status);
CREATE INDEX idx_tasks_dirty      ON tasks(dirty) WHERE dirty = 1;
CREATE INDEX idx_tasks_created_at ON tasks(created_at);

CREATE TABLE workspace_config (
    workspace_id            TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
    branch_prefix_template  TEXT,
    worktree_base_path      TEXT,
    default_merge_strategy  TEXT,
    env_vars                TEXT NOT NULL DEFAULT '{}',
    pre_task_hook           TEXT,
    post_task_hook          TEXT,
    updated_at              TEXT NOT NULL,
    synced_at               TEXT,
    dirty                   INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE run_commands (
    id             TEXT PRIMARY KEY,
    workspace_id   TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    name           TEXT NOT NULL,
    command        TEXT NOT NULL,
    shortcut       TEXT,
    pinned         INTEGER NOT NULL DEFAULT 0,
    sort_order     INTEGER NOT NULL DEFAULT 0,
    created_at     TEXT NOT NULL,
    updated_at     TEXT NOT NULL,
    synced_at      TEXT,
    dirty          INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX idx_run_commands_workspace ON run_commands(workspace_id);

-- Singleton row enforced by CHECK (id = 1).
CREATE TABLE user_settings (
    id                       INTEGER PRIMARY KEY CHECK (id = 1),
    theme                    TEXT NOT NULL DEFAULT 'dark',
    accent_color             TEXT NOT NULL DEFAULT 'indigo',
    sans_font                TEXT NOT NULL DEFAULT 'Inter',
    mono_font                TEXT NOT NULL DEFAULT 'JetBrains Mono',
    base_font_size           INTEGER NOT NULL DEFAULT 13,
    cursor_style             TEXT NOT NULL DEFAULT 'block',
    cursor_blink             INTEGER NOT NULL DEFAULT 1,
    terminal_scrollback      INTEGER NOT NULL DEFAULT 10000,
    default_editor           TEXT NOT NULL DEFAULT 'vscode',
    default_terminal         TEXT NOT NULL DEFAULT 'iterm',
    default_preset_id        TEXT REFERENCES presets(id) ON DELETE SET NULL,
    keyboard_shortcuts       TEXT NOT NULL DEFAULT '{}',
    branch_prefix_template   TEXT NOT NULL DEFAULT 'phasr/{{slug}}',
    worktree_base_path       TEXT NOT NULL DEFAULT '~/.phasr/worktrees',
    default_merge_strategy   TEXT NOT NULL DEFAULT 'merge',
    auto_fetch_seconds       INTEGER NOT NULL DEFAULT 60,
    honor_gpg_sign           INTEGER NOT NULL DEFAULT 1,
    auto_push_on_commit      INTEGER NOT NULL DEFAULT 0,
    updated_at               TEXT NOT NULL,
    synced_at                TEXT,
    dirty                    INTEGER NOT NULL DEFAULT 1
);
