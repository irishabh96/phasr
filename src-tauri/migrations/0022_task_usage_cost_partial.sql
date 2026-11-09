-- A task's cost is the sum of what could be priced; this marks it as a
-- lower bound when some model it used has no known price (before, one
-- unpriced model nulled the whole figure).
--
-- `task_usage` is local-only (never synced). Additive (see 0015): older
-- builds ignore it, and their upserts take the default.
ALTER TABLE task_usage ADD COLUMN cost_partial INTEGER NOT NULL DEFAULT 0;
