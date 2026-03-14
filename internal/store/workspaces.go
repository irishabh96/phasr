package store

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"

	"staq/internal/domain"
)

type WorkspaceStore struct {
	path string
	mu   sync.Mutex
}

func NewWorkspaceStore(path string) *WorkspaceStore {
	return &WorkspaceStore{path: path}
}

func (s *WorkspaceStore) Load() ([]domain.Workspace, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	data, err := os.ReadFile(s.path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return []domain.Workspace{}, nil
		}
		return nil, fmt.Errorf("read workspace store: %w", err)
	}
	if len(data) == 0 {
		return []domain.Workspace{}, nil
	}

	// Backward compatibility:
	// old format: ["default","alpha"]
	// new format: [{"name":"default","repo_path":"/path"}]
	var legacy []string
	if err := json.Unmarshal(data, &legacy); err == nil {
		out := make([]domain.Workspace, 0, len(legacy))
		for _, name := range legacy {
			trimmed := strings.TrimSpace(name)
			if trimmed == "" {
				continue
			}
			out = append(out, domain.Workspace{Name: trimmed})
		}
		return normalizeWorkspaces(out), nil
	}

	var workspaces []domain.Workspace
	if err := json.Unmarshal(data, &workspaces); err != nil {
		return nil, fmt.Errorf("decode workspace store: %w", err)
	}
	return normalizeWorkspaces(workspaces), nil
}

func (s *WorkspaceStore) Save(workspaces []domain.Workspace) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	clean := normalizeWorkspaces(workspaces)
	if err := os.MkdirAll(filepath.Dir(s.path), 0o755); err != nil {
		return fmt.Errorf("create workspace store dir: %w", err)
	}

	data, err := json.MarshalIndent(clean, "", "  ")
	if err != nil {
		return fmt.Errorf("encode workspace store: %w", err)
	}

	tmpFile := s.path + ".tmp"
	if err := os.WriteFile(tmpFile, data, 0o644); err != nil {
		return fmt.Errorf("write temp workspace store: %w", err)
	}
	if err := os.Rename(tmpFile, s.path); err != nil {
		return fmt.Errorf("move temp workspace store: %w", err)
	}
	return nil
}

func normalizeWorkspaces(workspaces []domain.Workspace) []domain.Workspace {
	seen := map[string]struct{}{}
	out := make([]domain.Workspace, 0, len(workspaces))
	for _, workspace := range workspaces {
		name := strings.TrimSpace(workspace.Name)
		if name == "" {
			continue
		}
		key := strings.ToLower(name)
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		out = append(out, domain.Workspace{
			Name:     name,
			RepoPath: strings.TrimSpace(workspace.RepoPath),
		})
	}
	sort.Slice(out, func(i, j int) bool {
		return strings.ToLower(out[i].Name) < strings.ToLower(out[j].Name)
	})
	return out
}
