package process

import (
	"bytes"
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
	"unicode/utf8"

	"github.com/creack/pty"

	"phasr/internal/domain"
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
	TaskID         string
	Command        string
	WorkDir        string
	LogFile        string
	PreCommands    []string
	KeepShellAlive bool
	Cols           uint16
	Rows           uint16
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

	script := buildScript(spec.WorkDir, spec.PreCommands, spec.Command, spec.KeepShellAlive)
	cmd := exec.Command("zsh", "-lc", script)
	cmd.Dir = spec.WorkDir
	cmd.Env = appendDefaultUTF8Env(append(os.Environ(), "TERM=xterm-256color"))

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

func (m *Manager) Interrupt(taskID string) error {
	m.mu.RLock()
	rp, ok := m.running[taskID]
	m.mu.RUnlock()
	if !ok {
		return fmt.Errorf("task %s is not running", taskID)
	}

	if err := syscall.Kill(-rp.cmd.Process.Pid, syscall.SIGINT); err != nil && !errors.Is(err, syscall.ESRCH) {
		// Fallback to direct process signal if process-group signal is unavailable.
		if err2 := syscall.Kill(rp.cmd.Process.Pid, syscall.SIGINT); err2 != nil && !errors.Is(err2, syscall.ESRCH) {
			return fmt.Errorf("interrupt task process: %w", err2)
		}
	}

	m.Publish(Event{
		TaskID:    taskID,
		Type:      EventStatus,
		Status:    domain.StatusRunning,
		Message:   "interrupt signal sent",
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
	pendingUTF8 := make([]byte, 0, 4)
	for {
		n, err := rp.ptyFile.Read(buf)
		if n > 0 {
			rp.ioMu.Lock()
			_, _ = rp.logFile.Write(buf[:n])
			rp.ioMu.Unlock()

			chunk, remainder := decodeUTF8Chunk(pendingUTF8, buf[:n])
			pendingUTF8 = remainder

			if chunk == "" {
				continue
			}

			m.Publish(Event{
				TaskID:    taskID,
				Type:      EventLog,
				Message:   chunk,
				Timestamp: time.Now().UTC(),
			})
		}

		if err != nil {
			if len(pendingUTF8) > 0 {
				flush := string(bytes.ToValidUTF8(pendingUTF8, []byte("\uFFFD")))
				if flush != "" {
					m.Publish(Event{
						TaskID:    taskID,
						Type:      EventLog,
						Message:   flush,
						Timestamp: time.Now().UTC(),
					})
				}
			}
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

func decodeUTF8Chunk(prefix, chunk []byte) (string, []byte) {
	if len(prefix) == 0 && len(chunk) == 0 {
		return "", nil
	}

	combined := make([]byte, 0, len(prefix)+len(chunk))
	combined = append(combined, prefix...)
	combined = append(combined, chunk...)

	end := 0
	for i := 0; i < len(combined); {
		if combined[i] < utf8.RuneSelf {
			i++
			end = i
			continue
		}

		r, size := utf8.DecodeRune(combined[i:])
		if r == utf8.RuneError && size == 1 {
			if !utf8.FullRune(combined[i:]) {
				break
			}
			i++
			end = i
			continue
		}
		i += size
		end = i
	}

	if end == 0 {
		return "", append([]byte(nil), combined...)
	}

	decoded := string(bytes.ToValidUTF8(combined[:end], []byte("\uFFFD")))
	remainder := append([]byte(nil), combined[end:]...)
	return decoded, remainder
}

func appendDefaultUTF8Env(env []string) []string {
	hasLCAll := false
	hasLANG := false
	hasLCCType := false

	for _, entry := range env {
		key, _, ok := strings.Cut(entry, "=")
		if !ok {
			continue
		}
		switch strings.ToUpper(key) {
		case "LC_ALL":
			hasLCAll = true
		case "LANG":
			hasLANG = true
		case "LC_CTYPE":
			hasLCCType = true
		}
	}

	if !hasLCAll && !hasLANG {
		env = append(env, "LANG=en_US.UTF-8")
	}
	if !hasLCAll && !hasLCCType {
		env = append(env, "LC_CTYPE=en_US.UTF-8")
	}
	return env
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

func buildScript(workDir string, preCommands []string, command string, keepShellAlive bool) string {
	lines := []string{"set -e"}
	if strings.TrimSpace(workDir) != "" {
		lines = append(lines, "cd -- "+shellQuote(workDir))
	}
	for _, c := range preCommands {
		trimmed := strings.TrimSpace(c)
		if trimmed == "" {
			continue
		}
		lines = append(lines, trimmed)
	}
	trimmedCommand := strings.TrimSpace(command)
	if keepShellAlive {
		// Keep setup strict, but don't exit the PTY if the main command returns non-zero.
		lines = append(lines, "set +e")
	}
	lines = append(lines, trimmedCommand)
	if keepShellAlive {
		lines = append(lines, "exec zsh -il")
	}
	return strings.Join(lines, "\n")
}

func shellQuote(value string) string {
	// Single-quote shell escaping: abc'def -> 'abc'"'"'def'
	return "'" + strings.ReplaceAll(value, "'", `'"'"'`) + "'"
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
