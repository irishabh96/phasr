//go:build darwin

package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"sync"
	"syscall"
	"time"

	webview "github.com/webview/webview_go"

	"phasr/internal/app"
	"phasr/internal/config"
)

func main() {
	if err := run(); err != nil {
		log.Fatalf("phasr.sh desktop: %v", err)
	}
}

func run() error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}

	var (
		title  string
		width  int
		height int
		debug  bool
	)

	flag.StringVar(&cfg.Addr, "addr", cfg.Addr, "HTTP listen address")
	flag.StringVar(&cfg.DataDir, "data-dir", cfg.DataDir, "phasr.sh data directory")
	flag.StringVar(&cfg.DefaultEditor, "editor", cfg.DefaultEditor, "Default editor command (code/cursor/zed/vim/open)")
	flag.StringVar(&title, "title", "phasr.sh", "Desktop window title")
	flag.IntVar(&width, "width", 1500, "Desktop window width")
	flag.IntVar(&height, "height", 980, "Desktop window height")
	flag.BoolVar(&debug, "debug", false, "Enable webview devtools")
	flag.Parse()

	listener, resolvedAddr, addrNotice, err := listenDesktop(cfg.Addr)
	if err != nil {
		return err
	}
	defer listener.Close()
	cfg.Addr = resolvedAddr

	runtime, err := app.New(cfg)
	if err != nil {
		return err
	}

	srv := &http.Server{
		Handler:           runtime.Handler,
		ReadHeaderTimeout: 10 * time.Second,
	}

	serveErrCh := make(chan error, 1)
	go func() {
		if err := srv.Serve(listener); err != nil && err != http.ErrServerClosed {
			serveErrCh <- err
		}
		close(serveErrCh)
	}()

	var shutdownOnce sync.Once
	shutdown := func() {
		shutdownOnce.Do(func() {
			shutdownCtx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
			defer cancel()
			_ = srv.Shutdown(shutdownCtx)
		})
	}

	w := webview.New(debug)
	if w == nil {
		return fmt.Errorf("failed to initialize webview")
	}
	defer w.Destroy()
	w.SetTitle(title)
	w.SetSize(width, height, webview.HintNone)
	if err := w.Bind("desktopQuit", func() {
		w.Terminate()
		shutdown()
	}); err != nil {
		return fmt.Errorf("bind desktopQuit: %w", err)
	}
	w.Init(`
		window.addEventListener("keydown", (event) => {
			const key = String(event && event.key ? event.key : "").toLowerCase();
			if (!event.metaKey || event.ctrlKey || event.altKey || key !== "q") return;
			event.preventDefault();
			event.stopPropagation();
			if (typeof window.desktopQuit === "function") {
				window.desktopQuit().catch(() => {});
			}
		}, true);
	`)

	appURL := httpURL(listener.Addr().String())
	w.Navigate(appURL)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	go func() {
		<-ctx.Done()
		w.Terminate()
		shutdown()
	}()

	if strings.TrimSpace(addrNotice) != "" {
		fmt.Println(addrNotice)
	}
	fmt.Printf("phasr.sh desktop listening on %s\n", appURL)
	fmt.Printf("Data dir: %s\n", runtime.Config.DataDir)

	w.Run()
	shutdown()

	if err, ok := <-serveErrCh; ok && err != nil {
		return err
	}
	return nil
}

func httpURL(addr string) string {
	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		return "http://" + addr
	}
	if host == "" || host == "0.0.0.0" || host == "::" {
		host = "127.0.0.1"
	}
	return "http://" + net.JoinHostPort(host, port)
}

func listenDesktop(addr string) (net.Listener, string, string, error) {
	listener, err := net.Listen("tcp", addr)
	if err == nil {
		return listener, listener.Addr().String(), "", nil
	}
	if !isAddrInUse(err) {
		return nil, "", "", err
	}

	host, _, splitErr := net.SplitHostPort(addr)
	if splitErr != nil {
		host = ""
	}
	if host == "" || host == "0.0.0.0" || host == "::" {
		host = "127.0.0.1"
	}

	fallback := net.JoinHostPort(host, "0")
	fallbackListener, fallbackErr := net.Listen("tcp", fallback)
	if fallbackErr != nil {
		return nil, "", "", fmt.Errorf("listen %s: %w (fallback %s failed: %v)", addr, err, fallback, fallbackErr)
	}

	resolved := fallbackListener.Addr().String()
	notice := fmt.Sprintf("Address %s is in use; using %s", addr, resolved)
	return fallbackListener, resolved, notice, nil
}

func isAddrInUse(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, syscall.EADDRINUSE) {
		return true
	}
	return strings.Contains(strings.ToLower(err.Error()), "address already in use")
}
