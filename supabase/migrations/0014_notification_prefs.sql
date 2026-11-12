-- Run in Supabase → SQL Editor after migration 0013, and BEFORE releasing a
-- desktop build that ships local migration 0019: that build pushes this
-- column, and PostgREST rejects an upsert naming a column that doesn't
-- exist (which would stall settings sync for that build).
--
-- Mirrors the desktop app's 0019_notifications.sql (the synced part only —
-- the notifications inbox itself is local).

-- { matrix: { <kind>: { badge, system, sound } }, backgroundOnly,
--   quietHours: { enabled, start, end } }
alter table public.user_settings
    add column if not exists notification_prefs jsonb not null default '{}'::jsonb;
