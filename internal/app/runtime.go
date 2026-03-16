package app

import (
	"fmt"
	"net/http"

	"staq/internal/api"
	"staq/internal/config"
	"staq/internal/diff"
	"staq/internal/editor"
	"staq/internal/gitops"
	"staq/internal/preset"
	"staq/internal/process"
	"staq/internal/store"
	"staq/internal/task"
)

type Runtime struct {
	Config  config.Config
	Tasks   *task.Manager
	Handler http.Handler
}

func New(cfg config.Config) (*Runtime, error) {
	if err := ensureUIBundleFresh(); err != nil {
		return nil, err
	}

	cfg.RefreshDerivedPaths()
	if err := cfg.EnsureDirs(); err != nil {
		return nil, err
	}

	taskStore := store.NewTaskStore(cfg.TasksFile)
	workspaceStore := store.NewWorkspaceStore(cfg.WorkspacesFile)
	presetManager, err := preset.NewManager(cfg.PresetsFile)
	if err != nil {
		return nil, err
	}
	processManager := process.NewManager()
	worktreeManager := gitops.NewWorktreeManager(cfg.WorktreesDir)
	diffService := diff.NewService()
	editorLauncher := editor.NewLauncher(cfg.DefaultEditor)

	taskManager, err := task.NewManager(task.Options{
		Store:          taskStore,
		WorkspaceStore: workspaceStore,
		Process:        processManager,
		Worktree:       worktreeManager,
		Diff:           diffService,
		Presets:        presetManager,
		Editor:         editorLauncher,
		LogsDir:        cfg.LogsDir,
	})
	if err != nil {
		return nil, err
	}

	handler, err := api.NewServer(api.Options{
		TaskManager: taskManager,
		Address:     cfg.Addr,
	})
	if err != nil {
		return nil, fmt.Errorf("create api server: %w", err)
	}

	return &Runtime{
		Config:  cfg,
		Tasks:   taskManager,
		Handler: handler,
	}, nil
}
