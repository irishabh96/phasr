package gitops

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

var nonSlug = regexp.MustCompile(`[^a-zA-Z0-9-_]+`)

type WorktreeManager struct {
	baseDir string
}

func NewWorktreeManager(baseDir string) *WorktreeManager {
	return &WorktreeManager{baseDir: baseDir}
}

func (m *WorktreeManager) Create(repoPath, taskName, taskID string) (string, string, error) {
	repoPath, err := filepath.Abs(repoPath)
	if err != nil {
		return "", "", fmt.Errorf("resolve repo path: %w", err)
	}

	if err := m.ensureRepo(repoPath); err != nil {
		return "", "", err
	}

	slug := sanitize(taskName)
	if slug == "" {
		slug = "task"
	}

	branchName := fmt.Sprintf("staq/%s-%s", slug, shortID(taskID))
	if m.branchExists(repoPath, branchName) {
		branchName = fmt.Sprintf("%s-%d", branchName, time.Now().Unix())
	}

	if err := os.MkdirAll(m.baseDir, 0o755); err != nil {
		return "", "", fmt.Errorf("create worktree root: %w", err)
	}

	worktreePath := filepath.Join(m.baseDir, fmt.Sprintf("%s-%s", shortID(taskID), slug))
	if _, err := os.Stat(worktreePath); err == nil {
		worktreePath = worktreePath + fmt.Sprintf("-%d", time.Now().Unix())
	}

	if out, err := runGit("-C", repoPath, "worktree", "add", "-b", branchName, worktreePath); err != nil {
		return "", "", fmt.Errorf("create worktree: %w (%s)", err, strings.TrimSpace(out))
	}

	return branchName, worktreePath, nil
}

func (m *WorktreeManager) Remove(repoPath, worktreePath string, force bool) error {
	repoPath, err := filepath.Abs(repoPath)
	if err != nil {
		return fmt.Errorf("resolve repo path: %w", err)
	}

	args := []string{"-C", repoPath, "worktree", "remove"}
	if force {
		args = append(args, "--force")
	}
	args = append(args, worktreePath)

	out, err := runGit(args...)
	if err != nil {
		return fmt.Errorf("remove worktree: %w (%s)", err, strings.TrimSpace(out))
	}
	_, _ = runGit("-C", repoPath, "worktree", "prune")
	return nil
}

func (m *WorktreeManager) ensureRepo(repoPath string) error {
	if out, err := runGit("-C", repoPath, "rev-parse", "--is-inside-work-tree"); err != nil {
		return fmt.Errorf("path is not a git repo: %w (%s)", err, strings.TrimSpace(out))
	}
	return nil
}

func (m *WorktreeManager) branchExists(repoPath, branch string) bool {
	_, err := runGit("-C", repoPath, "show-ref", "--verify", "--quiet", "refs/heads/"+branch)
	return err == nil
}

func runGit(args ...string) (string, error) {
	cmd := exec.Command("git", args...)
	out, err := cmd.CombinedOutput()
	return string(out), err
}

func sanitize(value string) string {
	value = strings.TrimSpace(strings.ToLower(value))
	value = nonSlug.ReplaceAllString(value, "-")
	value = strings.Trim(value, "-")
	return value
}

func shortID(value string) string {
	if len(value) > 8 {
		return value[:8]
	}
	return value
}
