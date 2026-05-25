-- Add a machine-local "local" workspace for each repository. Local
-- workspaces point at the repository's own checkout instead of a
-- Phasr-created git worktree and are intentionally kept out of cloud sync.

ALTER TABLE workspaces
    ADD COLUMN workspace_kind TEXT NOT NULL DEFAULT 'agent';

CREATE INDEX idx_workspaces_kind
    ON workspaces(workspace_kind);

INSERT INTO workspaces (
    id, user_id, repository_id, name, prompt, agent_id, command, status,
    branch, worktree_path, exit_code,
    created_at, started_at, finished_at, archived_at, updated_at,
    synced_at, dirty, workspace_kind
)
SELECT
    lower(hex(randomblob(4))) || '-' ||
    lower(hex(randomblob(2))) || '-' ||
    lower(hex(randomblob(2))) || '-' ||
    lower(hex(randomblob(2))) || '-' ||
    lower(hex(randomblob(6))),
    repositories.user_id,
    repositories.id,
    'local',
    NULL,
    NULL,
    '',
    'stopped',
    repositories.default_branch,
    repositories.local_path,
    NULL,
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    NULL,
    NULL,
    NULL,
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    0,
    'local'
FROM repositories
WHERE repositories.deleted_at IS NULL
  AND repositories.local_path IS NOT NULL
  AND repositories.local_path != ''
  AND NOT EXISTS (
      SELECT 1
      FROM workspaces
      WHERE workspaces.repository_id = repositories.id
        AND workspaces.workspace_kind = 'local'
  );
