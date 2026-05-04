# Agent Baseline

Use this file as persistent memory before making changes in this repository. It defines base product behavior feature by feature. Agents must preserve these behaviors unless the user explicitly approves a change.

## Permission Rule

Do not change protected base functionality without explicit user approval.

If a requested implementation appears to require changing any behavior in this file, stop before editing and ask for permission. The request should state:

- the exact baseline behavior that would change
- why the change is necessary
- the user-visible impact
- the risk or migration concern
- the tests that will prove the change is safe

Bug fixes are allowed without extra permission only when they preserve the baseline behavior.

## Product Model

### Workspaces

Baseline:

- A workspace represents one git repository folder.
- A workspace has a stable `name`, `id`, and `repo_path`.
- The workspace `repo_path` points to the original user repository, not a task worktree.
- Creating a workspace validates that the selected path exists and is a directory.
- Creating a workspace requires a git repository unless the user explicitly chooses to initialize git.
- Creating a workspace must not silently create, delete, move, or overwrite user files.
- Creating a workspace must not silently initialize git; the user must explicitly choose that action.
- Deleting a workspace removes the workspace record and its tasks.
- Deleting a workspace may remove managed worktrees owned by the app.
- Deleting a workspace must not delete the original workspace repo folder.

Ask permission before changing:

- workspace identity rules
- duplicate workspace matching by name or repo path
- git validation rules
- workspace delete semantics
- whether workspace creation automatically starts a task

Minimum tests when touched:

- create workspace with valid git repo
- reject or prompt for non-git folder
- init-git prompt path
- delete workspace with tasks
- confirm original repo folder remains on disk

### Tasks

Baseline:

- A task is an executable session inside a workspace.
- A top-level agent task is its own root task.
- `root_task_id` for a top-level task should point to the task itself.
- A child tab/task uses `root_task_id` to attach to an existing root task.
- Task state must survive reload through the task store.
- Task deletion removes that task from the store.
- Task deletion may remove app-managed worktrees.
- Task deletion must not delete an external user repo path.
- Running tasks can be stopped or interrupted.
- Stopped/completed/failed tasks can be resumed when the backend supports it.

Ask permission before changing:

- task grouping rules
- root task semantics
- persisted task fields
- delete behavior
- stop/resume behavior
- task status lifecycle

Minimum tests when touched:

- create top-level task
- create child task/tab under root
- reload task list
- stop running task
- delete task
- verify managed worktree cleanup and external repo preservation

### Agent Tasks

Baseline:

- Starting a new top-level agent task should create a managed git worktree by default.
- Top-level agent tasks should use `direct_repo: false`.
- Top-level agent tasks should store the original repo path as `repo_path`.
- Top-level agent tasks should store the managed worktree path as `worktree_path`.
- The task command comes from the selected provider command unless explicitly changed by an approved feature.
- The task prompt must be included in task creation.
- Branch name settings from the new task modal must be honored.
- Base branch selection must be honored only when valid.
- Invalid branch names must fail clearly.
- Agent task creation should not mutate the original repo working tree except through normal git worktree metadata.

Ask permission before changing:

- whether top-level agent tasks create worktrees
- default agent provider commands
- prompt delivery behavior
- branch naming conventions
- whether agent tasks run directly in the repo

Minimum tests when touched:

- top-level agent task creates managed worktree
- `direct_repo` is false for top-level agent task
- `repo_path` remains original repo
- `worktree_path` differs from original repo
- selected branch name is used
- invalid branch name shows a clear error

### Empty Repos

Baseline:

- Empty git repos with no commits are valid workspaces.
- A top-level agent task in an empty repo should still create a managed worktree.
- Empty repo worktrees should use orphan worktree behavior.
- Empty repo worktree branches should be visible in `git status --short --branch`.
- The app should not fall back to running top-level agent tasks directly in the original repo just because the repo has no commits.

Ask permission before changing:

- support for empty repos
- orphan worktree behavior
- fallback-to-direct-repo behavior

Minimum tests when touched:

- create workspace from empty git repo
- create top-level agent task
- verify managed orphan worktree exists
- verify bottom `PATH` shows orphan worktree path

### Terminal Tabs

Baseline:

- A Terminal tab is a task-like tab running a shell.
- A Terminal tab opened inside an existing task must reuse the root task worktree.
- A Terminal tab inside an existing task should use `direct_repo: true` against the root worktree path.
- A Terminal tab outside an existing task may run directly in the workspace repo.
- Terminal tabs must appear in the same task group when opened from a root task.
- Terminal input, resize, interrupt, and stop behavior must remain functional.

Ask permission before changing:

- Terminal command
- whether Terminal tabs create worktrees
- same-task tab grouping
- terminal input/interrupt routing

Minimum tests when touched:

- open Terminal from existing task
- verify `root_task_id` matches root task
- verify `repo_path` and `worktree_path` equal root worktree path
- verify bottom `PATH` remains root worktree path
- verify terminal stop/delete works

### New Tab Flow

Baseline:

- The plus tab opens a new tab type modal.
- New tab type choices include Agent Task and Terminal.
- Agent Task inside an existing task should attach to that task group unless the user chooses a different flow.
- Terminal inside an existing task must reuse the same worktree.
- Closing the new tab type modal must not create a task.
- The plus tab must remain visible when there are no open tabs.

Ask permission before changing:

- modal choices
- default selected choice
- plus-tab visibility
- whether new tabs attach to current task group

Minimum tests when touched:

- plus opens modal
- close modal does nothing
- Agent Task opens new task modal
- Terminal creates same-task terminal tab
- no-open-tabs state still has a visible plus/new-tab affordance

### Bottom Context Bar

Baseline:

- The bottom bar shows current task name, branch, path, UI build, and Open menu.
- When a task is active, `PATH` should prefer `task.worktree_path`.
- If `worktree_path` is unavailable, `PATH` may fall back to `task.repo_path`.
- If no task is active, `PATH` may fall back to the active workspace repo path.
- Clicking `PATH` opens that folder through `/api/local/open-directory`.
- The Open menu uses the same active code path as the bottom `PATH`.
- The Open menu supports editor launch, terminal launch, and copy path.

Ask permission before changing:

- path precedence
- displayed context fields
- Open menu destinations
- click behavior for `PATH`

Minimum tests when touched:

- active agent task shows worktree path
- child terminal tab shows same worktree path
- no active task shows workspace repo path
- Open menu sends active worktree path
- Copy Path copies active worktree path

### Git Worktrees

Baseline:

- Managed worktrees live under the configured app worktrees directory.
- Worktree paths should be unique per top-level task.
- Existing committed repos create branch-backed worktrees.
- Empty repos create orphan worktrees.
- Worktree branch names should be based on the requested branch or task slug.
- Explicit branch names must not overwrite existing branches.
- Worktree creation should prune stale registrations before adding.
- App-managed worktrees can be removed during task/workspace deletion.
- Non-managed paths must not be removed by managed cleanup.

Ask permission before changing:

- worktree directory layout
- branch naming rules
- orphan worktree support
- cleanup rules
- fallback behavior when worktree creation fails

Minimum tests when touched:

- committed repo worktree creation
- empty repo orphan worktree creation
- duplicate branch handling
- managed cleanup removes managed path
- managed cleanup ignores external repo path

### Git Status And Changes

Baseline:

- Changes tab shows staged and unstaged sections.
- Stage all stages all unstaged paths for the active task path.
- Unstage all unstages all staged paths for the active task path.
- Row-level stage, unstage, and discard operate on the clicked file.
- Discard is destructive and must require confirmation.
- Diff view opens for a selected changed file.
- Diff view supports next, previous, stage, unstage, discard, copy path, reveal, and close-to-terminal.
- Git operations must run against the active task code path, preferring `worktree_path`.

Ask permission before changing:

- stage/unstage/discard semantics
- confirmation requirement
- diff layout or action set
- active path resolution for git commands

Minimum tests when touched:

- create unstaged change
- stage row
- unstage row
- stage all
- unstage all
- discard with confirmation
- open diff and use diff actions

### Commits And Publish

Baseline:

- Commit message is required before commit.
- Suggest commit uses currently staged changes.
- Commit operates on staged changes in the active task path.
- Pull, push, and fetch operate on the active task path.
- Publish dropdown includes Push, Pull, Fetch, Commit, and Create PR.
- Disabled actions should remain visible but unavailable when prerequisites are missing.
- Create PR opens the derived PR URL when repository metadata supports it.

Ask permission before changing:

- publish action names
- publish action availability rules
- commit message validation
- PR URL generation or provider support

Minimum tests when touched:

- suggest commit with staged changes
- commit staged changes
- pull/fetch/push against safe remote
- Create PR URL route is called
- disabled action remains non-clickable

### Files Panel

Baseline:

- Files tab shows the active workspace repository tree.
- Files tab must preserve folder hierarchy.
- Search filters files without destroying hierarchy context.
- Refresh updates files and changes.
- File tree indentation should be readable and not excessive.
- Folders should be expandable/collapsible.

Ask permission before changing:

- file source path
- tree hierarchy model
- search behavior
- folder expansion defaults

Minimum tests when touched:

- root files render
- nested folders render
- folder expand/collapse works
- search filters expected files
- refresh updates after file changes

### Workspace Sidebar

Baseline:

- Sidebar shows workspaces.
- Each workspace row shows name, task count, add-tab button, and delete button.
- Workspace delete button opens delete confirmation.
- Workspace add-tab button opens new tab flow for that workspace.
- Workspace rows expand/collapse.
- Tasks appear nested under their workspace.
- Task rows show task name, status indicator, and close button.
- Task close button opens task delete confirmation.
- Workspace delete and task delete hit areas must not conflict.

Ask permission before changing:

- sidebar grouping model
- workspace/task row controls
- row click behavior
- hit target handling
- task count semantics

Minimum tests when touched:

- workspace expand/collapse
- workspace add tab
- workspace delete cancel/confirm
- task open
- task close cancel/confirm
- verify workspace delete button works independently from row click

### Provider Bar

Baseline:

- Provider bar includes Claude, Codex, Copilot, OpenCode, and Gemini.
- Provider icons must remain visible.
- Selected provider state must be visible.
- Clicking a provider starts or prepares a task for that provider according to the current task flow.
- Provider commands should stay mapped to their provider unless explicitly approved.

Ask permission before changing:

- provider list
- provider labels or icons
- provider command mapping
- click behavior

Minimum tests when touched:

- all provider pills visible
- all provider icons visible
- selected state changes
- task payload uses selected provider command

### Modals

Baseline:

- Create Workspace modal is compact, aligned, keyboard usable, and validated.
- Create Workspace close and cancel both close the modal without creating a workspace.
- Create Workspace submit requires workspace name and repo path.
- Browse button must stay aligned and keep a usable hit target.
- New Task modal requires prompt, agent, workspace, and valid branch slug.
- New Task close does not create a task.
- Delete Task modal requires explicit confirmation.
- Delete Workspace modal requires explicit confirmation.
- Escape closes non-destructive modals where supported.

Ask permission before changing:

- modal validation rules
- modal sizing and layout system
- destructive confirmation flows
- keyboard behavior

Minimum tests when touched:

- modal open/close/cancel
- validation errors
- disabled submit state
- successful submit state
- narrow viewport alignment
- destructive confirm/cancel

### Local Open Actions

Baseline:

- `PATH` click calls `/api/local/open-directory`.
- Reveal in diff calls `/api/local/open-directory` for the file folder.
- Open in Terminal calls `/api/local/open-in-terminal`.
- IDE menu calls `/api/local/open-in-ide` with selected IDE.
- Open PR/Open Branch/Create PR call `/api/local/open-url`.
- Copy Path uses clipboard when available and fallback copy otherwise.

Ask permission before changing:

- endpoint names
- menu item list
- path payload semantics
- external URL behavior

Minimum tests when touched:

- intercept each local endpoint
- verify payload path/url/ide
- verify copy path works
- verify disabled state without active path

### Persistence And Data Safety

Baseline:

- Tasks persist in `tasks.json`.
- Workspaces persist in `workspaces.json`.
- Logs are written under the configured logs directory.
- Worktrees are written under the configured worktrees directory.
- Data directory comes from `PHASR_DATA_DIR` when set.
- Tests must use temporary data directories.
- Tests must not mutate a user's real repository or global app data.

Ask permission before changing:

- file names
- data directory layout
- migration behavior
- cleanup behavior

Minimum tests when touched:

- create and reload workspace
- create and reload task
- delete task persists
- delete workspace persists
- temp data directory isolation

## Testing Baseline

Run the smallest relevant checks for a narrow change. For changes touching protected behavior, run all applicable checks:

- `go test ./...`
- `npm --prefix internal/api/frontend run build`
- `git diff --check`
- Playwright tests for touched UI flows

For worktree or task path changes, include coverage proving:

- top-level agent task creates a managed worktree
- empty repos create orphan worktrees
- same-task tabs reuse the root worktree
- bottom UI `PATH` shows the active worktree path

For UI changes, include Playwright coverage or a browser metric/screenshot check when visual alignment is part of the request.

## Change Discipline

- Prefer small, targeted patches over broad rewrites.
- Do not remove existing controls unless the user explicitly asks.
- Do not replace working behavior with a new abstraction without a clear reason.
- Do not alter unrelated styling, layout, or state behavior while fixing a specific bug.
- Preserve existing file ownership and dirty user changes.
- If unsure whether a behavior is baseline or incidental, treat it as baseline and ask first.
