package config

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

type Config struct {
	Addr          string
	DataDir       string
	TasksFile     string
	LogsDir       string
	WorktreesDir  string
	PresetsFile   string
	DefaultEditor string
}

func Load() (Config, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return Config{}, fmt.Errorf("resolve home dir: %w", err)
	}

	cfg := Config{
		Addr:          envOrDefault("STAQ_ADDR", "127.0.0.1:7777"),
		DataDir:       envOrDefault("STAQ_DATA_DIR", filepath.Join(home, ".staq")),
		DefaultEditor: envOrDefault("STAQ_DEFAULT_EDITOR", "code"),
	}
	cfg.RefreshDerivedPaths()
	return cfg, nil
}

func (c *Config) RefreshDerivedPaths() {
	c.DataDir = expandHome(c.DataDir)
	c.TasksFile = filepath.Join(c.DataDir, "tasks.json")
	c.LogsDir = filepath.Join(c.DataDir, "logs")
	c.WorktreesDir = filepath.Join(c.DataDir, "worktrees")
	c.PresetsFile = filepath.Join(c.DataDir, "presets.json")
}

func (c Config) EnsureDirs() error {
	for _, dir := range []string{c.DataDir, c.LogsDir, c.WorktreesDir} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return fmt.Errorf("create dir %s: %w", dir, err)
		}
	}
	return nil
}

func envOrDefault(key, fallback string) string {
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		return fallback
	}
	return value
}

func expandHome(path string) string {
	if path == "~" {
		home, _ := os.UserHomeDir()
		return home
	}
	if strings.HasPrefix(path, "~/") {
		home, _ := os.UserHomeDir()
		return filepath.Join(home, strings.TrimPrefix(path, "~/"))
	}
	return path
}
