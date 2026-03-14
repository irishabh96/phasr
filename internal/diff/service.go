package diff

import (
	"fmt"
	"os/exec"
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

func parsePorcelain(output string) []Change {
	lines := strings.Split(strings.TrimSpace(output), "\n")
	changes := make([]Change, 0, len(lines))
	for _, line := range lines {
		line = strings.TrimRight(line, "\r")
		if len(strings.TrimSpace(line)) < 4 {
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

func runGit(args ...string) (string, error) {
	cmd := exec.Command("git", args...)
	out, err := cmd.CombinedOutput()
	return string(out), err
}
