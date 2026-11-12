-- Permission modes + per-agent command templates (redesign M4).
--
-- Additive only, so 0.4.4 (the first build with `ignore_missing`) can still
-- open a database this migration has touched: it names its columns and the
-- new ones all have defaults or are nullable.

-- The mode a task was launched in. NULL = a row from before permission
-- modes, which launched with skip-all flags (baked into `command`), so it
-- keeps that behavior on resume.
ALTER TABLE workspaces ADD COLUMN permission_mode TEXT;

-- Whether the task raises a notification when it needs the user.
ALTER TABLE workspaces ADD COLUMN notify_on_attention INTEGER NOT NULL DEFAULT 1;

-- Default mode for new tasks. User decision: "Ask for shell", for existing
-- users too — the column DEFAULT fills every existing settings row.
ALTER TABLE user_settings
    ADD COLUMN default_permission_mode TEXT NOT NULL DEFAULT 'ask-shell';

-- JSON object: agent id -> launch command template override.
ALTER TABLE user_settings ADD COLUMN agent_commands TEXT NOT NULL DEFAULT '{}';
