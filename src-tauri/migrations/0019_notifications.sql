-- Notifications inbox (redesign M8).
--
-- Additive only (see 0015).

-- Everything phasr told the user about, newest first in the inbox. LOCAL
-- ONLY: a notification is about this machine's agents. No FK on
-- workspace/repository on purpose — the entry ("checks finished on X")
-- outlives a deleted task until it's pruned (30 days) or cleared.
CREATE TABLE notifications (
    id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT,
    workspace_id TEXT,
    repository_id TEXT,
    -- needs_approval | task_finished | task_failed | checks_finished |
    -- run_command_failed. No CHECK: a later client may add kinds.
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT,
    -- JSON object with kind-specific routing data.
    payload TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    read_at TEXT
);
CREATE INDEX idx_notifications_user_created ON notifications(user_id, created_at);

-- Delivery matrix / background-only / quiet hours, as a JSON object.
-- Synced (cloud migration 0014).
ALTER TABLE user_settings ADD COLUMN notification_prefs TEXT NOT NULL DEFAULT '{}';
