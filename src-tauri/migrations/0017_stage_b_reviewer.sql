-- Autopilot Stage B (spec §0.5): QAS auto-approve, opt-in per workflow.
--
-- require_human_approval: the per-epic human gate — DEFAULTS ON (1), so
-- hands-off reviews are an explicit choice each time. Only meaningful on a
-- `parent` row; Ship remains structurally human regardless (SafeVerb has no
-- Ship variant).
--
-- reviews_subtask_id: set only on a `reviewer` workspace row — the ticket it
-- was spawned to review. Reviewer rows have parent_id NULL (they are NOT board
-- cards) and no branch/worktree of their own; this link is how the driver
-- dedups ("one active reviewer per ticket") and how cleanup finds them.
-- Local-only, like every board column (0015/0016 precedent).
ALTER TABLE workspaces ADD COLUMN require_human_approval INTEGER NOT NULL DEFAULT 1;
ALTER TABLE workspaces ADD COLUMN reviews_subtask_id TEXT NULL;
