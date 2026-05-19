-- Run in Supabase → SQL Editor after migration 0003.
-- Seeded agents (Claude, Codex, etc.) move out of the agents table
-- entirely. They now live as hardcoded values in the desktop app
-- with deterministic UUIDs (uuid_v5 of agent name), so the same
-- agent has the same ID across every user and every machine.
--
-- After this migration, the `agents` table holds only USER-defined
-- custom agents. Per-user state for hardcoded seeds (enabled/
-- disabled) lives in user_settings.

DELETE FROM public.agents WHERE is_seed = TRUE;

ALTER TABLE public.user_settings
    ADD COLUMN IF NOT EXISTS disabled_agent_ids JSONB NOT NULL DEFAULT '[]'::jsonb;
