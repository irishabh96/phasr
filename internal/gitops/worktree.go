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

func (m *WorktreeManager) Create(repoPath, taskName, taskID, baseBranch, requestedBranch string) (string, string, error) {
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
	branchName, explicitBranch, err := m.branchName(repoPath, slug, requestedBranch)
	if err != nil {
		return "", "", err
	}
	if !explicitBranch && m.branchExists(repoPath, branchName) {
		branchName = fmt.Sprintf("%s-%s", branchName, idToken)
		if m.branchExists(repoPath, branchName) {
			branchName = fmt.Sprintf("%s-%d", branchName, time.Now().Unix())
		}
	}
	if explicitBranch && m.branchExists(repoPath, branchName) {
		return "", "", fmt.Errorf("branch %q already exists", branchName)
	}

	baseRef, err := m.baseRef(repoPath, baseBranch)
	if err != nil {
		return "", "", err
	}

	if err := os.MkdirAll(m.baseDir, 0o755); err != nil {
		return "", "", fmt.Errorf("create worktree root: %w", err)
	}

	worktreePath := filepath.Join(m.baseDir, fmt.Sprintf("%s-%s", idToken, slug))
	if _, err := os.Stat(worktreePath); err == nil {
		worktreePath = worktreePath + fmt.Sprintf("-%d", time.Now().Unix())
	}

	args := []string{"-C", repoPath, "worktree", "add", "-b", branchName, worktreePath}
	if baseRef != "" {
		args = append(args, baseRef)
	}
	out, err := runGit(args...)
	if err != nil && strings.Contains(strings.ToLower(out), "already registered worktree") {
		_, _ = runGit("-C", repoPath, "worktree", "prune")
		args = []string{"-C", repoPath, "worktree", "add", "-f", "-b", branchName, worktreePath}
		if baseRef != "" {
			args = append(args, baseRef)
		}
		out, err = runGit(args...)
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

func (m *WorktreeManager) RemoveManagedPath(path string) error {
	managedPath, ok := m.managedPath(path)
	if !ok {
		return nil
	}
	if err := os.RemoveAll(managedPath); err != nil {
		return fmt.Errorf("remove managed worktree path: %w", err)
	}
	return nil
}

func (m *WorktreeManager) managedPath(path string) (string, bool) {
	target := strings.TrimSpace(path)
	if target == "" {
		return "", false
	}
	base := strings.TrimSpace(m.baseDir)
	if base == "" {
		return "", false
	}
	absBase, err := filepath.Abs(base)
	if err != nil {
		return "", false
	}
	absPath, err := filepath.Abs(target)
	if err != nil {
		return "", false
	}
	rel, err := filepath.Rel(absBase, absPath)
	if err != nil {
		return "", false
	}
	if rel == "." || rel == "" {
		return "", false
	}
	if rel == ".." || strings.HasPrefix(rel, ".."+string(os.PathSeparator)) {
		return "", false
	}
	return absPath, true
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

func (m *WorktreeManager) branchName(repoPath, slug, requested string) (string, bool, error) {
	requested = strings.Trim(strings.TrimSpace(requested), "/")
	if requested == "" {
		return fmt.Sprintf("task/%s", slug), false, nil
	}
	if strings.HasPrefix(requested, "-") {
		return "", false, fmt.Errorf("invalid branch name %q", requested)
	}
	if out, err := runGit("-C", repoPath, "check-ref-format", "--branch", requested); err != nil {
		return "", false, fmt.Errorf("invalid branch name %q: %w (%s)", requested, err, strings.TrimSpace(out))
	}
	return requested, true, nil
}

func (m *WorktreeManager) baseRef(repoPath, baseBranch string) (string, error) {
	base := strings.Trim(strings.TrimSpace(baseBranch), "/")
	if base == "" || strings.EqualFold(base, "current") || strings.EqualFold(base, "detecting...") {
		return "", nil
	}
	if strings.HasPrefix(base, "-") {
		return "", fmt.Errorf("invalid base branch %q", base)
	}

	candidates := []string{base}
	if !strings.HasPrefix(base, "origin/") && !strings.HasPrefix(base, "refs/") {
		candidates = append(candidates, "origin/"+base)
	}
	for _, candidate := range candidates {
		if _, err := runGit("-C", repoPath, "rev-parse", "--verify", "--quiet", candidate+"^{commit}"); err == nil {
			return candidate, nil
		}
	}
	return "", fmt.Errorf("base branch %q was not found", base)
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
