-- Rename `presets` (which today hold AI tool definitions like Claude,
-- Codex, etc.) to `agents`. The "preset" word will be reused later
-- for actual saved prompt templates (planned for the Settings UI).

ALTER TABLE presets RENAME TO agents;
ALTER TABLE workspaces RENAME COLUMN preset_id TO agent_id;

DROP INDEX IF EXISTS idx_presets_dirty;
CREATE INDEX IF NOT EXISTS idx_agents_dirty ON agents(dirty) WHERE dirty = 1;

-- user_settings.default_preset_id → default_agent_id
ALTER TABLE user_settings RENAME COLUMN default_preset_id TO default_agent_id;
