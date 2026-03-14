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

	"staq/internal/app"
	"staq/internal/config"
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

	runtime, err := app.New(cfg)
	if err != nil {
		return err
	}

	srv := &http.Server{
		Addr:              runtime.Config.Addr,
		Handler:           runtime.Handler,
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

	fmt.Printf("Staq listening on http://%s\n", runtime.Config.Addr)
	fmt.Printf("Data dir: %s\n", runtime.Config.DataDir)
	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		return err
	}
	return nil
}
