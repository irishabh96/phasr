package task

import (
	"bufio"
	"bytes"
	"errors"
	"fmt"
	"math/rand"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"phasr/internal/diff"
	"phasr/internal/domain"
	"phasr/internal/editor"
	"phasr/internal/gitops"
	"phasr/internal/preset"
	"phasr/internal/process"
	"phasr/internal/store"
)

type Options struct {
	Store          *store.TaskStore
	WorkspaceStore *store.WorkspaceStore
	Process        *process.Manager
	Worktree       *gitops.WorktreeManager
	Diff           *diff.Service
	Presets        *preset.Manager
	Editor         *editor.Launcher
	LogsDir        string
}

type CreateRequest struct {
	Name       string   `json:"name"`
	Workspace  string   `json:"workspace"`
	Tags       []string `json:"tags"`
	RepoPath   string   `json:"repo_path"`
	Prompt     string   `json:"prompt"`
	Command    string   `json:"command"`
	Preset     string   `json:"preset"`
	DirectRepo bool     `json:"direct_repo"`
	RootTaskID string   `json:"root_task_id"`
	Cols       uint16   `json:"cols"`
	Rows       uint16   `json:"rows"`
}

type Manager struct {
	mu             sync.RWMutex
	tasks          map[string]*domain.Task
	store          *store.TaskStore
	workspaceStore *store.WorkspaceStore
	workspaces     map[string]domain.Workspace
	process        *process.Manager
	worktree       *gitops.WorktreeManager
	diffs          *diff.Service
	presets        *preset.Manager
	editor         *editor.Launcher
	logsDir        string
}

func NewManager(opts Options) (*Manager, error) {
	if opts.Store == nil || opts.WorkspaceStore == nil || opts.Process == nil || opts.Worktree == nil || opts.Diff == nil || opts.Presets == nil || opts.Editor == nil {
		return nil, errors.New("task manager options are incomplete")
	}

	storedTasks, err := opts.Store.Load()
	if err != nil {
		return nil, err
	}
	storedWorkspaces, err := opts.WorkspaceStore.Load()
	if err != nil {
		return nil, err
	}

	m := &Manager{
		tasks:          map[string]*domain.Task{},
		store:          opts.Store,
		workspaceStore: opts.WorkspaceStore,
		workspaces:     map[string]domain.Workspace{},
		process:        opts.Process,
		worktree:       opts.Worktree,
		diffs:          opts.Diff,
		presets:        opts.Presets,
		editor:         opts.Editor,
		logsDir:        opts.LogsDir,
	}

	for _, workspace := range storedWorkspaces {
		m.ensureWorkspaceLocked(workspace)
	}

	mutated := false
	restartTaskIDs := make([]string, 0, 8)
	for i := range storedTasks {
		t := storedTasks[i]
		t.Workspace = normalizedWorkspace(t.Workspace)
		if t.Workspace == "" {
			t.Workspace = defaultWorkspace
			mutated = true
		}
		if strings.TrimSpace(t.RootTaskID) == "" {
			t.RootTaskID = t.ID
			mutated = true
		}
		if m.ensureWorkspaceLocked(domain.Workspace{Name: t.Workspace}) {
			mutated = true
		}
		if t.Status == domain.StatusRunning {
			restartTaskIDs = append(restartTaskIDs, t.ID)
		}
		copyTask := t
		m.tasks[t.ID] = &copyTask
	}
	if mutated {
		if err := m.persistLocked(); err != nil {
			return nil, err
		}
		if err := m.persistWorkspacesLocked(); err != nil {
			return nil, err
		}
	}

	opts.Process.SetExitHandler(m.handleExit)

	for _, taskID := range restartTaskIDs {
		// Best-effort restore: revive tasks that were persisted as running.
		if err := m.startInternal(taskID, false, 0, 0, true); err != nil {
			m.mu.Lock()
			if t, ok := m.tasks[taskID]; ok {
				t.Status = domain.StatusFailed
				now := time.Now().UTC()
				t.UpdatedAt = now
				t.FinishedAt = &now
				t.LastError = "failed to restore after server restart: " + err.Error()
				_ = m.persistLocked()
			}
			m.mu.Unlock()
		}
	}

	return m, nil
}

func (m *Manager) Create(req CreateRequest) (domain.Task, error) {
	if strings.TrimSpace(req.Command) == "" {
		return domain.Task{}, errors.New("command is required")
	}

	rootTaskID := strings.TrimSpace(req.RootTaskID)
	var rootTask *domain.Task
	if rootTaskID != "" {
		m.mu.RLock()
		root, ok := m.tasks[rootTaskID]
		if ok {
			copy := tCopy(*root)
			rootTask = &copy
		}
		m.mu.RUnlock()
		if rootTask == nil {
			return domain.Task{}, fmt.Errorf("root task %q not found", rootTaskID)
		}
	}

	workspaceName := normalizedWorkspace(req.Workspace)
	if workspaceName == "" && rootTask != nil {
		workspaceName = normalizedWorkspace(rootTask.Workspace)
	}
	if workspaceName == "" {
		return domain.Task{}, errors.New("workspace is required")
	}
	repoInput := strings.TrimSpace(req.RepoPath)
	directRepo := req.DirectRepo
	if rootTask != nil {
		// Tabs under an existing task must reuse the same worktree/repo.
		directRepo = true
		repoInput = strings.TrimSpace(rootTask.WorktreePath)
		if repoInput == "" {
			repoInput = strings.TrimSpace(rootTask.RepoPath)
		}
	}
	if repoInput == "" {
		m.mu.RLock()
		workspace, ok := m.workspaces[strings.ToLower(workspaceName)]
		m.mu.RUnlock()
		if ok && strings.TrimSpace(workspace.RepoPath) != "" {
			repoInput = workspace.RepoPath
		}
	}
	if repoInput == "" {
		return domain.Task{}, errors.New("repo_path is required (or configure repo on workspace)")
	}

	repoPath, err := absAndExpand(repoInput)
	if err != nil {
		return domain.Task{}, err
	}

	taskID := newTaskID()
	taskName := strings.TrimSpace(req.Name)
	if taskName == "" {
		taskName = "task-" + taskID[:6]
	}

	var (
		branch       string
		worktreePath string
	)

	if directRepo {
		branch = currentRepoBranch(repoPath)
		worktreePath = repoPath
	} else {
		// Repos without a commit cannot produce a usable detached worktree with tracked files.
		// Fall back to running directly in repo so files remain visible/editable.
		if !repoHasCommits(repoPath) {
			directRepo = true
			branch = currentRepoBranch(repoPath)
			worktreePath = repoPath
		} else {
			branch, worktreePath, err = m.worktree.Create(repoPath, taskName, taskID)
			if err != nil {
				return domain.Task{}, err
			}
		}
	}

	now := time.Now().UTC()
	workspace := workspaceName
	if rootTaskID == "" {
		rootTaskID = taskID
	}
	t := &domain.Task{
		ID:             taskID,
		RootTaskID:     rootTaskID,
		Name:           taskName,
		Workspace:      workspace,
		Tags:           normalizedTags(req.Tags),
		DirectRepo:     directRepo,
		RepoPath:       repoPath,
		Branch:         branch,
		WorktreePath:   worktreePath,
		Prompt:         strings.TrimSpace(req.Prompt),
		Command:        strings.TrimSpace(req.Command),
		CurrentCommand: strings.TrimSpace(req.Command),
		Preset:         normalizedPreset(req.Preset),
		Status:         domain.StatusPending,
		LogFile:        filepath.Join(m.logsDir, taskID+".log"),
		CreatedAt:      now,
		UpdatedAt:      now,
	}

	m.mu.Lock()
	m.ensureWorkspaceLocked(domain.Workspace{Name: workspace, RepoPath: repoPath})
	m.tasks[t.ID] = t
	if err := m.persistLocked(); err != nil {
		m.mu.Unlock()
		return domain.Task{}, err
	}
	if err := m.persistWorkspacesLocked(); err != nil {
		m.mu.Unlock()
		return domain.Task{}, err
	}
	m.mu.Unlock()

	if err := m.start(t.ID, true, req.Cols, req.Rows); err != nil {
		m.mu.Lock()
		t.Status = domain.StatusFailed
		t.LastError = err.Error()
		t.UpdatedAt = time.Now().UTC()
		_ = m.persistLocked()
		m.mu.Unlock()
		return tCopy(*t), err
	}

	return m.Get(t.ID)
}

func (m *Manager) Start(id string) (domain.Task, error) {
	if err := m.start(id, false, 0, 0); err != nil {
		return domain.Task{}, err
	}
	return m.Get(id)
}

func (m *Manager) start(id string, includePresetSetup bool, cols, rows uint16) error {
	return m.startInternal(id, includePresetSetup, cols, rows, false)
}

func (m *Manager) startInternal(id string, includePresetSetup bool, cols, rows uint16, allowRestoreRunning bool) error {
	m.mu.Lock()
	t, ok := m.tasks[id]
	if !ok {
		m.mu.Unlock()
		return fmt.Errorf("task %s not found", id)
	}
	if t.Status == domain.StatusArchived {
		m.mu.Unlock()
		return errors.New("archived task cannot be resumed")
	}
	if t.Status == domain.StatusRunning {
		if !allowRestoreRunning {
			m.mu.Unlock()
			return errors.New("task already running")
		}
		if m.process.IsRunning(id) {
			m.mu.Unlock()
			return errors.New("task already running")
		}
	}

	command := t.Command
	promptSeed := strings.TrimSpace(t.Prompt)
	if inlineCommand, ok := appendPromptAsArgument(command, promptSeed); ok {
		command = inlineCommand
		promptSeed = ""
	}
	keepShellAlive := shouldKeepShellAlive(command)
	worktreePath := t.WorktreePath
	logFile := t.LogFile
	preCommands := []string{}
	if includePresetSetup && t.Preset != "" && t.Preset != "none" {
		preset, ok := m.presets.Get(t.Preset)
		if !ok {
			m.mu.Unlock()
			return fmt.Errorf("preset %q not found", t.Preset)
		}
		preCommands = append(preCommands, preset.SetupCommands...)
	}
	m.mu.Unlock()

	pid, err := m.process.Start(process.StartSpec{
		TaskID:         id,
		Command:        command,
		WorkDir:        worktreePath,
		LogFile:        logFile,
		PreCommands:    preCommands,
		KeepShellAlive: keepShellAlive,
		Cols:           cols,
		Rows:           rows,
	})
	if err != nil {
		return err
	}

	now := time.Now().UTC()
	m.mu.Lock()
	t.PID = pid
	t.Status = domain.StatusRunning
	t.ExitCode = nil
	t.LastError = ""
	t.StartedAt = &now
	t.FinishedAt = nil
	t.UpdatedAt = now
	err = m.persistLocked()
	m.mu.Unlock()
	if err != nil {
		return err
	}

	if promptSeed != "" {
		go m.deliverPromptWhenReady(id, promptSeed)
	}
	return nil
}

func appendPromptAsArgument(command, prompt string) (string, bool) {
	baseCommand := strings.TrimSpace(command)
	basePrompt := strings.TrimSpace(prompt)
	if baseCommand == "" || basePrompt == "" {
		return "", false
	}

	parts := strings.Fields(baseCommand)
	if len(parts) == 0 {
		return "", false
	}

	binary := strings.ToLower(filepath.Base(parts[0]))
	switch binary {
	case "codex", "claude", "gemini":
		// These CLIs support an initial prompt argument; passing it inline avoids
		// PTY timing races at startup.
		return baseCommand + " " + shellQuoteArg(basePrompt), true
	default:
		return "", false
	}
}

func shouldKeepShellAlive(command string) bool {
	baseCommand := strings.TrimSpace(command)
	if baseCommand == "" {
		return false
	}

	parts := strings.Fields(baseCommand)
	if len(parts) == 0 {
		return false
	}

	binary := strings.ToLower(filepath.Base(parts[0]))
	switch binary {
	case "codex", "claude", "gemini", "copilot", "opencode":
		return true
	default:
		return false
	}
}

func shellQuoteArg(value string) string {
	// Single-quote shell escaping: abc'def -> 'abc'"'"'def'
	return "'" + strings.ReplaceAll(value, "'", `'"'"'`) + "'"
}

func (m *Manager) deliverPromptWhenReady(taskID, prompt string) {
	seed := strings.TrimSpace(prompt)
	if seed == "" {
		return
	}

	events, cancel := m.process.Subscribe(taskID)
	defer cancel()

	timeout := time.NewTimer(12 * time.Second)
	defer timeout.Stop()

	for {
		select {
		case event := <-events:
			if event.Type == process.EventLog {
				if m.process.IsRunning(taskID) {
					_ = m.process.WriteInput(taskID, seed+"\n")
				}
				return
			}
		case <-timeout.C:
			// Fallback in case startup produced no logs yet.
			if m.process.IsRunning(taskID) {
				_ = m.process.WriteInput(taskID, seed+"\n")
			}
			return
		}
	}
}

func (m *Manager) Stop(id string, force bool) (domain.Task, error) {
	m.mu.Lock()
	t, ok := m.tasks[id]
	if !ok {
		m.mu.Unlock()
		return domain.Task{}, fmt.Errorf("task %s not found", id)
	}
	m.mu.Unlock()

	if err := m.process.Stop(id, force); err != nil {
		return domain.Task{}, err
	}

	now := time.Now().UTC()
	m.mu.Lock()
	t.Status = domain.StatusStopped
	t.PID = 0
	t.FinishedAt = &now
	t.UpdatedAt = now
	if err := m.persistLocked(); err != nil {
		m.mu.Unlock()
		return domain.Task{}, err
	}
	copy := tCopy(*t)
	m.mu.Unlock()
	return copy, nil
}

func (m *Manager) Archive(id string) (domain.Task, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	t, ok := m.tasks[id]
	if !ok {
		return domain.Task{}, fmt.Errorf("task %s not found", id)
	}
	if t.Status == domain.StatusRunning {
		return domain.Task{}, errors.New("stop task before archiving")
	}

	now := time.Now().UTC()
	t.Status = domain.StatusArchived
	t.ArchivedAt = &now
	t.UpdatedAt = now
	if err := m.persistLocked(); err != nil {
		return domain.Task{}, err
	}
	return tCopy(*t), nil
}

func (m *Manager) Delete(id string) error {
	m.mu.RLock()
	t, ok := m.tasks[id]
	if !ok {
		m.mu.RUnlock()
		return fmt.Errorf("task %s not found", id)
	}
	copy := tCopy(*t)
	m.mu.RUnlock()

	_ = m.process.Stop(id, true)
	if !copy.DirectRepo {
		if err := m.worktree.Remove(copy.RepoPath, copy.WorktreePath, true); err != nil {
			// Fallback cleanup for stale or detached registrations: if this is a
			// managed local worktree path, remove it directly from disk.
			if cleanupErr := m.worktree.RemoveManagedPath(copy.WorktreePath); cleanupErr != nil {
				return err
			}
		}
	}
	if err := m.worktree.RemoveManagedPath(copy.WorktreePath); err != nil {
		return err
	}
	_ = os.Remove(copy.LogFile)

	m.mu.Lock()
	delete(m.tasks, id)
	if err := m.persistLocked(); err != nil {
		m.mu.Unlock()
		return err
	}
	m.mu.Unlock()
	return nil
}

func (m *Manager) OpenInEditor(id, editorName string) error {
	t, err := m.Get(id)
	if err != nil {
		return err
	}
	return m.editor.Open(editorName, t.WorktreePath)
}

func (m *Manager) Get(id string) (domain.Task, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()

	t, ok := m.tasks[id]
	if !ok {
		return domain.Task{}, fmt.Errorf("task %s not found", id)
	}
	return tCopy(*t), nil
}

func (m *Manager) List() []domain.Task {
	m.mu.RLock()
	defer m.mu.RUnlock()

	items := make([]domain.Task, 0, len(m.tasks))
	for _, t := range m.tasks {
		items = append(items, tCopy(*t))
	}
	sort.Slice(items, func(i, j int) bool {
		return items[i].UpdatedAt.After(items[j].UpdatedAt)
	})
	return items
}

func (m *Manager) Presets() []preset.Preset {
	return m.presets.List()
}

func (m *Manager) Workspaces() []domain.Workspace {
	m.mu.RLock()
	defer m.mu.RUnlock()

	items := make([]domain.Workspace, 0, len(m.workspaces))
	for _, workspace := range m.workspaces {
		items = append(items, workspace)
	}
	sort.Slice(items, func(i, j int) bool {
		if items[i].UpdatedAt.Equal(items[j].UpdatedAt) {
			return strings.ToLower(items[i].Name) < strings.ToLower(items[j].Name)
		}
		return items[i].UpdatedAt.After(items[j].UpdatedAt)
	})
	return items
}

func (m *Manager) Workspace(workspaceID string) (domain.Workspace, error) {
	targetID := strings.TrimSpace(workspaceID)
	if targetID == "" {
		return domain.Workspace{}, errors.New("workspace id is required")
	}

	m.mu.RLock()
	defer m.mu.RUnlock()
	for _, workspace := range m.workspaces {
		if strings.EqualFold(strings.TrimSpace(workspace.ID), targetID) {
			return workspace, nil
		}
	}
	return domain.Workspace{}, fmt.Errorf("workspace %q not found", targetID)
}

func (m *Manager) CreateWorkspace(name, repoPath string, initGit bool) (domain.Workspace, error) {
	workspaceName := normalizedWorkspace(name)
	if workspaceName == "" {
		return domain.Workspace{}, errors.New("workspace name is required")
	}

	repoPath = strings.TrimSpace(repoPath)
	if repoPath == "" {
		return domain.Workspace{}, errors.New("repo_path is required")
	}
	absRepoPath, err := absAndExpand(repoPath)
	if err != nil {
		return domain.Workspace{}, err
	}
	if err := ensureGitRepo(absRepoPath); err != nil {
		if initGit {
			if initErr := initGitRepo(absRepoPath); initErr != nil {
				return domain.Workspace{}, initErr
			}
		} else {
			return domain.Workspace{}, err
		}
	}

	m.mu.Lock()
	defer m.mu.Unlock()

	canonicalRepoPath := strings.ToLower(filepath.Clean(absRepoPath))
	for key, existing := range m.workspaces {
		sameName := strings.EqualFold(strings.TrimSpace(existing.Name), workspaceName)
		sameRepo := strings.TrimSpace(existing.RepoPath) != "" &&
			strings.EqualFold(filepath.Clean(existing.RepoPath), canonicalRepoPath)
		if !sameName && !sameRepo {
			continue
		}

		mutated := false
		now := time.Now().UTC()
		if existing.CreatedAt.IsZero() {
			existing.CreatedAt = now
			mutated = true
		}
		if existing.UpdatedAt.IsZero() {
			existing.UpdatedAt = existing.CreatedAt
			mutated = true
		}
		if strings.TrimSpace(existing.RepoPath) == "" {
			existing.RepoPath = absRepoPath
			existing.UpdatedAt = now
			mutated = true
		}
		if mutated {
			m.workspaces[key] = existing
			if err := m.persistWorkspacesLocked(); err != nil {
				return domain.Workspace{}, err
			}
		}
		return existing, nil
	}

	now := time.Now().UTC()
	workspace := domain.Workspace{
		ID:        newWorkspaceID(workspaceName),
		Name:      workspaceName,
		RepoPath:  absRepoPath,
		CreatedAt: now,
		UpdatedAt: now,
	}

	m.ensureWorkspaceLocked(workspace)
	if err := m.persistWorkspacesLocked(); err != nil {
		return domain.Workspace{}, err
	}
	return workspace, nil
}

func (m *Manager) DeleteWorkspace(workspaceID string) error {
	targetID := strings.TrimSpace(workspaceID)
	if targetID == "" {
		return errors.New("workspace id is required")
	}

	m.mu.RLock()
	var target domain.Workspace
	found := false
	taskIDs := make([]string, 0)
	for _, workspace := range m.workspaces {
		if strings.EqualFold(strings.TrimSpace(workspace.ID), targetID) {
			target = workspace
			found = true
			break
		}
	}
	if found {
		for _, task := range m.tasks {
			if strings.EqualFold(strings.TrimSpace(task.Workspace), target.Name) {
				taskIDs = append(taskIDs, task.ID)
			}
		}
	}
	m.mu.RUnlock()

	if !found {
		return fmt.Errorf("workspace %q not found", targetID)
	}

	for _, id := range taskIDs {
		if err := m.Delete(id); err != nil {
			return fmt.Errorf("delete task %q while deleting workspace: %w", id, err)
		}
	}

	m.mu.Lock()
	delete(m.workspaces, strings.ToLower(target.Name))
	if err := m.persistWorkspacesLocked(); err != nil {
		m.mu.Unlock()
		return err
	}
	m.mu.Unlock()
	return nil
}

func (m *Manager) Diff(id, file string) ([]diff.Change, string, string, error) {
	t, err := m.Get(id)
	if err != nil {
		return nil, "", "", err
	}

	changes, stat, err := m.diffs.Summary(t.WorktreePath)
	if err != nil {
		return nil, "", "", err
	}
	patch, err := m.diffs.Patch(t.WorktreePath, file)
	if err != nil {
		return nil, "", "", err
	}
	return changes, stat, patch, nil
}

func (m *Manager) GitStatus(id string) (diff.GitStatus, error) {
	t, err := m.Get(id)
	if err != nil {
		return diff.GitStatus{}, err
	}
	return m.diffs.WorkingTreeStatus(t.WorktreePath)
}

func (m *Manager) StageFile(id, path string) error {
	t, err := m.Get(id)
	if err != nil {
		return err
	}
	return m.diffs.StageFile(t.WorktreePath, path)
}

func (m *Manager) UnstageFile(id, path string) error {
	t, err := m.Get(id)
	if err != nil {
		return err
	}
	return m.diffs.UnstageFile(t.WorktreePath, path)
}

func (m *Manager) DiscardFile(id, path string) error {
	t, err := m.Get(id)
	if err != nil {
		return err
	}
	return m.diffs.DiscardFile(t.WorktreePath, path)
}

func (m *Manager) Commit(id, message string) (string, error) {
	t, err := m.Get(id)
	if err != nil {
		return "", err
	}
	return m.diffs.Commit(t.WorktreePath, message)
}

func (m *Manager) Push(id string) (string, error) {
	t, err := m.Get(id)
	if err != nil {
		return "", err
	}
	return m.diffs.Push(t.WorktreePath)
}

func (m *Manager) Pull(id string) (string, error) {
	t, err := m.Get(id)
	if err != nil {
		return "", err
	}
	return m.diffs.Pull(t.WorktreePath)
}

func (m *Manager) Fetch(id string) (string, error) {
	t, err := m.Get(id)
	if err != nil {
		return "", err
	}
	return m.diffs.Fetch(t.WorktreePath)
}

func (m *Manager) GitCommits(id string) ([]diff.CommitHistoryItem, int, error) {
	t, err := m.Get(id)
	if err != nil {
		return nil, 0, err
	}
	return m.diffs.CommitHistory(t.WorktreePath)
}

func (m *Manager) Logs(id string, tail int) (string, error) {
	t, err := m.Get(id)
	if err != nil {
		return "", err
	}

	file, err := os.Open(t.LogFile)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return "", nil
		}
		return "", err
	}
	defer file.Close()

	if tail <= 0 {
		tail = 200
	}

	scanner := bufio.NewScanner(file)
	lines := make([]string, 0, tail)
	for scanner.Scan() {
		lines = append(lines, scanner.Text())
		if len(lines) > tail {
			lines = lines[1:]
		}
	}
	if err := scanner.Err(); err != nil {
		return "", err
	}

	return strings.Join(lines, "\n"), nil
}

func (m *Manager) LogTailBytes(id string, maxBytes int) (string, error) {
	t, err := m.Get(id)
	if err != nil {
		return "", err
	}

	data, err := os.ReadFile(t.LogFile)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return "", nil
		}
		return "", err
	}

	if maxBytes <= 0 || len(data) <= maxBytes {
		return string(bytes.ToValidUTF8(data, []byte("\uFFFD"))), nil
	}

	start := len(data) - maxBytes
	for start < len(data) && !utf8.RuneStart(data[start]) {
		start++
	}

	tail := bytes.ToValidUTF8(data[start:], []byte("\uFFFD"))
	return string(tail), nil
}

func (m *Manager) Subscribe(taskID string) (<-chan process.Event, func()) {
	return m.process.Subscribe(taskID)
}

func (m *Manager) SendInput(id, input string) error {
	m.mu.RLock()
	t, ok := m.tasks[id]
	m.mu.RUnlock()
	if !ok {
		return fmt.Errorf("task %s not found", id)
	}
	if t.Status != domain.StatusRunning && t.Status != domain.StatusPending && !m.process.IsRunning(id) {
		return fmt.Errorf("task %s is not running", id)
	}
	return m.process.WriteInput(id, input)
}

func (m *Manager) Interrupt(id string) error {
	m.mu.RLock()
	_, ok := m.tasks[id]
	m.mu.RUnlock()
	if !ok {
		return fmt.Errorf("task %s not found", id)
	}
	return m.process.Interrupt(id)
}

func (m *Manager) ResizeTerminal(id string, cols, rows uint16) error {
	m.mu.RLock()
	t, ok := m.tasks[id]
	m.mu.RUnlock()
	if !ok {
		return fmt.Errorf("task %s not found", id)
	}
	if t.Status != domain.StatusRunning {
		return fmt.Errorf("task %s is not running", id)
	}
	return m.process.Resize(id, cols, rows)
}

func (m *Manager) handleExit(result process.ExitResult) {
	m.mu.Lock()
	defer m.mu.Unlock()

	t, ok := m.tasks[result.TaskID]
	if !ok {
		return
	}
	code := result.ExitCode
	now := time.Now().UTC()

	if t.Status != domain.StatusStopped && t.Status != domain.StatusArchived {
		if code == 0 {
			t.Status = domain.StatusCompleted
		} else {
			t.Status = domain.StatusFailed
		}
	}
	t.ExitCode = &code
	t.PID = 0
	t.FinishedAt = &now
	t.UpdatedAt = now
	if result.Err != nil && code != 0 {
		t.LastError = result.Err.Error()
	}
	_ = m.persistLocked()
}

func (m *Manager) persistLocked() error {
	tasks := make([]domain.Task, 0, len(m.tasks))
	for _, t := range m.tasks {
		tasks = append(tasks, tCopy(*t))
	}
	sort.Slice(tasks, func(i, j int) bool {
		return tasks[i].CreatedAt.Before(tasks[j].CreatedAt)
	})
	return m.store.Save(tasks)
}

func (m *Manager) persistWorkspacesLocked() error {
	items := make([]domain.Workspace, 0, len(m.workspaces))
	for _, workspace := range m.workspaces {
		items = append(items, workspace)
	}
	sort.Slice(items, func(i, j int) bool {
		if items[i].UpdatedAt.Equal(items[j].UpdatedAt) {
			return strings.ToLower(items[i].Name) < strings.ToLower(items[j].Name)
		}
		return items[i].UpdatedAt.After(items[j].UpdatedAt)
	})
	return m.workspaceStore.Save(items)
}

func newTaskID() string {
	now := time.Now().UTC().Format("20060102-150405")
	randPart := rand.New(rand.NewSource(time.Now().UnixNano())).Intn(8999) + 1000
	return fmt.Sprintf("%s-%d", now, randPart)
}

func normalizedPreset(name string) string {
	name = strings.TrimSpace(name)
	if name == "" {
		return "none"
	}
	return name
}

const defaultWorkspace = "default"

func normalizedWorkspace(workspace string) string {
	return strings.TrimSpace(workspace)
}

func (m *Manager) ensureWorkspaceLocked(workspace domain.Workspace) bool {
	workspace.Name = normalizedWorkspace(workspace.Name)
	if workspace.Name == "" {
		return false
	}
	now := time.Now().UTC()
	workspace.ID = normalizedWorkspaceID(workspace.ID, workspace.Name)
	workspace.RepoPath = strings.TrimSpace(workspace.RepoPath)
	if workspace.CreatedAt.IsZero() {
		workspace.CreatedAt = now
	}
	if workspace.UpdatedAt.IsZero() {
		workspace.UpdatedAt = workspace.CreatedAt
	}
	key := strings.ToLower(workspace.Name)

	existing, ok := m.workspaces[key]
	if !ok {
		m.workspaces[key] = workspace
		return true
	}
	mutated := false
	if strings.TrimSpace(existing.ID) == "" && strings.TrimSpace(workspace.ID) != "" {
		existing.ID = workspace.ID
		mutated = true
	}
	if existing.CreatedAt.IsZero() {
		existing.CreatedAt = workspace.CreatedAt
		mutated = true
	}
	if existing.UpdatedAt.IsZero() {
		existing.UpdatedAt = existing.CreatedAt
		mutated = true
	}
	if existing.RepoPath == "" && workspace.RepoPath != "" {
		existing.RepoPath = workspace.RepoPath
		existing.UpdatedAt = now
		mutated = true
	}
	if mutated {
		m.workspaces[key] = existing
	}
	return mutated
}

func normalizedWorkspaceID(id, name string) string {
	cleanID := strings.TrimSpace(id)
	if cleanID != "" {
		return cleanID
	}
	return newWorkspaceID(name)
}

func newWorkspaceID(name string) string {
	return "ws-" + strings.ToLower(strings.TrimSpace(name))
}

func ensureGitRepo(repoPath string) error {
	out, err := exec.Command("git", "-C", repoPath, "rev-parse", "--is-inside-work-tree").CombinedOutput()
	if err != nil {
		return fmt.Errorf("path is not a git repo: %w (%s)", err, strings.TrimSpace(string(out)))
	}
	return nil
}

func initGitRepo(repoPath string) error {
	if err := os.MkdirAll(repoPath, 0o755); err != nil {
		return fmt.Errorf("create repo directory: %w", err)
	}
	out, err := exec.Command("git", "-C", repoPath, "init").CombinedOutput()
	if err != nil {
		return fmt.Errorf("git init failed: %w (%s)", err, strings.TrimSpace(string(out)))
	}
	return nil
}

func currentRepoBranch(repoPath string) string {
	out, err := exec.Command("git", "-C", repoPath, "rev-parse", "--abbrev-ref", "HEAD").CombinedOutput()
	if err != nil {
		return "HEAD"
	}
	branch := strings.TrimSpace(string(out))
	if branch == "" {
		return "HEAD"
	}
	return branch
}

func repoHasCommits(repoPath string) bool {
	cmd := exec.Command("git", "-C", repoPath, "rev-parse", "--verify", "HEAD")
	return cmd.Run() == nil
}

func normalizedTags(tags []string) []string {
	if len(tags) == 0 {
		return nil
	}
	out := make([]string, 0, len(tags))
	seen := map[string]struct{}{}
	for _, tag := range tags {
		clean := strings.TrimSpace(tag)
		if clean == "" {
			continue
		}
		key := strings.ToLower(clean)
		if _, exists := seen[key]; exists {
			continue
		}
		seen[key] = struct{}{}
		out = append(out, clean)
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

func absAndExpand(path string) (string, error) {
	if strings.HasPrefix(path, "~/") {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		path = filepath.Join(home, strings.TrimPrefix(path, "~/"))
	}
	abs, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	return abs, nil
}

func tCopy(task domain.Task) domain.Task {
	copy := task
	return copy
}
