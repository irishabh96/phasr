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

type CommitHistoryItem struct {
	Hash    string       `json:"hash"`
	Message string       `json:"message"`
	Files   []FileChange `json:"files"`
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

func (s *Service) DiscardFile(worktreePath, path string) error {
	path = strings.TrimSpace(path)
	if path == "" {
		return fmt.Errorf("path is required")
	}

	hasHead := false
	if _, err := runGit("-C", worktreePath, "rev-parse", "--verify", "HEAD"); err == nil {
		hasHead = true
	}

	attempts := []struct {
		args []string
		desc string
	}{}
	if hasHead {
		attempts = append(attempts,
			struct {
				args []string
				desc string
			}{
				args: []string{"-C", worktreePath, "restore", "--source=HEAD", "--staged", "--worktree", "--", path},
				desc: "git restore --source=HEAD --staged --worktree",
			},
			struct {
				args []string
				desc string
			}{
				args: []string{"-C", worktreePath, "restore", "--worktree", "--", path},
				desc: "git restore --worktree",
			},
		)
	}
	attempts = append(attempts,
		struct {
			args []string
			desc string
		}{
			args: []string{"-C", worktreePath, "rm", "-f", "-r", "--", path},
			desc: "git rm -f -r",
		},
		struct {
			args []string
			desc string
		}{
			args: []string{"-C", worktreePath, "clean", "-f", "-d", "--", path},
			desc: "git clean -f -d",
		},
	)

	lastErr := ""
	for _, attempt := range attempts {
		out, err := runGit(attempt.args...)
		if err == nil {
			return nil
		}
		lastErr = fmt.Sprintf("%s: %v (%s)", attempt.desc, err, strings.TrimSpace(out))
	}
	if lastErr == "" {
		return fmt.Errorf("discard changes failed")
	}
	return fmt.Errorf("discard changes: %s", lastErr)
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

func (s *Service) Push(worktreePath string) (string, error) {
	out, err := runGit("-C", worktreePath, "push")
	if err != nil {
		return "", fmt.Errorf("git push: %w (%s)", err, strings.TrimSpace(out))
	}
	return strings.TrimSpace(out), nil
}

func (s *Service) Pull(worktreePath string) (string, error) {
	out, err := runGit("-C", worktreePath, "pull")
	if err != nil {
		return "", fmt.Errorf("git pull: %w (%s)", err, strings.TrimSpace(out))
	}
	return strings.TrimSpace(out), nil
}

func (s *Service) Fetch(worktreePath string) (string, error) {
	out, err := runGit("-C", worktreePath, "fetch")
	if err != nil {
		return "", fmt.Errorf("git fetch: %w (%s)", err, strings.TrimSpace(out))
	}
	return strings.TrimSpace(out), nil
}

func (s *Service) CommitHistory(worktreePath string) ([]CommitHistoryItem, int, error) {
	if strings.TrimSpace(worktreePath) == "" {
		return []CommitHistoryItem{}, 0, nil
	}

	// Branches without any commits have no HEAD yet.
	if _, headErr := runGit("-C", worktreePath, "rev-parse", "--verify", "HEAD"); headErr != nil {
		return []CommitHistoryItem{}, 0, nil
	}

	rangeSpec := commitHistoryRangeSpec(worktreePath)

	countOut, err := runGit("-C", worktreePath, "rev-list", "--count", rangeSpec)
	if err != nil {
		return nil, 0, fmt.Errorf("git rev-list --count: %w (%s)", err, strings.TrimSpace(countOut))
	}
	total, convErr := strconv.Atoi(strings.TrimSpace(countOut))
	if convErr != nil {
		return nil, 0, fmt.Errorf("parse commit count: %w", convErr)
	}

	logOut, err := runGit(
		"-C", worktreePath,
		"log",
		"--pretty=format:__COMMIT__%H\t%s",
		"--numstat",
		"--no-color",
		rangeSpec,
	)
	if err != nil {
		return nil, 0, fmt.Errorf("git log --numstat: %w (%s)", err, strings.TrimSpace(logOut))
	}

	return parseCommitHistory(logOut), total, nil
}

func commitHistoryRangeSpec(worktreePath string) string {
	// Default: all commits reachable from HEAD.
	defaultSpec := "HEAD"

	currentBranchOut, err := runGit("-C", worktreePath, "rev-parse", "--abbrev-ref", "HEAD")
	if err != nil {
		return defaultSpec
	}
	currentBranch := strings.TrimSpace(currentBranchOut)
	if currentBranch == "" || currentBranch == "HEAD" {
		return defaultSpec
	}

	seen := map[string]struct{}{}
	candidates := make([]string, 0, 8)
	addCandidate := func(ref string) {
		ref = strings.TrimSpace(ref)
		if ref == "" {
			return
		}
		if _, ok := seen[ref]; ok {
			return
		}
		seen[ref] = struct{}{}
		candidates = append(candidates, ref)
	}

	// 1) Upstream of current branch (if configured)
	if upstreamOut, upstreamErr := runGit(
		"-C", worktreePath,
		"rev-parse",
		"--abbrev-ref",
		"--symbolic-full-name",
		"@{upstream}",
	); upstreamErr == nil {
		addCandidate(upstreamOut)
	}

	// 2) Remote default branch (origin/HEAD -> origin/main|master)
	if originHeadOut, originHeadErr := runGit(
		"-C", worktreePath,
		"symbolic-ref",
		"--quiet",
		"--short",
		"refs/remotes/origin/HEAD",
	); originHeadErr == nil {
		addCandidate(originHeadOut)
	}

	// 3) Conventional local/remote default branches
	for _, base := range []string{"main", "master"} {
		addCandidate(base)
		addCandidate("origin/" + base)
	}

	for _, candidate := range candidates {
		if candidate == currentBranch {
			continue
		}
		if _, verifyErr := runGit("-C", worktreePath, "rev-parse", "--verify", candidate); verifyErr != nil {
			continue
		}
		if _, mergeBaseErr := runGit("-C", worktreePath, "merge-base", "HEAD", candidate); mergeBaseErr != nil {
			continue
		}
		return fmt.Sprintf("%s..HEAD", candidate)
	}

	return defaultSpec
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

func normalizedPathFromNumStat(path string) string {
	value := strings.TrimSpace(path)
	if value == "" {
		return ""
	}
	if strings.Contains(value, " => ") {
		parts := strings.Split(value, " => ")
		value = strings.TrimSpace(parts[len(parts)-1])
		value = strings.ReplaceAll(value, "{", "")
		value = strings.ReplaceAll(value, "}", "")
	}
	return strings.Trim(value, "\"")
}

func parseCommitHistory(output string) []CommitHistoryItem {
	lines := strings.Split(strings.ReplaceAll(output, "\r\n", "\n"), "\n")
	commits := make([]CommitHistoryItem, 0, 64)
	var current *CommitHistoryItem

	flush := func() {
		if current == nil {
			return
		}
		if current.Files == nil {
			current.Files = []FileChange{}
		}
		commits = append(commits, *current)
		current = nil
	}

	for _, rawLine := range lines {
		line := strings.TrimRight(rawLine, "\r")
		if strings.HasPrefix(line, "__COMMIT__") {
			flush()
			payload := strings.TrimPrefix(line, "__COMMIT__")
			parts := strings.SplitN(payload, "\t", 2)
			hash := strings.TrimSpace(parts[0])
			message := ""
			if len(parts) > 1 {
				message = strings.TrimSpace(parts[1])
			}
			current = &CommitHistoryItem{
				Hash:    hash,
				Message: message,
				Files:   []FileChange{},
			}
			continue
		}
		if current == nil || strings.TrimSpace(line) == "" {
			continue
		}

		parts := strings.SplitN(line, "\t", 3)
		if len(parts) < 3 {
			continue
		}
		path := normalizedPathFromNumStat(parts[2])
		if path == "" {
			continue
		}
		current.Files = append(current.Files, FileChange{
			Path:    path,
			Status:  "M",
			Added:   parseNumStatCell(parts[0]),
			Deleted: parseNumStatCell(parts[1]),
		})
	}

	flush()
	if len(commits) == 0 {
		return []CommitHistoryItem{}
	}
	return commits
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
