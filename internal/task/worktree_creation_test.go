package task

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"phasr/internal/domain"
	"phasr/internal/gitops"
	"phasr/internal/process"
	"phasr/internal/store"
)

func TestCreateTopLevelAgentTaskCreatesManagedWorktreeAndChildReusesIt(t *testing.T) {
	m, worktreesDir := newWorktreeCreateTestManager(t)
	repoPath := initWorktreeTestRepo(t, true)
	workspace, err := m.CreateWorkspace("qa-worktree", repoPath, false)
	if err != nil {
		t.Fatalf("create workspace: %v", err)
	}

	root, err := m.Create(CreateRequest{
		Name:          "investigate path",
		Workspace:     workspace.Name,
		RepoPath:      workspace.RepoPath,
		Command:       "sleep 30",
		NewBranchName: "task/investigate-path",
	})
	if err != nil {
		t.Fatalf("create root task: %v", err)
	}
	t.Cleanup(func() { _ = m.process.Stop(root.ID, true) })

	assertManagedWorktreeTask(t, root, workspace.RepoPath, worktreesDir)
	if root.RootTaskID != root.ID {
		t.Fatalf("expected root task id %q to point at itself, got %q", root.ID, root.RootTaskID)
	}

	child, err := m.Create(CreateRequest{
		Name:       "Terminal",
		Workspace:  workspace.Name,
		RepoPath:   root.WorktreePath,
		Command:    "sleep 30",
		DirectRepo: true,
		RootTaskID: root.ID,
	})
	if err != nil {
		t.Fatalf("create child tab task: %v", err)
	}
	t.Cleanup(func() { _ = m.process.Stop(child.ID, true) })

	if !child.DirectRepo {
		t.Fatalf("expected child tab to run direct in the root worktree")
	}
	if child.RootTaskID != root.ID {
		t.Fatalf("expected child root_task_id %q, got %q", root.ID, child.RootTaskID)
	}
	if filepath.Clean(child.WorktreePath) != filepath.Clean(root.WorktreePath) {
		t.Fatalf("expected child worktree path %q, got %q", root.WorktreePath, child.WorktreePath)
	}
	if filepath.Clean(child.RepoPath) != filepath.Clean(root.WorktreePath) {
		t.Fatalf("expected child repo path %q, got %q", root.WorktreePath, child.RepoPath)
	}
}

func TestCreateTopLevelAgentTaskCreatesOrphanWorktreeForEmptyRepo(t *testing.T) {
	m, worktreesDir := newWorktreeCreateTestManager(t)
	repoPath := initWorktreeTestRepo(t, false)
	workspace, err := m.CreateWorkspace("qa-empty-worktree", repoPath, false)
	if err != nil {
		t.Fatalf("create workspace: %v", err)
	}

	root, err := m.Create(CreateRequest{
		Name:          "empty repo task",
		Workspace:     workspace.Name,
		RepoPath:      workspace.RepoPath,
		Command:       "sleep 30",
		NewBranchName: "task/empty-repo-task",
	})
	if err != nil {
		t.Fatalf("create root task for empty repo: %v", err)
	}
	t.Cleanup(func() { _ = m.process.Stop(root.ID, true) })

	assertManagedWorktreeTask(t, root, workspace.RepoPath, worktreesDir)
	if root.Branch != "task/empty-repo-task" {
		t.Fatalf("expected orphan worktree branch %q, got %q", "task/empty-repo-task", root.Branch)
	}

	out := gitOutput(t, root.WorktreePath, "status", "--short", "--branch")
	if !strings.Contains(out, "No commits yet on task/empty-repo-task") {
		t.Fatalf("expected orphan worktree status, got %q", out)
	}
}

func assertManagedWorktreeTask(t *testing.T, task domain.Task, repoPath, worktreesDir string) {
	t.Helper()

	if task.DirectRepo {
		t.Fatalf("expected managed worktree task, got direct_repo=true")
	}
	if strings.TrimSpace(task.WorktreePath) == "" {
		t.Fatalf("expected worktree path to be set")
	}
	if filepath.Clean(task.WorktreePath) == filepath.Clean(repoPath) {
		t.Fatalf("expected worktree path %q to differ from repo path %q", task.WorktreePath, repoPath)
	}
	rel, err := filepath.Rel(worktreesDir, task.WorktreePath)
	if err != nil {
		t.Fatalf("relative worktree path: %v", err)
	}
	if rel == "." || strings.HasPrefix(rel, ".."+string(os.PathSeparator)) {
		t.Fatalf("expected worktree path %q under managed dir %q", task.WorktreePath, worktreesDir)
	}
	if info, err := os.Stat(task.WorktreePath); err != nil {
		t.Fatalf("expected worktree path to exist: %v", err)
	} else if !info.IsDir() {
		t.Fatalf("expected worktree path to be a directory")
	}
}

func newWorktreeCreateTestManager(t *testing.T) (*Manager, string) {
	t.Helper()

	base := t.TempDir()
	worktreesDir := filepath.Join(base, "worktrees")
	m := &Manager{
		tasks:          map[string]*domain.Task{},
		store:          store.NewTaskStore(filepath.Join(base, "tasks.json")),
		workspaceStore: store.NewWorkspaceStore(filepath.Join(base, "workspaces.json")),
		workspaces:     map[string]domain.Workspace{},
		process:        process.NewManager(),
		worktree:       gitops.NewWorktreeManager(worktreesDir),
		logsDir:        filepath.Join(base, "logs"),
	}
	return m, worktreesDir
}

func initWorktreeTestRepo(t *testing.T, withCommit bool) string {
	t.Helper()

	repoPath := t.TempDir()
	runGitForTest(t, repoPath, "init", "-b", "main")
	runGitForTest(t, repoPath, "config", "user.email", "qa@example.test")
	runGitForTest(t, repoPath, "config", "user.name", "QA")
	if withCommit {
		if err := os.WriteFile(filepath.Join(repoPath, "README.md"), []byte("qa repo\n"), 0o644); err != nil {
			t.Fatalf("write README: %v", err)
		}
		runGitForTest(t, repoPath, "add", "README.md")
		runGitForTest(t, repoPath, "commit", "-m", "seed")
	}
	return repoPath
}

func gitOutput(t *testing.T, repoPath string, args ...string) string {
	t.Helper()

	cmd := exec.Command("git", append([]string{"-C", repoPath}, args...)...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %s failed: %v (%s)", strings.Join(args, " "), err, strings.TrimSpace(string(out)))
	}
	return string(out)
}

func runGitForTest(t *testing.T, repoPath string, args ...string) {
	t.Helper()
	_ = gitOutput(t, repoPath, args...)
}
