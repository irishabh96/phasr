package api

import (
	"encoding/json"
	"fmt"
	"html/template"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"

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

	logs, _ := s.tasks.Logs(id, 80)
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
	default:
		http.NotFound(w, r)
	}
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
