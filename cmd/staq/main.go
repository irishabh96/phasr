package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

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

func main() {
	if err := run(); err != nil {
		log.Fatalf("staq: %v", err)
	}
}

func run() error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}

	flag.StringVar(&cfg.Addr, "addr", cfg.Addr, "HTTP listen address")
	flag.StringVar(&cfg.DataDir, "data-dir", cfg.DataDir, "Staq data directory")
	flag.StringVar(&cfg.DefaultEditor, "editor", cfg.DefaultEditor, "Default editor command (code/cursor/zed/vim/open)")
	flag.Parse()

	cfg.RefreshDerivedPaths()
	if err := cfg.EnsureDirs(); err != nil {
		return err
	}

	taskStore := store.NewTaskStore(cfg.TasksFile)
	presetManager, err := preset.NewManager(cfg.PresetsFile)
	if err != nil {
		return err
	}
	processManager := process.NewManager()
	worktreeManager := gitops.NewWorktreeManager(cfg.WorktreesDir)
	diffService := diff.NewService()
	editorLauncher := editor.NewLauncher(cfg.DefaultEditor)

	taskManager, err := task.NewManager(task.Options{
		Store:    taskStore,
		Process:  processManager,
		Worktree: worktreeManager,
		Diff:     diffService,
		Presets:  presetManager,
		Editor:   editorLauncher,
		LogsDir:  cfg.LogsDir,
	})
	if err != nil {
		return err
	}

	handler, err := api.NewServer(api.Options{
		TaskManager: taskManager,
		Address:     cfg.Addr,
	})
	if err != nil {
		return err
	}

	srv := &http.Server{
		Addr:              cfg.Addr,
		Handler:           handler,
		ReadHeaderTimeout: 10 * time.Second,
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
		defer cancel()
		_ = srv.Shutdown(shutdownCtx)
	}()

	fmt.Printf("Staq listening on http://%s\n", cfg.Addr)
	fmt.Printf("Data dir: %s\n", cfg.DataDir)
	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		return err
	}
	return nil
}
