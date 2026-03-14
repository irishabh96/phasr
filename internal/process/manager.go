package process

import (
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/creack/pty"

	"staq/internal/domain"
)

type EventType string

const (
	EventLog    EventType = "log"
	EventStatus EventType = "status"
)

type Event struct {
	TaskID    string            `json:"task_id"`
	Type      EventType         `json:"type"`
	Status    domain.TaskStatus `json:"status,omitempty"`
	Message   string            `json:"message,omitempty"`
	Timestamp time.Time         `json:"timestamp"`
	ExitCode  *int              `json:"exit_code,omitempty"`
}

type StartSpec struct {
	TaskID      string
	Command     string
	WorkDir     string
	LogFile     string
	PreCommands []string
	Cols        uint16
	Rows        uint16
}

type ExitResult struct {
	TaskID   string
	ExitCode int
	Err      error
}

type runningProcess struct {
	cmd     *exec.Cmd
	ptyFile *os.File
	logFile *os.File
	ioMu    sync.Mutex
}

type Manager struct {
	mu          sync.RWMutex
	running     map[string]*runningProcess
	subscribers map[string]map[chan Event]struct{}
	onExit      func(ExitResult)
}

func NewManager() *Manager {
	return &Manager{
		running:     map[string]*runningProcess{},
		subscribers: map[string]map[chan Event]struct{}{},
	}
}

func (m *Manager) SetExitHandler(handler func(ExitResult)) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.onExit = handler
}

func (m *Manager) Start(spec StartSpec) (int, error) {
	if strings.TrimSpace(spec.TaskID) == "" {
		return 0, errors.New("task id is required")
	}
	if strings.TrimSpace(spec.Command) == "" {
		return 0, errors.New("agent command is required")
	}

	m.mu.Lock()
	if _, exists := m.running[spec.TaskID]; exists {
		m.mu.Unlock()
		return 0, fmt.Errorf("task %s is already running", spec.TaskID)
	}
	m.mu.Unlock()

	if err := os.MkdirAll(filepath.Dir(spec.LogFile), 0o755); err != nil {
		return 0, fmt.Errorf("create logs dir: %w", err)
	}
	logFile, err := os.OpenFile(spec.LogFile, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		return 0, fmt.Errorf("open log file: %w", err)
	}

	script := buildScript(spec.PreCommands, spec.Command)
	cmd := exec.Command("zsh", "-lc", script)
	cmd.Dir = spec.WorkDir
	cmd.Env = append(os.Environ(), "TERM=xterm-256color")

	winsize := &pty.Winsize{Cols: defaultCols(spec.Cols), Rows: defaultRows(spec.Rows)}
	ptyFile, err := pty.StartWithSize(cmd, winsize)
	if err != nil {
		_ = logFile.Close()
		return 0, fmt.Errorf("start PTY process: %w", err)
	}

	rp := &runningProcess{cmd: cmd, ptyFile: ptyFile, logFile: logFile}
	m.mu.Lock()
	m.running[spec.TaskID] = rp
	m.mu.Unlock()

	m.Publish(Event{
		TaskID:    spec.TaskID,
		Type:      EventStatus,
		Status:    domain.StatusRunning,
		Message:   fmt.Sprintf("started pid=%d (pty %dx%d)", cmd.Process.Pid, winsize.Cols, winsize.Rows),
		Timestamp: time.Now().UTC(),
	})

	go m.streamPTY(spec.TaskID, rp)
	go m.wait(spec.TaskID, rp)

	return cmd.Process.Pid, nil
}

func (m *Manager) Stop(taskID string, force bool) error {
	m.mu.RLock()
	rp, ok := m.running[taskID]
	m.mu.RUnlock()
	if !ok {
		return nil
	}

	sig := syscall.SIGTERM
	if force {
		sig = syscall.SIGKILL
	}

	if err := syscall.Kill(-rp.cmd.Process.Pid, sig); err != nil && !errors.Is(err, syscall.ESRCH) {
		// Fallback to direct process signal if process-group signal is unavailable.
		if err2 := syscall.Kill(rp.cmd.Process.Pid, sig); err2 != nil && !errors.Is(err2, syscall.ESRCH) {
			return fmt.Errorf("stop task process: %w", err2)
		}
	}

	m.Publish(Event{
		TaskID:    taskID,
		Type:      EventStatus,
		Status:    domain.StatusStopped,
		Message:   "stop signal sent",
		Timestamp: time.Now().UTC(),
	})

	return nil
}

func (m *Manager) WriteInput(taskID, input string) error {
	m.mu.RLock()
	rp, ok := m.running[taskID]
	m.mu.RUnlock()
	if !ok {
		return fmt.Errorf("task %s is not running", taskID)
	}

	rp.ioMu.Lock()
	defer rp.ioMu.Unlock()
	if _, err := io.WriteString(rp.ptyFile, input); err != nil {
		return fmt.Errorf("write task input: %w", err)
	}
	return nil
}

func (m *Manager) Resize(taskID string, cols, rows uint16) error {
	m.mu.RLock()
	rp, ok := m.running[taskID]
	m.mu.RUnlock()
	if !ok {
		return fmt.Errorf("task %s is not running", taskID)
	}

	rp.ioMu.Lock()
	defer rp.ioMu.Unlock()
	if err := pty.Setsize(rp.ptyFile, &pty.Winsize{Cols: defaultCols(cols), Rows: defaultRows(rows)}); err != nil {
		return fmt.Errorf("resize task PTY: %w", err)
	}
	return nil
}

func (m *Manager) IsRunning(taskID string) bool {
	m.mu.RLock()
	defer m.mu.RUnlock()
	_, ok := m.running[taskID]
	return ok
}

func (m *Manager) Subscribe(taskID string) (<-chan Event, func()) {
	if strings.TrimSpace(taskID) == "" {
		taskID = "*"
	}

	ch := make(chan Event, 256)

	m.mu.Lock()
	if _, ok := m.subscribers[taskID]; !ok {
		m.subscribers[taskID] = map[chan Event]struct{}{}
	}
	m.subscribers[taskID][ch] = struct{}{}
	m.mu.Unlock()

	cancel := func() {
		m.mu.Lock()
		defer m.mu.Unlock()
		if subs, ok := m.subscribers[taskID]; ok {
			delete(subs, ch)
			if len(subs) == 0 {
				delete(m.subscribers, taskID)
			}
		}
	}

	return ch, cancel
}

func (m *Manager) Publish(event Event) {
	m.mu.RLock()
	targeted := m.subscribers[event.TaskID]
	wildcard := m.subscribers["*"]
	recipients := make([]chan Event, 0, len(targeted)+len(wildcard))
	for ch := range targeted {
		recipients = append(recipients, ch)
	}
	for ch := range wildcard {
		recipients = append(recipients, ch)
	}
	m.mu.RUnlock()

	for _, ch := range recipients {
		select {
		case ch <- event:
		default:
		}
	}
}

func (m *Manager) streamPTY(taskID string, rp *runningProcess) {
	buf := make([]byte, 4096)
	for {
		n, err := rp.ptyFile.Read(buf)
		if n > 0 {
			chunk := string(buf[:n])

			rp.ioMu.Lock()
			_, _ = rp.logFile.Write(buf[:n])
			rp.ioMu.Unlock()

			m.Publish(Event{
				TaskID:    taskID,
				Type:      EventLog,
				Message:   chunk,
				Timestamp: time.Now().UTC(),
			})
		}

		if err != nil {
			if isExpectedPTYClose(err) {
				return
			}
			m.Publish(Event{
				TaskID:    taskID,
				Type:      EventStatus,
				Status:    domain.StatusFailed,
				Message:   "PTY read error: " + err.Error(),
				Timestamp: time.Now().UTC(),
			})
			return
		}
	}
}

func (m *Manager) wait(taskID string, rp *runningProcess) {
	err := rp.cmd.Wait()
	exitCode := exitCodeFromError(err)

	rp.ioMu.Lock()
	_ = rp.ptyFile.Close()
	_ = rp.logFile.Close()
	rp.ioMu.Unlock()

	m.mu.Lock()
	delete(m.running, taskID)
	handler := m.onExit
	m.mu.Unlock()

	status := domain.StatusCompleted
	if exitCode != 0 {
		status = domain.StatusFailed
	}
	m.Publish(Event{
		TaskID:    taskID,
		Type:      EventStatus,
		Status:    status,
		Message:   fmt.Sprintf("process exited with code %d", exitCode),
		Timestamp: time.Now().UTC(),
		ExitCode:  &exitCode,
	})

	if handler != nil {
		handler(ExitResult{TaskID: taskID, ExitCode: exitCode, Err: err})
	}
}

func exitCodeFromError(err error) int {
	if err == nil {
		return 0
	}
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) {
		return exitErr.ExitCode()
	}
	return -1
}

func buildScript(preCommands []string, command string) string {
	lines := []string{"set -e"}
	for _, c := range preCommands {
		trimmed := strings.TrimSpace(c)
		if trimmed == "" {
			continue
		}
		lines = append(lines, trimmed)
	}
	lines = append(lines, strings.TrimSpace(command))
	return strings.Join(lines, "\n")
}

func defaultCols(value uint16) uint16 {
	if value == 0 {
		return 120
	}
	return value
}

func defaultRows(value uint16) uint16 {
	if value == 0 {
		return 40
	}
	return value
}

func isExpectedPTYClose(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, io.EOF) || errors.Is(err, os.ErrClosed) || errors.Is(err, syscall.EIO) {
		return true
	}
	var pathErr *os.PathError
	if errors.As(err, &pathErr) {
		if errors.Is(pathErr.Err, os.ErrClosed) || errors.Is(pathErr.Err, syscall.EIO) || errors.Is(pathErr.Err, io.EOF) {
			return true
		}
	}
	return false
}
