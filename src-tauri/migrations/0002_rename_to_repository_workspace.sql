-- Rename for the "repository/workspace" naming model.
--
-- - The old `workspaces` table represents a connection to a git repo →
--   becomes `repositories`.
-- - The old `tasks` table represents one agent run inside a repo →
--   becomes `workspaces`.
-- - The FK column `tasks.workspace_id` becomes `workspaces.repository_id`.
--
-- SQLite handles the rename with foreign keys auto-following because
-- we use the modern (3.25+) `ALTER TABLE … RENAME COLUMN` syntax.

PRAGMA foreign_keys = OFF;

ALTER TABLE workspaces      RENAME TO repositories;
ALTER TABLE tasks           RENAME TO workspaces;
ALTER TABLE workspaces      RENAME COLUMN workspace_id TO repository_id;

ALTER TABLE workspace_config RENAME TO repository_config;
ALTER TABLE repository_config RENAME COLUMN workspace_id TO repository_id;

ALTER TABLE run_commands    RENAME COLUMN workspace_id TO repository_id;

-- Indexes: drop the now-stale names and recreate against the new tables.
DROP INDEX IF EXISTS idx_workspaces_dirty;
DROP INDEX IF EXISTS idx_workspaces_updated;
DROP INDEX IF EXISTS idx_tasks_workspace;
DROP INDEX IF EXISTS idx_tasks_status;
DROP INDEX IF EXISTS idx_tasks_dirty;
DROP INDEX IF EXISTS idx_tasks_created_at;
DROP INDEX IF EXISTS idx_run_commands_workspace;

CREATE INDEX idx_repositories_dirty    ON repositories(dirty) WHERE dirty = 1;
CREATE INDEX idx_repositories_updated  ON repositories(updated_at);
CREATE INDEX idx_workspaces_repository ON workspaces(repository_id);
CREATE INDEX idx_workspaces_status     ON workspaces(status);
CREATE INDEX idx_workspaces_dirty      ON workspaces(dirty) WHERE dirty = 1;
CREATE INDEX idx_workspaces_created_at ON workspaces(created_at);
CREATE INDEX idx_run_commands_repository ON run_commands(repository_id);

PRAGMA foreign_keys = ON;
