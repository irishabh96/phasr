-- Agents are now a fixed enum stored directly on the workspace, not a
-- foreign key into an `agents` table. Each agent's launch command is
-- hardcoded in the app (see domain::agent::Agent), so the table and the
-- per-user customization columns it backed are removed.
--
-- Both `workspaces` and `user_settings` carry a FOREIGN KEY into
-- `agents`, so we can't just DROP COLUMN / DROP TABLE — SQLite forbids
-- dropping a column named in a FK, and a dangling FK reference would
-- break future inserts once foreign_keys is re-enabled. We rebuild both
-- tables instead (the standard SQLite table-mutation pattern).

PRAGMA foreign_keys = OFF;

------------------------------------------------------------------------
-- 1) Map existing agent_id UUIDs to their lowercase enum string while
--    the `agents` table is still around to resolve names.
------------------------------------------------------------------------

UPDATE workspaces
   SET agent_id = (SELECT lower(name) FROM agents WHERE agents.id = workspaces.agent_id)
 WHERE agent_id IS NOT NULL
   AND EXISTS (SELECT 1 FROM agents WHERE agents.id = workspaces.agent_id);

-- Anything that didn't resolve to a known agent becomes NULL; the
-- workspace's stored `command` snapshot still runs.
UPDATE workspaces
   SET agent_id = NULL
 WHERE agent_id IS NOT NULL
   AND agent_id NOT IN ('claude', 'codex', 'copilot', 'gemini', 'opencode');

------------------------------------------------------------------------
-- 2) Rebuild `workspaces` without the agents FK, renaming agent_id -> agent.
------------------------------------------------------------------------

CREATE TABLE workspaces_new (
    id             TEXT PRIMARY KEY,
    repository_id  TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    name           TEXT NOT NULL,
    prompt         TEXT,
    agent          TEXT,
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
    dirty          INTEGER NOT NULL DEFAULT 1,
    user_id        TEXT REFERENCES users(id),
    workspace_kind TEXT NOT NULL DEFAULT 'agent'
);

INSERT INTO workspaces_new (
    id, repository_id, name, prompt, agent, command, status,
    branch, worktree_path, exit_code,
    created_at, started_at, finished_at, archived_at, updated_at,
    synced_at, dirty, user_id, workspace_kind
)
SELECT
    id, repository_id, name, prompt, agent_id, command, status,
    branch, worktree_path, exit_code,
    created_at, started_at, finished_at, archived_at, updated_at,
    synced_at, dirty, user_id, workspace_kind
FROM workspaces;

DROP TABLE workspaces;
ALTER TABLE workspaces_new RENAME TO workspaces;

CREATE INDEX idx_workspaces_repository ON workspaces(repository_id);
CREATE INDEX idx_workspaces_status     ON workspaces(status);
CREATE INDEX idx_workspaces_dirty      ON workspaces(dirty) WHERE dirty = 1;
CREATE INDEX idx_workspaces_created_at ON workspaces(created_at);
CREATE INDEX idx_workspaces_user       ON workspaces(user_id);
CREATE INDEX idx_workspaces_kind       ON workspaces(workspace_kind);

------------------------------------------------------------------------
-- 3) Drop the agents table (now unreferenced).
------------------------------------------------------------------------

DROP TABLE IF EXISTS agents;

------------------------------------------------------------------------
-- 4) Rebuild `user_settings` to drop default_agent_id (FK into agents)
--    and disabled_agent_ids.
------------------------------------------------------------------------

CREATE TABLE user_settings_new (
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
    keyboard_shortcuts       TEXT NOT NULL DEFAULT '{}',
    branch_prefix_template   TEXT NOT NULL DEFAULT 'phasr/{{slug}}',
    worktree_base_path       TEXT NOT NULL DEFAULT '~/.phasr/worktrees',
    default_merge_strategy   TEXT NOT NULL DEFAULT 'merge',
    auto_fetch_seconds       INTEGER NOT NULL DEFAULT 60,
    honor_gpg_sign           INTEGER NOT NULL DEFAULT 1,
    auto_push_on_commit      INTEGER NOT NULL DEFAULT 0,
    updated_at               TEXT NOT NULL,
    synced_at                TEXT,
    dirty                    INTEGER NOT NULL DEFAULT 1,
    user_id                  TEXT REFERENCES users(id)
);

INSERT INTO user_settings_new (
    id, theme, accent_color, sans_font, mono_font, base_font_size,
    cursor_style, cursor_blink, terminal_scrollback, default_editor,
    default_terminal, keyboard_shortcuts, branch_prefix_template,
    worktree_base_path, default_merge_strategy, auto_fetch_seconds,
    honor_gpg_sign, auto_push_on_commit, updated_at, synced_at, dirty, user_id
)
SELECT
    id, theme, accent_color, sans_font, mono_font, base_font_size,
    cursor_style, cursor_blink, terminal_scrollback, default_editor,
    default_terminal, keyboard_shortcuts, branch_prefix_template,
    worktree_base_path, default_merge_strategy, auto_fetch_seconds,
    honor_gpg_sign, auto_push_on_commit, updated_at, synced_at, dirty, user_id
FROM user_settings;

DROP TABLE user_settings;
ALTER TABLE user_settings_new RENAME TO user_settings;

PRAGMA foreign_keys = ON;
