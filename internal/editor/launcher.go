package editor

import (
	"fmt"
	"os/exec"
	"strings"
)

type Launcher struct {
	defaultEditor string
}

func NewLauncher(defaultEditor string) *Launcher {
	if strings.TrimSpace(defaultEditor) == "" {
		defaultEditor = "code"
	}
	return &Launcher{defaultEditor: defaultEditor}
}

func (l *Launcher) Open(editorName, workspacePath string) error {
	editorName = strings.TrimSpace(editorName)
	if editorName == "" {
		editorName = l.defaultEditor
	}

	command := buildCommand(editorName, workspacePath)
	cmd := exec.Command("zsh", "-lc", command)
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("launch editor command %q: %w", command, err)
	}
	return nil
}

func buildCommand(editorName, workspacePath string) string {
	switch editorName {
	case "code", "cursor", "zed", "vim", "nvim", "subl":
		return fmt.Sprintf("%s %q", editorName, workspacePath)
	case "open", "finder":
		return fmt.Sprintf("open %q", workspacePath)
	}

	if strings.Contains(editorName, "{path}") {
		return strings.ReplaceAll(editorName, "{path}", shellQuote(workspacePath))
	}
	return fmt.Sprintf("%s %q", editorName, workspacePath)
}

func shellQuote(value string) string {
	return fmt.Sprintf("%q", value)
}
