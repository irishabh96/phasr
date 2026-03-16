package api

import (
	"encoding/json"
	"errors"
	"fmt"
	"html/template"
	"io/fs"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"staq/internal/localfs"
	"staq/internal/task"
)

type Options struct {
	TaskManager *task.Manager
	Address     string
}

type server struct {
	tasks      *task.Manager
	dashboardT *template.Template
	address    string
}

func NewServer(opts Options) (http.Handler, error) {
	if opts.TaskManager == nil {
		return nil, fmt.Errorf("task manager is required")
	}

	tmpl, err := template.ParseFS(templateFS, "templates/index.html")
	if err != nil {
		return nil, fmt.Errorf("parse dashboard template: %w", err)
	}

	s := &server{
		tasks:      opts.TaskManager,
		dashboardT: tmpl,
		address:    opts.Address,
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/", s.handleDashboard)
	staticSub, err := fs.Sub(staticFS, "static")
	if err != nil {
		return nil, fmt.Errorf("load static assets: %w", err)
	}
	staticHandler := http.StripPrefix("/static/", http.FileServer(http.FS(staticSub)))
	mux.Handle("/static/", withNoStore(staticHandler))
	mux.HandleFunc("/api/local/browse-directory", s.handleBrowseDirectory)
	mux.HandleFunc("/api/local/git-metadata", s.handleGitMetadata)
	mux.HandleFunc("/api/local/open-directory", s.handleOpenDirectory)
	mux.HandleFunc("/api/local/open-url", s.handleOpenURL)
	mux.HandleFunc("/api/local/validate-directory", s.handleValidateDirectory)
	mux.HandleFunc("/api/workspaces", s.handleWorkspaces)
	mux.HandleFunc("/api/workspaces/", s.handleWorkspaceByName)
	mux.HandleFunc("/api/presets", s.handlePresets)
	mux.HandleFunc("/api/tasks", s.handleTasks)
	mux.HandleFunc("/api/tasks/", s.handleTaskByID)
	return requestLog(mux), nil
}

func (s *server) handleDashboard(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/" {
		http.NotFound(w, r)
		return
	}
	if r.Method != http.MethodGet {
		methodNotAllowed(w)
		return
	}

	data := struct {
		Address string
	}{Address: s.address}

	if err := s.dashboardT.ExecuteTemplate(w, "index.html", data); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
	}
}

func (s *server) handlePresets(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"presets": s.tasks.Presets(),
	})
}

func (s *server) handleBrowseDirectory(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	path, err := localfs.BrowseDirectory()
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"path": path})
}

func (s *server) handleOpenDirectory(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}

	var payload struct {
		Path string `json:"path"`
	}
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	path := strings.TrimSpace(payload.Path)
	if path == "" {
		writeError(w, http.StatusBadRequest, "path is required")
		return
	}

	info, err := os.Stat(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			writeError(w, http.StatusBadRequest, "path does not exist")
			return
		}
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if !info.IsDir() {
		writeError(w, http.StatusBadRequest, "path is not a directory")
		return
	}

	if err := localfs.OpenDirectory(path); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"opened": path})
}

func (s *server) handleOpenURL(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}

	var payload struct {
		URL string `json:"url"`
	}
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	rawURL := strings.TrimSpace(payload.URL)
	if rawURL == "" {
		writeError(w, http.StatusBadRequest, "url is required")
		return
	}
	parsed, err := url.Parse(rawURL)
	if err != nil || parsed == nil || parsed.Host == "" {
		writeError(w, http.StatusBadRequest, "invalid url")
		return
	}
	scheme := strings.ToLower(strings.TrimSpace(parsed.Scheme))
	if scheme != "https" && scheme != "http" {
		writeError(w, http.StatusBadRequest, "only http/https urls are allowed")
		return
	}

	if err := localfs.OpenURL(rawURL); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"opened": rawURL})
}

func (s *server) handleValidateDirectory(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	var payload struct {
		Path string `json:"path"`
	}
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	path := strings.TrimSpace(payload.Path)
	if path == "" {
		writeJSON(w, http.StatusOK, map[string]any{
			"path":    "",
			"exists":  false,
			"is_dir":  false,
			"valid":   false,
			"message": "Path is required.",
		})
		return
	}

	info, err := os.Stat(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			writeJSON(w, http.StatusOK, map[string]any{
				"path":    path,
				"exists":  false,
				"is_dir":  false,
				"valid":   false,
				"message": "Path does not exist.",
			})
			return
		}
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	isDir := info.IsDir()
	message := ""
	if !isDir {
		message = "Path exists but is not a directory."
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"path":    path,
		"exists":  true,
		"is_dir":  isDir,
		"valid":   isDir,
		"message": message,
	})
}

func (s *server) handleWorkspaces(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		writeJSON(w, http.StatusOK, map[string]any{
			"workspaces": s.tasks.Workspaces(),
		})
	case http.MethodPost:
		var payload struct {
			Name     string `json:"name"`
			RepoPath string `json:"repo_path"`
			InitGit  bool   `json:"init_git"`
		}
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			writeError(w, http.StatusBadRequest, "invalid request body")
			return
		}
		workspace, err := s.tasks.CreateWorkspace(payload.Name, payload.RepoPath, payload.InitGit)
		if err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		writeJSON(w, http.StatusCreated, map[string]any{
			"workspace":  workspace,
			"workspaces": s.tasks.Workspaces(),
		})
	default:
		methodNotAllowed(w)
	}
}

func (s *server) handleTasks(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		writeJSON(w, http.StatusOK, map[string]any{"tasks": s.tasks.List()})
	case http.MethodPost:
		var req task.CreateRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "invalid request body")
			return
		}
		created, err := s.tasks.Create(req)
		if err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		writeJSON(w, http.StatusCreated, map[string]any{"task": created})
	default:
		methodNotAllowed(w)
	}
}

func (s *server) handleWorkspaceByName(w http.ResponseWriter, r *http.Request) {
	suffix := strings.TrimPrefix(r.URL.Path, "/api/workspaces/")
	suffix = strings.Trim(suffix, "/")
	if suffix == "" {
		http.NotFound(w, r)
		return
	}

	parts := strings.SplitN(suffix, "/", 2)
	workspaceID, err := url.PathUnescape(parts[0])
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid workspace path")
		return
	}
	action := ""
	if len(parts) > 1 {
		action = parts[1]
	}

	if action == "" {
		if r.Method != http.MethodDelete {
			methodNotAllowed(w)
			return
		}
		if err := s.tasks.DeleteWorkspace(workspaceID); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"deleted":    workspaceID,
			"workspaces": s.tasks.Workspaces(),
		})
		return
	}

	switch action {
	case "files":
		s.handleWorkspaceFiles(w, r, workspaceID)
	default:
		http.NotFound(w, r)
	}
}

func (s *server) handleTaskByID(w http.ResponseWriter, r *http.Request) {
	suffix := strings.TrimPrefix(r.URL.Path, "/api/tasks/")
	suffix = strings.Trim(suffix, "/")
	if suffix == "" {
		http.NotFound(w, r)
		return
	}

	parts := strings.Split(suffix, "/")
	id := parts[0]
	action := ""
	subaction := ""
	if len(parts) > 1 {
		action = parts[1]
	}
	if len(parts) > 2 {
		subaction = parts[2]
	}

	if action == "" {
		s.handleTaskRoot(w, r, id)
		return
	}

	switch action {
	case "stop":
		s.handleStopTask(w, r, id)
	case "resume":
		s.handleResumeTask(w, r, id)
	case "archive":
		s.handleArchiveTask(w, r, id)
	case "logs":
		s.handleTaskLogs(w, r, id)
	case "diff":
		s.handleTaskDiff(w, r, id)
	case "events":
		s.handleTaskEvents(w, r, id)
	case "open-editor":
		s.handleOpenEditor(w, r, id)
	case "terminal":
		s.handleTaskTerminal(w, r, id, subaction)
	case "git":
		s.handleTaskGit(w, r, id, subaction)
	case "files":
		s.handleTaskFiles(w, r, id)
	default:
		http.NotFound(w, r)
	}
}

func (s *server) handleTaskRoot(w http.ResponseWriter, r *http.Request, id string) {
	switch r.Method {
	case http.MethodGet:
		t, err := s.tasks.Get(id)
		if err != nil {
			writeError(w, http.StatusNotFound, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"task": t})
	case http.MethodDelete:
		if err := s.tasks.Delete(id); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"deleted": id})
	default:
		methodNotAllowed(w)
	}
}

func (s *server) handleStopTask(w http.ResponseWriter, r *http.Request, id string) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	force := r.URL.Query().Get("force") == "1"
	t, err := s.tasks.Stop(id, force)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"task": t})
}

func (s *server) handleResumeTask(w http.ResponseWriter, r *http.Request, id string) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	t, err := s.tasks.Start(id)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"task": t})
}

func (s *server) handleArchiveTask(w http.ResponseWriter, r *http.Request, id string) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	t, err := s.tasks.Archive(id)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"task": t})
}

func (s *server) handleTaskLogs(w http.ResponseWriter, r *http.Request, id string) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w)
		return
	}
	tail, _ := strconv.Atoi(r.URL.Query().Get("tail"))
	logs, err := s.tasks.Logs(id, tail)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"task_id": id, "logs": logs})
}

func (s *server) handleTaskDiff(w http.ResponseWriter, r *http.Request, id string) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w)
		return
	}
	file := r.URL.Query().Get("file")
	changes, stat, patch, err := s.tasks.Diff(id, file)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"task_id":       id,
		"selected_file": file,
		"changes":       changes,
		"stat":          stat,
		"patch":         patch,
	})
}

func (s *server) handleTaskEvents(w http.ResponseWriter, r *http.Request, id string) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w)
		return
	}

	if _, err := s.tasks.Get(id); err != nil {
		writeError(w, http.StatusNotFound, err.Error())
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")

	flusher, ok := w.(http.Flusher)
	if !ok {
		writeError(w, http.StatusInternalServerError, "streaming unsupported")
		return
	}

	logs, _ := s.tasks.LogTailBytes(id, 256*1024)
	bootstrap := map[string]any{"logs": logs}
	payload, _ := json.Marshal(bootstrap)
	_, _ = fmt.Fprintf(w, "event: bootstrap\ndata: %s\n\n", payload)
	flusher.Flush()

	events, cancel := s.tasks.Subscribe(id)
	defer cancel()

	pingTicker := time.NewTicker(15 * time.Second)
	defer pingTicker.Stop()

	for {
		select {
		case <-r.Context().Done():
			return
		case <-pingTicker.C:
			_, _ = w.Write([]byte(": ping\n\n"))
			flusher.Flush()
		case event := <-events:
			payload, err := json.Marshal(event)
			if err != nil {
				continue
			}
			_, _ = fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event.Type, payload)
			flusher.Flush()
		}
	}
}

func (s *server) handleOpenEditor(w http.ResponseWriter, r *http.Request, id string) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}

	var payload struct {
		Editor string `json:"editor"`
	}
	_ = json.NewDecoder(r.Body).Decode(&payload)

	if err := s.tasks.OpenInEditor(id, payload.Editor); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"opened": id, "editor": payload.Editor})
}

func (s *server) handleTaskTerminal(w http.ResponseWriter, r *http.Request, id, subaction string) {
	switch subaction {
	case "input":
		s.handleTerminalInput(w, r, id)
	case "resize":
		s.handleTerminalResize(w, r, id)
	case "interrupt":
		s.handleTerminalInterrupt(w, r, id)
	default:
		http.NotFound(w, r)
	}
}

func (s *server) handleTaskGit(w http.ResponseWriter, r *http.Request, id, subaction string) {
	switch subaction {
	case "status":
		s.handleGitStatus(w, r, id)
	case "stage":
		s.handleGitStage(w, r, id)
	case "unstage":
		s.handleGitUnstage(w, r, id)
	case "commit":
		s.handleGitCommit(w, r, id)
	case "commits":
		s.handleGitCommits(w, r, id)
	default:
		http.NotFound(w, r)
	}
}

func (s *server) handleTaskFiles(w http.ResponseWriter, r *http.Request, id string) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w)
		return
	}

	taskInfo, err := s.tasks.Get(id)
	if err != nil {
		writeError(w, http.StatusNotFound, err.Error())
		return
	}

	root := strings.TrimSpace(taskInfo.WorktreePath)
	if root == "" {
		root = strings.TrimSpace(taskInfo.RepoPath)
	}
	if root == "" {
		writeError(w, http.StatusBadRequest, "task repository path is missing")
		return
	}

	if info, err := os.Stat(root); err != nil || !info.IsDir() {
		writeError(w, http.StatusBadRequest, "task repository path is not a directory")
		return
	}

	entries, truncated, err := collectRepoFiles(root)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"task_id":   id,
		"root":      root,
		"entries":   entries,
		"truncated": truncated,
		"entries_n": len(entries),
	})
}

func (s *server) handleWorkspaceFiles(w http.ResponseWriter, r *http.Request, workspaceID string) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w)
		return
	}

	workspace, err := s.tasks.Workspace(workspaceID)
	if err != nil {
		writeError(w, http.StatusNotFound, err.Error())
		return
	}

	root := strings.TrimSpace(workspace.RepoPath)
	if root == "" {
		writeError(w, http.StatusBadRequest, "workspace repository path is missing")
		return
	}
	if info, err := os.Stat(root); err != nil || !info.IsDir() {
		writeError(w, http.StatusBadRequest, "workspace repository path is not a directory")
		return
	}

	entries, truncated, err := collectRepoFiles(root)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"workspace": workspace.ID,
		"root":      root,
		"entries":   entries,
		"truncated": truncated,
		"entries_n": len(entries),
	})
}

type repoFileItem struct {
	Path string `json:"path"`
	Kind string `json:"kind"`
}

func collectRepoFiles(root string) ([]repoFileItem, bool, error) {
	const maxEntries = 30000
	entries := make([]repoFileItem, 0, 1024)
	truncated := false

	err := filepath.WalkDir(root, func(path string, d fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return nil
		}
		if len(entries) >= maxEntries {
			truncated = true
			return fs.SkipAll
		}

		rel, relErr := filepath.Rel(root, path)
		if relErr != nil {
			return nil
		}
		rel = filepath.ToSlash(rel)
		if rel == "." {
			return nil
		}
		if d.IsDir() && d.Name() == ".git" {
			return filepath.SkipDir
		}

		kind := "file"
		if d.IsDir() {
			kind = "dir"
		}
		entries = append(entries, repoFileItem{Path: rel, Kind: kind})
		return nil
	})
	if err != nil && err != fs.SkipAll {
		return nil, truncated, err
	}

	sort.Slice(entries, func(i, j int) bool {
		if entries[i].Path == entries[j].Path {
			return entries[i].Kind < entries[j].Kind
		}
		return entries[i].Path < entries[j].Path
	})

	return entries, truncated, nil
}

func (s *server) handleGitStatus(w http.ResponseWriter, r *http.Request, id string) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w)
		return
	}
	status, err := s.tasks.GitStatus(id)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"task_id":   id,
		"staged":    status.Staged,
		"unstaged":  status.Unstaged,
		"staged_n":  len(status.Staged),
		"changes_n": len(status.Staged) + len(status.Unstaged),
	})
}

func (s *server) handleGitStage(w http.ResponseWriter, r *http.Request, id string) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	var payload struct {
		Path string `json:"path"`
	}
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if err := s.tasks.StageFile(id, payload.Path); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"task_id": id, "staged": payload.Path})
}

func (s *server) handleGitUnstage(w http.ResponseWriter, r *http.Request, id string) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	var payload struct {
		Path string `json:"path"`
	}
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if err := s.tasks.UnstageFile(id, payload.Path); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"task_id": id, "unstaged": payload.Path})
}

func (s *server) handleGitCommit(w http.ResponseWriter, r *http.Request, id string) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	var payload struct {
		Message string `json:"message"`
	}
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	out, err := s.tasks.Commit(id, payload.Message)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"task_id": id,
		"commit":  out,
	})
}

func (s *server) handleGitCommits(w http.ResponseWriter, r *http.Request, id string) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w)
		return
	}

	commits, total, err := s.tasks.GitCommits(id)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"task_id":       id,
		"commits":       commits,
		"commits_n":     len(commits),
		"commits_total": total,
	})
}

func (s *server) handleTerminalInput(w http.ResponseWriter, r *http.Request, id string) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}

	var payload struct {
		Input         string `json:"input"`
		AppendNewline bool   `json:"append_newline"`
	}
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	input := payload.Input
	if payload.AppendNewline {
		input += "\n"
	}
	if input == "" {
		writeError(w, http.StatusBadRequest, "input is required")
		return
	}

	if err := s.tasks.SendInput(id, input); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"task_id": id, "sent": len(input)})
}

func (s *server) handleTerminalResize(w http.ResponseWriter, r *http.Request, id string) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}

	var payload struct {
		Cols uint16 `json:"cols"`
		Rows uint16 `json:"rows"`
	}
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	if err := s.tasks.ResizeTerminal(id, payload.Cols, payload.Rows); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"task_id": id,
		"cols":    payload.Cols,
		"rows":    payload.Rows,
	})
}

func (s *server) handleTerminalInterrupt(w http.ResponseWriter, r *http.Request, id string) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	if err := s.tasks.Interrupt(id); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"task_id": id, "interrupted": true})
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

func writeError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]any{"error": message})
}

func methodNotAllowed(w http.ResponseWriter) {
	writeError(w, http.StatusMethodNotAllowed, "method not allowed")
}

func requestLog(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		next.ServeHTTP(w, r)
		log.Printf("%s %s (%s)", r.Method, r.URL.Path, time.Since(start).Round(time.Millisecond))
	})
}

func withNoStore(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store, no-cache, must-revalidate")
		w.Header().Set("Pragma", "no-cache")
		w.Header().Set("Expires", "0")
		next.ServeHTTP(w, r)
	})
}
