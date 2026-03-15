package domain

import "time"

type Workspace struct {
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	RepoPath  string    `json:"repo_path"`
	CreatedAt time.Time `json:"created_at,omitempty"`
	UpdatedAt time.Time `json:"updated_at,omitempty"`
}
