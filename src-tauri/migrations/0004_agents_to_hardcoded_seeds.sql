-- Seeded agents (Claude, Codex, etc.) are now hardcoded in the app
-- with deterministic UUIDs computed via uuid_v5. They no longer live
-- in the `agents` table at all. The table now stores only USER-defined
-- custom agents.
--
-- Per-user agent state (disabled list) moves into user_settings.

-- Drop seed rows. workspaces.agent_id of those becomes NULL via the
-- ON DELETE SET NULL constraint defined in migration 0001.
DELETE FROM agents WHERE is_seed = 1;

-- Track which agent IDs the user has turned off (works for both
-- hardcoded seeds and their own custom agents). JSON-encoded list.
ALTER TABLE user_settings ADD COLUMN disabled_agent_ids TEXT NOT NULL DEFAULT '[]';
