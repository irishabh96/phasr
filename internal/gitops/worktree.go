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
	_, _ = runGit("-C", repoPath, "worktree", "prune")

	slug := sanitize(taskName)
	if slug == "" {
		slug = "task"
	}

	idToken := compactTaskToken(taskID)
	branchName := fmt.Sprintf("task/%s", slug)
	if m.branchExists(repoPath, branchName) {
		branchName = fmt.Sprintf("%s-%s", branchName, idToken)
		if m.branchExists(repoPath, branchName) {
			branchName = fmt.Sprintf("%s-%d", branchName, time.Now().Unix())
		}
	}

	if err := os.MkdirAll(m.baseDir, 0o755); err != nil {
		return "", "", fmt.Errorf("create worktree root: %w", err)
	}

	worktreePath := filepath.Join(m.baseDir, fmt.Sprintf("%s-%s", idToken, slug))
	if _, err := os.Stat(worktreePath); err == nil {
		worktreePath = worktreePath + fmt.Sprintf("-%d", time.Now().Unix())
	}

	out, err := runGit("-C", repoPath, "worktree", "add", "-b", branchName, worktreePath)
	if err != nil && strings.Contains(strings.ToLower(out), "already registered worktree") {
		_, _ = runGit("-C", repoPath, "worktree", "prune")
		out, err = runGit("-C", repoPath, "worktree", "add", "-f", "-b", branchName, worktreePath)
	}
	if err != nil {
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

func compactTaskToken(value string) string {
	clean := strings.ToLower(strings.TrimSpace(value))
	if clean == "" {
		return fmt.Sprintf("%d", time.Now().UnixNano())
	}
	clean = strings.NewReplacer("-", "", "_", "", "/", "", " ", "").Replace(clean)
	if len(clean) > 16 {
		return clean[len(clean)-16:]
	}
	return clean
}
