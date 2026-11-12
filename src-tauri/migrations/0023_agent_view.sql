-- How a task's agent is shown on THIS machine: 'transcript' (Claude's
-- headless stream mode, rendered by Phasr) or 'terminal' (the agent's TUI
-- in a PTY). NULL = terminal.
--
-- Local-only, never synced: which process runs here, and how, is this
-- machine's business. Not in the sync push/pull column lists, and writes
-- touch neither `updated_at` nor `dirty`. Additive (see 0015): older builds
-- ignore it, and their INSERTs take the default.
ALTER TABLE workspaces ADD COLUMN agent_view TEXT;
