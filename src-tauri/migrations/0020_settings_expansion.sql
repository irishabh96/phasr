-- Settings expansion + worktree management (redesign M11).
--
-- Additive only (see 0015): older builds name their columns, so they never
-- see these, and their INSERTs take the defaults.

-- Shell for session terminals and task PTYs ('' = the account's login
-- shell). Synced (cloud migration 0015) — a path that doesn't exist on
-- another machine falls back to the login shell there.
ALTER TABLE user_settings ADD COLUMN terminal_shell TEXT NOT NULL DEFAULT '';
-- Copy terminal selections to the clipboard on mouse-up. Synced.
ALTER TABLE user_settings ADD COLUMN copy_on_select INTEGER NOT NULL DEFAULT 0;

-- Per-repository rules. repository_config is LOCAL ONLY (never pushed):
-- these describe this machine's checkout. The existing columns keep their
-- meaning — pre_task_hook is "After creating" (runs once in a new task
-- worktree), branch_prefix_template / worktree_base_path are per-repo
-- overrides of the user_settings values. No CHECKs on the enum-ish text
-- columns, so a later client can add a value without a lockstep migration
-- (this build reads an unknown value as the default).

-- Base branch for new tasks (NULL = the repository's default branch).
ALTER TABLE repository_config ADD COLUMN default_base_branch TEXT;
-- `git fetch origin <base>` before cutting a task's worktree.
ALTER TABLE repository_config ADD COLUMN fetch_base_before_task INTEGER NOT NULL DEFAULT 0;
-- 'ask' | 'allow' | 'deny' — enforced for Claude via its settings file.
ALTER TABLE repository_config ADD COLUMN agents_may_push TEXT NOT NULL DEFAULT 'ask';
-- 'draft' | 'ready' — default for "Approve & create PR".
ALTER TABLE repository_config ADD COLUMN pr_mode TEXT NOT NULL DEFAULT 'draft';
-- JSON array of globs the agent must ask before editing (Claude).
ALTER TABLE repository_config ADD COLUMN protected_paths TEXT NOT NULL DEFAULT '[]';
-- JSON array of globs copied from the checkout into each new worktree
-- (untracked/ignored files like `.env`), never overwriting.
ALTER TABLE repository_config ADD COLUMN copy_untracked_globs TEXT NOT NULL DEFAULT '[]';
-- 'ask' | 'always' | 'never' — remove worktree + local branch once merged.
ALTER TABLE repository_config ADD COLUMN cleanup_after_merge TEXT NOT NULL DEFAULT 'ask';
