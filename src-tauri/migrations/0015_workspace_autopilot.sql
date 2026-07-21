-- Autopilot (Phase 5a, S3). LOCAL-ONLY + additive, NOT NULL DEFAULT 0 (mirrors
-- 0012/0013/0014). Board tables are never synced (the `workspace_kind='agent'`
-- sync PUSH filter, sync/mod.rs), so a per-epic autopilot flag needs no sync
-- change. A `parent` (epic) workspace opts INTO autopilot; every existing row
-- defaults 0 (off) — autopilot is opt-in per epic.
ALTER TABLE workspaces ADD COLUMN autopilot_enabled INTEGER NOT NULL DEFAULT 0;

-- The global autopilot kill switch — a PERSISTED true-halt (§5). A singleton
-- row (CHECK id = 1). Local-only BY CONSTRUCTION: no sync filter references this
-- table, so a 2am panic-button survives a crash/reboot. The driver re-reads
-- `kill_switch_halted` at boot and no-ops while set — there is NO auto-resume.
CREATE TABLE autopilot_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    kill_switch_halted INTEGER NOT NULL DEFAULT 0
);
INSERT INTO autopilot_state (id, kill_switch_halted) VALUES (1, 0);
