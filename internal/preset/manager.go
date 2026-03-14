package preset

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"sort"
	"strings"
	"sync"
)

type Preset struct {
	Name          string   `json:"name"`
	Description   string   `json:"description"`
	SetupCommands []string `json:"setup_commands"`
}

type fileConfig struct {
	Presets []Preset `json:"presets"`
}

type Manager struct {
	mu      sync.RWMutex
	presets map[string]Preset
}

func NewManager(path string) (*Manager, error) {
	m := &Manager{presets: map[string]Preset{}}
	for _, preset := range defaultPresets() {
		m.presets[preset.Name] = preset
	}

	if err := m.loadFromFile(path); err != nil {
		return nil, err
	}

	return m, nil
}

func (m *Manager) loadFromFile(path string) error {
	data, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		return fmt.Errorf("read presets file: %w", err)
	}

	if len(strings.TrimSpace(string(data))) == 0 {
		return nil
	}

	var cfg fileConfig
	if err := json.Unmarshal(data, &cfg); err != nil {
		return fmt.Errorf("decode presets file: %w", err)
	}

	m.mu.Lock()
	defer m.mu.Unlock()
	for _, preset := range cfg.Presets {
		preset.Name = strings.TrimSpace(preset.Name)
		if preset.Name == "" {
			continue
		}
		m.presets[preset.Name] = preset
	}
	return nil
}

func (m *Manager) List() []Preset {
	m.mu.RLock()
	defer m.mu.RUnlock()

	presets := make([]Preset, 0, len(m.presets))
	for _, preset := range m.presets {
		presets = append(presets, preset)
	}

	sort.Slice(presets, func(i, j int) bool {
		return presets[i].Name < presets[j].Name
	})
	return presets
}

func (m *Manager) Get(name string) (Preset, bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()

	preset, ok := m.presets[name]
	return preset, ok
}

func defaultPresets() []Preset {
	return []Preset{
		{
			Name:          "none",
			Description:   "No setup commands",
			SetupCommands: nil,
		},
		{
			Name:        "go-bootstrap",
			Description: "Prepare a Go repo for local iteration",
			SetupCommands: []string{
				"go mod tidy || true",
				"go test ./... || true",
			},
		},
		{
			Name:        "js-bootstrap",
			Description: "Install JS dependencies when package managers are available",
			SetupCommands: []string{
				"if [ -f package-lock.json ]; then npm ci || npm install; fi",
				"if [ -f pnpm-lock.yaml ]; then pnpm install || true; fi",
				"if [ -f yarn.lock ]; then yarn install || true; fi",
			},
		},
		{
			Name:        "verify-and-test",
			Description: "Run quick repo diagnostics",
			SetupCommands: []string{
				"git status --short",
				"if [ -f Makefile ]; then make test || true; fi",
			},
		},
	}
}
