-- Run in Supabase → SQL Editor after migration 0002.
-- Renames `presets` to `agents` and `workspaces.preset_id` to
-- `workspaces.agent_id`. RLS policies are recreated under the new
-- name (Postgres policies are tied to the table name).

ALTER TABLE public.presets RENAME TO agents;
ALTER TABLE public.workspaces RENAME COLUMN preset_id TO agent_id;

ALTER TABLE public.user_settings RENAME COLUMN default_preset_id TO default_agent_id;

------------------------------------------------------------------------
-- Indexes
------------------------------------------------------------------------

DROP INDEX IF EXISTS public.idx_presets_user;
CREATE INDEX idx_agents_user ON public.agents (user_id, sort_order);

------------------------------------------------------------------------
-- RLS policies
------------------------------------------------------------------------

DROP POLICY IF EXISTS presets_select ON public.agents;
DROP POLICY IF EXISTS presets_insert ON public.agents;
DROP POLICY IF EXISTS presets_update ON public.agents;
DROP POLICY IF EXISTS presets_delete ON public.agents;

CREATE POLICY agents_select ON public.agents
    FOR SELECT USING (user_id = public.clerk_user_id());
CREATE POLICY agents_insert ON public.agents
    FOR INSERT WITH CHECK (user_id = public.clerk_user_id());
CREATE POLICY agents_update ON public.agents
    FOR UPDATE USING (user_id = public.clerk_user_id())
                  WITH CHECK (user_id = public.clerk_user_id());
CREATE POLICY agents_delete ON public.agents
    FOR DELETE USING (user_id = public.clerk_user_id());
