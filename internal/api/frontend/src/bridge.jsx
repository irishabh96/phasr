import React from "react";
import { createRoot } from "react-dom/client";

function cx(...parts) {
  return parts.filter(Boolean).join(" ");
}

function fileIconType(name, kind = "file") {
  if (kind === "dir") return { label: "dir", cls: "dir" };
  const lower = String(name || "").toLowerCase();
  if (lower === "go.mod") return { label: "mod", cls: "go" };
  if (lower === "go.sum") return { label: "sum", cls: "go" };
  if (lower === "readme.md" || lower.endsWith(".md")) return { label: "md", cls: "doc" };
  if (lower === ".env" || lower.startsWith(".env.")) return { label: "env", cls: "cfg" };
  if (lower === ".gitignore") return { label: "git", cls: "cfg" };
  if (lower === "dockerfile") return { label: "dk", cls: "cfg" };
  if (lower === "makefile") return { label: "mk", cls: "cfg" };
  if (lower.endsWith(".go")) return { label: "go", cls: "go" };
  if (lower.endsWith(".json")) return { label: "js", cls: "cfg" };
  if (lower.endsWith(".yaml") || lower.endsWith(".yml")) return { label: "yl", cls: "cfg" };
  if (lower.endsWith(".toml") || lower.endsWith(".ini")) return { label: "cf", cls: "cfg" };
  if (lower.endsWith(".lock")) return { label: "lk", cls: "cfg" };
  return { label: "f", cls: "" };
}

function FileIcon({ name, kind = "file" }) {
  const icon = fileIconType(name, kind);
  return <span className={cx("file-icon", icon.cls)} aria-hidden="true">{icon.label}</span>;
}

function TreeChevron() {
  return (
    <svg stroke="currentColor" fill="currentColor" strokeWidth="0" viewBox="0 0 16 16" className="tree-chevron" height="1em" width="1em" aria-hidden="true">
      <path fillRule="evenodd" clipRule="evenodd" d="M10.072 8.024L5.715 3.667l.618-.62L11 7.716v.618L6.333 13l-.618-.619 4.357-4.357z" />
    </svg>
  );
}

const PROVIDERS = [
  { id: "claude", label: "claude", icon: "C", title: "Anthropic Claude — autonomous coding agent" },
  { id: "codex", label: "codex", icon: "O", title: "OpenAI Codex — GPT-powered coding agent" },
  { id: "copilot", label: "copilot", icon: "G", title: "GitHub Copilot — AI pair programmer" },
  { id: "opencode", label: "opencode", icon: "OC", title: "OpenCode — open-source coding assistant" },
  { id: "gemini", label: "gemini", icon: "Gm", title: "Google Gemini — multimodal AI agent" },
];

function ProviderBarView({ model }) {
  const selected = String(model?.selected || "");
  return (
    <>
      <span className="provider-label">Run with:</span>
      {PROVIDERS.map((provider) => (
        <button
          key={provider.id}
          type="button"
          className={cx("provider-pill", selected === provider.id && "active")}
          data-provider-pill={provider.id}
          title={provider.title}
        >
          <span className="provider-icon" aria-hidden="true">{provider.icon}</span>
          <span>{provider.label}</span>
        </button>
      ))}
    </>
  );
}

function TaskHeaderView({ model }) {
  if (!model) return null;
  return (
    <div className="task-header-main">
      <span className={cx("status-dot", model.isRunning && "active")} />
      <h2 className="task-header-title">{model.title}</h2>
    </div>
  );
}

function SidebarTaskRow({ task }) {
  return (
    <div className={cx("sidebar-row", task.isSelected && "selected")} data-open-task={task.rootTaskID}>
      <div className="sidebar-row-content">
        <span className="sidebar-row-title">{task.title}</span>
        {task.subtitle ? <span className="sidebar-row-subtitle">{task.subtitle}</span> : null}
      </div>
      {task.dotClass ? <span className={cx("sidebar-status-dot", task.dotClass)} title={task.dotTooltip || ""} /> : null}
      {task.canCloseWorktree ? (
        <button
          className="sidebar-task-close flex items-center justify-center text-muted-foreground hover:text-foreground"
          type="button"
          data-close-worktree-task={task.closeTaskID || task.rootTaskID}
          aria-label={`Close ${task.title}`}
          data-state="closed"
          data-slot="tooltip-trigger"
          title={`Close ${task.title}`}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
        >
          <svg
            stroke="currentColor"
            fill="currentColor"
            strokeWidth="0"
            viewBox="0 0 20 20"
            aria-hidden="true"
            className="sidebar-task-close-icon size-3.5"
            height="1em"
            width="1em"
            xmlns="http://www.w3.org/2000/svg"
          >
            <path d="M6.28 5.22a.75.75 0 0 0-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 1 0 1.06 1.06L10 11.06l3.72 3.72a.75.75 0 1 0 1.06-1.06L11.06 10l3.72-3.72a.75.75 0 0 0-1.06-1.06L10 8.94 6.28 5.22Z" />
          </svg>
        </button>
      ) : null}
    </div>
  );
}

function WorkspaceItem({ row }) {
  return (
    <>
      {row.showDivider ? <div className="workspace-divider" /> : null}
      <details className={cx("workspace-node", row.isActive && "active")} data-workspace-node={row.id} open={row.isOpen}>
        <summary className="workspace-summary" data-workspace-summary={row.id}>
          <span className="workspace-avatar">{row.initial}</span>
          <span className="workspace-name">{row.name}</span>
          <span className="workspace-count">({row.taskCount})</span>
          <div className="workspace-actions">
            <button
              className="icon-btn ghost-action workspace-add-tab-btn p-1 rounded hover:bg-muted transition-colors shrink-0 ml-1"
              type="button"
              data-new-workspace-tab={row.id}
              aria-label={`New tab in ${row.name}`}
              data-state="closed"
              data-slot="tooltip-trigger"
              title={`New tab in ${row.name}`}
            >
              <svg
                stroke="currentColor"
                fill="currentColor"
                strokeWidth="0"
                viewBox="0 0 20 20"
                aria-hidden="true"
                className="workspace-add-tab-icon size-4 text-muted-foreground"
                height="1em"
                width="1em"
                xmlns="http://www.w3.org/2000/svg"
              >
                <path d="M10.75 4.75a.75.75 0 0 0-1.5 0v4.5h-4.5a.75.75 0 0 0 0 1.5h4.5v4.5a.75.75 0 0 0 1.5 0v-4.5h4.5a.75.75 0 0 0 0-1.5h-4.5v-4.5Z" />
              </svg>
            </button>
            <button
              className="icon-btn ghost-action workspace-delete-btn"
              type="button"
              data-delete-workspace={row.id}
              aria-label={`Delete workspace ${row.name}`}
              title={`Delete workspace ${row.name}`}
            >
              <svg
                stroke="currentColor"
                fill="currentColor"
                strokeWidth="0"
                viewBox="0 0 20 20"
                aria-hidden="true"
                className="sidebar-task-close-icon size-3.5"
                height="1em"
                width="1em"
                xmlns="http://www.w3.org/2000/svg"
              >
                <path d="M6.28 5.22a.75.75 0 0 0-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 1 0 1.06 1.06L10 11.06l3.72 3.72a.75.75 0 1 0 1.06-1.06L11.06 10l3.72-3.72a.75.75 0 0 0-1.06-1.06L10 8.94 6.28 5.22Z" />
              </svg>
            </button>
          </div>
        </summary>

        <div className="workspace-children">
          {row.tasks.length ? (
            row.tasks.map((task) => <SidebarTaskRow key={task.rootTaskID} task={task} />)
          ) : (
            <div className="sidebar-empty sidebar-empty-tasks">No tasks</div>
          )}
        </div>
      </details>
    </>
  );
}

function WorkspaceListView({ model }) {
  if (!model || model.empty || !Array.isArray(model.rows) || model.rows.length === 0) {
    return <div className="sidebar-empty">No workspaces</div>;
  }

  return <>{model.rows.map((row) => <WorkspaceItem key={row.id} row={row} />)}</>;
}

function TabButton({ tab }) {
  return (
    <div className={cx("tab", tab.active && "active")} data-tab={tab.id} title={tab.title}>
      <span className="tab-label">{tab.label}</span>
      <button className="tab-close" data-close-tab={tab.id} type="button" aria-label="Close tab">
        &times;
      </button>
    </div>
  );
}

function TabBarView({ model }) {
  if (!model) return null;

  if (model.overflow && model.overflow.length) {
    return (
      <div className="tab-list">
        {model.tabs.map((tab) => <TabButton key={tab.id} tab={tab} />)}

        <div className="tab-overflow-wrap">
          <button className="tab-overflow-btn" type="button" aria-label="More tabs">+{model.overflowCount} more</button>
          <div className="tab-overflow-menu hidden">
            {model.overflow.map((tab) => (
              <button key={tab.id} className="tab-overflow-item" data-overflow-tab={tab.id} type="button">{tab.name}</button>
            ))}
          </div>
        </div>

        <button className="tab plus-tab" type="button" aria-label="New tab">+</button>
      </div>
    );
  }

  return (
    <>
      <div className="tab-list">
        {model.tabs.map((tab) => <TabButton key={tab.id} tab={tab} />)}
        <button className="tab plus-tab" type="button" aria-label="New tab">+</button>
      </div>
      {model.showEmptyHint ? <div className="tabs-empty">No open tabs</div> : null}
    </>
  );
}

function ChangeFileRow({ file, mode, commitMode = false }) {
  const safePath = String(file?.path || "");
  const showStage = !commitMode && mode === "unstaged";
  const showUnstage = !commitMode && mode === "staged";
  const showDiscard = !commitMode && !!safePath;

  return (
    <div
      className={cx("change-file-row", commitMode && "commit-file-row", file.selected && "selected")}
      style={{ "--change-depth": file.depth }}
      data-patch-file={commitMode ? undefined : file.path}
      title={commitMode ? file.path : undefined}
    >
      <div className="change-file-main">
        <span className={cx("change-status-icon", file.statusClass)} aria-hidden="true" />
        <span className="change-file-name mono">{file.name}</span>
        <span className="change-inline-counts">
          <span className="add">+{file.added}</span>
          <span className="del">-{file.deleted}</span>
        </span>
      </div>
      {!commitMode ? (
        <span className="tree-row-right">
          {showStage ? (
            <button className="tree-action-btn stage" type="button" data-stage-file={safePath} title="Stage file" aria-label="Stage file">
              <span className="tree-action-icon icon-stage-plus" aria-hidden="true"></span>
            </button>
          ) : null}
          {showUnstage ? (
            <button className="tree-action-btn unstage" type="button" data-unstage-file={safePath} title="Unstage file" aria-label="Unstage file">
              <span className="tree-action-icon icon-unstage-minus" aria-hidden="true"></span>
            </button>
          ) : null}
          {showDiscard ? (
            <button className="tree-action-btn discard" type="button" data-discard-file={safePath} title="Discard changes" aria-label="Discard changes">
              <span className="tree-action-icon icon-discard" aria-hidden="true"></span>
            </button>
          ) : null}
        </span>
      ) : null}
    </div>
  );
}

function GroupedChangeList({ model, mode }) {
  return model.groups.map((group) => (
    <div className="change-group" key={group.folder}>
      <div className="change-group-label">
        <FileIcon name={group.folder} kind="dir" />
        <span className="tree-row-label">{group.folder}</span>
      </div>
      <div className="change-group-files">
        {group.files.map((file) => <ChangeFileRow key={file.path} file={file} mode={mode} />)}
      </div>
    </div>
  ));
}

function ChangeTreeDir({ node, mode }) {
  return (
    <details className="change-tree-dir" open={node.open} style={{ "--change-depth": node.depth }}>
      <summary>
        <TreeChevron />
        <FileIcon name={node.name} kind="dir" />
        <span className="tree-row-label">{node.name}</span>
      </summary>
      <div className="change-tree-children">
        {node.dirs.map((dir) => <ChangeTreeDir key={`${node.name}/${dir.name}`} node={dir} mode={mode} />)}
        {node.files.map((file) => <ChangeFileRow key={file.path} file={file} mode={mode} />)}
      </div>
    </details>
  );
}

function TreeChangeList({ model, mode }) {
  return (
    <>
      {model.rootFiles.length ? (
        <div className="change-group">
          <div className="change-group-label">
            <FileIcon name="(root)" kind="dir" />
            <span className="tree-row-label">(root)</span>
          </div>
          <div className="change-group-files">
            {model.rootFiles.map((file) => <ChangeFileRow key={file.path} file={file} mode={mode} />)}
          </div>
        </div>
      ) : null}
      {model.dirs.map((dir) => <ChangeTreeDir key={dir.name} node={dir} mode={mode} />)}
    </>
  );
}

function ChangeListView({ model, mode }) {
  if (!model || model.empty) {
    return <div className="empty">{model?.emptyText || `No ${mode} changes.`}</div>;
  }
  if (model.view === "tree") {
    return <TreeChangeList model={model} mode={mode} />;
  }
  return <GroupedChangeList model={model} mode={mode} />;
}

function CommitsView({ model }) {
  if (!model || model.empty) {
    return <div className="empty">{model?.emptyText || "No commits in this branch."}</div>;
  }

  return model.items.map((item) => (
    <details className="commit-history-item change-tree-dir" key={item.key}>
      <summary className="commit-history-summary">
        <TreeChevron />
        <span className="commit-history-label tree-row-label mono">{item.label}</span>
      </summary>
      <div className="change-tree-children">
        {item.files.length ? item.files.map((file) => (
          <ChangeFileRow key={`${item.key}:${file.path}`} file={file} mode="staged" commitMode />
        )) : <div className="empty">No files changed.</div>}
      </div>
    </details>
  ));
}

function RepoTreeDir({ node }) {
  return (
    <details className="repo-tree-dir" open={node.open} style={{ "--depth": node.depth }}>
      <summary>
        <TreeChevron />
        <FileIcon name={node.name} kind="dir" />
        <span className="tree-row-label">{node.name}</span>
      </summary>
      <div className="repo-tree-children">
        {node.dirs.map((dir) => <RepoTreeDir key={`${node.name}/${dir.name}`} node={dir} />)}
        {node.files.map((file) => (
          <div className="repo-tree-file" style={{ "--depth": file.depth }} key={`${node.name}/${file.name}`}>
            <FileIcon name={file.name} kind="file" />
            <span className="tree-row-label">{file.name}</span>
          </div>
        ))}
      </div>
    </details>
  );
}

function RepoFilesTreeView({ model }) {
  if (!model || model.empty) {
    return <div className="empty">{model?.emptyText || "No files found."}</div>;
  }

  return <>{model.nodes.map((node) => <RepoTreeDir key={node.key} node={node} />)}</>;
}

export function setupReactBridge() {
  const workspaceHost = document.getElementById("workspaceList");
  const tabHost = document.getElementById("tabBar");
  const providerHost = document.getElementById("providerBar");
  const taskHeaderHost = document.getElementById("taskHeader");
  const stagedHost = document.getElementById("stagedList");
  const unstagedHost = document.getElementById("unstagedList");
  const commitsHost = document.getElementById("commitsList");
  const repoFilesHost = document.getElementById("repoFilesTree");

  const workspaceRoot = workspaceHost ? createRoot(workspaceHost) : null;
  const tabRoot = tabHost ? createRoot(tabHost) : null;
  const providerRoot = providerHost ? createRoot(providerHost) : null;
  const taskHeaderRoot = taskHeaderHost ? createRoot(taskHeaderHost) : null;
  const stagedRoot = stagedHost ? createRoot(stagedHost) : null;
  const unstagedRoot = unstagedHost ? createRoot(unstagedHost) : null;
  const commitsRoot = commitsHost ? createRoot(commitsHost) : null;
  const repoFilesRoot = repoFilesHost ? createRoot(repoFilesHost) : null;

  window.__PHASR_REACT_BRIDGE__ = {
    renderWorkspaces(model) {
      if (!workspaceRoot) return;
      workspaceRoot.render(<WorkspaceListView model={model} />);
    },
    renderTabs(model) {
      if (!tabRoot) return;
      tabRoot.render(<TabBarView model={model} />);
    },
    renderProviderBar(model) {
      if (!providerRoot) return;
      providerRoot.render(<ProviderBarView model={model} />);
    },
    renderTaskHeader(model) {
      if (!taskHeaderRoot) return;
      taskHeaderRoot.render(<TaskHeaderView model={model} />);
    },
    renderStagedChanges(model) {
      if (!stagedRoot) return;
      stagedRoot.render(<ChangeListView model={model} mode="staged" />);
    },
    renderUnstagedChanges(model) {
      if (!unstagedRoot) return;
      unstagedRoot.render(<ChangeListView model={model} mode="unstaged" />);
    },
    renderCommits(model) {
      if (!commitsRoot) return;
      commitsRoot.render(<CommitsView model={model} />);
    },
    renderRepoFilesTree(model) {
      if (!repoFilesRoot) return;
      repoFilesRoot.render(<RepoFilesTreeView model={model} />);
    },
  };
}
