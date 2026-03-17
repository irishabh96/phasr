package task

import (
	"os"
	"path/filepath"
	"testing"

	"phasr/internal/domain"
	"phasr/internal/gitops"
	"phasr/internal/process"
	"phasr/internal/store"
)

func TestDeleteRemovesManagedWorktreeForDirectRepoTask(t *testing.T) {
	t.Parallel()

	m, worktreesDir := newDeleteTestManager(t)
	worktreePath := mustCreateDir(t, filepath.Join(worktreesDir, "direct-repo-task"))
	logFile := mustCreateFile(t, filepath.Join(t.TempDir(), "logs", "direct.log"))

	m.tasks["task-direct"] = &domain.Task{
		ID:           "task-direct",
		Workspace:    "workspace-one",
		DirectRepo:   true,
		RepoPath:     filepath.Join(t.TempDir(), "repo"),
		WorktreePath: worktreePath,
		LogFile:      logFile,
	}

	if err := m.Delete("task-direct"); err != nil {
		t.Fatalf("delete task: %v", err)
	}
	if _, err := os.Stat(worktreePath); !os.IsNotExist(err) {
		t.Fatalf("expected managed worktree path to be removed, stat err=%v", err)
	}
	if _, err := os.Stat(logFile); !os.IsNotExist(err) {
		t.Fatalf("expected task log file to be removed, stat err=%v", err)
	}
	if _, exists := m.tasks["task-direct"]; exists {
		t.Fatalf("expected task to be removed from manager")
	}
}

func TestDeleteRemovesManagedWorktreeWhenGitWorktreeRemoveFails(t *testing.T) {
	t.Parallel()

	m, worktreesDir := newDeleteTestManager(t)
	worktreePath := mustCreateDir(t, filepath.Join(worktreesDir, "stale-worktree-task"))
	logFile := mustCreateFile(t, filepath.Join(t.TempDir(), "logs", "stale.log"))

	// RepoPath intentionally points to a non-repo path so git worktree remove fails.
	m.tasks["task-stale"] = &domain.Task{
		ID:           "task-stale",
		Workspace:    "workspace-one",
		DirectRepo:   false,
		RepoPath:     filepath.Join(t.TempDir(), "not-a-git-repo"),
		WorktreePath: worktreePath,
		LogFile:      logFile,
	}

	if err := m.Delete("task-stale"); err != nil {
		t.Fatalf("delete task with stale registration: %v", err)
	}
	if _, err := os.Stat(worktreePath); !os.IsNotExist(err) {
		t.Fatalf("expected stale managed worktree path to be removed, stat err=%v", err)
	}
	if _, err := os.Stat(logFile); !os.IsNotExist(err) {
		t.Fatalf("expected task log file to be removed, stat err=%v", err)
	}
}

func TestDeleteWorkspaceRemovesManagedWorktreesFromDisk(t *testing.T) {
	t.Parallel()

	m, worktreesDir := newDeleteTestManager(t)
	workspace := domain.Workspace{
		ID:       "ws-one",
		Name:     "workspace-one",
		RepoPath: filepath.Join(t.TempDir(), "repo"),
	}
	m.workspaces["workspace-one"] = workspace

	targetPathA := mustCreateDir(t, filepath.Join(worktreesDir, "ws-one-task-a"))
	targetPathB := mustCreateDir(t, filepath.Join(worktreesDir, "ws-one-task-b"))
	otherPath := mustCreateDir(t, filepath.Join(worktreesDir, "ws-other-task"))

	m.tasks["ws-one-task-a"] = &domain.Task{
		ID:           "ws-one-task-a",
		Workspace:    "workspace-one",
		DirectRepo:   true,
		RepoPath:     filepath.Join(t.TempDir(), "repo"),
		WorktreePath: targetPathA,
		LogFile:      mustCreateFile(t, filepath.Join(t.TempDir(), "logs", "ws-one-a.log")),
	}
	m.tasks["ws-one-task-b"] = &domain.Task{
		ID:           "ws-one-task-b",
		Workspace:    "workspace-one",
		DirectRepo:   false,
		RepoPath:     filepath.Join(t.TempDir(), "not-a-git-repo"),
		WorktreePath: targetPathB,
		LogFile:      mustCreateFile(t, filepath.Join(t.TempDir(), "logs", "ws-one-b.log")),
	}
	m.tasks["other-task"] = &domain.Task{
		ID:           "other-task",
		Workspace:    "workspace-other",
		DirectRepo:   true,
		RepoPath:     filepath.Join(t.TempDir(), "repo-other"),
		WorktreePath: otherPath,
		LogFile:      mustCreateFile(t, filepath.Join(t.TempDir(), "logs", "other.log")),
	}

	if err := m.DeleteWorkspace("ws-one"); err != nil {
		t.Fatalf("delete workspace: %v", err)
	}

	if _, err := os.Stat(targetPathA); !os.IsNotExist(err) {
		t.Fatalf("expected workspace worktree path A to be removed, stat err=%v", err)
	}
	if _, err := os.Stat(targetPathB); !os.IsNotExist(err) {
		t.Fatalf("expected workspace worktree path B to be removed, stat err=%v", err)
	}
	if _, err := os.Stat(otherPath); err != nil {
		t.Fatalf("expected unrelated workspace path to remain, stat err=%v", err)
	}
	if _, exists := m.workspaces["workspace-one"]; exists {
		t.Fatalf("expected workspace to be removed from manager")
	}
	if _, exists := m.tasks["ws-one-task-a"]; exists {
		t.Fatalf("expected workspace task A to be removed")
	}
	if _, exists := m.tasks["ws-one-task-b"]; exists {
		t.Fatalf("expected workspace task B to be removed")
	}
	if _, exists := m.tasks["other-task"]; !exists {
		t.Fatalf("expected other workspace task to remain")
	}
}

func newDeleteTestManager(t *testing.T) (*Manager, string) {
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
	}
	return m, worktreesDir
}

func mustCreateDir(t *testing.T, path string) string {
	t.Helper()
	if err := os.MkdirAll(path, 0o755); err != nil {
		t.Fatalf("create dir %s: %v", path, err)
	}
	return path
}

func mustCreateFile(t *testing.T, path string) string {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("create parent dir for %s: %v", path, err)
	}
	if err := os.WriteFile(path, []byte("log"), 0o644); err != nil {
		t.Fatalf("create file %s: %v", path, err)
	}
	return path
}

