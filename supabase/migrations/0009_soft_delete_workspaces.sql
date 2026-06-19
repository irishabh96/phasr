-- Run in Supabase → SQL Editor after migration 0008.
--
-- Mirror the desktop app: workspaces are soft-deleted with a deleted_at
-- tombstone (PATCHed by the sync worker) instead of being hard-deleted,
-- so a deleted workspace doesn't get re-inserted by the next pull.

alter table public.workspaces add column if not exists deleted_at timestamptz;

create index if not exists idx_workspaces_deleted_at
    on public.workspaces (deleted_at);
