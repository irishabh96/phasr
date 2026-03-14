    const AGENT_COMMANDS = {
      claude: "claude",
      codex: "codex --model gpt-5",
      copilot: "copilot",
      opencode: "opencode",
      gemini: "gemini",
    };

    let tasksCache = [];
    let workspaces = [];
    let activeWorkspace = "default";
    let openTabs = [];
    let activeTabId = "";
    let activeStream = null;
    let launchingAgent = false;
    let rightPanelMode = "changes";
    const expandedWorkspaces = new Set();
    let workspaceExpansionInitialized = false;

    let terminal = null;
    let fitAddon = null;
    let terminalReady = false;
    let inputBuffer = "";
    let flushTimer = null;

    let currentGitStatus = { staged: [], unstaged: [] };
    let selectedPatchFile = "";
    let centerViewMode = "terminal";

    const workspaceListEl = document.getElementById("workspaceList");

    const agentSelectEl = document.getElementById("agentSelect");
    const commandInputEl = document.getElementById("commandInput");
    const presetSelectEl = document.getElementById("presetSelect");
    const repoInputEl = document.getElementById("repoInput");
    const taskNameInputEl = document.getElementById("taskNameInput");
    const tagInputEl = document.getElementById("tagInput");
    const promptInputEl = document.getElementById("promptInput");

    const tabBarEl = document.getElementById("tabBar");
    const terminalOverlayEl = document.getElementById("terminalOverlay");
    const terminalMetaEl = document.getElementById("terminalMeta");

    const gitTaskLabelEl = document.getElementById("gitTaskLabel");
    const stagedCountChipEl = document.getElementById("stagedCountChip");
    const unstagedCountChipEl = document.getElementById("unstagedCountChip");
    const stagedSectionLabelEl = document.getElementById("stagedSectionLabel");
    const unstagedSectionLabelEl = document.getElementById("unstagedSectionLabel");
    const unstagedListEl = document.getElementById("unstagedList");
    const stagedListEl = document.getElementById("stagedList");
    const rightTabChangesEl = document.getElementById("rightTabChanges");
    const rightTabFilesEl = document.getElementById("rightTabFiles");
    const changesPanelEl = document.getElementById("changesPanel");
    const filesPanelEl = document.getElementById("filesPanel");
    const repoFilesMetaEl = document.getElementById("repoFilesMeta");
    const repoFilesTreeEl = document.getElementById("repoFilesTree");
    const patchPreviewEl = document.getElementById("patchPreview");
    const terminalPanelEl = document.getElementById("terminalPanel");
    const workspaceGroupCountEl = document.getElementById("workspaceGroupCount");
    const providerBarEl = document.getElementById("providerBar");
    const taskTitleTextEl = document.getElementById("taskTitleText");
    const taskStatusDotEl = document.getElementById("taskStatusDot");
    const runAgentBtnEl = document.getElementById("runAgentBtn");

    const workspaceModalBackdropEl = document.getElementById("workspaceModalBackdrop");
    const workspaceModalNameEl = document.getElementById("workspaceModalName");
    const workspaceModalRepoEl = document.getElementById("workspaceModalRepo");
    const workspaceModalErrorEl = document.getElementById("workspaceModalError");
    const workspaceModalBrowseBtnEl = document.getElementById("workspaceModalBrowseBtn");
    const workspaceModalCreateBtnEl = document.getElementById("workspaceModalCreateBtn");
    const workspaceModalCloseBtnEl = document.getElementById("workspaceModalCloseBtn");
    const workspaceModalCancelBtnEl = document.getElementById("workspaceModalCancelBtn");
    const workspaceInitPromptEl = document.getElementById("workspaceInitPrompt");
    const workspaceInitPromptYesBtnEl = document.getElementById("workspaceInitPromptYesBtn");
    const workspaceInitPromptBrowseBtnEl = document.getElementById("workspaceInitPromptBrowseBtn");

    let pendingWorkspaceCreate = null;

    function escapeHtml(value) {
      return String(value || "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
    }

    function parseTags(input) {
      return String(input || "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)
        .filter((item, idx, arr) => arr.findIndex((x) => x.toLowerCase() === item.toLowerCase()) === idx);
    }

    function statusClass(status) {
      return `status-${status || "pending"}`;
    }

    function syncProviderPills() {
      if (!providerBarEl) return;
      const selected = agentSelectEl.value;
      providerBarEl.querySelectorAll("[data-provider-pill]").forEach((pill) => {
        pill.classList.toggle("active", pill.dataset.providerPill === selected);
      });
    }

    function updateTaskHeader(task = null) {
      const nextTask = task || getTask(activeTabId);
      if (!nextTask) {
        taskTitleTextEl.textContent = "make this an desktop app";
        taskStatusDotEl.classList.add("active");
        return;
      }
      taskTitleTextEl.textContent = nextTask.name || "untitled task";
      taskStatusDotEl.classList.toggle("active", nextTask.status === "running" || nextTask.status === "pending");
    }

    function setPatchPreviewMessage(message) {
      patchPreviewEl.innerHTML = `<div class="diff-empty">${escapeHtml(message)}</div>`;
    }

    function setMainViewMode(mode) {
      centerViewMode = mode === "diff" ? "diff" : "terminal";
      const showDiff = centerViewMode === "diff";
      patchPreviewEl.classList.toggle("hidden", !showDiff);
      terminalPanelEl.classList.toggle("hidden", showDiff);
      if (!showDiff) {
        setTimeout(() => {
          resizeTerminalForActiveTab().catch(() => {});
        }, 0);
      }
    }

    function statusBadgeClass(status) {
      const value = String(status || "").toLowerCase();
      if (value.startsWith("a")) return "added";
      if (value.startsWith("d")) return "deleted";
      return "modified";
    }

    function closestFromEvent(event, selector) {
      const target = event?.target;
      if (target instanceof Element) return target.closest(selector);
      if (target && target.parentElement) return target.parentElement.closest(selector);
      return null;
    }

    function parseHunkHeader(line) {
      const match = String(line || "").match(/^@@\s*-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s*@@/);
      if (!match) return null;
      return {
        oldStart: Number(match[1] || 0),
        newStart: Number(match[2] || 0),
      };
    }

    function buildSideBySideRows(patch) {
      const rows = [];
      const lines = String(patch || "").replaceAll("\r\n", "\n").split("\n");
      let oldLine = 0;
      let newLine = 0;

      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        if (!line) continue;
        if (line.startsWith("diff --git") || line.startsWith("index ") || line.startsWith("---") || line.startsWith("+++")) {
          continue;
        }

        if (line.startsWith("@@")) {
          const header = parseHunkHeader(line);
          if (header) {
            oldLine = header.oldStart;
            newLine = header.newStart;
          }
          rows.push({
            leftNo: "",
            rightNo: "",
            leftText: line,
            rightText: line,
            leftType: "hunk",
            rightType: "hunk",
          });
          continue;
        }

        if (line.startsWith(" ")) {
          rows.push({
            leftNo: String(oldLine++),
            rightNo: String(newLine++),
            leftText: line.slice(1),
            rightText: line.slice(1),
            leftType: "context",
            rightType: "context",
          });
          continue;
        }

        const isRemoval = line.startsWith("-") && !line.startsWith("---");
        const isAddition = line.startsWith("+") && !line.startsWith("+++");
        if (!isRemoval && !isAddition) {
          continue;
        }

        const removed = [];
        const added = [];
        if (isRemoval) {
          while (i < lines.length && lines[i].startsWith("-") && !lines[i].startsWith("---")) {
            removed.push(lines[i].slice(1));
            i += 1;
          }
          while (i < lines.length && lines[i].startsWith("+") && !lines[i].startsWith("+++")) {
            added.push(lines[i].slice(1));
            i += 1;
          }
          i -= 1;
        } else {
          while (i < lines.length && lines[i].startsWith("+") && !lines[i].startsWith("+++")) {
            added.push(lines[i].slice(1));
            i += 1;
          }
          i -= 1;
        }

        const rowCount = Math.max(removed.length, added.length);
        for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
          const leftText = removed[rowIndex];
          const rightText = added[rowIndex];
          rows.push({
            leftNo: leftText === undefined ? "" : String(oldLine++),
            rightNo: rightText === undefined ? "" : String(newLine++),
            leftText: leftText ?? "",
            rightText: rightText ?? "",
            leftType: leftText === undefined ? "empty" : "removed",
            rightType: rightText === undefined ? "empty" : "added",
          });
        }
      }

      return rows;
    }

    function renderPatchDiff(path, stat, patch) {
      const cleanPath = String(path || "").trim();
      const segments = cleanPath.split("/").filter(Boolean);
      const fileName = segments.length ? segments[segments.length - 1] : cleanPath || "Diff";
      const parentPath = segments.length > 1 ? segments.slice(0, -1).join("/") : "(root)";
      const statLine = String(stat || "")
        .split("\n")
        .map((line) => line.trim())
        .find(Boolean) || "";

      const rows = buildSideBySideRows(patch);
      const rowsHtml = rows.length
        ? rows.map((row) => `
            <div class="diff-sbs-row">
              <div class="diff-cell left ${row.leftType}">
                <span class="diff-ln">${escapeHtml(row.leftNo || "")}</span>
                <span class="diff-code">${escapeHtml(row.leftText || " ")}</span>
              </div>
              <div class="diff-cell right ${row.rightType}">
                <span class="diff-ln">${escapeHtml(row.rightNo || "")}</span>
                <span class="diff-code">${escapeHtml(row.rightText || " ")}</span>
              </div>
            </div>
          `).join("")
        : `<div class="diff-empty">No line-level changes available for this selection.</div>`;

      return `
        <div class="diff-editor-head">
          <div class="diff-head-main">
            <div class="diff-file-name">${escapeHtml(fileName)}</div>
            <div class="diff-file-path">${escapeHtml(parentPath)}</div>
          </div>
          <div class="diff-head-right">
            <span class="diff-head-mode">Changes</span>
            ${statLine ? `<span class="diff-head-stat">${escapeHtml(statLine)}</span>` : ""}
            <button class="diff-close-btn" data-diff-close type="button">Terminal</button>
          </div>
        </div>
        <div class="diff-columns-head">
          <div class="pane left">Original</div>
          <div class="pane right">Current</div>
        </div>
        <div class="diff-scroll">${rowsHtml}</div>
      `;
    }

    async function api(url, options = {}) {
      const response = await fetch(url, {
        headers: { "Content-Type": "application/json" },
        ...options,
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.error || `request failed: ${response.status}`);
      }
      return data;
    }

    function getTask(taskId) {
      return tasksCache.find((task) => task.id === taskId) || null;
    }

    function getWorkspace(name) {
      const key = String(name || "").toLowerCase();
      return workspaces.find((workspace) => String(workspace.name || "").toLowerCase() === key) || null;
    }

    function activeWorkspaceRepoPath() {
      const workspace = getWorkspace(activeWorkspace);
      return workspace?.repo_path || "";
    }

    function shortPath(path) {
      const value = String(path || "").trim();
      if (!value) return "-";
      const parts = value.split("/");
      return parts.slice(-2).join("/");
    }

    function syncRepoInputToActiveWorkspace(force = false) {
      const repoPath = activeWorkspaceRepoPath();
      if (!repoPath) {
        if (force) {
          repoInputEl.value = "";
        }
        return;
      }
      if (force || !repoInputEl.value.trim()) {
        repoInputEl.value = repoPath;
      }
    }

    function setWorkspaceModalError(message) {
      workspaceModalErrorEl.textContent = message || "";
      workspaceModalErrorEl.style.color = message ? "var(--red)" : "var(--text-secondary)";
    }

    function hideWorkspaceInitPrompt() {
      pendingWorkspaceCreate = null;
      workspaceInitPromptEl.classList.add("hidden");
    }

    function showWorkspaceInitPrompt(name, repoPath) {
      pendingWorkspaceCreate = { name, repoPath };
      workspaceInitPromptEl.classList.remove("hidden");
    }

    function openWorkspaceModal() {
      workspaceModalNameEl.value = "";
      workspaceModalRepoEl.value = "";
      setWorkspaceModalError("");
      hideWorkspaceInitPrompt();
      workspaceModalBackdropEl.classList.remove("hidden");
      setTimeout(() => {
        workspaceModalNameEl.focus();
      }, 0);
    }

    function closeWorkspaceModal() {
      workspaceModalBackdropEl.classList.add("hidden");
    }

    async function browseWorkspaceRepoIntoModal() {
      setWorkspaceModalError("");
      const picked = await api("/api/local/browse-directory", { method: "POST" });
      const path = String(picked.path || "").trim();
      if (!path) {
        throw new Error("No folder selected.");
      }
      workspaceModalRepoEl.value = path;
      return path;
    }

    function tasksForWorkspace(workspace) {
      return tasksCache
        .filter((task) => (task.workspace || "default") === workspace)
        .sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());
    }

    function ensureTerminal() {
      if (terminalReady) return;
      terminal = new Terminal({
        convertEol: false,
        cursorBlink: true,
        fontFamily: '"JetBrains Mono", "SF Mono", Menlo, Consolas, monospace',
        fontSize: 12,
        lineHeight: 1.2,
        scrollback: 40000,
        theme: {
          background: "#120F0E",
          foreground: "#E8E1DB",
          cursor: "#D59B1A",
          black: "#1A1513",
          red: "#C65C5C",
          green: "#31B36E",
          yellow: "#D59B1A",
          blue: "#79A7FF",
          magenta: "#BE9AD3",
          cyan: "#86B7A2",
          white: "#D9CFC7",
          brightBlack: "#7D726B",
          brightRed: "#E18989",
          brightGreen: "#6FD09A",
          brightYellow: "#E4B85F",
          brightBlue: "#A4C2FF",
          brightMagenta: "#D3B6E2",
          brightCyan: "#A4D3C1",
          brightWhite: "#F3ECE6",
        },
      });

      fitAddon = new FitAddon.FitAddon();
      terminal.loadAddon(fitAddon);
      terminal.open(document.getElementById("terminal"));
      fitAddon.fit();

      terminal.onData((data) => {
        const task = getTask(activeTabId);
        if (!task || task.status !== "running") return;
        inputBuffer += data;
        scheduleInputFlush();
      });

      terminalReady = true;
    }

    function scheduleInputFlush() {
      if (flushTimer) return;
      flushTimer = setTimeout(async () => {
        flushTimer = null;
        const chunk = inputBuffer;
        inputBuffer = "";
        if (!chunk || !activeTabId) return;
        try {
          await api(`/api/tasks/${activeTabId}/terminal/input`, {
            method: "POST",
            body: JSON.stringify({ input: chunk, append_newline: false }),
          });
        } catch (error) {
          console.error(error);
        }
      }, 25);
    }

    function setTerminalOverlay(message, show = true) {
      terminalOverlayEl.textContent = message;
      terminalOverlayEl.style.display = show ? "flex" : "none";
    }

    async function resizeTerminalForActiveTab() {
      if (centerViewMode !== "terminal") return;
      const task = getTask(activeTabId);
      if (!task || task.status !== "running" || !terminalReady) return;
      fitAddon.fit();
      await api(`/api/tasks/${activeTabId}/terminal/resize`, {
        method: "POST",
        body: JSON.stringify({ cols: terminal.cols, rows: terminal.rows }),
      });
    }

    function renderWorkspaces() {
      workspaceGroupCountEl.textContent = String(workspaces.length || 0);
      if (!workspaces.length) {
        workspaceListEl.innerHTML = `<div class="empty">No workspaces</div>`;
        return;
      }
      workspaceListEl.innerHTML = workspaces.map((workspace) => {
        const name = workspace.name || "default";
        const workspaceTasks = tasksForWorkspace(name);
        const count = workspaceTasks.length;
        const activeClass = name === activeWorkspace ? "active" : "";
        const isOpen = expandedWorkspaces.has(name);
        const repoPath = workspace.repo_path || "";
        const repoName = shortPath(repoPath) === "-" ? "local" : shortPath(repoPath).split("/").slice(-1)[0];
        const activeBadges = name === activeWorkspace
          ? `<span class="workspace-badges"><span class="badge-add">+2514</span><span class="badge-del">-534</span></span>`
          : `<span class="chip">${count}</span>`;
        const tasksMarkup = workspaceTasks.length
          ? workspaceTasks.map((task) => {
            const isOpenTab = openTabs.includes(task.id);
            const tags = (task.tags || []).map((tag) => `<span class="chip">${escapeHtml(tag)}</span>`).join(" ");
            return `
              <div class="workspace-task-row">
                <div class="name">${escapeHtml(task.name)}</div>
                <div class="workspace-task-meta">
                  <span class="chip ${statusClass(task.status)}">${escapeHtml(task.status)}</span>
                  ${tags || ""}
                </div>
                <div class="task-actions">
                  <button data-open-tab="${task.id}" type="button">${isOpenTab ? "Focus" : "Open Tab"}</button>
                  <button data-open-editor="${task.id}" type="button">Editor</button>
                  ${task.status === "running"
                    ? `<button data-stop="${task.id}" type="button">Stop</button>`
                    : `<button data-resume="${task.id}" type="button">Resume</button>`}
                </div>
              </div>
            `;
          }).join("")
          : `<div class="empty">No tasks in this workspace.</div>`;
        return `
          <details class="workspace-node ${activeClass}" data-workspace-node="${escapeHtml(name)}" ${isOpen ? "open" : ""}>
            <summary class="workspace-summary" data-workspace-summary="${escapeHtml(name)}" title="${escapeHtml(repoPath)}">
              <span class="workspace-main">
                <span class="workspace-name">${escapeHtml(name)}</span>
                <span class="workspace-branch">master</span>
              </span>
              <span class="workspace-repo-row">
                <span>${escapeHtml(repoName)}</span>
                ${activeBadges}
              </span>
            </summary>
            <div class="workspace-task-list">
              ${tasksMarkup}
            </div>
          </details>
        `;
      }).join("");
    }

    function renderWorkspaceTasks() {
      // tasks are rendered inline under each workspace node
    }

    function renderTabs() {
      const dynamicTabs = openTabs
        .map((taskId) => getTask(taskId))
        .filter(Boolean)
        .map((task) => {
          const active = task.id === activeTabId ? "active" : "";
          return `
            <div class="tab ${active}" data-tab="${task.id}">
              <span class="chip ${statusClass(task.status)}">${escapeHtml(task.status)}</span>
              <span>${escapeHtml(task.name)}</span>
              <button class="tab-close" data-close-tab="${task.id}" type="button">x</button>
            </div>
          `;
        })
        .join("");

      const emptyHint = openTabs.length ? "" : `<div class="tabs-empty">No open tabs</div>`;
      tabBarEl.innerHTML = `
        <div class="tab-list">
          ${dynamicTabs}
          <button class="tab plus-tab" type="button" aria-label="New tab">+</button>
        </div>
        ${emptyHint}
      `;
    }

    function closeTab(taskId) {
      openTabs = openTabs.filter((id) => id !== taskId);
      if (activeTabId !== taskId) {
        renderTabs();
        return;
      }
      if (!openTabs.length) {
        detachStream();
        activeTabId = "";
        terminalMetaEl.textContent = "No active tab";
        gitTaskLabelEl.textContent = "No task";
        currentGitStatus = { staged: [], unstaged: [] };
        renderGitStatus();
        setPatchPreviewMessage("Select a changed file to open a diff view.");
        updateTaskHeader(null);
        if (terminal) {
          terminal.clear();
          terminal.reset();
        }
        setMainViewMode("terminal");
        setTerminalOverlay("Open a task in this workspace to attach terminal.", true);
        renderTabs();
        if (rightPanelMode === "files") {
          loadRepoFiles().catch((error) => console.error(error));
        }
        return;
      }
      selectTab(openTabs[openTabs.length - 1]).catch((error) => alert(error.message || String(error)));
    }

    function openTab(taskId) {
      if (!openTabs.includes(taskId)) {
        openTabs.push(taskId);
      }
      selectTab(taskId).catch((error) => alert(error.message || String(error)));
    }

    function detachStream() {
      if (activeStream) {
        activeStream.close();
        activeStream = null;
      }
      inputBuffer = "";
    }

    async function selectTab(taskId) {
      const task = getTask(taskId);
      if (!task) return;

      activeTabId = taskId;
      renderTabs();

      ensureTerminal();
      terminal.clear();
      terminal.reset();
      detachStream();
      selectedPatchFile = "";
      setPatchPreviewMessage("Select a changed file to open a diff view.");
      setMainViewMode("terminal");

      terminalMetaEl.textContent = `${task.name} | ${task.workspace || "default"} | ${task.repo_path}`;
      updateTaskHeader(task);

      if (task.status === "running") {
        setTerminalOverlay("Connecting to terminal stream...", true);
      } else {
        setTerminalOverlay("Task is not running. Resume to use terminal.", true);
      }

      attachStream(taskId);
      await refreshGitStatus();
      if (rightPanelMode === "files") {
        await loadRepoFiles();
      }
      await resizeTerminalForActiveTab().catch(() => {});
    }

    function attachStream(taskId) {
      activeStream = new EventSource(`/api/tasks/${taskId}/events`);

      activeStream.addEventListener("bootstrap", (event) => {
        if (activeTabId !== taskId) return;
        const data = JSON.parse(event.data || "{}");
        if (typeof data.logs === "string" && data.logs.length > 0) {
          terminal.write(data.logs);
        }
        const task = getTask(taskId);
        if (task && task.status === "running") {
          setTerminalOverlay("", false);
        }
      });

      activeStream.addEventListener("log", (event) => {
        if (activeTabId !== taskId) return;
        const data = JSON.parse(event.data || "{}");
        if (!data.message) return;
        terminal.write(data.message);
        setTerminalOverlay("", false);
      });

      activeStream.addEventListener("status", async () => {
        await loadTasks({ keepTab: true });
        if (activeTabId !== taskId) return;
        const task = getTask(taskId);
        if (!task) return;

        terminalMetaEl.textContent = `${task.name} | ${task.workspace || "default"} | ${task.repo_path}`;
        updateTaskHeader(task);

        if (task.status === "running") {
          setTerminalOverlay("", false);
          await resizeTerminalForActiveTab().catch(() => {});
        } else {
          setTerminalOverlay("Task is not running. Resume to use terminal.", true);
        }

        await refreshGitStatus();
        if (rightPanelMode === "files") {
          await loadRepoFiles();
        }
      });

      activeStream.onerror = () => {
        if (activeStream) {
          activeStream.close();
          activeStream = null;
        }
        if (activeTabId === taskId) {
          setTerminalOverlay("Terminal stream disconnected. Re-open tab to reconnect.", true);
        }
      };
    }

    async function loadPresets() {
      const data = await api("/api/presets");
      const presets = data.presets || [];
      if (!presets.length) {
        presetSelectEl.innerHTML = `<option value="none">none</option>`;
        return;
      }
      presetSelectEl.innerHTML = presets
        .map((preset) => `<option value="${escapeHtml(preset.name)}">${escapeHtml(preset.name)} - ${escapeHtml(preset.description || "")}</option>`)
        .join("");
    }

    async function loadWorkspaces() {
      const data = await api("/api/workspaces");
      workspaces = Array.isArray(data.workspaces) ? data.workspaces : [];
      if (!workspaces.length) {
        workspaces = [{ name: "default", repo_path: "" }];
      }
      if (!getWorkspace(activeWorkspace)) {
        activeWorkspace = workspaces[0]?.name || "default";
        expandedWorkspaces.add(activeWorkspace);
      }
      if (!workspaceExpansionInitialized) {
        expandedWorkspaces.add(activeWorkspace);
        workspaceExpansionInitialized = true;
      }
      renderWorkspaces();
      renderWorkspaceTasks();
      syncRepoInputToActiveWorkspace(true);
      if (rightPanelMode === "files" && !activeTabId) {
        loadRepoFiles().catch((error) => console.error(error));
      }
    }

    async function loadTasks({ keepTab = true } = {}) {
      const data = await api("/api/tasks");
      tasksCache = data.tasks || [];

      if (!tasksCache.some((task) => (task.workspace || "default") === activeWorkspace)) {
        if (getWorkspace(activeWorkspace)) {
          // keep active workspace even if empty
        } else {
          activeWorkspace = workspaces[0]?.name || "default";
          expandedWorkspaces.add(activeWorkspace);
        }
      }

      openTabs = openTabs.filter((id) => !!getTask(id));
      if (!keepTab) {
        activeTabId = "";
      } else if (activeTabId && !getTask(activeTabId)) {
        activeTabId = openTabs[0] || "";
      }

      renderWorkspaces();
      renderWorkspaceTasks();
      renderTabs();
      updateTaskHeader();
      if (!activeTabId) {
        setPatchPreviewMessage("Select a changed file to open a diff view.");
      }
    }

    async function refreshGitStatus() {
      if (!activeTabId) {
        currentGitStatus = { staged: [], unstaged: [] };
        renderGitStatus();
        return;
      }
      try {
        const data = await api(`/api/tasks/${activeTabId}/git/status`);
        currentGitStatus = {
          staged: data.staged || [],
          unstaged: data.unstaged || [],
        };
      } catch (error) {
        currentGitStatus = { staged: [], unstaged: [] };
        console.error(error);
      }
      renderGitStatus();
    }

    function SidebarSectionHeader(title, count) {
      return `${title} ${count}`;
    }

    function TreeChevron() {
      return `<span class="tree-chevron" aria-hidden="true">▸</span>`;
    }

    function fileIconType(name, kind = "file") {
      if (kind === "dir") {
        return { label: "dir", cls: "dir" };
      }
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

    function FileIcon(name, kind = "file") {
      const icon = fileIconType(name, kind);
      const cls = icon.cls ? ` ${icon.cls}` : "";
      return `<span class="file-icon${cls}" aria-hidden="true">${icon.label}</span>`;
    }

    function FolderGroupLabel(label) {
      return `
        <div class="change-group-label">
          ${FileIcon(label, "dir")}
          <span class="tree-row-label">${escapeHtml(label)}</span>
        </div>
      `;
    }

    function ChangedFileRow(change, mode) {
      const path = String(change.path || "");
      const parts = path.split("/").filter(Boolean);
      const name = parts.length ? parts[parts.length - 1] : path;
      const statusClassName = statusBadgeClass(change.status || "modified");
      const actionClass = mode === "unstaged" ? "stage" : "unstage";
      const actionSymbol = mode === "unstaged" ? "+" : "−";
      const actionAttr = mode === "unstaged"
        ? `data-stage-file="${escapeHtml(path)}"`
        : `data-unstage-file="${escapeHtml(path)}"`;
      const actionLabel = mode === "unstaged" ? "Stage file" : "Unstage file";
      const add = Number(change.added || 0);
      const del = Number(change.deleted || 0);
      const selectedClass = selectedPatchFile === path ? " selected" : "";

      return `
        <div class="change-file-row${selectedClass}" data-patch-file="${escapeHtml(path)}">
          <div class="change-file-main">
            <span class="change-status-icon ${statusClassName}" aria-hidden="true"></span>
            <span class="change-file-name">${escapeHtml(name)}</span>
            <span class="change-inline-counts">
              <span class="add">+${add}</span>
              <span class="del">-${del}</span>
            </span>
          </div>
          <div class="tree-row-right">
            <button class="tree-action-btn ${actionClass}" ${actionAttr} aria-label="${actionLabel}" type="button">${actionSymbol}</button>
          </div>
        </div>
      `;
    }

    function groupChangesByFolder(list) {
      const grouped = new Map();
      (list || []).forEach((change) => {
        const path = String(change.path || "").trim();
        if (!path) return;
        const parts = path.split("/").filter(Boolean);
        const folder = parts.length > 1 ? parts.slice(0, -1).join("/") : "(root)";
        if (!grouped.has(folder)) {
          grouped.set(folder, []);
        }
        grouped.get(folder).push(change);
      });

      const folders = [...grouped.keys()].sort((a, b) => {
        if (a === "(root)") return -1;
        if (b === "(root)") return 1;
        return a.localeCompare(b);
      });

      return folders.map((folder) => ({
        folder,
        changes: grouped.get(folder).slice().sort((a, b) => String(a.path || "").localeCompare(String(b.path || ""))),
      }));
    }

    function renderChangeList(list, mode) {
      if (!list.length) {
        return `<div class="empty">No ${mode} changes.</div>`;
      }

      return groupChangesByFolder(list).map((group) => `
        <div class="change-group">
          ${FolderGroupLabel(group.folder)}
          <div class="change-group-files">
            ${group.changes.map((change) => ChangedFileRow(change, mode)).join("")}
          </div>
        </div>
      `).join("");
    }

    function createRepoTreeNode(name = "") {
      return { name, dirs: new Map(), files: [] };
    }

    function buildRepoTree(entries) {
      const root = createRepoTreeNode();
      (entries || []).forEach((entry) => {
        const kind = String(entry.kind || "file").toLowerCase();
        const path = String(entry.path || "").trim();
        if (!path) return;
        const parts = path.split("/").filter(Boolean);
        if (!parts.length) return;

        let node = root;
        for (let i = 0; i < parts.length; i += 1) {
          const part = parts[i];
          const isLast = i === parts.length - 1;
          if (isLast) {
            if (kind === "dir") {
              if (!node.dirs.has(part)) {
                node.dirs.set(part, createRepoTreeNode(part));
              }
            } else {
              node.files.push(part);
            }
          } else {
            if (!node.dirs.has(part)) {
              node.dirs.set(part, createRepoTreeNode(part));
            }
            node = node.dirs.get(part);
          }
        }
      });
      return root;
    }

    function FileTreeRow({ name, kind = "file", depth = 0, open = false, children = "" }) {
      if (kind === "dir") {
        return `
          <details class="repo-tree-dir" ${open ? "open" : ""} style="--depth:${depth};">
            <summary>
              ${TreeChevron()}
              ${FileIcon(name, "dir")}
              <span class="tree-row-label">${escapeHtml(name)}</span>
            </summary>
            <div class="repo-tree-children">${children}</div>
          </details>
        `;
      }
      return `
        <div class="repo-tree-file" style="--depth:${depth};">
          ${FileIcon(name, "file")}
          <span class="tree-row-label">${escapeHtml(name)}</span>
        </div>
      `;
    }

    function renderRepoTreeNode(name, node, depth = 0) {
      const dirs = [...node.dirs.values()].sort((a, b) => a.name.localeCompare(b.name));
      const files = [...node.files].sort((a, b) => a.localeCompare(b));
      const children = [
        ...dirs.map((child) => renderRepoTreeNode(child.name, child, depth + 1)),
        ...files.map((file) => FileTreeRow({ name: file, kind: "file", depth: depth + 1 })),
      ].join("");
      return FileTreeRow({ name, kind: "dir", depth, open: depth < 2, children });
    }

    function renderRepoFilesTree(entries) {
      if (!entries?.length) {
        repoFilesTreeEl.innerHTML = `<div class="empty">No files found.</div>`;
        return;
      }
      const rootTree = buildRepoTree(entries);
      const parts = [];

      if (rootTree.files.length) {
        const rootNode = createRepoTreeNode("(root)");
        rootNode.files = [...rootTree.files];
        parts.push(renderRepoTreeNode("(root)", rootNode, 0));
      }

      const topDirs = [...rootTree.dirs.values()].sort((a, b) => a.name.localeCompare(b.name));
      topDirs.forEach((node) => {
        parts.push(renderRepoTreeNode(node.name, node, 0));
      });

      repoFilesTreeEl.innerHTML = parts.join("");
    }

    async function loadRepoFiles() {
      const workspace = getWorkspace(activeWorkspace);
      const workspaceName = workspace?.name || activeWorkspace;
      const workspaceRepo = workspace?.repo_path || activeWorkspaceRepoPath();

      let endpoint = "";
      if (activeTabId) {
        endpoint = `/api/tasks/${activeTabId}/files`;
      } else if (workspaceName) {
        endpoint = `/api/workspaces/${encodeURIComponent(workspaceName)}/files`;
      }

      if (!endpoint) {
        repoFilesMetaEl.textContent = "No active workspace";
        repoFilesTreeEl.innerHTML = `<div class="empty">Select a workspace to view files.</div>`;
        return;
      }

      repoFilesMetaEl.textContent = "Loading files...";
      try {
        const data = await api(endpoint);
        const task = getTask(activeTabId);
        const root = String(data.root || task?.repo_path || workspaceRepo || "");
        repoFilesMetaEl.textContent = root || "Repository files";
        renderRepoFilesTree(data.entries || []);
      } catch (error) {
        repoFilesMetaEl.textContent = "Files";
        repoFilesTreeEl.innerHTML = `<div class="empty">${escapeHtml(error.message || String(error))}</div>`;
      }
    }

    function setRightPanelMode(mode) {
      rightPanelMode = mode === "files" ? "files" : "changes";
      const filesActive = rightPanelMode === "files";
      rightTabFilesEl.classList.toggle("active", filesActive);
      rightTabChangesEl.classList.toggle("active", !filesActive);
      filesPanelEl.classList.toggle("hidden", !filesActive);
      changesPanelEl.classList.toggle("hidden", filesActive);
      if (filesActive) {
        loadRepoFiles().catch((error) => console.error(error));
      }
    }

    function renderGitStatus() {
      const task = getTask(activeTabId);
      gitTaskLabelEl.textContent = task ? task.name : "No task";

      const staged = currentGitStatus.staged || [];
      const unstaged = currentGitStatus.unstaged || [];

      stagedCountChipEl.textContent = SidebarSectionHeader("Staged", staged.length);
      unstagedCountChipEl.textContent = SidebarSectionHeader("Unstaged", unstaged.length);
      stagedSectionLabelEl.textContent = SidebarSectionHeader("Staged", staged.length);
      unstagedSectionLabelEl.textContent = SidebarSectionHeader("Unstaged", unstaged.length);

      stagedListEl.innerHTML = renderChangeList(staged, "staged");
      unstagedListEl.innerHTML = renderChangeList(unstaged, "unstaged");
    }

    async function loadPatch(path) {
      if (!activeTabId) return;
      const targetPath = String(path || "").trim();
      selectedPatchFile = targetPath;
      renderGitStatus();
      if (!targetPath) {
        setMainViewMode("terminal");
        return;
      }
      try {
        const query = `?file=${encodeURIComponent(targetPath)}`;
        const data = await api(`/api/tasks/${activeTabId}/diff${query}`);
        const stat = data.stat || `Diff: ${targetPath}`;
        patchPreviewEl.innerHTML = renderPatchDiff(targetPath, stat, data.patch || "");
        setMainViewMode("diff");
      } catch (error) {
        setPatchPreviewMessage(error.message || String(error));
        setMainViewMode("diff");
      }
    }

    async function autoCreateTaskForWorkspace(workspace) {
      const workspaceName = workspace?.name || activeWorkspace;
      const workspaceRepoPath = workspace?.repo_path || "";
      const command = commandInputEl.value.trim();
      if (!command) {
        throw new Error("Agent command is required to auto-create workspace task.");
      }
      if (!workspaceRepoPath) {
        throw new Error("Workspace repo path is missing.");
      }

      const payload = {
        name: `${workspaceName}-session`,
        workspace: workspaceName,
        tags: [],
        repo_path: workspaceRepoPath,
        command,
        prompt: promptInputEl.value,
        preset: presetSelectEl.value,
        direct_repo: true,
      };

      const result = await api("/api/tasks", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      return result.task || null;
    }

    async function createQuickTaskForAgent(agent) {
      if (launchingAgent) return;
      launchingAgent = true;
      if (runAgentBtnEl) runAgentBtnEl.disabled = true;
      const promptSnapshot = promptInputEl.value;

      try {
        const selectedAgent = AGENT_COMMANDS[agent] ? agent : agentSelectEl.value;
        agentSelectEl.value = selectedAgent;
        syncProviderPills();

        const command = AGENT_COMMANDS[selectedAgent] || commandInputEl.value.trim();
        commandInputEl.value = command;

        const workspaceRepoPath = activeWorkspaceRepoPath();
        const payload = {
          name: `${selectedAgent}-session`,
          workspace: activeWorkspace,
          tags: parseTags(tagInputEl.value),
          repo_path: workspaceRepoPath || repoInputEl.value,
          command,
          prompt: promptSnapshot,
          preset: presetSelectEl.value,
          direct_repo: true,
        };

        const result = await api("/api/tasks", {
          method: "POST",
          body: JSON.stringify(payload),
        });

        await loadTasks({ keepTab: true });
        await loadWorkspaces();
        if (result.task && result.task.id) {
          openTab(result.task.id);
          if (String(promptSnapshot || "").trim()) {
            promptInputEl.value = "";
          }
        }
      } finally {
        launchingAgent = false;
        if (runAgentBtnEl) runAgentBtnEl.disabled = false;
      }
    }

    async function runTaskAction(action, taskId) {
      if (!taskId) return;
      try {
        if (action === "stop") {
          await api(`/api/tasks/${taskId}/stop`, { method: "POST" });
        }
        if (action === "resume") {
          await api(`/api/tasks/${taskId}/resume`, { method: "POST" });
        }
        if (action === "open-editor") {
          await api(`/api/tasks/${taskId}/open-editor`, {
            method: "POST",
            body: JSON.stringify({}),
          });
        }
        await loadTasks({ keepTab: true });
        await refreshGitStatus();
      } catch (error) {
        alert(error.message || String(error));
      }
    }

    function moveChangeBetweenLists(path, fromKey, toKey) {
      const from = currentGitStatus[fromKey] || [];
      const index = from.findIndex((item) => item.path === path);
      if (index < 0) return false;
      const [item] = from.splice(index, 1);
      const to = currentGitStatus[toKey] || [];
      to.unshift(item);
      currentGitStatus[toKey] = to;
      renderGitStatus();
      return true;
    }

    async function stageFile(path) {
      if (!activeTabId) return;
      const moved = moveChangeBetweenLists(path, "unstaged", "staged");
      try {
        await api(`/api/tasks/${activeTabId}/git/stage`, {
          method: "POST",
          body: JSON.stringify({ path }),
        });
        if (selectedPatchFile === path) {
          await loadPatch(path);
        }
      } catch (error) {
        if (moved) {
          moveChangeBetweenLists(path, "staged", "unstaged");
        }
        alert(error.message || String(error));
      } finally {
        await refreshGitStatus();
      }
    }

    async function unstageFile(path) {
      if (!activeTabId) return;
      const moved = moveChangeBetweenLists(path, "staged", "unstaged");
      try {
        await api(`/api/tasks/${activeTabId}/git/unstage`, {
          method: "POST",
          body: JSON.stringify({ path }),
        });
        if (selectedPatchFile === path) {
          await loadPatch(path);
        }
      } catch (error) {
        if (moved) {
          moveChangeBetweenLists(path, "unstaged", "staged");
        }
        alert(error.message || String(error));
      } finally {
        await refreshGitStatus();
      }
    }

    async function commitChanges() {
      if (!activeTabId) return;
      const message = document.getElementById("commitMessage").value.trim();
      if (!message) {
        alert("Commit message is required.");
        return;
      }
      try {
        const result = await api(`/api/tasks/${activeTabId}/git/commit`, {
          method: "POST",
          body: JSON.stringify({ message }),
        });
        document.getElementById("commitMessage").value = "";
        await refreshGitStatus();
        await loadPatch(selectedPatchFile);
        alert(result.commit || "Committed");
      } catch (error) {
        alert(error.message || String(error));
      }
    }

    function installEventHandlers() {
      document.getElementById("createWorkspaceBtn").addEventListener("click", () => {
        openWorkspaceModal();
      });
      document.getElementById("topOpenBtn").addEventListener("click", () => {
        openWorkspaceModal();
      });
      document.getElementById("addRepositoryBtn").addEventListener("click", () => {
        openWorkspaceModal();
      });

      workspaceModalCloseBtnEl.addEventListener("click", closeWorkspaceModal);
      workspaceModalCancelBtnEl.addEventListener("click", closeWorkspaceModal);
      workspaceModalBackdropEl.addEventListener("click", (event) => {
        if (event.target === workspaceModalBackdropEl) {
          closeWorkspaceModal();
        }
      });

      workspaceModalBrowseBtnEl.addEventListener("click", async () => {
        hideWorkspaceInitPrompt();
        try {
          await browseWorkspaceRepoIntoModal();
        } catch (error) {
          setWorkspaceModalError(error.message || String(error));
        }
      });

      workspaceModalCreateBtnEl.addEventListener("click", async () => {
        const cleanName = workspaceModalNameEl.value.trim();
        const repoPath = workspaceModalRepoEl.value.trim();
        hideWorkspaceInitPrompt();

        if (!cleanName) {
          setWorkspaceModalError("Workspace name is required.");
          workspaceModalNameEl.focus();
          return;
        }
        if (!repoPath) {
          setWorkspaceModalError("Git repository path is required. Type it or browse local folder.");
          workspaceModalRepoEl.focus();
          return;
        }

        setWorkspaceModalError("");
        workspaceModalCreateBtnEl.disabled = true;
        try {
          let data = await api("/api/workspaces", {
            method: "POST",
            body: JSON.stringify({ name: cleanName, repo_path: repoPath, init_git: false }),
          });
          const createdTask = await autoCreateTaskForWorkspace(data.workspace);

          workspaces = data.workspaces || workspaces;
          activeWorkspace = data.workspace?.name || activeWorkspace;
          expandedWorkspaces.add(activeWorkspace);
          closeWorkspaceModal();
          await loadWorkspaces();
          await loadTasks({ keepTab: true });
          if (createdTask?.id) {
            openTab(createdTask.id);
          }
        } catch (error) {
          const message = error.message || String(error);
          const isNotGitRepo = message.toLowerCase().includes("not a git repo");
          if (isNotGitRepo) {
            setWorkspaceModalError("Selected folder is not a git repo.");
            showWorkspaceInitPrompt(cleanName, repoPath);
            return;
          }

          setWorkspaceModalError(message);
        } finally {
          workspaceModalCreateBtnEl.disabled = false;
        }
      });

      workspaceModalRepoEl.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          workspaceModalCreateBtnEl.click();
        }
      });
      workspaceInitPromptYesBtnEl.addEventListener("click", async () => {
        if (!pendingWorkspaceCreate) return;
        const { name, repoPath } = pendingWorkspaceCreate;
        setWorkspaceModalError("");
        workspaceInitPromptYesBtnEl.disabled = true;
        try {
          const data = await api("/api/workspaces", {
            method: "POST",
            body: JSON.stringify({ name, repo_path: repoPath, init_git: true }),
          });
          const createdTask = await autoCreateTaskForWorkspace(data.workspace);
          workspaces = data.workspaces || workspaces;
          activeWorkspace = data.workspace?.name || activeWorkspace;
          expandedWorkspaces.add(activeWorkspace);
          closeWorkspaceModal();
          await loadWorkspaces();
          await loadTasks({ keepTab: true });
          if (createdTask?.id) {
            openTab(createdTask.id);
          }
        } catch (error) {
          setWorkspaceModalError(error.message || String(error));
        } finally {
          workspaceInitPromptYesBtnEl.disabled = false;
        }
      });
      workspaceInitPromptBrowseBtnEl.addEventListener("click", async () => {
        hideWorkspaceInitPrompt();
        setWorkspaceModalError("");
        try {
          await browseWorkspaceRepoIntoModal();
        } catch (error) {
          setWorkspaceModalError(error.message || String(error));
        }
      });
      workspaceModalNameEl.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          workspaceModalRepoEl.focus();
        }
      });
      window.addEventListener("keydown", (event) => {
        const key = String(event.key || "").toLowerCase();
        if ((event.metaKey || event.ctrlKey) && key === "n") {
          event.preventDefault();
          openWorkspaceModal();
          return;
        }
        if (event.key === "Escape" && !workspaceModalBackdropEl.classList.contains("hidden")) {
          closeWorkspaceModal();
        }
      });

      workspaceListEl.addEventListener("click", async (event) => {
        const openBtn = event.target.closest("button[data-open-tab]");
        if (openBtn) {
          openTab(openBtn.dataset.openTab);
          return;
        }

        const editorBtn = event.target.closest("button[data-open-editor]");
        if (editorBtn) {
          await runTaskAction("open-editor", editorBtn.dataset.openEditor);
          return;
        }

        const stopBtn = event.target.closest("button[data-stop]");
        if (stopBtn) {
          await runTaskAction("stop", stopBtn.dataset.stop);
          return;
        }

        const resumeBtn = event.target.closest("button[data-resume]");
        if (resumeBtn) {
          await runTaskAction("resume", resumeBtn.dataset.resume);
          return;
        }

        const summary = event.target.closest("summary[data-workspace-summary]");
        if (!summary) return;
        event.preventDefault();
        const workspaceName = summary.dataset.workspaceSummary;
        const details = summary.closest("details[data-workspace-node]");
        if (!workspaceName || !details) return;
        if (details.open) {
          expandedWorkspaces.delete(workspaceName);
        } else {
          expandedWorkspaces.add(workspaceName);
        }
        activeWorkspace = workspaceName;
        renderWorkspaces();
        renderWorkspaceTasks();
        syncRepoInputToActiveWorkspace(true);
        if (rightPanelMode === "files") {
          loadRepoFiles().catch((error) => console.error(error));
        }
      });

      tabBarEl.addEventListener("click", (event) => {
        const closeBtn = event.target.closest("button[data-close-tab]");
        if (closeBtn) {
          event.stopPropagation();
          closeTab(closeBtn.dataset.closeTab);
          return;
        }

        const tab = event.target.closest("[data-tab]");
        if (tab) {
          openTab(tab.dataset.tab);
          return;
        }

        const plusTab = event.target.closest(".plus-tab");
        if (plusTab) {
          promptInputEl.focus();
        }
      });

      agentSelectEl.addEventListener("change", () => {
        commandInputEl.value = AGENT_COMMANDS[agentSelectEl.value] || "";
        syncProviderPills();
      });
      providerBarEl.addEventListener("click", async (event) => {
        const pill = event.target.closest("[data-provider-pill]");
        if (!pill) return;
        try {
          await createQuickTaskForAgent(pill.dataset.providerPill);
        } catch (error) {
          alert(error.message || String(error));
        }
      });
      runAgentBtnEl.addEventListener("click", async () => {
        try {
          await createQuickTaskForAgent(agentSelectEl.value);
        } catch (error) {
          alert(error.message || String(error));
        }
      });
      promptInputEl.addEventListener("keydown", async (event) => {
        if (event.key !== "Enter" || event.shiftKey) return;
        event.preventDefault();
        try {
          await createQuickTaskForAgent(agentSelectEl.value);
        } catch (error) {
          alert(error.message || String(error));
        }
      });

      document.getElementById("createTaskForm").addEventListener("submit", async (event) => {
        event.preventDefault();
        try {
          await createQuickTaskForAgent(agentSelectEl.value);
        } catch (error) {
          alert(error.message || String(error));
        }
      });

      document.getElementById("refreshGitBtn").addEventListener("click", () => {
        refreshGitStatus()
          .then(async () => {
            if (rightPanelMode === "files") {
              await loadRepoFiles();
            }
          })
          .catch((error) => alert(error.message || String(error)));
      });

      document.getElementById("commitBtn").addEventListener("click", () => {
        commitChanges().catch((error) => alert(error.message || String(error)));
      });

      rightTabChangesEl.addEventListener("click", () => {
        setRightPanelMode("changes");
      });
      rightTabFilesEl.addEventListener("click", () => {
        setRightPanelMode("files");
      });

      unstagedListEl.addEventListener("click", async (event) => {
        const stageBtn = closestFromEvent(event, "button[data-stage-file]");
        if (stageBtn) {
          event.preventDefault();
          event.stopPropagation();
          const path = stageBtn.getAttribute("data-stage-file") || stageBtn.dataset.stageFile || "";
          if (path) {
            await stageFile(path);
          }
          return;
        }
        const patchTarget = closestFromEvent(event, "[data-patch-file]");
        if (patchTarget) {
          const path = patchTarget.getAttribute("data-patch-file") || patchTarget.dataset.patchFile || "";
          if (path) {
            await loadPatch(path);
          }
        }
      });

      stagedListEl.addEventListener("click", async (event) => {
        const unstageBtn = closestFromEvent(event, "button[data-unstage-file]");
        if (unstageBtn) {
          event.preventDefault();
          event.stopPropagation();
          const path = unstageBtn.getAttribute("data-unstage-file") || unstageBtn.dataset.unstageFile || "";
          if (path) {
            await unstageFile(path);
          }
          return;
        }
        const patchTarget = closestFromEvent(event, "[data-patch-file]");
        if (patchTarget) {
          const path = patchTarget.getAttribute("data-patch-file") || patchTarget.dataset.patchFile || "";
          if (path) {
            await loadPatch(path);
          }
        }
      });

      patchPreviewEl.addEventListener("click", (event) => {
        const closeBtn = closestFromEvent(event, "button[data-diff-close]");
        if (!closeBtn) return;
        event.preventDefault();
        setMainViewMode("terminal");
      });

      document.getElementById("activeOpenEditorBtn").addEventListener("click", async () => {
        if (!activeTabId) return;
        await runTaskAction("open-editor", activeTabId);
      });

      document.getElementById("activeResumeBtn").addEventListener("click", async () => {
        if (!activeTabId) return;
        await runTaskAction("resume", activeTabId);
      });

      document.getElementById("activeStopBtn").addEventListener("click", async () => {
        if (!activeTabId) return;
        await runTaskAction("stop", activeTabId);
      });

      let resizeTimer = null;
      window.addEventListener("resize", () => {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
          resizeTerminalForActiveTab().catch(() => {});
        }, 180);
      });
    }

    async function boot() {
      ensureTerminal();
      setTerminalOverlay("Open a task in this workspace to attach terminal.", true);
      setPatchPreviewMessage("Select a changed file to open a diff view.");
      setMainViewMode("terminal");
      updateTaskHeader(null);

      commandInputEl.value = AGENT_COMMANDS[agentSelectEl.value] || "";
      syncProviderPills();

      await loadPresets();
      await loadWorkspaces();
      await loadTasks({ keepTab: true });
      installEventHandlers();
      setRightPanelMode("changes");

      setInterval(async () => {
        await loadTasks({ keepTab: true });
        if (activeTabId) {
          await refreshGitStatus();
        }
      }, 4000);
    }

    boot().catch((error) => {
      alert(error.message || String(error));
    });
