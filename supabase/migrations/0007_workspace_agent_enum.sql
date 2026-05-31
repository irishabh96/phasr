-- Run in Supabase → SQL Editor after migration 0006.
--
-- Mirrors the desktop app's migration 0010: agents are now a fixed enum
-- stored directly on the workspace as text (claude/codex/copilot/gemini/
-- opencode), not a foreign key into an `agents` table. Drop the old FK
-- model so the cloud schema matches the local one.
--
-- `workspaces.agent_id` only ever held NULL (the old sync layer never
-- pushed it), so there is no data to migrate.

-- Workspace: text `agent` column replaces the agent_id uuid FK.
alter table public.workspaces add column if not exists agent text;
alter table public.workspaces drop column if exists agent_id;

-- user_settings: these columns existed only to customize agents.
alter table public.user_settings drop column if exists default_agent_id;
alter table public.user_settings drop column if exists disabled_agent_ids;

-- The agents table (and its RLS policies / realtime publication entry,
-- which Postgres drops along with the table) is no longer used.
drop table if exists public.agents;
