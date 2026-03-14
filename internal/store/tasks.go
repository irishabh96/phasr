package store

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"

	"staq/internal/domain"
)

type TaskStore struct {
	path string
	mu   sync.Mutex
}

func NewTaskStore(path string) *TaskStore {
	return &TaskStore{path: path}
}

func (s *TaskStore) Load() ([]domain.Task, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	data, err := os.ReadFile(s.path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return []domain.Task{}, nil
		}
		return nil, fmt.Errorf("read task store: %w", err)
	}

	if len(data) == 0 {
		return []domain.Task{}, nil
	}

	var tasks []domain.Task
	if err := json.Unmarshal(data, &tasks); err != nil {
		return nil, fmt.Errorf("decode task store: %w", err)
	}
	return tasks, nil
}

func (s *TaskStore) Save(tasks []domain.Task) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if err := os.MkdirAll(filepath.Dir(s.path), 0o755); err != nil {
		return fmt.Errorf("create task store dir: %w", err)
	}

	data, err := json.MarshalIndent(tasks, "", "  ")
	if err != nil {
		return fmt.Errorf("encode task store: %w", err)
	}

	tmpFile := s.path + ".tmp"
	if err := os.WriteFile(tmpFile, data, 0o644); err != nil {
		return fmt.Errorf("write temp task store: %w", err)
	}
	if err := os.Rename(tmpFile, s.path); err != nil {
		return fmt.Errorf("move temp task store: %w", err)
	}
	return nil
}
