package diff

import (
	"fmt"
	"os/exec"
	"sort"
	"strconv"
	"strings"
)

type Change struct {
	Path   string `json:"path"`
	Status string `json:"status"`
}

type Service struct{}

func NewService() *Service {
	return &Service{}
}

func (s *Service) Summary(worktreePath string) ([]Change, string, error) {
	statusOut, err := runGit("-C", worktreePath, "status", "--porcelain")
	if err != nil {
		return nil, "", fmt.Errorf("git status: %w (%s)", err, strings.TrimSpace(statusOut))
	}

	changes := parsePorcelain(statusOut)
	statOut, _ := runGit("-C", worktreePath, "diff", "--stat")
	return changes, strings.TrimSpace(statOut), nil
}

func (s *Service) Patch(worktreePath, file string) (string, error) {
	args := []string{"-C", worktreePath, "diff"}
	if strings.TrimSpace(file) != "" {
		args = append(args, "--", file)
	}
	out, err := runGit(args...)
	if err != nil {
		return "", fmt.Errorf("git diff: %w (%s)", err, strings.TrimSpace(out))
	}
	return out, nil
}

type FileChange struct {
	Path    string `json:"path"`
	Status  string `json:"status"`
	Added   int    `json:"added"`
	Deleted int    `json:"deleted"`
}

type GitStatus struct {
	Staged   []FileChange `json:"staged"`
	Unstaged []FileChange `json:"unstaged"`
}

func (s *Service) WorkingTreeStatus(worktreePath string) (GitStatus, error) {
	statusOut, err := runGit("-C", worktreePath, "status", "--porcelain")
	if err != nil {
		return GitStatus{}, fmt.Errorf("git status: %w (%s)", err, strings.TrimSpace(statusOut))
	}

	stagedMap := map[string]FileChange{}
	unstagedMap := map[string]FileChange{}

	lines := strings.Split(strings.ReplaceAll(statusOut, "\r\n", "\n"), "\n")
	for _, line := range lines {
		line = strings.TrimRight(line, "\r")
		if strings.TrimSpace(line) == "" || len(line) < 4 {
			continue
		}
		status := line[:2]
		path := normalizedPathFromPorcelain(line[3:])
		if path == "" {
			continue
		}

		x := status[0]
		y := status[1]

		if x != ' ' && x != '?' && x != '!' {
			stagedMap[path] = FileChange{Path: path, Status: string(x)}
		}
		if y != ' ' && y != '?' && y != '!' {
			unstagedMap[path] = FileChange{Path: path, Status: string(y)}
		}
		if x == '?' && y == '?' {
			unstagedMap[path] = FileChange{Path: path, Status: "?"}
		}
	}

	stagedCounts, err := parseNumStat(runGit("-C", worktreePath, "diff", "--numstat", "--cached"))
	if err != nil {
		return GitStatus{}, err
	}
	unstagedCounts, err := parseNumStat(runGit("-C", worktreePath, "diff", "--numstat"))
	if err != nil {
		return GitStatus{}, err
	}

	for path, counts := range stagedCounts {
		item := stagedMap[path]
		item.Path = path
		item.Added = counts.added
		item.Deleted = counts.deleted
		if item.Status == "" {
			item.Status = "M"
		}
		stagedMap[path] = item
	}
	for path, counts := range unstagedCounts {
		item := unstagedMap[path]
		item.Path = path
		item.Added = counts.added
		item.Deleted = counts.deleted
		if item.Status == "" {
			item.Status = "M"
		}
		unstagedMap[path] = item
	}

	return GitStatus{
		Staged:   mapToSortedChanges(stagedMap),
		Unstaged: mapToSortedChanges(unstagedMap),
	}, nil
}

func (s *Service) StageFile(worktreePath, path string) error {
	path = strings.TrimSpace(path)
	if path == "" {
		return fmt.Errorf("path is required")
	}
	out, err := runGit("-C", worktreePath, "add", "--", path)
	if err != nil {
		return fmt.Errorf("git add: %w (%s)", err, strings.TrimSpace(out))
	}
	return nil
}

func (s *Service) UnstageFile(worktreePath, path string) error {
	path = strings.TrimSpace(path)
	if path == "" {
		return fmt.Errorf("path is required")
	}
	out, err := runGit("-C", worktreePath, "restore", "--staged", "--", path)
	if err == nil {
		return nil
	}

	// In repos without an initial commit, `restore --staged` can fail because HEAD
	// does not exist yet. Fall back to removing the entry from index.
	if _, headErr := runGit("-C", worktreePath, "rev-parse", "--verify", "HEAD"); headErr != nil {
		fallbackOut, fallbackErr := runGit("-C", worktreePath, "rm", "--cached", "-r", "--", path)
		if fallbackErr == nil {
			return nil
		}
		return fmt.Errorf(
			"git restore --staged: %w (%s); fallback git rm --cached failed: %v (%s)",
			err,
			strings.TrimSpace(out),
			fallbackErr,
			strings.TrimSpace(fallbackOut),
		)
	}

	return fmt.Errorf("git restore --staged: %w (%s)", err, strings.TrimSpace(out))
}

func (s *Service) Commit(worktreePath, message string) (string, error) {
	message = strings.TrimSpace(message)
	if message == "" {
		return "", fmt.Errorf("commit message is required")
	}
	out, err := runGit("-C", worktreePath, "commit", "-m", message)
	if err != nil {
		return "", fmt.Errorf("git commit: %w (%s)", err, strings.TrimSpace(out))
	}
	return strings.TrimSpace(out), nil
}

func parsePorcelain(output string) []Change {
	lines := strings.Split(strings.ReplaceAll(output, "\r\n", "\n"), "\n")
	changes := make([]Change, 0, len(lines))
	for _, line := range lines {
		line = strings.TrimRight(line, "\r")
		if strings.TrimSpace(line) == "" || len(line) < 4 {
			continue
		}
		status := strings.TrimSpace(line[:2])
		path := strings.TrimSpace(line[3:])
		changes = append(changes, Change{
			Path:   path,
			Status: status,
		})
	}
	if len(changes) == 0 {
		return []Change{}
	}
	return changes
}

type diffCounts struct {
	added   int
	deleted int
}

func parseNumStat(out string, err error) (map[string]diffCounts, error) {
	if err != nil {
		return nil, fmt.Errorf("git diff --numstat: %w (%s)", err, strings.TrimSpace(out))
	}
	result := map[string]diffCounts{}
	lines := strings.Split(strings.TrimSpace(out), "\n")
	for _, line := range lines {
		line = strings.TrimRight(line, "\r")
		if strings.TrimSpace(line) == "" {
			continue
		}
		parts := strings.SplitN(line, "\t", 3)
		if len(parts) < 3 {
			continue
		}
		path := strings.TrimSpace(parts[2])
		if path == "" {
			continue
		}
		added := parseNumStatCell(parts[0])
		deleted := parseNumStatCell(parts[1])
		result[path] = diffCounts{added: added, deleted: deleted}
	}
	return result, nil
}

func parseNumStatCell(raw string) int {
	value := strings.TrimSpace(raw)
	if value == "" || value == "-" {
		return 0
	}
	n, err := strconv.Atoi(value)
	if err != nil {
		return 0
	}
	return n
}

func normalizedPathFromPorcelain(path string) string {
	value := strings.TrimSpace(path)
	if value == "" {
		return ""
	}
	if strings.Contains(value, " -> ") {
		parts := strings.Split(value, " -> ")
		value = strings.TrimSpace(parts[len(parts)-1])
	}
	return strings.Trim(value, "\"")
}

func mapToSortedChanges(items map[string]FileChange) []FileChange {
	changes := make([]FileChange, 0, len(items))
	for _, item := range items {
		changes = append(changes, item)
	}
	sort.Slice(changes, func(i, j int) bool {
		return changes[i].Path < changes[j].Path
	})
	if len(changes) == 0 {
		return []FileChange{}
	}
	return changes
}

func runGit(args ...string) (string, error) {
	cmd := exec.Command("git", args...)
	out, err := cmd.CombinedOutput()
	return string(out), err
}
