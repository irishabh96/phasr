# Changelog

What changed in each Phasr release. Versions follow [RELEASING.md → Versioning](RELEASING.md#versioning); downloads are on the [Releases page](https://github.com/irishabh96/phasr/releases).

## [0.5.0] — Unreleased

Phasr has been rebuilt around a board of tasks: every agent's work in one place, the ones waiting on you flagged, and a review step before anything ships.

> **Upgrade from 0.4.4, not straight from 0.4.3.** 0.5.0 adds database migrations that 0.4.3 can't open. If you ever need to roll back, go to 0.4.4. See [Upgrading](#upgrading-to-050).

### Added

**Board**
- Every task on one board in four columns: **Queued**, **Needs you**, **Running** and **Review**. A failed task shows under **Needs you**.
- Running cards show what the agent is doing right now. Blocked cards show what it wants to run, with **Allow** and **Deny** on the card. Review cards show files changed and lines added and removed.
- List view, filters, and keyboard navigation (↑ ↓ ↵).
- Queue tasks to start later, or after another task finishes. Save a task as a draft.
- A task sidebar grouped by status.

**Starting tasks**
- A new **New task** dialog, prompt first. Pick the agent (with its installed version), base branch, where it runs (a fresh worktree, or in place in your checkout) and permissions.
- **Permission modes:** Ask for edits, **Ask for shell** (the new default), or Skip all.
- **Show commands** lists exactly what Phasr will run. Attach images and files. Start a run command along with the task.
- A first-run screen that checks your environment (git, `gh`, installed agents) and helps you add a repository: open a folder, clone a URL, start an empty repo, or use a template.

**Working with agents**
- **Approvals in the app.** When an agent asks to run a command or edit a file, a card appears in its task: **Allow once** (⌘Y), **Allow for this task**, or **Deny** (⌘⌫).
- **macOS notifications** with **Allow** and **Deny** buttons, and an inbox (the bell) of approvals, finished tasks, failures and check results.
- **Transcript view for Claude.** Replies render as formatted text with tables, links to files, task lists and Mermaid diagrams. Edits show as diffs and commands show their output. Thinking, subagents and background commands each get their own row.
  - Follow a subagent live in the side panel.
  - Reply suggestions after each turn.
  - **Stop turn** interrupts Claude without ending the task.
  - Switch between transcript and terminal per task.
- **A reply box for every agent.** Messages sent mid-turn wait until the turn ends.
- **Side panel** (⌘I): agent and model, base branch with **Sync** when it falls behind, start time, token usage and cost (Claude and Codex), run commands and notes.

**Voice input**
- Dictate into a reply or a new task's prompt. Whisper runs on your Mac and the words appear as you speak; your voice is never uploaded.
- **Hold fn** and talk, then let go to insert. You can also press ⌘⇧D, or click the mic, which is the send button while the reply box is empty.
- The text goes in exactly as heard. Optionally, **Settings → Voice** can have Claude Haiku or Codex's fast model clean it up afterwards, through your own login.
- Models are downloaded on first use, never bundled: Fast (148 MB), Accurate (190 MB) and Multilingual (574 MB).

**Review and ship**
- A **Changes** pane listing every file changed against the task's base branch. Split or unified diff (⌘\\), and mark files as viewed.
- **Comments** on diff lines, sent to the agent as one message.
- **Checks:** run commands marked "before review" run when a task is ready for review. Mark them required to block approval until they pass.
- **Approve & create PR** (⌘⇧↵) pushes the branch and opens a pull request with `gh`, or opens GitHub's compare page if `gh` isn't installed. The board tracks the PR until it's merged or closed.
- **Merge locally** (merge commit, squash or fast-forward), **Request changes**, or **Discard worktree** (notes are kept).

**Everything else**
- **Files pane:** a full editor for any file in the worktree. Phasr asks before overwriting if the agent changes a file you're editing. Revert a single hunk from the diff.
- **Run commands** run in the task's worktree. Choose when each one runs: by hand, at task start, or before review. Commands are suggested from `package.json`, and a server's port shows on its tab.
- **Command palette (⌘K):** tasks, files, actions and settings in one list. Narrow it with `>` commands, `#` tasks, `@` files or `?` help.
- **Settings sheet (⌘,):**
  - Account and active sessions.
  - Theme (dark, light, system), accent colour and density. Terminal font, shell and copy-on-select.
  - Agents & keys: API keys stored in the macOS Keychain and never synced, plus command templates.
  - Voice and run commands.
  - Notifications, including quiet hours, and keyboard shortcuts.
  - Per repository:
    - **Worktrees:** location, copy untracked files like `.env`, a setup command, and a list of worktrees with their size and Remove.
    - **Branch rules:** naming, protected paths, and whether agents may push.

### Changed
- A new look: a dense dark theme with a coral accent, a matching light theme, and Inter and JetBrains Mono bundled with the app.
- New tasks ask before running shell commands (**Ask for shell**) instead of skipping all permissions. Change the default in **Settings → Agents & keys**.
- Settings open as a sheet over your work, not as separate pages.
- macOS Writing Tools are turned off inside the app, so they no longer get in the way of terminals and prompts.

### Fixed
- If the agent didn't start, the first prompt is no longer typed into the bare shell.
- A task that fails during setup shows its log, and starting it again attaches to the new agent.
- Terminals fill their pane, stop taking focus from open dialogs, and apply font size changes at once.
- Closed, archived and renamed tasks leave the board straight away. Removing a repository removes its tasks in every window.
- Stopping a terminal whose process has already exited no longer reports an error.

### Performance
- The board and sidebar no longer re-render every card each second. Agent updates reach the UI at most 30 times a second.
- Side panels slide without re-laying out the terminals.
- Smaller app: fonts ship as Latin-only WOFF2, syntax highlighting loads on demand, and source maps stay out of the bundle.
- File watching ignores paths the repository ignores.

### Security
- Run commands synced from another Mac don't start on their own until you confirm them on this one.
- API keys live in the macOS Keychain, per Phasr account.
- Updated dependencies with security advisories, including rustls, h2, quinn-proto, seroval and js-cookie.

### Upgrading to 0.5.0
- **Install 0.4.4 first** on every Mac you use with Phasr, then 0.5.0. 0.5.0 adds database migrations 0015–0023. They only add data, and 0.4.4 opens such a database without trouble. 0.4.3 and earlier won't start with it.
- **Microphone permission:** builds aren't code-signed yet, so macOS may ask for microphone access again after each update.
- **Known limitations:**
  - Apple Silicon only.
  - The transcript view is Claude only. Usage and cost cover Claude and Codex.
  - Codex, Copilot, Gemini and OpenCode run in the terminal view.

## [0.4.4] — Unreleased

A safety release, to install before 0.5.0. It makes 0.4.4 a version you can roll back to from 0.5.0.

### Fixed
- Opens a database written by a newer Phasr instead of failing at launch with "migration … was previously applied but is missing".
- Won't launch a task synced from a newer Mac that was saved as a draft and never started. Previously it ran in the repository's main checkout.
- A task that was never started on this Mac shows a calm empty state instead of an error.
- Cloud sync skips tasks with values this version can't read, instead of failing the whole sync.

## [0.4.3] — 2026-10-20

See the [v0.4.3 release](https://github.com/irishabh96/phasr/releases/tag/v0.4.3). Earlier releases are listed on the [Releases page](https://github.com/irishabh96/phasr/releases).

[0.5.0]: https://github.com/irishabh96/phasr/compare/v0.4.4...v0.5.0
[0.4.4]: https://github.com/irishabh96/phasr/compare/v0.4.3...v0.4.4
[0.4.3]: https://github.com/irishabh96/phasr/releases/tag/v0.4.3
