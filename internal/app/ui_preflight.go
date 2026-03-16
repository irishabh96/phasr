package app

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const skipUIBuildCheckEnv = "STAQ_SKIP_UI_BUILD_CHECK"

func ensureUIBundleFresh() error {
	if strings.TrimSpace(os.Getenv(skipUIBuildCheckEnv)) == "1" {
		return nil
	}

	repoRoot, ok := findRepoRoot()
	if !ok {
		// Running outside repository context (for example packaged binary).
		return nil
	}

	frontendSrcDir := filepath.Join(repoRoot, "internal", "api", "frontend", "src")
	frontendScriptsDir := filepath.Join(repoRoot, "internal", "api", "frontend", "scripts")
	frontendPkgJSON := filepath.Join(repoRoot, "internal", "api", "frontend", "package.json")
	distDir := filepath.Join(repoRoot, "internal", "api", "static", "dist")

	if _, err := os.Stat(frontendSrcDir); errors.Is(err, os.ErrNotExist) {
		return nil
	}

	requiredDist := []string{
		filepath.Join(distDir, "react-ui.js"),
		filepath.Join(distDir, "build-meta.json"),
		filepath.Join(distDir, "build-meta.js"),
	}

	distOldest := time.Time{}
	for _, path := range requiredDist {
		info, err := os.Stat(path)
		if err != nil {
			return fmt.Errorf("missing frontend build artifact %q; run `make ui-build` before starting the app", filepath.Base(path))
		}
		if distOldest.IsZero() || info.ModTime().Before(distOldest) {
			distOldest = info.ModTime()
		}
	}

	srcLatest := time.Time{}
	for _, p := range []string{frontendSrcDir, frontendScriptsDir, frontendPkgJSON} {
		mt, err := latestModTime(p)
		if err != nil {
			return err
		}
		if mt.After(srcLatest) {
			srcLatest = mt
		}
	}

	if srcLatest.After(distOldest) {
		return fmt.Errorf(
			"frontend sources are newer than compiled UI bundle; run `make ui-build` (or `make build` / `make desktop-build`) before starting the app",
		)
	}

	return nil
}

func findRepoRoot() (string, bool) {
	candidates := make([]string, 0, 2)
	if cwd, err := os.Getwd(); err == nil && strings.TrimSpace(cwd) != "" {
		candidates = append(candidates, cwd)
	}
	if exePath, err := os.Executable(); err == nil && strings.TrimSpace(exePath) != "" {
		candidates = append(candidates, filepath.Dir(exePath))
	}

	for _, start := range candidates {
		if root, ok := walkUpForRepoRoot(start); ok {
			return root, true
		}
	}
	return "", false
}

func walkUpForRepoRoot(start string) (string, bool) {
	dir := filepath.Clean(start)
	for {
		if pathExists(filepath.Join(dir, "go.mod")) &&
			pathExists(filepath.Join(dir, "internal", "api", "frontend", "package.json")) {
			return dir, true
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return "", false
		}
		dir = parent
	}
}

func latestModTime(path string) (time.Time, error) {
	info, err := os.Stat(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return time.Time{}, nil
		}
		return time.Time{}, fmt.Errorf("stat %s: %w", path, err)
	}

	if !info.IsDir() {
		return info.ModTime(), nil
	}

	latest := info.ModTime()
	err = filepath.WalkDir(path, func(walkPath string, d fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if d.IsDir() {
			return nil
		}
		fileInfo, err := d.Info()
		if err != nil {
			return err
		}
		if fileInfo.ModTime().After(latest) {
			latest = fileInfo.ModTime()
		}
		return nil
	})
	if err != nil {
		return time.Time{}, fmt.Errorf("walk %s: %w", path, err)
	}
	return latest, nil
}

func pathExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}
