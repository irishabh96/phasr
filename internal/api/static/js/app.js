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

    // P0-A: ANSI color codes for severity highlighting
    const ANSI_RESET = "\x1b[0m";
    const ANSI_RED = "\x1b[38;2;208;92;92m";     // --red
    const ANSI_YELLOW = "\x1b[38;2;209;154;26m";  // --amber
    const ANSI_GREEN = "\x1b[38;2;39;196;107m";   // --green

    const SEVERITY_PATTERNS = [
      { pattern: /^.*\b(FAIL|ERROR|FATAL|PANIC|error:|fatal:)\b/i, ansi: ANSI_RED },
      { pattern: /^.*\b(WARN|WARNING|warn:|warning:)\b/i, ansi: ANSI_YELLOW },
      { pattern: /^.*\b(SUCCESS|PASS|OK|ok|PASSED|passed|succeeded)\b/i, ansi: ANSI_GREEN },
    ];

    function colorizeLine(line) {
      // Skip lines that already contain ANSI escapes
      if (line.includes("\x1b[")) return line;
      for (const rule of SEVERITY_PATTERNS) {
        if (rule.pattern.test(line)) {
          return rule.ansi + line + ANSI_RESET;
        }
      }
      return line;
    }

    function colorizeTerminalOutput(data) {
      if (!data || !data.includes("\n")) return colorizeLine(data);
      return data.split("\n").map(colorizeLine).join("\n");
    }

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
    const taskContextTaskEl = document.getElementById("taskContextTask");
    const taskContextBranchEl = document.getElementById("taskContextBranch");
    const taskContextBranchMenuEl = document.getElementById("taskContextBranchMenu");
    const taskContextOpenPrBtnEl = document.getElementById("taskContextOpenPrBtn");
    const taskContextOpenBranchBtnEl = document.getElementById("taskContextOpenBranchBtn");
    const taskContextPathEl = document.getElementById("taskContextPath");

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
    const providerBarEl = document.getElementById("providerBar");
    const runAgentBtnEl = document.getElementById("runAgentBtn");

    const terminalOverlayTextEl = document.getElementById("terminalOverlayText");

    const workspaceModalBackdropEl = document.getElementById("workspaceModalBackdrop");
    const workspaceModalNameEl = document.getElementById("workspaceModalName");
    const workspaceModalNameHelpEl = document.getElementById("workspaceModalNameHelp");
    const workspaceModalRepoEl = document.getElementById("workspaceModalRepo");
    const workspaceModalRepoHelpEl = document.getElementById("workspaceModalRepoHelp");
    const workspaceModalErrorEl = document.getElementById("workspaceModalError");
    const workspaceModalBrowseBtnEl = document.getElementById("workspaceModalBrowseBtn");
    const workspaceModalCreateBtnEl = document.getElementById("workspaceModalCreateBtn");
    const workspaceModalCreateLabelEl = document.getElementById("workspaceModalCreateLabel");
    const workspaceModalCreateSpinnerEl = document.getElementById("workspaceModalCreateSpinner");
    const workspaceModalCloseBtnEl = document.getElementById("workspaceModalCloseBtn");
    const workspaceModalCancelBtnEl = document.getElementById("workspaceModalCancelBtn");
    const workspaceInitPromptEl = document.getElementById("workspaceInitPrompt");
    const workspaceInitPromptYesBtnEl = document.getElementById("workspaceInitPromptYesBtn");
    const workspaceInitPromptBrowseBtnEl = document.getElementById("workspaceInitPromptBrowseBtn");

    let pendingWorkspaceCreate = null;
    let autoWorkspaceNameValue = "";
    let workspaceModalNameTouched = false;
    let workspaceModalRepoTouched = false;
    let workspaceModalSubmitAttempted = false;
    let workspaceModalCreating = false;
    let workspaceRepoValidationTimer = null;
    let workspaceRepoValidationSeq = 0;
    let workspaceRepoValidation = {
      path: "",
      valid: false,
      checking: false,
      message: "",
    };
    const taskContextRepoMetaCache = new Map();
    let taskContextBranchLookupSeq = 0;

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

    const taskHeaderEl = document.getElementById("taskHeader");
    const taskTitleTextEl = document.getElementById("taskTitleText");
    const taskStatusDotEl = document.getElementById("taskStatusDot");

    function updateTaskHeader(task = null) {
      const nextTask = task || getTask(activeTabId);
      if (!nextTask || (nextTask.status !== "running" && nextTask.status !== "pending")) {
        taskHeaderEl.classList.add("hidden");
        return;
      }
      taskTitleTextEl.textContent = nextTask.name || "untitled task";
      taskStatusDotEl.classList.toggle("active", true);
      taskHeaderEl.classList.remove("hidden");
    }

    function taskCodePath(task) {
      return String(task?.worktree_path || task?.repo_path || "").trim();
    }

    function closeTaskContextBranchMenu() {
      if (!taskContextBranchMenuEl) return;
      taskContextBranchMenuEl.classList.add("hidden");
    }

    function setTaskContextBranchActions({ provider = "", baseBranch = "", branchUrl = "", prUrl = "" } = {}) {
      if (!taskContextBranchEl || !taskContextOpenPrBtnEl || !taskContextOpenBranchBtnEl) return;

      const hasActions = Boolean(branchUrl || prUrl);
      taskContextBranchEl.disabled = !hasActions;
      taskContextBranchEl.dataset.branchUrl = branchUrl || "";
      taskContextBranchEl.dataset.prUrl = prUrl || "";
      taskContextBranchEl.dataset.provider = provider || "";
      taskContextBranchEl.dataset.baseBranch = baseBranch || "";

      const branchLabel = String(taskContextBranchEl.textContent || "").trim();
      const providerLabel = provider ? provider.toUpperCase() : "";
      const branchTitleParts = [branchLabel];
      if (providerLabel) branchTitleParts.push(providerLabel);
      if (baseBranch) branchTitleParts.push(`base: ${baseBranch}`);
      taskContextBranchEl.title = hasActions ? branchTitleParts.join(" · ") : branchLabel;

      taskContextOpenPrBtnEl.disabled = !prUrl;
      taskContextOpenPrBtnEl.dataset.url = prUrl || "";
      taskContextOpenPrBtnEl.textContent = baseBranch ? `Open PR to ${baseBranch}` : "Open PR";

      taskContextOpenBranchBtnEl.disabled = !branchUrl;
      taskContextOpenBranchBtnEl.dataset.url = branchUrl || "";
      closeTaskContextBranchMenu();
    }

    async function loadTaskContextBranchActions(pathValue, branchValue) {
      const path = String(pathValue || "").trim();
      const branch = String(branchValue || "").trim();
      const lookupSeq = ++taskContextBranchLookupSeq;
      setTaskContextBranchActions({});

      if (!path || !branch || branch === "-") return;

      const cacheKey = `${path}::${branch}`;
      const cached = taskContextRepoMetaCache.get(cacheKey);
      if (cached) {
        setTaskContextBranchActions(cached);
        return;
      }

      try {
        const data = await api("/api/local/git-metadata", {
          method: "POST",
          body: JSON.stringify({ path, branch }),
        });
        if (lookupSeq !== taskContextBranchLookupSeq) return;
        const nextActions = {
          provider: String(data.provider || ""),
          baseBranch: String(data.base_branch || ""),
          branchUrl: String(data.branch_url || ""),
          prUrl: String(data.pr_url || ""),
        };
        taskContextRepoMetaCache.set(cacheKey, nextActions);
        setTaskContextBranchActions(nextActions);
      } catch (_) {
        if (lookupSeq !== taskContextBranchLookupSeq) return;
        setTaskContextBranchActions({});
      }
    }

    function updateTaskContextBar(task = undefined) {
      if (!taskContextTaskEl || !taskContextBranchEl || !taskContextPathEl) return;

      const nextTask = task === undefined ? getTask(activeTabId) : task;
      const workspacePath = String(activeWorkspaceRepoPath() || "").trim();

      function applyPath(pathValue) {
        const path = String(pathValue || "").trim();
        const hasPath = Boolean(path);
        taskContextPathEl.textContent = `Path: ${hasPath ? path : "-"}`;
        taskContextPathEl.title = hasPath ? path : "";
        taskContextPathEl.dataset.path = hasPath ? path : "";
        taskContextPathEl.disabled = !hasPath;
      }

      if (nextTask) {
        const taskLabel = nextTask.name || (nextTask.id ? nextTask.id.slice(0, 8) : "untitled");
        const branch = String(nextTask.branch || "").trim() || "-";
        const path = taskCodePath(nextTask) || workspacePath;
        taskContextTaskEl.textContent = `Task: ${taskLabel}`;
        taskContextBranchEl.textContent = `Branch: ${branch}`;
        applyPath(path);
        void loadTaskContextBranchActions(path, branch);
        return;
      }

      taskContextTaskEl.textContent = "Task: none";
      taskContextBranchEl.textContent = "Branch: -";
      applyPath(workspacePath);
      void loadTaskContextBranchActions(workspacePath, "");
    }

    function setPatchPreviewMessage(message) {
      patchPreviewEl.innerHTML = `<div class="diff-empty text-text-tertiary p-3 text-sm">${escapeHtml(message)}</div>`;
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
            <div class="diff-sbs-row grid grid-cols-2 border-b border-[rgba(49,42,40,0.52)] last:border-b-0">
              <div class="diff-cell left ${row.leftType} grid grid-cols-[44px_minmax(0,1fr)] items-stretch min-h-[22px] bg-transparent">
                <span class="diff-ln text-[#7D726B] text-right select-none px-1 pr-2 border-r border-[rgba(49,42,40,0.68)] inline-flex items-center justify-end">${escapeHtml(row.leftNo || "")}</span>
                <span class="diff-code text-[#E5DED8] px-2.5 whitespace-pre-wrap break-words inline-flex items-center min-h-[22px]">${escapeHtml(row.leftText || " ")}</span>
              </div>
              <div class="diff-cell right ${row.rightType} grid grid-cols-[44px_minmax(0,1fr)] items-stretch min-h-[22px] bg-transparent">
                <span class="diff-ln text-[#7D726B] text-right select-none px-1 pr-2 border-r border-[rgba(49,42,40,0.68)] inline-flex items-center justify-end">${escapeHtml(row.rightNo || "")}</span>
                <span class="diff-code text-[#E5DED8] px-2.5 whitespace-pre-wrap break-words inline-flex items-center min-h-[22px]">${escapeHtml(row.rightText || " ")}</span>
              </div>
            </div>
          `).join("")
        : `<div class="diff-empty text-text-tertiary p-3 text-sm">No line-level changes available for this selection.</div>`;

      return `
        <div class="diff-editor-head flex items-center justify-between gap-2.5 px-2.5 py-2 border-b border-[#312A28] bg-[#24201D]">
          <div class="diff-head-main min-w-0 grid gap-px">
            <div class="diff-file-name text-text-primary text-base font-[560] whitespace-nowrap overflow-hidden text-ellipsis">${escapeHtml(fileName)}</div>
            <div class="diff-file-path text-[#9C8F86] text-xs font-mono whitespace-nowrap overflow-hidden text-ellipsis">${escapeHtml(parentPath)}</div>
          </div>
          <div class="diff-head-right inline-flex items-center gap-[9px] shrink-0">
            <span class="diff-head-mode text-[#AA9D94] text-xs font-[560] tracking-[0.03em] uppercase">Changes</span>
            ${statLine ? `<span class="diff-head-stat text-[#9C8F86] text-xs font-mono whitespace-nowrap max-w-[340px] overflow-hidden text-ellipsis">${escapeHtml(statLine)}</span>` : ""}
            <button class="diff-close-btn min-h-[24px] px-2 rounded-sm border border-[#3A3130] bg-[#2A2421] text-[#CFC3BA] text-xs" data-diff-close type="button">Terminal</button>
          </div>
        </div>
        <div class="diff-columns-head grid grid-cols-2 border-b border-[#312A28] bg-[#201B19] text-[#9D9087] text-xs tracking-[0.03em] uppercase">
          <div class="pane left px-2.5 py-1.5 flex items-center gap-1.5">Original</div>
          <div class="pane right px-2.5 py-1.5 flex items-center gap-1.5">Current</div>
        </div>
        <div class="diff-scroll min-h-0 overflow-auto bg-[#181312] font-mono text-base leading-[1.52]">${rowsHtml}</div>
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

    function isWorkspaceModalOpen() {
      return !workspaceModalBackdropEl.classList.contains("hidden");
    }

    function setWorkspaceModalError(message) {
      const text = String(message || "").trim();
      workspaceModalErrorEl.textContent = text;
      workspaceModalErrorEl.classList.toggle("hidden", !text);
    }

    function workspaceModalSnapshot() {
      const name = String(workspaceModalNameEl.value || "").trim();
      const repoPath = String(workspaceModalRepoEl.value || "").trim();
      const repoValidationMatches = workspaceRepoValidation.path === repoPath;
      const repoValid = Boolean(repoPath) && repoValidationMatches && workspaceRepoValidation.valid && !workspaceRepoValidation.checking;
      const nameValid = Boolean(name);
      return {
        name,
        repoPath,
        nameValid,
        repoValid,
        canSubmit: nameValid && repoValid && !workspaceModalCreating,
      };
    }

    function setWorkspaceModalCreateLoading(loading) {
      workspaceModalCreating = Boolean(loading);
      workspaceModalCreateSpinnerEl.classList.toggle("hidden", !workspaceModalCreating);
      workspaceModalCreateSpinnerEl.classList.toggle("animate-spin", workspaceModalCreating);
      workspaceModalCreateLabelEl.textContent = workspaceModalCreating ? "Creating…" : "Create Workspace";
      updateWorkspaceModalValidityUI();
    }

    function updateWorkspaceModalValidityUI() {
      const state = workspaceModalSnapshot();

      const showNameError = (workspaceModalNameTouched || workspaceModalSubmitAttempted) && !state.nameValid;
      workspaceModalNameEl.classList.toggle("workspace-modal-input-invalid", showNameError);
      workspaceModalNameEl.setAttribute("aria-invalid", showNameError ? "true" : "false");
      workspaceModalNameHelpEl.textContent = showNameError ? "Workspace name is required." : "";
      workspaceModalNameHelpEl.classList.toggle("workspace-modal-help-error", showNameError);

      const showRepoValidationError = (workspaceModalRepoTouched || workspaceModalSubmitAttempted) && state.repoPath
        && !workspaceRepoValidation.checking
        && workspaceRepoValidation.path === state.repoPath
        && !workspaceRepoValidation.valid;
      const showRepoRequiredError = (workspaceModalRepoTouched || workspaceModalSubmitAttempted) && !state.repoPath;
      const showRepoError = showRepoValidationError || showRepoRequiredError;
      workspaceModalRepoEl.classList.toggle("workspace-modal-input-invalid", showRepoError);
      workspaceModalRepoEl.setAttribute("aria-invalid", showRepoError ? "true" : "false");

      let repoHelpText = "Select the root folder of your git repository.";
      let repoHelpError = false;
      if (showRepoRequiredError) {
        repoHelpText = "Git repo path is required.";
        repoHelpError = true;
      } else if (state.repoPath && (workspaceRepoValidation.checking || workspaceRepoValidation.path !== state.repoPath)) {
        repoHelpText = "Validating path...";
      } else if (showRepoValidationError) {
        repoHelpText = workspaceRepoValidation.message || "Path does not exist.";
        repoHelpError = true;
      }
      workspaceModalRepoHelpEl.textContent = repoHelpText;
      workspaceModalRepoHelpEl.classList.toggle("workspace-modal-help-error", repoHelpError);

      workspaceModalCreateBtnEl.disabled = !state.canSubmit || workspaceRepoValidation.checking;
    }

    async function validateWorkspaceRepoPath(path) {
      const repoPath = String(path || "").trim();
      if (!repoPath) {
        workspaceRepoValidation = { path: "", valid: false, checking: false, message: "" };
        updateWorkspaceModalValidityUI();
        return;
      }

      const seq = ++workspaceRepoValidationSeq;
      workspaceRepoValidation = { path: repoPath, valid: false, checking: true, message: "" };
      updateWorkspaceModalValidityUI();

      try {
        const data = await api("/api/local/validate-directory", {
          method: "POST",
          body: JSON.stringify({ path: repoPath }),
        });
        if (seq !== workspaceRepoValidationSeq) return;
        workspaceRepoValidation = {
          path: repoPath,
          valid: Boolean(data.valid),
          checking: false,
          message: String(data.message || (data.valid ? "" : "Path does not exist.")),
        };
      } catch (error) {
        if (seq !== workspaceRepoValidationSeq) return;
        workspaceRepoValidation = {
          path: repoPath,
          valid: false,
          checking: false,
          message: String(error.message || error || "Unable to validate path."),
        };
      }
      updateWorkspaceModalValidityUI();
    }

    function queueWorkspaceRepoValidation({ immediate = false } = {}) {
      if (workspaceRepoValidationTimer) {
        clearTimeout(workspaceRepoValidationTimer);
        workspaceRepoValidationTimer = null;
      }
      const repoPath = String(workspaceModalRepoEl.value || "").trim();
      if (!repoPath) {
        workspaceRepoValidation = { path: "", valid: false, checking: false, message: "" };
        updateWorkspaceModalValidityUI();
        return;
      }
      if (immediate) {
        void validateWorkspaceRepoPath(repoPath);
        return;
      }
      workspaceRepoValidation = { path: repoPath, valid: false, checking: true, message: "" };
      updateWorkspaceModalValidityUI();
      workspaceRepoValidationTimer = setTimeout(() => {
        void validateWorkspaceRepoPath(repoPath);
      }, 180);
    }

    function resetWorkspaceModalValidationState() {
      workspaceModalNameTouched = false;
      workspaceModalRepoTouched = false;
      workspaceModalSubmitAttempted = false;
      workspaceModalCreating = false;
      workspaceRepoValidationSeq += 1;
      if (workspaceRepoValidationTimer) {
        clearTimeout(workspaceRepoValidationTimer);
        workspaceRepoValidationTimer = null;
      }
      workspaceRepoValidation = { path: "", valid: false, checking: false, message: "" };
      workspaceModalCreateSpinnerEl.classList.add("hidden");
      workspaceModalCreateSpinnerEl.classList.remove("animate-spin");
      workspaceModalCreateLabelEl.textContent = "Create Workspace";
      setWorkspaceModalError("");
      workspaceModalNameHelpEl.textContent = "";
      workspaceModalNameHelpEl.classList.remove("workspace-modal-help-error");
      workspaceModalRepoHelpEl.textContent = "Select the root folder of your git repository.";
      workspaceModalRepoHelpEl.classList.remove("workspace-modal-help-error");
      workspaceModalNameEl.classList.remove("workspace-modal-input-invalid");
      workspaceModalRepoEl.classList.remove("workspace-modal-input-invalid");
      workspaceModalNameEl.setAttribute("aria-invalid", "false");
      workspaceModalRepoEl.setAttribute("aria-invalid", "false");
      workspaceModalCreateBtnEl.disabled = true;
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
      autoWorkspaceNameValue = "";
      resetWorkspaceModalValidationState();
      hideWorkspaceInitPrompt();
      workspaceModalBackdropEl.classList.remove("hidden");
      setTimeout(() => {
        workspaceModalNameEl.focus();
      }, 0);
    }

    function closeWorkspaceModal() {
      if (workspaceRepoValidationTimer) {
        clearTimeout(workspaceRepoValidationTimer);
        workspaceRepoValidationTimer = null;
      }
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
      syncWorkspaceNameWithRepoPath(path);
      workspaceModalRepoTouched = true;
      queueWorkspaceRepoValidation({ immediate: true });
      return path;
    }

    function inferWorkspaceNameFromRepoPath(repoPath) {
      const normalized = String(repoPath || "")
        .trim()
        .replaceAll("\\", "/")
        .replace(/\/+$/, "");
      if (!normalized) return "";
      const parts = normalized.split("/").filter(Boolean);
      return parts.length ? parts[parts.length - 1] : "";
    }

    function syncWorkspaceNameWithRepoPath(repoPath) {
      const suggested = inferWorkspaceNameFromRepoPath(repoPath);
      const currentName = String(workspaceModalNameEl.value || "").trim();
      if (!suggested) {
        if (currentName === autoWorkspaceNameValue) {
          workspaceModalNameEl.value = "";
        }
        autoWorkspaceNameValue = "";
        return;
      }
      // Only auto-fill when the name is empty or still using the previous auto value.
      if (!currentName || currentName === autoWorkspaceNameValue) {
        workspaceModalNameEl.value = suggested;
      }
      autoWorkspaceNameValue = suggested;
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
      terminalOverlayTextEl.textContent = message;
      terminalOverlayEl.classList.toggle("hidden", !show);
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

    function workspaceInitial(name) {
      return String(name || "W").charAt(0).toUpperCase();
    }

    function WorkspaceHeader(name, taskCount, isOpen) {
      return `
        <summary class="workspace-summary list-none cursor-pointer h-[56px] flex items-center gap-3 px-[14px] bg-[#1A1615] hover:bg-[#1E1B19]" data-workspace-summary="${escapeHtml(name)}">
          <span class="w-[30px] h-[30px] flex-none rounded-[6px] bg-[#2A2624] flex items-center justify-center text-[13px] font-semibold text-[rgba(255,255,255,0.72)]">${workspaceInitial(name)}</span>
          <span class="text-[15px] font-semibold text-[rgba(255,255,255,0.88)] truncate">${escapeHtml(name)}</span>
          <span class="text-[14px] font-medium text-[rgba(255,255,255,0.32)]">(${taskCount})</span>
          <div class="ml-auto flex items-center gap-1.5 flex-none">
            <span class="ws-chevron w-[18px] h-[18px] flex items-center justify-center text-[rgba(255,255,255,0.40)] text-[11px] ${isOpen ? "rotate-90" : ""}">&#9656;</span>
          </div>
        </summary>`;
    }

    function healthDotColor(status) {
      switch (String(status || "").toLowerCase()) {
        case "running": return "bg-green-accent";
        case "pending": return "bg-amber";
        case "failed": return "bg-red-accent";
        case "stopped": case "completed": return "bg-text-dim";
        default: return "bg-text-dim";
      }
    }

    function healthDotTooltip(status, updatedAt) {
      const state = status || "unknown";
      const time = updatedAt ? new Date(updatedAt).toLocaleTimeString() : "–";
      return `${state} \u00b7 last active ${time}`;
    }

    function SidebarRow({ id, title, subtitle, isSelected, dataAttr, status, updatedAt }) {
      const bg = isSelected ? "bg-[#2F2A29]" : "";
      const leftAccent = isSelected ? "border-l-[3px] border-l-amber pl-[55px]" : "pl-[58px]";
      const titleColor = isSelected ? "text-[rgba(255,255,255,0.92)] font-medium" : "text-[rgba(255,255,255,0.80)]";
      const attr = dataAttr || "";
      const dot = status
        ? `<span class="w-2 h-2 rounded-full flex-none ${healthDotColor(status)}" title="${escapeHtml(healthDotTooltip(status, updatedAt))}"></span>`
        : "";
      return `
        <div class="sidebar-row flex items-center gap-3 h-[56px] px-[14px] ${leftAccent} cursor-pointer hover:bg-[rgba(255,255,255,0.03)] ${bg}" ${attr}>
          <div class="min-w-0 flex-1 flex flex-col justify-center gap-[2px]">
            <span class="text-[14px] font-medium ${titleColor} truncate leading-tight">${escapeHtml(title)}</span>
            ${subtitle ? `<span class="text-[12px] text-[rgba(255,255,255,0.42)] font-mono truncate leading-tight">${escapeHtml(subtitle)}</span>` : ""}
          </div>
          ${dot}
        </div>`;
    }

    function renderWorkspaces() {
      if (!workspaces.length) {
        workspaceListEl.innerHTML = `<div class="px-[14px] py-5 text-[13px] text-[rgba(255,255,255,0.32)]">No workspaces</div>`;
        return;
      }
      workspaceListEl.innerHTML = workspaces.map((workspace, idx) => {
        const name = workspace.name || "default";
        const isActive = name === activeWorkspace;
        const activeClass = isActive ? "active" : "";
        const isOpen = expandedWorkspaces.has(name);
        const tasks = tasksForWorkspace(name);

        const taskRows = tasks.map((task) => {
          const isOpenTab = task.id === activeTabId;
          return SidebarRow({
            id: task.id,
            title: task.name || "untitled",
            subtitle: task.id ? task.id.slice(0, 8) : "",
            isSelected: isOpenTab,
            dataAttr: `data-open-tab="${task.id}"`,
            status: task.status,
            updatedAt: task.updated_at,
          });
        }).join("");

        const divider = idx > 0 ? `<div class="h-px bg-[rgba(255,255,255,0.06)]"></div>` : "";

        return `
          ${divider}
          <details class="workspace-node ${activeClass}" data-workspace-node="${escapeHtml(name)}" ${isOpen ? "open" : ""}>
            ${WorkspaceHeader(name, tasks.length, isOpen)}
            <div class="workspace-children bg-[#141110]">
              ${taskRows || `<div class="px-[58px] py-3 text-[12px] text-[rgba(255,255,255,0.34)]">No tasks</div>`}
            </div>
          </details>
        `;
      }).join("");
    }

    function renderWorkspaceTasks() {
      // tasks are rendered inline under each workspace node
    }

    function tabLabel(task, index) {
      const name = task.name || "untitled";
      const hint = task.command ? task.command.split(" ")[0] : "";
      const suffix = hint ? ` \u00b7 ${hint}` : ` #${index + 1}`;
      const full = name + suffix;
      const truncated = full.length > 24 ? full.slice(0, 22) + "\u2026" : full;
      return { truncated, full };
    }

    function renderTabs() {
      const tasksWithIndex = openTabs.map((taskId, idx) => ({ task: getTask(taskId), idx })).filter(({ task }) => task);
      const dynamicTabs = tasksWithIndex
        .map(({ task, idx }) => {
          const active = task.id === activeTabId ? "active" : "";
          const label = tabLabel(task, idx);
          return `
            <div class="tab ${active} inline-flex items-center gap-1.5 border border-border-subtle rounded-sm min-h-[27px] px-[9px] bg-tab-bg text-[#B5A8A0] cursor-pointer text-sm max-w-[300px]" data-tab="${task.id}" title="${escapeHtml(label.full)}">
              <span class="truncate">${escapeHtml(label.truncated)}</span>
              <button class="tab-close border-0 bg-transparent text-inherit p-0 w-auto text-base leading-none opacity-70 flex-none" data-close-tab="${task.id}" type="button" aria-label="Close tab">&times;</button>
            </div>
          `;
        })
        .join("");

      const MAX_VISIBLE_TABS = 6;
      const visibleTabs = dynamicTabs;
      let overflowPill = "";
      if (tasksWithIndex.length > MAX_VISIBLE_TABS) {
        const overflowCount = tasksWithIndex.length - MAX_VISIBLE_TABS;
        const visibleIds = new Set(tasksWithIndex.slice(0, MAX_VISIBLE_TABS).map(({ task }) => task.id));
        // re-render only the visible portion
        const visibleHtml = tasksWithIndex.slice(0, MAX_VISIBLE_TABS).map(({ task, idx }) => {
          const active = task.id === activeTabId ? "active" : "";
          const label = tabLabel(task, idx);
          return `
            <div class="tab ${active} inline-flex items-center gap-1.5 border border-border-subtle rounded-sm min-h-[27px] px-[9px] bg-tab-bg text-[#B5A8A0] cursor-pointer text-sm max-w-[300px]" data-tab="${task.id}" title="${escapeHtml(label.full)}">
              <span class="truncate">${escapeHtml(label.truncated)}</span>
              <button class="tab-close border-0 bg-transparent text-inherit p-0 w-auto text-base leading-none opacity-70 flex-none" data-close-tab="${task.id}" type="button" aria-label="Close tab">&times;</button>
            </div>`;
        }).join("");
        const overflowItems = tasksWithIndex.slice(MAX_VISIBLE_TABS).map(({ task }) => {
          return `<button class="w-full text-left px-2.5 py-1.5 text-sm text-text-secondary hover:bg-hover-bg hover:text-text-primary border-0 bg-transparent rounded-sm" data-overflow-tab="${task.id}" type="button">${escapeHtml(task.name || "untitled")}</button>`;
        }).join("");
        overflowPill = `
          <div class="tab-overflow-wrap relative flex-none">
            <button class="tab-overflow-btn inline-flex items-center border border-border-subtle rounded-sm min-h-[27px] px-2 bg-tab-bg text-text-tertiary cursor-pointer text-sm flex-none" type="button" aria-label="More tabs">+${overflowCount} more</button>
            <div class="tab-overflow-menu hidden absolute top-full left-0 mt-1 z-50 bg-panel-bg border border-border-default rounded-md shadow-lg py-1 min-w-[180px]">
              ${overflowItems}
            </div>
          </div>`;

        const emptyHint = "";
        tabBarEl.innerHTML = `
          <div class="tab-list inline-flex items-center gap-1 min-w-0 overflow-x-auto pb-px">
            ${visibleHtml}
            ${overflowPill}
            <button class="tab plus-tab inline-flex items-center justify-center border border-border-subtle rounded-sm min-h-[27px] w-[27px] p-0 bg-tab-bg text-amber cursor-pointer text-sm flex-none" type="button" aria-label="New tab">+</button>
          </div>
        `;
        return;
      }

      const emptyHint = openTabs.length ? "" : `<div class="tabs-empty text-[#8E827A] text-sm whitespace-nowrap pr-1">No open tabs</div>`;
      tabBarEl.innerHTML = `
        <div class="tab-list inline-flex items-center gap-1 min-w-0 overflow-x-auto pb-px">
          ${dynamicTabs}
          <button class="tab plus-tab inline-flex items-center justify-center border border-border-subtle rounded-sm min-h-[27px] w-[27px] p-0 bg-tab-bg text-amber cursor-pointer text-sm flex-none" type="button" aria-label="New tab">+</button>
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
        updateTaskContextBar(null);
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

      updateTaskHeader(task);
      updateTaskContextBar(task);

      if (task.status === "running") {
        setTerminalOverlay("Connecting…", true);
      } else {
        setTerminalOverlay("", false);
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
          terminal.write(colorizeTerminalOutput(data.logs));
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
        terminal.write(colorizeTerminalOutput(data.message));
        setTerminalOverlay("", false);
      });

      activeStream.addEventListener("status", async () => {
        await loadTasks({ keepTab: true });
        if (activeTabId !== taskId) return;
        const task = getTask(taskId);
        if (!task) return;

          updateTaskHeader(task);
          updateTaskContextBar(task);

        if (task.status === "running") {
          setTerminalOverlay("", false);
          await resizeTerminalForActiveTab().catch(() => {});
        } else {
          setTerminalOverlay("", false);
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
          setTerminalOverlay("Stream disconnected — re-open tab to reconnect", true);
        }
      };
    }

    async function loadPresets() {
      const data = await api("/api/presets");
      const presets = data.presets || [];
      if (!presets.length) {
        presetSelectEl.innerHTML = `<option value="none">none</option>`;
        presetSelectEl.value = "none";
        return;
      }
      const previousPreset = presetSelectEl.value;
      presetSelectEl.innerHTML = presets
        .map((preset) => `<option value="${escapeHtml(preset.name)}">${escapeHtml(preset.name)} - ${escapeHtml(preset.description || "")}</option>`)
        .join("");
      const presetNames = new Set(presets.map((preset) => String(preset.name || "")));
      if (previousPreset && presetNames.has(previousPreset)) {
        presetSelectEl.value = previousPreset;
      } else if (presetNames.has("none")) {
        presetSelectEl.value = "none";
      } else {
        presetSelectEl.value = String(presets[0]?.name || "none");
      }
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
      updateTaskContextBar();
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
      updateTaskContextBar();
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
      return `<span class="tree-chevron" aria-hidden="true">\u25B8</span>`;
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
      return `<span class="file-icon${cls} w-[18px] min-w-[18px] h-[14px] inline-flex items-center justify-center text-[8px] leading-none lowercase tracking-[0.01em] border border-[#3C322F] rounded text-[#B4A79D] bg-[#221C1A]" aria-hidden="true">${icon.label}</span>`;
    }

    function FolderGroupLabel(label) {
      return `
        <div class="change-group-label min-h-[22px] flex items-center gap-1.5 px-1.5 text-[#9F9288] text-xs bg-transparent font-mono tracking-[0.015em]">
          ${FileIcon(label, "dir")}
          <span class="tree-row-label inline-flex items-center min-w-0 whitespace-nowrap overflow-hidden text-ellipsis">${escapeHtml(label)}</span>
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
        <div class="change-file-row${selectedClass} flex items-center justify-between gap-2 min-h-[24px] px-1.5 rounded-[7px] bg-transparent cursor-pointer hover:bg-[#211B19]" data-patch-file="${escapeHtml(path)}">
          <div class="change-file-main min-w-0 flex items-center gap-[7px]">
            <span class="change-status-icon ${statusClassName} w-[7px] h-[7px] rounded-full flex-none bg-[#8B7F77]" aria-hidden="true"></span>
            <span class="change-file-name text-sm font-[450] text-text-primary whitespace-nowrap overflow-hidden text-ellipsis font-mono">${escapeHtml(name)}</span>
            <span class="change-inline-counts inline-flex items-center gap-1.5 text-xs font-mono ml-0.5 whitespace-nowrap">
              <span class="add text-green-accent">+${add}</span>
              <span class="del text-red-accent">-${del}</span>
            </span>
          </div>
          <div class="tree-row-right inline-flex items-center gap-1.5 shrink-0">
            <button class="tree-action-btn ${actionClass} w-5 min-w-[20px] h-5 min-h-[20px] p-0 rounded-[5px] inline-flex items-center justify-center text-sm leading-none font-semibold border border-[#3C322F] bg-[#231D1B] text-[#CFC3BA] relative z-[1]" ${actionAttr} aria-label="${actionLabel}" type="button">${actionSymbol}</button>
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
        return `<div class="empty text-[#9A8E86] text-sm border border-dashed border-[#413733] rounded-md p-2.5">No ${mode} changes.</div>`;
      }

      return groupChangesByFolder(list).map((group) => `
        <div class="change-group mb-1.5 last:mb-0">
          ${FolderGroupLabel(group.folder)}
          <div class="change-group-files ml-4 pl-2 border-l border-[rgba(58,49,48,0.35)] grid gap-0.5">
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
          <details class="repo-tree-dir block" ${open ? "open" : ""} style="--depth:${depth};">
            <summary class="list-none cursor-pointer min-h-[24px] flex items-center gap-1.5 pr-1.5 text-[#A79A91] text-sm font-mono rounded-sm bg-transparent hover:bg-[#201A18]">
              ${TreeChevron()}
              ${FileIcon(name, "dir")}
              <span class="tree-row-label inline-flex items-center min-w-0 whitespace-nowrap overflow-hidden text-ellipsis">${escapeHtml(name)}</span>
            </summary>
            <div class="repo-tree-children block">${children}</div>
          </details>
        `;
      }
      return `
        <div class="repo-tree-file min-h-[24px] flex items-center gap-1.5 pr-1.5 text-[#D7CDC4] text-sm font-mono rounded-sm bg-transparent whitespace-nowrap overflow-hidden text-ellipsis hover:bg-[#201A18]" style="--depth:${depth};">
          ${FileIcon(name, "file")}
          <span class="tree-row-label inline-flex items-center min-w-0 whitespace-nowrap overflow-hidden text-ellipsis">${escapeHtml(name)}</span>
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
        repoFilesTreeEl.innerHTML = `<div class="empty text-[#9A8E86] text-sm border border-dashed border-[#413733] rounded-md p-2.5">No files found.</div>`;
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
        repoFilesTreeEl.innerHTML = `<div class="empty text-[#9A8E86] text-sm border border-dashed border-[#413733] rounded-md p-2.5">Select a workspace to view files.</div>`;
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
        repoFilesTreeEl.innerHTML = `<div class="empty text-[#9A8E86] text-sm border border-dashed border-[#413733] rounded-md p-2.5">${escapeHtml(error.message || String(error))}</div>`;
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
        direct_repo: false,
      };

      const result = await api("/api/tasks", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      return result.task || null;
    }

    function setRunAgentBtnState(running) {
      const labelEl = document.getElementById("runAgentLabel");
      const kbdEl = runAgentBtnEl?.querySelector(".run-agent-kbd");
      if (running) {
        if (labelEl) labelEl.innerHTML = `<span class="inline-block w-3 h-3 border-2 border-text-dim border-t-text-primary rounded-full animate-spin"></span> Running\u2026`;
        if (kbdEl) kbdEl.classList.add("hidden");
        if (runAgentBtnEl) runAgentBtnEl.disabled = true;
      } else {
        if (labelEl) labelEl.textContent = "Run Agent";
        if (kbdEl) kbdEl.classList.remove("hidden");
        if (runAgentBtnEl) runAgentBtnEl.disabled = false;
      }
    }

    async function createQuickTaskForAgent(agent, options = {}) {
      if (launchingAgent) return;
      launchingAgent = true;
      setRunAgentBtnState(true);
      const promptSnapshot = String(options.prompt ?? promptInputEl.value ?? "");

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
          direct_repo: false,
        };

        const result = await api("/api/tasks", {
          method: "POST",
          body: JSON.stringify(payload),
        });

        await loadTasks({ keepTab: true });
        await loadWorkspaces();
        if (result.task && result.task.id) {
          openTab(result.task.id);
          if (!options.keepPromptInput && String(promptSnapshot || "").trim()) {
            promptInputEl.value = "";
          }
        }
      } finally {
        launchingAgent = false;
        setRunAgentBtnState(false);
      }
    }

    async function createTaskFromNewTab() {
      let trimmedPrompt = String(promptInputEl.value || "").trim();
      if (!trimmedPrompt && typeof window.prompt === "function") {
        const nextPrompt = window.prompt("What should the agent run in this new task?", "");
        if (nextPrompt !== null) {
          trimmedPrompt = String(nextPrompt).trim();
        }
      }
      if (!trimmedPrompt) {
        promptInputEl.focus();
        alert("Enter task instructions in the prompt box, then click New tab.");
        return;
      }
      await createQuickTaskForAgent(agentSelectEl.value, {
        prompt: trimmedPrompt,
        keepPromptInput: true,
      });
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

      workspaceModalCloseBtnEl.addEventListener("click", closeWorkspaceModal);
      workspaceModalCancelBtnEl.addEventListener("click", closeWorkspaceModal);
      workspaceModalBackdropEl.addEventListener("click", (event) => {
        if (event.target === workspaceModalBackdropEl) {
          closeWorkspaceModal();
        }
      });

      workspaceModalBrowseBtnEl.addEventListener("click", async () => {
        hideWorkspaceInitPrompt();
        setWorkspaceModalError("");
        try {
          await browseWorkspaceRepoIntoModal();
        } catch (error) {
          setWorkspaceModalError(error.message || String(error));
        }
      });

      workspaceModalNameEl.addEventListener("input", () => {
        workspaceModalNameTouched = true;
        setWorkspaceModalError("");
        updateWorkspaceModalValidityUI();
      });
      workspaceModalNameEl.addEventListener("blur", () => {
        workspaceModalNameTouched = true;
        updateWorkspaceModalValidityUI();
      });

      workspaceModalRepoEl.addEventListener("input", () => {
        workspaceModalRepoTouched = true;
        setWorkspaceModalError("");
        syncWorkspaceNameWithRepoPath(workspaceModalRepoEl.value);
        queueWorkspaceRepoValidation();
      });
      workspaceModalRepoEl.addEventListener("blur", () => {
        workspaceModalRepoTouched = true;
        queueWorkspaceRepoValidation({ immediate: true });
      });

      workspaceModalCreateBtnEl.addEventListener("click", async () => {
        const cleanName = String(workspaceModalNameEl.value || "").trim();
        const repoPath = String(workspaceModalRepoEl.value || "").trim();
        workspaceModalSubmitAttempted = true;
        hideWorkspaceInitPrompt();
        updateWorkspaceModalValidityUI();

        if (workspaceModalCreateBtnEl.disabled) {
          if (!cleanName) {
            workspaceModalNameTouched = true;
            updateWorkspaceModalValidityUI();
            workspaceModalNameEl.focus();
            return;
          }
          if (!repoPath) {
            workspaceModalRepoTouched = true;
            updateWorkspaceModalValidityUI();
            workspaceModalRepoEl.focus();
            return;
          }
          workspaceModalRepoEl.focus();
          return;
        }

        setWorkspaceModalError("");
        setWorkspaceModalCreateLoading(true);
        try {
          const data = await api("/api/workspaces", {
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
          setWorkspaceModalCreateLoading(false);
        }
      });

      workspaceModalRepoEl.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          workspaceModalSubmitAttempted = true;
          updateWorkspaceModalValidityUI();
          if (!workspaceModalCreateBtnEl.disabled) {
            workspaceModalCreateBtnEl.click();
          }
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

      const openTaskContextLink = async (targetUrl) => {
        const href = String(targetUrl || "").trim();
        if (!href) return;
        try {
          await api("/api/local/open-url", {
            method: "POST",
            body: JSON.stringify({ url: href }),
          });
          return;
        } catch (_) {
          const opened = window.open(href, "_blank", "noopener,noreferrer");
          if (opened) {
            opened.opener = null;
            return;
          }
        }
        alert("Unable to open link in browser.");
      };

      taskContextBranchEl.addEventListener("click", (event) => {
        event.preventDefault();
        if (taskContextBranchEl.disabled) return;
        taskContextBranchMenuEl.classList.toggle("hidden");
      });
      taskContextOpenPrBtnEl.addEventListener("click", async (event) => {
        event.preventDefault();
        event.stopPropagation();
        await openTaskContextLink(taskContextOpenPrBtnEl.dataset.url);
        closeTaskContextBranchMenu();
      });
      taskContextOpenBranchBtnEl.addEventListener("click", async (event) => {
        event.preventDefault();
        event.stopPropagation();
        await openTaskContextLink(taskContextOpenBranchBtnEl.dataset.url);
        closeTaskContextBranchMenu();
      });
      document.addEventListener("click", (event) => {
        const target = event.target;
        if (!(target instanceof Element)) {
          closeTaskContextBranchMenu();
          return;
        }
        if (target.closest("#taskContextBranch") || target.closest("#taskContextBranchMenu")) return;
        closeTaskContextBranchMenu();
      });

      taskContextPathEl.addEventListener("click", async () => {
        const path = String(taskContextPathEl.dataset.path || "").trim();
        if (!path) return;
        try {
          await api("/api/local/open-directory", {
            method: "POST",
            body: JSON.stringify({ path }),
          });
        } catch (error) {
          alert(error.message || String(error));
        }
      });

      window.addEventListener("keydown", (event) => {
        const key = String(event.key || "").toLowerCase();
        if ((event.metaKey || event.ctrlKey) && key === "n") {
          event.preventDefault();
          openWorkspaceModal();
          return;
        }

        if (event.key === "Escape" && !taskContextBranchMenuEl.classList.contains("hidden")) {
          closeTaskContextBranchMenu();
          if (!isWorkspaceModalOpen()) return;
        }
        if (!isWorkspaceModalOpen()) return;

        if (event.key === "Escape") {
          event.preventDefault();
          closeWorkspaceModal();
          return;
        }
        if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
          event.preventDefault();
          workspaceModalSubmitAttempted = true;
          updateWorkspaceModalValidityUI();
          if (!workspaceModalCreateBtnEl.disabled) {
            workspaceModalCreateBtnEl.click();
          }
        }
      });

      workspaceListEl.addEventListener("click", async (event) => {
        const openBtn = event.target.closest("[data-open-tab]");
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
        updateTaskContextBar();
        if (rightPanelMode === "files") {
          loadRepoFiles().catch((error) => console.error(error));
        }
      });

      tabBarEl.addEventListener("click", async (event) => {
        const closeBtn = event.target.closest("button[data-close-tab]");
        if (closeBtn) {
          event.stopPropagation();
          closeTab(closeBtn.dataset.closeTab);
          return;
        }

        // P2-B: overflow menu toggle
        const overflowBtn = event.target.closest(".tab-overflow-btn");
        if (overflowBtn) {
          const menu = overflowBtn.parentElement.querySelector(".tab-overflow-menu");
          if (menu) menu.classList.toggle("hidden");
          return;
        }
        const overflowTab = event.target.closest("[data-overflow-tab]");
        if (overflowTab) {
          openTab(overflowTab.dataset.overflowTab);
          const menu = overflowTab.closest(".tab-overflow-menu");
          if (menu) menu.classList.add("hidden");
          return;
        }

        const tab = event.target.closest("[data-tab]");
        if (tab) {
          openTab(tab.dataset.tab);
          return;
        }

        const plusTab = event.target.closest(".plus-tab");
        if (plusTab) {
          try {
            await createTaskFromNewTab();
          } catch (error) {
            alert(error.message || String(error));
          }
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
        // Plain Enter or ⌘Enter both submit
        if (event.key !== "Enter" || event.shiftKey) return;
        event.preventDefault();
        try {
          await createQuickTaskForAgent(agentSelectEl.value);
        } catch (error) {
          alert(error.message || String(error));
        }
      });
      // ⌘↵ global shortcut
      window.addEventListener("keydown", async (event) => {
        if (isWorkspaceModalOpen()) return;
        if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
          event.preventDefault();
          try {
            await createQuickTaskForAgent(agentSelectEl.value);
          } catch (error) {
            alert(error.message || String(error));
          }
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

      document.getElementById("suggestCommitBtn").addEventListener("click", () => {
        const staged = currentGitStatus.staged || [];
        if (staged.length === 0) return;
        const files = staged.map((f) => f.path.split("/").pop()).slice(0, 5);
        const prefix = staged.some((f) => f.status === "A") ? "feat" : "fix";
        const msg = `${prefix}: update ${files.join(", ")}`;
        const el = document.getElementById("commitMessage");
        el.value = msg;
        el.style.fontStyle = "normal";
      });

      rightTabChangesEl.addEventListener("click", () => {
        setRightPanelMode("changes");
      });
      rightTabFilesEl.addEventListener("click", () => {
        setRightPanelMode("files");
      });

      document.getElementById("stageAllBtn").addEventListener("click", async (event) => {
        event.preventDefault();
        event.stopPropagation();
        const unstaged = currentGitStatus.unstaged || [];
        for (const change of unstaged) {
          await stageFile(change.path);
        }
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
      updateTaskContextBar(null);

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
