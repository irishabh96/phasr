package domain

import "time"

type TaskStatus string

const (
	StatusPending   TaskStatus = "pending"
	StatusRunning   TaskStatus = "running"
	StatusStopped   TaskStatus = "stopped"
	StatusCompleted TaskStatus = "completed"
	StatusFailed    TaskStatus = "failed"
	StatusArchived  TaskStatus = "archived"
)

type Task struct {
	ID             string     `json:"id"`
	Name           string     `json:"name"`
	Workspace      string     `json:"workspace"`
	Tags           []string   `json:"tags"`
	DirectRepo     bool       `json:"direct_repo"`
	RepoPath       string     `json:"repo_path"`
	Branch         string     `json:"branch"`
	WorktreePath   string     `json:"worktree_path"`
	Prompt         string     `json:"prompt"`
	Command        string     `json:"command"`
	CurrentCommand string     `json:"current_command"`
	Preset         string     `json:"preset"`
	Status         TaskStatus `json:"status"`
	PID            int        `json:"pid"`
	LogFile        string     `json:"log_file"`
	ExitCode       *int       `json:"exit_code,omitempty"`
	LastError      string     `json:"last_error,omitempty"`
	CreatedAt      time.Time  `json:"created_at"`
	UpdatedAt      time.Time  `json:"updated_at"`
	StartedAt      *time.Time `json:"started_at,omitempty"`
	FinishedAt     *time.Time `json:"finished_at,omitempty"`
	ArchivedAt     *time.Time `json:"archived_at,omitempty"`
}

func (t Task) IsActive() bool {
	return t.Status == StatusPending || t.Status == StatusRunning
}

func (t Task) CanRun() bool {
	return t.Status == StatusStopped || t.Status == StatusCompleted || t.Status == StatusFailed
}
