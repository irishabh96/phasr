package api

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

type gitMetadataResponse struct {
	Path       string `json:"path"`
	Provider   string `json:"provider"`
	Host       string `json:"host"`
	Remote     string `json:"remote"`
	RepoPath   string `json:"repo_path"`
	RepoURL    string `json:"repo_url"`
	BaseBranch string `json:"base_branch"`
	Branch     string `json:"branch"`
	BranchURL  string `json:"branch_url"`
	PRURL      string `json:"pr_url"`
}

func (s *server) handleGitMetadata(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}

	var payload struct {
		Path   string `json:"path"`
		Branch string `json:"branch"`
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
	meta, err := resolveGitMetadata(path, strings.TrimSpace(payload.Branch))
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, meta)
}

func resolveGitMetadata(path, branch string) (gitMetadataResponse, error) {
	absPath, err := filepath.Abs(path)
	if err != nil {
		return gitMetadataResponse{}, fmt.Errorf("resolve path: %w", err)
	}

	info, err := os.Stat(absPath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return gitMetadataResponse{}, errors.New("path does not exist")
		}
		return gitMetadataResponse{}, err
	}
	if !info.IsDir() {
		return gitMetadataResponse{}, errors.New("path is not a directory")
	}

	if _, err := runGitInPath(absPath, "rev-parse", "--is-inside-work-tree"); err != nil {
		return gitMetadataResponse{}, errors.New("path is not a git repository")
	}

	remoteName, remoteURL, err := gitRemote(absPath)
	if err != nil {
		return gitMetadataResponse{}, err
	}
	host, repoPath := parseGitRemoteURL(remoteURL)
	if host == "" || repoPath == "" {
		return gitMetadataResponse{}, errors.New("unable to parse git remote URL")
	}

	provider := detectProvider(host)
	baseBranch := detectBaseBranch(absPath, remoteName)
	branchURL, prURL := buildProviderURLs(provider, host, repoPath, baseBranch, branch)

	return gitMetadataResponse{
		Path:       absPath,
		Provider:   provider,
		Host:       host,
		Remote:     remoteURL,
		RepoPath:   repoPath,
		RepoURL:    fmt.Sprintf("https://%s/%s", host, repoPath),
		BaseBranch: baseBranch,
		Branch:     branch,
		BranchURL:  branchURL,
		PRURL:      prURL,
	}, nil
}

func gitRemote(repoPath string) (string, string, error) {
	if originURL, err := runGitInPath(repoPath, "config", "--get", "remote.origin.url"); err == nil && originURL != "" {
		return "origin", originURL, nil
	}

	remotesOut, err := runGitInPath(repoPath, "remote")
	if err != nil {
		return "", "", errors.New("no git remote configured")
	}
	for _, line := range strings.Split(remotesOut, "\n") {
		remoteName := strings.TrimSpace(line)
		if remoteName == "" {
			continue
		}
		remoteURL, err := runGitInPath(repoPath, "config", "--get", fmt.Sprintf("remote.%s.url", remoteName))
		if err == nil && remoteURL != "" {
			return remoteName, remoteURL, nil
		}
	}
	return "", "", errors.New("no git remote configured")
}

func detectBaseBranch(repoPath, remoteName string) string {
	if strings.TrimSpace(remoteName) == "" {
		return ""
	}

	headRef, err := runGitInPath(repoPath, "symbolic-ref", "--quiet", fmt.Sprintf("refs/remotes/%s/HEAD", remoteName))
	if err == nil {
		prefix := fmt.Sprintf("refs/remotes/%s/", remoteName)
		if strings.HasPrefix(headRef, prefix) {
			return strings.TrimPrefix(headRef, prefix)
		}
	}

	remoteInfo, err := runGitInPath(repoPath, "remote", "show", remoteName)
	if err != nil {
		return ""
	}
	for _, line := range strings.Split(remoteInfo, "\n") {
		trimmed := strings.TrimSpace(line)
		const prefix = "HEAD branch:"
		if strings.HasPrefix(trimmed, prefix) {
			return strings.TrimSpace(strings.TrimPrefix(trimmed, prefix))
		}
	}
	return ""
}

func runGitInPath(repoPath string, args ...string) (string, error) {
	gitArgs := append([]string{"-C", repoPath}, args...)
	cmd := exec.Command("git", gitArgs...)
	out, err := cmd.CombinedOutput()
	output := strings.TrimSpace(string(out))
	if err != nil {
		if output == "" {
			return "", err
		}
		return "", fmt.Errorf("%w (%s)", err, output)
	}
	return output, nil
}

func detectProvider(host string) string {
	lowerHost := strings.ToLower(strings.TrimSpace(host))
	switch {
	case strings.Contains(lowerHost, "github"):
		return "github"
	case strings.Contains(lowerHost, "gitlab"):
		return "gitlab"
	case strings.Contains(lowerHost, "bitbucket"):
		return "bitbucket"
	default:
		return "unknown"
	}
}

func parseGitRemoteURL(remoteURL string) (string, string) {
	raw := strings.TrimSpace(remoteURL)
	if raw == "" {
		return "", ""
	}

	var host string
	var repoPath string

	if strings.Contains(raw, "://") {
		parsed, err := url.Parse(raw)
		if err == nil {
			host = strings.TrimSpace(parsed.Hostname())
			repoPath = strings.Trim(strings.TrimPrefix(parsed.Path, "/"), "/")
		}
	} else if at := strings.Index(raw, "@"); at >= 0 {
		remainder := raw[at+1:]
		if idx := strings.Index(remainder, ":"); idx > 0 {
			host = strings.TrimSpace(remainder[:idx])
			repoPath = strings.TrimSpace(remainder[idx+1:])
		}
	}

	if host == "" {
		if idx := strings.Index(raw, ":"); idx > 0 && !strings.Contains(raw[:idx], "/") {
			host = strings.TrimSpace(raw[:idx])
			repoPath = strings.TrimSpace(raw[idx+1:])
		}
	}

	repoPath = strings.Trim(strings.TrimSuffix(repoPath, ".git"), "/")
	return host, repoPath
}

func buildProviderURLs(provider, host, repoPath, baseBranch, branch string) (string, string) {
	trimmedHost := strings.TrimSpace(host)
	trimmedRepoPath := strings.Trim(strings.TrimSpace(repoPath), "/")
	trimmedBranch := strings.TrimSpace(branch)
	if trimmedHost == "" || trimmedRepoPath == "" || trimmedBranch == "" {
		return "", ""
	}

	escapedBranch := escapeRefPath(trimmedBranch)
	escapedBase := escapeRefPath(baseBranch)
	switch provider {
	case "github":
		branchURL := fmt.Sprintf("https://%s/%s/tree/%s", trimmedHost, trimmedRepoPath, escapedBranch)
		prURL := ""
		if escapedBase != "" {
			prURL = fmt.Sprintf("https://%s/%s/compare/%s...%s?expand=1", trimmedHost, trimmedRepoPath, escapedBase, escapedBranch)
		}
		return branchURL, prURL
	case "gitlab":
		branchURL := fmt.Sprintf("https://%s/%s/-/tree/%s", trimmedHost, trimmedRepoPath, escapedBranch)
		params := url.Values{}
		if strings.TrimSpace(baseBranch) != "" {
			params.Set("merge_request[source_branch]", trimmedBranch)
			params.Set("merge_request[target_branch]", strings.TrimSpace(baseBranch))
			return branchURL, fmt.Sprintf("https://%s/%s/-/merge_requests/new?%s", trimmedHost, trimmedRepoPath, params.Encode())
		}
		return branchURL, ""
	case "bitbucket":
		branchURL := fmt.Sprintf("https://%s/%s/src/%s/", trimmedHost, trimmedRepoPath, escapedBranch)
		params := url.Values{}
		if strings.TrimSpace(baseBranch) != "" {
			params.Set("source", trimmedBranch)
			params.Set("dest", fmt.Sprintf("%s:%s", trimmedRepoPath, strings.TrimSpace(baseBranch)))
			return branchURL, fmt.Sprintf("https://%s/%s/pull-requests/new?%s", trimmedHost, trimmedRepoPath, params.Encode())
		}
		return branchURL, ""
	default:
		return "", ""
	}
}

func escapeRefPath(value string) string {
	escaped := url.PathEscape(strings.TrimSpace(value))
	return strings.ReplaceAll(escaped, "%2F", "/")
}
