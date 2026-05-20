-- Rename for the "repository/workspace" naming model.
-- Run this in Supabase → SQL Editor after migration 0001.
--
-- - public.workspaces       (git repo connection)      → public.repositories
-- - public.tasks            (one agent run per repo)    → public.workspaces
-- - public.workspace_config                             → public.repository_config
-- - Rename FK columns: workspace_id → repository_id
--
-- RLS policies reference table names in their identifier, so they get
-- dropped and recreated under the new names.

ALTER TABLE public.workspaces       RENAME TO repositories;
ALTER TABLE public.tasks            RENAME TO workspaces;
ALTER TABLE public.workspaces       RENAME COLUMN workspace_id TO repository_id;

ALTER TABLE public.workspace_config RENAME TO repository_config;
ALTER TABLE public.repository_config RENAME COLUMN workspace_id TO repository_id;

ALTER TABLE public.run_commands     RENAME COLUMN workspace_id TO repository_id;

------------------------------------------------------------------------
-- Indexes
------------------------------------------------------------------------

DROP INDEX IF EXISTS public.idx_workspaces_user_updated;
DROP INDEX IF EXISTS public.idx_tasks_user_workspace;
DROP INDEX IF EXISTS public.idx_tasks_user_status;
DROP INDEX IF EXISTS public.idx_run_commands_user_workspace;

CREATE INDEX idx_repositories_user_updated
    ON public.repositories (user_id, updated_at DESC);
CREATE INDEX idx_workspaces_user_repository
    ON public.workspaces (user_id, repository_id, created_at DESC);
CREATE INDEX idx_workspaces_user_status
    ON public.workspaces (user_id, status);
CREATE INDEX idx_run_commands_user_repository
    ON public.run_commands (user_id, repository_id, sort_order);

------------------------------------------------------------------------
-- RLS policies: drop old, recreate with new names.
------------------------------------------------------------------------

DROP POLICY IF EXISTS workspaces_select ON public.repositories;
DROP POLICY IF EXISTS workspaces_insert ON public.repositories;
DROP POLICY IF EXISTS workspaces_update ON public.repositories;
DROP POLICY IF EXISTS workspaces_delete ON public.repositories;

CREATE POLICY repositories_select ON public.repositories
    FOR SELECT USING (user_id = public.clerk_user_id());
CREATE POLICY repositories_insert ON public.repositories
    FOR INSERT WITH CHECK (user_id = public.clerk_user_id());
CREATE POLICY repositories_update ON public.repositories
    FOR UPDATE USING (user_id = public.clerk_user_id())
                  WITH CHECK (user_id = public.clerk_user_id());
CREATE POLICY repositories_delete ON public.repositories
    FOR DELETE USING (user_id = public.clerk_user_id());

DROP POLICY IF EXISTS tasks_select ON public.workspaces;
DROP POLICY IF EXISTS tasks_insert ON public.workspaces;
DROP POLICY IF EXISTS tasks_update ON public.workspaces;
DROP POLICY IF EXISTS tasks_delete ON public.workspaces;

CREATE POLICY workspaces_select ON public.workspaces
    FOR SELECT USING (user_id = public.clerk_user_id());
CREATE POLICY workspaces_insert ON public.workspaces
    FOR INSERT WITH CHECK (user_id = public.clerk_user_id());
CREATE POLICY workspaces_update ON public.workspaces
    FOR UPDATE USING (user_id = public.clerk_user_id())
                  WITH CHECK (user_id = public.clerk_user_id());
CREATE POLICY workspaces_delete ON public.workspaces
    FOR DELETE USING (user_id = public.clerk_user_id());

DROP POLICY IF EXISTS workspace_config_select ON public.repository_config;
DROP POLICY IF EXISTS workspace_config_insert ON public.repository_config;
DROP POLICY IF EXISTS workspace_config_update ON public.repository_config;
DROP POLICY IF EXISTS workspace_config_delete ON public.repository_config;

CREATE POLICY repository_config_select ON public.repository_config
    FOR SELECT USING (user_id = public.clerk_user_id());
CREATE POLICY repository_config_insert ON public.repository_config
    FOR INSERT WITH CHECK (user_id = public.clerk_user_id());
CREATE POLICY repository_config_update ON public.repository_config
    FOR UPDATE USING (user_id = public.clerk_user_id())
                  WITH CHECK (user_id = public.clerk_user_id());
CREATE POLICY repository_config_delete ON public.repository_config
    FOR DELETE USING (user_id = public.clerk_user_id());

-- Realtime publication tracks tables by OID, so renames don't need
-- publication changes.
