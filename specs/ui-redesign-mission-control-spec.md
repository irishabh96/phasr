# Spec: UI redesign — Option A "Mission Control"

**Status:** M0–M12 implemented on `feature/redesign-v2` (uncommitted) · **Author:** BSA (agent) · **Date:** 2026-11-09

## Objective

Rebuild Phasr's interface to the "Mission Control" direction (Option A of the redesign
canvas): dark, dense, status-first. One coral accent (user-selectable) for actions; fixed
hues for status (running blue, attention amber, success green, danger red). Home becomes
a board of tasks; a task session is pane tabs + terminal + composer + inspector; settings
open as a sheet over any screen; ⌘K searches tasks, files, actions and settings.

The redesign also brings the backend features the design assumes: per-task permission
modes with in-app approvals ("needs you"), token/cost per task, checks gating approval,
diff comments sent to the agent, a notifications inbox, an editor for the Files tab,
agent detection, and the full settings surface.

Design source: claude.ai artifact `d5958bba-f7b5-44d0-aacd-d12d68c785a0` (artboards
`Main`, `A-*`). B and C directions are out of scope.

## User stories

- As a developer running several agents, I want one board that shows which tasks are
  queued, running, waiting on me, ready for review, or done, so I know where to look.
- As a developer, I want an agent that needs approval to tell me in-app (and by
  notification), and to approve or deny without hunting for the right terminal.
- As a reviewer, I want to read the diff vs base, see checks, leave line comments the
  agent receives, and approve into a PR in one place.
- As a user, I want settings, theme and accent to change instantly without leaving my
  session, and terminals to keep their state.

## Acceptance criteria (by milestone; see plan for file-level detail)

- **M0 foundations**: migrator ignores unknown applied migrations (safe rollback target);
  PTY spawn supports extra env, exec mode with the command's real exit code, bracketed-paste
  aware `send_message`; workspace/git/PTY commands are scoped `_for_user`.
- **M1 design system**: tokens match A-System / A-SystemLight; no backdrop blur anywhere;
  Inter + JetBrains Mono bundled (offline); accent selectable (coral, blue, green, violet,
  amber) and applied to terminals; status is always color + glyph + word.
- **M2 settings sheet**: `?settings=<section>` opens an 880×600 sheet over any route; the
  terminal under it keeps its surface; esc closes; old settings routes redirect.
- **M3 shell**: 44px title bar, task sidebar grouped by status, 28px status bar, rails.
- **M4 launch config**: permission mode per task (default Ask for shell), agent detection
  with versions, prompt-first New task dialog, first-run screen.
- **M5 session**: pane tabs (agent / terminals / run / Changes / Files), composer, inspector.
- **M6 agent signals**: needs-you detection (hooks first, heuristics fallback), approvals
  reject stale ids, tokens/cost for Claude and Codex, agent summary.
- **M7 board**: lanes derived (no new status values), drafts/queue/dependencies, outcomes.
- **M8 review + inbox**: checks with stale detection gate Approve; diff comments; PR via
  `gh` with compare-URL fallback; local notifications inbox with prefs + quiet hours.
- **M9 editor**: worktree-scoped read/write with conflict detection; revert hunk.
- **M10 palette**, **M11 settings expansion** (keychain keys, branch rules, worktrees),
  **M12 compact/density/cleanup**.

## Decisions

- #PATH_DECISION Keep existing CSS token names and change values (avoids ~785 call-site
  edits); add aliases for new design names. Alternative (rename) rejected for churn.
- #PATH_DECISION Accent tokens are literal hex per `[data-accent]` block, not
  `color-mix()`: the terminal engine reads them via `getPropertyValue` and parses plain
  colors only.
- #PATH_DECISION "Needs you" detection uses agent hooks (Claude `--settings` hooks, Codex
  `notify`) as primary, PTY output heuristics as fallback. Approvals are keystrokes from a
  per-agent table, guarded by an attention id so a stale click can't answer a new dialog.
- #PATH_DECISION No new `WorkspaceStatus` values; board lanes are derived. Older synced
  clients would fail to parse unknown statuses.
- #EXPORT_CRITICAL API keys live in the macOS Keychain, are never synced or logged, and
  are injected only into the matching agent's PTY. `repository_config` (hooks that run
  automatically) is never synced. Synced run commands do not auto-run until confirmed on
  this machine.
- #EXPORT_CRITICAL Editor writes are confined to the task worktree (no `..`, absolute
  paths, `.git/`, or symlink escapes) and refuse to overwrite a file changed on disk.
- Default permission mode for new tasks: **Ask for shell** (user decision).
- Automations: hidden until designed. In place: one active per repo. Pane focus: ⌘⌥1–9.

## #PLAN_UNCERTAINTY

- Agent CLI flags drift between versions (e.g. Claude `--permission-mode` values, Codex
  sandbox flags); templates are user-editable and the detected version is shown.
- Claude `Notification` hook `notification_type` strings vary by version; match the type
  when present, else the message text.
- Heuristic approval patterns for Gemini/Copilot/OpenCode need fixtures from real logs.

## Deferred

Timeline view, split panes, editor blame/formatter/problems, `@issue`, per-test counts,
per-device app versions, usage for Gemini/Copilot/OpenCode, renderer choice.
