-- Machine-local sync state + local_path integrity guard.
--
-- Fallout from the 2026-08-12 data-wipe recovery: the machine id lived in
-- localStorage, so the wipe minted a new one and every cloud repository
-- pulled down with local_path = NULL; re-adding the folders then minted
-- duplicate repository rows because nothing — code or schema — enforced
-- one active row per local_path.

-- Tiny key-value store for machine-local sync state (currently just
-- `machine_id`, so the sync worker can detect an id transition and
-- re-publish local_paths under the new key).
CREATE TABLE IF NOT EXISTS app_meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

-- Heal `user_id IS NULL` ghost run_commands (written by the old unvalidated
-- upsert_run_command_from_cloud command): they are invisible to every
-- user-scoped read and can never be pushed. Only safe when the row's owner
-- is unambiguous, i.e. exactly one user exists.
UPDATE run_commands
SET user_id = (SELECT id FROM users)
WHERE user_id IS NULL
  AND (SELECT count(*) FROM users) = 1;

-- Resolve pre-existing duplicates before the unique guard lands: for each
-- local_path keep the most recently updated active row, tombstone the rest
-- (dirty = 1 so the soft-delete also propagates to cloud).
UPDATE repositories
SET deleted_at = STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now'),
    updated_at = STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now'),
    dirty = 1
WHERE deleted_at IS NULL
  AND local_path IS NOT NULL
  AND rowid NOT IN (
      SELECT rowid FROM (
          SELECT rowid,
                 ROW_NUMBER() OVER (
                     PARTITION BY local_path
                     ORDER BY updated_at DESC, rowid DESC
                 ) AS rn
          FROM repositories
          WHERE deleted_at IS NULL AND local_path IS NOT NULL
      )
      WHERE rn = 1
  );

-- One ACTIVE row per local folder. Tombstones are exempt (history may
-- legitimately hold many dead rows for one path) and so are cloud-restored
-- rows that have no path on this machine yet.
CREATE UNIQUE INDEX idx_repositories_active_local_path
ON repositories(local_path)
WHERE deleted_at IS NULL AND local_path IS NOT NULL;
