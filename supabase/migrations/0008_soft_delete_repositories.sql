-- Run in Supabase → SQL Editor after migration 0007.
--
-- Repositories are soft-deleted, not hard-deleted, in the cloud. The
-- desktop app already soft-deletes locally (deleted_at tombstone); the
-- sync worker now PATCHes this column instead of issuing a DELETE, so
-- removing a repo preserves the cloud row + its children.

alter table public.repositories add column if not exists deleted_at timestamptz;

create index if not exists idx_repositories_deleted_at
    on public.repositories (deleted_at);
