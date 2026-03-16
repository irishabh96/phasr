//go:build darwin

package localfs

import (
	"fmt"
	"os/exec"
	"strings"
)

func BrowseDirectory() (string, error) {
	primaryScript := `POSIX path of (choose folder with prompt "Select a git repository folder")`
	path, err := runAppleScript(primaryScript)
	if err == nil {
		return path, nil
	}

	// Retry once after foregrounding Finder; some macOS sessions incorrectly
	// dismiss `choose folder` unless a GUI app is active.
	retryScript := `tell application "Finder" to activate
POSIX path of (choose folder with prompt "Select a git repository folder")`
	path, retryErr := runAppleScript(retryScript)
	if retryErr == nil {
		return path, nil
	}

	// Fallback to native NSOpenPanel via Swift CLI if AppleScript fails.
	path, swiftErr := runSwiftDirectoryPicker()
	if swiftErr == nil {
		return path, nil
	}

	return "", fmt.Errorf("browse directory failed: %v; fallback failed: %v", err, swiftErr)
}

func OpenDirectory(path string) error {
	path = strings.TrimSpace(path)
	if path == "" {
		return fmt.Errorf("path is required")
	}
	cmd := exec.Command("open", path)
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("open directory %q: %w", path, err)
	}
	return nil
}

func OpenURL(target string) error {
	target = strings.TrimSpace(target)
	if target == "" {
		return fmt.Errorf("url is required")
	}
	cmd := exec.Command("open", target)
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("open url %q: %w", target, err)
	}
	return nil
}

func OpenInIDE(path, ide string) error {
	path = strings.TrimSpace(path)
	if path == "" {
		return fmt.Errorf("path is required")
	}
	ide = strings.TrimSpace(ide)
	if ide == "" {
		return fmt.Errorf("ide is required")
	}

	validateCmd := exec.Command("open", "-Ra", ide)
	if out, err := validateCmd.CombinedOutput(); err != nil {
		msg := strings.TrimSpace(string(out))
		if msg == "" {
			msg = strings.TrimSpace(err.Error())
		}
		if msg == "" {
			msg = fmt.Sprintf("Unable to find application named %q", ide)
		}
		return fmt.Errorf("%s", msg)
	}

	cmd := exec.Command("open", "-a", ide, path)
	if out, err := cmd.CombinedOutput(); err != nil {
		msg := strings.TrimSpace(string(out))
		if msg == "" {
			msg = strings.TrimSpace(err.Error())
		}
		if msg == "" {
			msg = fmt.Sprintf("failed to open path in %q", ide)
		}
		return fmt.Errorf("%s", msg)
	}
	return nil
}

func OpenInTerminal(path string) error {
	return OpenInIDE(path, "Terminal")
}

func runAppleScript(script string) (string, error) {
	out, err := exec.Command("osascript", "-e", script).CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("%w (%s)", err, strings.TrimSpace(string(out)))
	}
	path := strings.TrimSpace(string(out))
	if path == "" {
		return "", fmt.Errorf("no folder selected")
	}
	return path, nil
}

func runSwiftDirectoryPicker() (string, error) {
	swiftCode := `
import AppKit
let panel = NSOpenPanel()
panel.canChooseDirectories = true
panel.canChooseFiles = false
panel.allowsMultipleSelection = false
panel.canCreateDirectories = true
panel.title = "Select Folder"
panel.message = "Select a git repository folder"
let result = panel.runModal()
if result == .OK, let url = panel.url {
  print(url.path)
  exit(0)
}
fputs("selection dismissed", stderr)
exit(1)
`
	out, err := exec.Command("swift", "-e", swiftCode).CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("%w (%s)", err, strings.TrimSpace(string(out)))
	}
	path := strings.TrimSpace(string(out))
	if path == "" {
		return "", fmt.Errorf("no folder selected")
	}
	return path, nil
}
