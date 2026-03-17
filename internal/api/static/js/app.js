const AGENT_COMMANDS = {
  claude: 'claude --dangerously-skip-permissions --permission-mode bypassPermissions',
  codex:
    'codex --model gpt-5 --sandbox danger-full-access --ask-for-approval never -c approval_policy=never -c sandbox_mode=danger-full-access',
  copilot: 'copilot --allow-all-tools',
  opencode: 'opencode --dangerously-skip-permissions',
  gemini: 'gemini --yolo',
};
const TERMINAL_TAB_COMMAND = 'zsh -il';

let tasksCache = [];
let workspaces = [];
let activeWorkspace = '';
let activeTaskGroupId = '';
let openTabs = [];
let activeTabId = '';
const closedTabsByGroup = new Map();
let activeStream = null;
let launchingAgent = false;
let rightPanelMode = 'changes';
const expandedWorkspaces = new Set();
let workspaceExpansionInitialized = false;

let terminal = null;
let fitAddon = null;
let terminalReady = false;
let terminalResizeObserver = null;
let terminalFitTimer = null;
let terminalBackendResizeTimer = null;
let terminalThemeObserver = null;
let lastPtyCols = 0;
let lastPtyRows = 0;
let lastInterruptHandledAt = 0;
const bootstrappedTerminalTasks = new Set();
let inputBuffer = '';
let flushTimer = null;

let currentGitStatus = { staged: [], unstaged: [] };
let currentGitCommits = [];
let currentGitCommitsTotal = 0;
let gitStatusRefreshSeq = 0;
let lastGitRenderSignature = '';
let lastWorkspaceListHTML = '';
let lastTabBarHTML = '';
let selectedPatchFile = '';
let centerViewMode = 'terminal';
let changesViewMode = 'grouped';
let repoFilesEntriesCache = [];
let selectedPublishAction = 'push';

// P0-A: ANSI color codes for severity highlighting
const ANSI_RESET = '\x1b[0m';
const ANSI_RED = '\x1b[38;2;224;109;109m'; // danger #E06D6D
const ANSI_YELLOW = '\x1b[38;2;231;182;92m'; // warning #E7B65C
const ANSI_GREEN = '\x1b[38;2;86;194;136m'; // success #56C288
const terminalFormatter = window.phasrTerminalFormatter?.createFormatter
  ? window.phasrTerminalFormatter.createFormatter()
  : null;

const SEVERITY_PATTERNS = [
  { pattern: /^.*\b(FAIL|ERROR|FATAL|PANIC|error:|fatal:)\b/i, ansi: ANSI_RED },
  { pattern: /^.*\b(WARN|WARNING|warn:|warning:)\b/i, ansi: ANSI_YELLOW },
  { pattern: /^.*\b(SUCCESS|PASS|OK|ok|PASSED|passed|succeeded)\b/i, ansi: ANSI_GREEN },
];

function colorizeLine(line) {
  // Skip lines that already contain ANSI escapes
  if (line.includes('\x1b[')) return line;
  for (const rule of SEVERITY_PATTERNS) {
    if (rule.pattern.test(line)) {
      return rule.ansi + line + ANSI_RESET;
    }
  }
  return line;
}

function colorizeTerminalOutput(data) {
  const raw = String(data || '');
  const cols = terminal?.cols || 120;
  const formatted = terminalFormatter ? terminalFormatter.format(raw, cols) : raw;
  if (!formatted || !formatted.includes('\n')) return colorizeLine(formatted);
  return formatted.split('\n').map(colorizeLine).join('\n');
}

function cssVar(name, fallback = '') {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

function buildTerminalTheme() {
  return {
    background: cssVar('--mockup-terminal-bg', '#0D1017'),
    foreground: cssVar('--terminal-fg', '#E2E8F0'),
    cursor: cssVar('--terminal-cursor', '#7C9BFF'),
    cursorAccent: cssVar('--mockup-terminal-bg', '#0D1017'),
    selectionBackground: cssVar('--terminal-selection', 'rgba(124, 155, 255, 0.24)'),
    black: cssVar('--terminal-black', '#0B0D12'),
    red: cssVar('--terminal-red', '#E06D6D'),
    green: cssVar('--terminal-green', '#56C288'),
    yellow: cssVar('--terminal-yellow', '#E7B65C'),
    blue: cssVar('--terminal-blue', '#7C9BFF'),
    magenta: cssVar('--terminal-magenta', '#B39DFF'),
    cyan: cssVar('--terminal-cyan', '#63C7D9'),
    white: cssVar('--terminal-white', '#E2E8F0'),
    brightBlack: cssVar('--terminal-bright-black', '#5D687A'),
    brightRed: cssVar('--terminal-bright-red', '#EE8F8F'),
    brightGreen: cssVar('--terminal-bright-green', '#88D8AA'),
    brightYellow: cssVar('--terminal-bright-yellow', '#F1C977'),
    brightBlue: cssVar('--terminal-bright-blue', '#A4B8FF'),
    brightMagenta: cssVar('--terminal-bright-magenta', '#D2BEFF'),
    brightCyan: cssVar('--terminal-bright-cyan', '#9BE2EE'),
    brightWhite: cssVar('--terminal-bright-white', '#FFFFFF'),
  };
}

function applyTerminalTheme() {
  if (!terminal) return;
  terminal.options.theme = buildTerminalTheme();
  terminal.refresh(0, Math.max(0, terminal.rows - 1));
}

function watchThemeChanges() {
  if (terminalThemeObserver || typeof MutationObserver === 'undefined') return;
  terminalThemeObserver = new MutationObserver(() => {
    applyTerminalTheme();
  });
  terminalThemeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme'],
  });
}

function applyTheme(theme) {
  const normalized = theme === 'light' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', normalized);
  try {
    window.localStorage?.setItem('phasr-theme', normalized);
  } catch (_) {}
}

function initTheme() {
  try {
    const stored = window.localStorage?.getItem('phasr-theme');
    if (stored === 'light' || stored === 'dark') {
      applyTheme(stored);
    }
  } catch (_) {}
  window.phasrSetTheme = applyTheme;
}

initTheme();

const workspaceListEl = document.getElementById('workspaceList');

const agentSelectEl = document.getElementById('agentSelect');
const commandInputEl = document.getElementById('commandInput');
const presetSelectEl = document.getElementById('presetSelect');
const repoInputEl = document.getElementById('repoInput');
const taskNameInputEl = document.getElementById('taskNameInput');
const tagInputEl = document.getElementById('tagInput');
const promptInputEl = document.getElementById('promptInput');

const tabBarEl = document.getElementById('tabBar');
const terminalOverlayEl = document.getElementById('terminalOverlay');
const taskContextTaskEl = document.getElementById('taskContextTask');
const taskContextBranchEl = document.getElementById('taskContextBranch');
const taskContextBranchMenuEl = document.getElementById('taskContextBranchMenu');
const taskContextOpenPrBtnEl = document.getElementById('taskContextOpenPrBtn');
const taskContextOpenBranchBtnEl = document.getElementById('taskContextOpenBranchBtn');
const taskContextPathEl = document.getElementById('taskContextPath');
const uiBuildVersionEl = document.getElementById('uiBuildVersion');
const openIdeBtnEl = document.getElementById('openIdeBtn');
const openIdeMenuEl = document.getElementById('openIdeMenu');
const toastViewportEl = document.getElementById('toastViewport');

const gitTaskLabelEl = document.getElementById('gitTaskLabel');
const stagedCountChipEl = document.getElementById('stagedCountChip');
const unstagedCountChipEl = document.getElementById('unstagedCountChip');
const stagedSectionLabelEl = document.getElementById('stagedSectionLabel');
const unstagedSectionLabelEl = document.getElementById('unstagedSectionLabel');
const commitsSectionLabelEl = document.getElementById('commitsSectionLabel');
const unstagedListEl = document.getElementById('unstagedList');
const stagedListEl = document.getElementById('stagedList');
const commitsListEl = document.getElementById('commitsList');
const rightTabChangesEl = document.getElementById('rightTabChanges');
const rightTabFilesEl = document.getElementById('rightTabFiles');
const changeViewModeBtnEl = document.getElementById('changeViewModeBtn');
const changesPanelEl = document.getElementById('changesPanel');
const filesPanelEl = document.getElementById('filesPanel');
const repoFilesMetaEl = document.getElementById('repoFilesMeta');
const repoFilesSearchEl = document.getElementById('repoFilesSearch');
const repoFilesTreeEl = document.getElementById('repoFilesTree');
const publishBranchSplitEl = document.getElementById('publishBranchSplit');
const publishPrimaryBtnEl = document.getElementById('publishPrimaryBtn');
const publishDropdownBtnEl = document.getElementById('publishDropdownBtn');
const publishActionMenuEl = document.getElementById('publishActionMenu');
const patchPreviewEl = document.getElementById('patchPreview');
const terminalPanelEl = document.getElementById('terminalPanel');
const centerEmptyStateEl = document.getElementById('centerEmptyState');
const providerBarEl = document.getElementById('providerBar');
const runAgentBtnEl = document.getElementById('runAgentBtn');

const terminalOverlayTextEl = document.getElementById('terminalOverlayText');

const workspaceModalBackdropEl = document.getElementById('workspaceModalBackdrop');
const workspaceModalNameEl = document.getElementById('workspaceModalName');
const workspaceModalNameHelpEl = document.getElementById('workspaceModalNameHelp');
const workspaceModalRepoEl = document.getElementById('workspaceModalRepo');
const workspaceModalRepoHelpEl = document.getElementById('workspaceModalRepoHelp');
const workspaceModalErrorEl = document.getElementById('workspaceModalError');
const workspaceModalBrowseBtnEl = document.getElementById('workspaceModalBrowseBtn');
const workspaceModalCreateBtnEl = document.getElementById('workspaceModalCreateBtn');
const workspaceModalCreateLabelEl = document.getElementById('workspaceModalCreateLabel');
const workspaceModalCreateSpinnerEl = document.getElementById('workspaceModalCreateSpinner');
const workspaceModalCloseBtnEl = document.getElementById('workspaceModalCloseBtn');
const workspaceModalCancelBtnEl = document.getElementById('workspaceModalCancelBtn');
const workspaceInitPromptEl = document.getElementById('workspaceInitPrompt');
const workspaceInitPromptYesBtnEl = document.getElementById('workspaceInitPromptYesBtn');
const workspaceInitPromptBrowseBtnEl = document.getElementById('workspaceInitPromptBrowseBtn');
const newTaskModalBackdropEl = document.getElementById('newTaskModalBackdrop');
const newTaskModalPromptEl = document.getElementById('newTaskModalPrompt');
const newTaskModalPromptHelpEl = document.getElementById('newTaskModalPromptHelp');
const newTaskModalAgentEl = document.getElementById('newTaskModalAgent');
const newTaskModalWorkspaceEl = document.getElementById('newTaskModalWorkspace');
const newTaskModalErrorEl = document.getElementById('newTaskModalError');
const newTaskModalCloseBtnEl = document.getElementById('newTaskModalCloseBtn');
const newTaskModalCancelBtnEl = document.getElementById('newTaskModalCancelBtn');
const newTaskModalCreateBtnEl = document.getElementById('newTaskModalCreateBtn');
const newTaskModalCreateLabelEl = document.getElementById('newTaskModalCreateLabel');
const newTaskModalCreateSpinnerEl = document.getElementById('newTaskModalCreateSpinner');
const newTabTypeModalBackdropEl = document.getElementById('newTabTypeModalBackdrop');
const newTabTypeModalCloseBtnEl = document.getElementById('newTabTypeModalCloseBtn');
const newTabTypeModalCancelBtnEl = document.getElementById('newTabTypeModalCancelBtn');
const newTabTypeTerminalBtnEl = document.getElementById('newTabTypeTerminalBtn');
const newTabTypeTaskBtnEl = document.getElementById('newTabTypeTaskBtn');
const closeTaskModalBackdropEl = document.getElementById('closeTaskModalBackdrop');
const closeTaskModalTaskNameEl = document.getElementById('closeTaskModalTaskName');
const closeTaskModalCancelBtnEl = document.getElementById('closeTaskModalCancelBtn');
const closeTaskModalDeleteBtnEl = document.getElementById('closeTaskModalDeleteBtn');

let pendingWorkspaceCreate = null;
let autoWorkspaceNameValue = '';
let workspaceModalNameTouched = false;
let workspaceModalRepoTouched = false;
let workspaceModalSubmitAttempted = false;
let workspaceModalCreating = false;
let workspaceRepoValidationTimer = null;
let workspaceRepoValidationSeq = 0;
let workspaceRepoValidation = {
  path: '',
  valid: false,
  checking: false,
  message: '',
};
let newTaskModalPromptTouched = false;
let newTaskModalSubmitAttempted = false;
let newTaskModalCreating = false;
let newTaskModalRootTaskId = '';
let newTabTypeSelection = { preferredWorkspace: '', rootTaskID: '' };
let closeTaskModalSelection = { rootTaskID: '', taskName: '' };
let closeTaskModalBusy = false;
const taskContextRepoMetaCache = new Map();
let taskContextBranchLookupSeq = 0;
let taskContextBranchLookupKey = '';

function escapeHtml(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function renderUiBuildVersion() {
  if (!uiBuildVersionEl) return;
  const meta =
    window.__PHASR_UI_BUILD_META__ && typeof window.__PHASR_UI_BUILD_META__ === 'object'
      ? window.__PHASR_UI_BUILD_META__
      : null;
  const version = String((meta && meta.version) || window.__PHASR_ASSET_VERSION__ || 'unknown').trim() || 'unknown';
  const shortVersion = version.length > 18 ? `${version.slice(0, 18)}...` : version;
  uiBuildVersionEl.textContent = shortVersion;
  uiBuildVersionEl.title = version;
  uiBuildVersionEl.dataset.version = version;
}

function showToast(message, type = 'error', timeoutMs = 4200) {
  const text = String(message || '').trim();
  if (!text) return;
  if (!toastViewportEl) {
    if (type === 'error') {
      console.error(text);
    } else {
      console.info(text);
    }
    return;
  }
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = text;
  toastViewportEl.appendChild(toast);
  window.setTimeout(
    () => {
      toast.remove();
    },
    Math.max(1200, Number(timeoutMs) || 4200),
  );
}

function parseTags(input) {
  return String(input || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .filter((item, idx, arr) => arr.findIndex((x) => x.toLowerCase() === item.toLowerCase()) === idx);
}

function reactBridge() {
  const bridge = window.__PHASR_REACT_BRIDGE__;
  if (!bridge) return null;
  const hasWorkspaceRenderer = typeof bridge.renderWorkspaces === 'function';
  const hasTabRenderer = typeof bridge.renderTabs === 'function';
  if (!hasWorkspaceRenderer && !hasTabRenderer) return null;
  return bridge;
}

function isCtrlC(event) {
  const key = String(event?.key || '').toLowerCase();
  const code = String(event?.code || '');
  const keyCode = Number(event?.keyCode || 0);
  const which = Number(event?.which || 0);
  const charCode = Number(event?.charCode || 0);
  const isControl = !!(event?.ctrlKey || event?.getModifierState?.('Control'));
  return (
    isControl &&
    !event?.metaKey &&
    !event?.altKey &&
    !event?.shiftKey &&
    (key === 'c' || key === '\x03' || code === 'KeyC' || keyCode === 67 || which === 67 || charCode === 3)
  );
}

function interruptOrStopActiveTask() {
  const taskId = String(activeTabId || '').trim();
  if (!taskId) return false;
  const task = getTask(taskId);
  if (!task) return false;
  const status = String(task.status || '').toLowerCase();
  const isRunningLike = status === 'running' || status === 'pending';
  if (!isRunningLike) return false;
  flushInputImmediately('\x03');
  return true;
}

function statusClass(status) {
  return `status-${status || 'pending'}`;
}

function syncProviderPills() {
  if (!providerBarEl) return;
  const selected = agentSelectEl.value;
  const pills = Array.from(providerBarEl.querySelectorAll('[data-provider-pill]'));
  if (pills.length) {
    pills.forEach((pill) => {
      pill.classList.toggle('active', pill.dataset.providerPill === selected);
    });
    return;
  }
  const bridge = reactBridge();
  if (bridge?.renderProviderBar) {
    bridge.renderProviderBar({ selected });
    return;
  }
}

const taskHeaderEl = document.getElementById('taskHeader');
const taskTitleTextEl = document.getElementById('taskTitleText');
const taskStatusDotEl = document.getElementById('taskStatusDot');

function updateTaskHeader(task = null) {
  const nextTask = task || getTask(activeTabId);
  const bridge = reactBridge();
  if (!nextTask) {
    if (bridge?.renderTaskHeader) {
      bridge.renderTaskHeader(null);
    }
    taskHeaderEl.classList.add('hidden');
    return;
  }
  const isRunning = nextTask.status === 'running' || nextTask.status === 'pending';
  if (bridge?.renderTaskHeader) {
    bridge.renderTaskHeader({
      title: nextTask.name || 'untitled task',
      isRunning,
    });
  } else {
    taskTitleTextEl.textContent = nextTask.name || 'untitled task';
    taskStatusDotEl.classList.toggle('active', isRunning);
  }

  taskHeaderEl.classList.remove('hidden');
}

function taskCodePath(task) {
  return String(task?.worktree_path || task?.repo_path || '').trim();
}

function closeTaskContextBranchMenu() {
  if (!taskContextBranchMenuEl) return;
  taskContextBranchMenuEl.classList.add('hidden');
}

function closePublishActionMenu() {
  if (!publishActionMenuEl) return;
  publishActionMenuEl.classList.add('hidden');
  publishDropdownBtnEl?.setAttribute('aria-expanded', 'false');
}

function closeOpenIdeMenu() {
  if (!openIdeMenuEl) return;
  openIdeMenuEl.classList.add('hidden');
  if (openIdeBtnEl) {
    openIdeBtnEl.setAttribute('aria-expanded', 'false');
  }
}

function currentCodebasePath() {
  const contextPath = String(taskContextPathEl?.dataset.path || '').trim();
  if (contextPath) return contextPath;
  const activeTaskPath = taskCodePath(getTask(activeTabId));
  if (activeTaskPath) return activeTaskPath;
  return String(activeWorkspaceRepoPath() || '').trim();
}

async function openExternalUrl(targetUrl) {
  const href = String(targetUrl || '').trim();
  if (!href) return false;
  try {
    await api('/api/local/open-url', {
      method: 'POST',
      body: JSON.stringify({ url: href }),
    });
    return true;
  } catch (_) {
    const opened = window.open(href, '_blank', 'noopener,noreferrer');
    if (opened) {
      opened.opener = null;
      return true;
    }
  }
  return false;
}

async function openCurrentCodebaseInIDE(ideName) {
  const ide = String(ideName || '').trim();
  if (!ide) return;
  const path = currentCodebasePath();
  if (!path) {
    showToast('Failed to open: No active workspace path found.', 'error');
    return;
  }
  try {
    await api('/api/local/open-in-ide', {
      method: 'POST',
      body: JSON.stringify({ path, ide }),
    });
  } catch (error) {
    const message = String(error?.message || 'Unable to open IDE');
    showToast(`Failed to open: ${message}`, 'error');
  }
}

async function openCurrentCodebaseInTerminal() {
  const path = currentCodebasePath();
  if (!path) {
    showToast('Failed to open: No active workspace path found.', 'error');
    return;
  }
  try {
    await api('/api/local/open-in-terminal', {
      method: 'POST',
      body: JSON.stringify({ path }),
    });
  } catch (error) {
    const message = String(error?.message || 'Unable to open Terminal');
    showToast(`Failed to open: ${message}`, 'error');
  }
}

async function copyCurrentCodebasePath() {
  const path = currentCodebasePath();
  if (!path) {
    showToast('Failed to copy: No active workspace path found.', 'error');
    return;
  }
  try {
    if (navigator?.clipboard?.writeText) {
      await navigator.clipboard.writeText(path);
    } else {
      const tmp = document.createElement('textarea');
      tmp.value = path;
      tmp.setAttribute('readonly', 'true');
      tmp.style.position = 'absolute';
      tmp.style.left = '-9999px';
      document.body.appendChild(tmp);
      tmp.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(tmp);
      if (!ok) throw new Error('Clipboard write failed');
    }
    showToast('Path copied to clipboard.', 'success', 2200);
  } catch (error) {
    const message = String(error?.message || 'Clipboard write failed');
    showToast(`Failed to copy: ${message}`, 'error');
  }
}

function releaseTabMemory(taskId) {
  const key = String(taskId || '').trim();
  if (!key) return;
  bootstrappedTerminalTasks.delete(key);
}

function setTaskContextBranchActions({ provider = '', baseBranch = '', branchUrl = '', prUrl = '' } = {}) {
  if (!taskContextBranchEl || !taskContextOpenPrBtnEl || !taskContextOpenBranchBtnEl) return;

  const hasActions = Boolean(branchUrl || prUrl);
  taskContextBranchEl.disabled = !hasActions;
  taskContextBranchEl.dataset.branchUrl = branchUrl || '';
  taskContextBranchEl.dataset.prUrl = prUrl || '';
  taskContextBranchEl.dataset.provider = provider || '';
  taskContextBranchEl.dataset.baseBranch = baseBranch || '';

  const branchLabel = String(taskContextBranchEl.textContent || '').trim() || '-';
  const providerLabel = provider ? provider.toUpperCase() : '';
  const branchTitleParts = [branchLabel];
  if (providerLabel) branchTitleParts.push(providerLabel);
  if (baseBranch) branchTitleParts.push(`base: ${baseBranch}`);
  taskContextBranchEl.title = hasActions ? branchTitleParts.join(' · ') : branchLabel;

  taskContextOpenPrBtnEl.disabled = !prUrl;
  taskContextOpenPrBtnEl.dataset.url = prUrl || '';
  taskContextOpenPrBtnEl.textContent = baseBranch ? `Open PR to ${baseBranch}` : 'Open PR';

  taskContextOpenBranchBtnEl.disabled = !branchUrl;
  taskContextOpenBranchBtnEl.dataset.url = branchUrl || '';
  closeTaskContextBranchMenu();
  renderPublishActionControls();
}

async function loadTaskContextBranchActions(pathValue, branchValue) {
  const path = String(pathValue || '').trim();
  const branch = String(branchValue || '').trim();

  if (!path || !branch || branch === '-') {
    taskContextBranchLookupKey = '';
    setTaskContextBranchActions({});
    return;
  }

  const cacheKey = `${path}::${branch}`;
  if (cacheKey === taskContextBranchLookupKey) return;
  taskContextBranchLookupKey = cacheKey;

  const cached = taskContextRepoMetaCache.get(cacheKey);
  if (cached) {
    setTaskContextBranchActions(cached);
    return;
  }

  const lookupSeq = ++taskContextBranchLookupSeq;
  setTaskContextBranchActions({});

  try {
    const data = await api('/api/local/git-metadata', {
      method: 'POST',
      body: JSON.stringify({ path, branch }),
    });
    if (lookupSeq !== taskContextBranchLookupSeq) return;
    if (cacheKey !== taskContextBranchLookupKey) return;
    const nextActions = {
      provider: String(data.provider || ''),
      baseBranch: String(data.base_branch || ''),
      branchUrl: String(data.branch_url || ''),
      prUrl: String(data.pr_url || ''),
    };
    taskContextRepoMetaCache.set(cacheKey, nextActions);
    setTaskContextBranchActions(nextActions);
  } catch (_) {
    if (lookupSeq !== taskContextBranchLookupSeq) return;
    if (cacheKey !== taskContextBranchLookupKey) return;
    setTaskContextBranchActions({});
  }
}

function updateTaskContextBar(task = undefined) {
  if (!taskContextTaskEl || !taskContextBranchEl || !taskContextPathEl) return;

  const nextTask = task === undefined ? getTask(activeTabId) : task;
  const workspacePath = String(activeWorkspaceRepoPath() || '').trim();

  function applyPath(pathValue) {
    const path = String(pathValue || '').trim();
    const hasPath = Boolean(path);
    taskContextPathEl.textContent = hasPath ? path : '-';
    taskContextPathEl.title = hasPath ? path : '';
    taskContextPathEl.dataset.path = hasPath ? path : '';
    taskContextPathEl.disabled = !hasPath;
    if (openIdeBtnEl) {
      openIdeBtnEl.disabled = !hasPath;
      openIdeBtnEl.dataset.path = hasPath ? path : '';
      openIdeBtnEl.title = hasPath ? path : 'No active workspace path';
    }
  }

  if (nextTask) {
    const taskLabel = nextTask.name || (nextTask.id ? nextTask.id.slice(0, 8) : 'untitled');
    const branch = String(nextTask.branch || '').trim() || '-';
    const path = taskCodePath(nextTask) || workspacePath;
    taskContextTaskEl.textContent = taskLabel;
    taskContextBranchEl.textContent = branch;
    applyPath(path);
    void loadTaskContextBranchActions(path, branch);
    return;
  }

  taskContextTaskEl.textContent = 'none';
  taskContextBranchEl.textContent = '-';
  applyPath(workspacePath);
  void loadTaskContextBranchActions(workspacePath, '');
}

function publishActionDefinitions() {
  return [
    { id: 'push', label: 'Push', title: 'git push' },
    { id: 'pull', label: 'Pull', title: 'git pull' },
    { id: 'fetch', label: 'Fetch', title: 'git fetch' },
    { id: 'commit', label: 'Commit', title: 'git commit' },
    { id: 'create-pr', label: 'Create PR', title: 'Create PR with base branch' },
  ];
}

function publishActionAvailability() {
  const hasActiveTask = Boolean(String(activeTabId || '').trim());
  const staged = currentGitStatus.staged || [];
  const commitsTotal = Number(currentGitCommitsTotal || currentGitCommits.length || 0);
  const prUrl = String(taskContextBranchEl?.dataset.prUrl || '').trim();
  return {
    push: hasActiveTask && commitsTotal > 0,
    pull: hasActiveTask,
    fetch: hasActiveTask,
    commit: hasActiveTask && staged.length > 0,
    'create-pr': hasActiveTask && Boolean(prUrl),
  };
}

function normalizePublishPrimaryAction() {
  const defs = publishActionDefinitions();
  const available = publishActionAvailability();
  if (available[selectedPublishAction]) return selectedPublishAction;
  const fallback = defs.find((item) => available[item.id]);
  if (fallback) {
    selectedPublishAction = fallback.id;
    return selectedPublishAction;
  }
  selectedPublishAction = defs[0]?.id || 'push';
  return selectedPublishAction;
}

function renderPublishActionControls() {
  if (!publishPrimaryBtnEl || !publishActionMenuEl) return;
  const defs = publishActionDefinitions();
  const available = publishActionAvailability();
  const primaryAction = normalizePublishPrimaryAction();
  const primaryDef = defs.find((item) => item.id === primaryAction) || defs[0];
  publishPrimaryBtnEl.textContent = primaryDef?.label || 'Push';
  publishPrimaryBtnEl.title = primaryDef?.title || '';
  publishPrimaryBtnEl.disabled = !available[primaryAction];

  const items = publishActionMenuEl.querySelectorAll('[data-publish-action]');
  for (const item of items) {
    const action = String(item.getAttribute('data-publish-action') || '').trim();
    if (!action) continue;
    const enabled = Boolean(available[action]);
    item.disabled = !enabled;
    item.classList.toggle('active', action === primaryAction);
  }
}

async function runTaskGitAction(action) {
  const actionName = String(action || '').trim();
  if (!activeTabId || !actionName) return;
  const result = await api(`/api/tasks/${activeTabId}/git/${actionName}`, {
    method: 'POST',
  });
  await refreshGitStatus();
  const output = String(result?.output || '').trim();
  if (output) {
    showToast(output, 'success', 2600);
  } else {
    showToast(`Git ${actionName} completed.`, 'success', 2200);
  }
}

async function currentTaskPrUrl() {
  const task = getTask(activeTabId);
  if (!task) return '';
  const path = taskCodePath(task) || String(activeWorkspaceRepoPath() || '').trim();
  const branch = String(task.branch || '').trim();
  if (!path || !branch || branch === '-') return '';
  await loadTaskContextBranchActions(path, branch);
  return String(taskContextBranchEl?.dataset.prUrl || '').trim();
}

async function runPublishAction(action) {
  const actionName = String(action || '').trim();
  if (!actionName) return;
  if (actionName === 'push' || actionName === 'pull' || actionName === 'fetch') {
    await runTaskGitAction(actionName);
    return;
  }
  if (actionName === 'commit') {
    await commitChanges();
    renderPublishActionControls();
    return;
  }
  if (actionName === 'create-pr') {
    const prUrl = await currentTaskPrUrl();
    if (!prUrl) {
      throw new Error('PR URL is unavailable for this branch.');
    }
    const opened = await openExternalUrl(prUrl);
    if (!opened) {
      throw new Error('Unable to open PR URL in browser.');
    }
    return;
  }
  throw new Error(`Unsupported action: ${actionName}`);
}

function setPatchPreviewMessage(message) {
  patchPreviewEl.innerHTML = `<div class="diff-empty text-text-tertiary p-3 text-sm">${escapeHtml(message)}</div>`;
}

function setMainViewMode(mode) {
  centerViewMode = mode === 'diff' ? 'diff' : 'terminal';
  const hasActiveTab = Boolean(String(activeTabId || '').trim());
  if (centerEmptyStateEl) {
    centerEmptyStateEl.classList.toggle('hidden', hasActiveTab);
  }
  if (!hasActiveTab) {
    patchPreviewEl.classList.add('hidden');
    terminalPanelEl.classList.add('hidden');
    return;
  }
  const showDiff = centerViewMode === 'diff';
  patchPreviewEl.classList.toggle('hidden', !showDiff);
  terminalPanelEl.classList.toggle('hidden', showDiff);
  if (!showDiff) {
    setTimeout(() => {
      resizeTerminalForActiveTab().catch(() => {});
    }, 0);
  }
}

function statusBadgeClass(status) {
  const value = String(status || '').toLowerCase();
  if (value.startsWith('a')) return 'added';
  if (value.startsWith('d')) return 'deleted';
  return 'modified';
}

function closestFromEvent(event, selector) {
  const target = event?.target;
  if (target instanceof Element) return target.closest(selector);
  if (target && target.parentElement) return target.parentElement.closest(selector);
  return null;
}

function parseHunkHeader(line) {
  const match = String(line || '').match(/^@@\s*-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s*@@/);
  if (!match) return null;
  return {
    oldStart: Number(match[1] || 0),
    newStart: Number(match[2] || 0),
  };
}

function buildSideBySideRows(patch) {
  const rows = [];
  const lines = String(patch || '')
    .replaceAll('\r\n', '\n')
    .split('\n');
  let oldLine = 0;
  let newLine = 0;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line) continue;
    if (
      line.startsWith('diff --git') ||
      line.startsWith('index ') ||
      line.startsWith('---') ||
      line.startsWith('+++')
    ) {
      continue;
    }

    if (line.startsWith('@@')) {
      const header = parseHunkHeader(line);
      if (header) {
        oldLine = header.oldStart;
        newLine = header.newStart;
      }
      rows.push({
        leftNo: '',
        rightNo: '',
        leftText: line,
        rightText: line,
        leftType: 'hunk',
        rightType: 'hunk',
      });
      continue;
    }

    if (line.startsWith(' ')) {
      rows.push({
        leftNo: String(oldLine++),
        rightNo: String(newLine++),
        leftText: line.slice(1),
        rightText: line.slice(1),
        leftType: 'context',
        rightType: 'context',
      });
      continue;
    }

    const isRemoval = line.startsWith('-') && !line.startsWith('---');
    const isAddition = line.startsWith('+') && !line.startsWith('+++');
    if (!isRemoval && !isAddition) {
      continue;
    }

    const removed = [];
    const added = [];
    if (isRemoval) {
      while (i < lines.length && lines[i].startsWith('-') && !lines[i].startsWith('---')) {
        removed.push(lines[i].slice(1));
        i += 1;
      }
      while (i < lines.length && lines[i].startsWith('+') && !lines[i].startsWith('+++')) {
        added.push(lines[i].slice(1));
        i += 1;
      }
      i -= 1;
    } else {
      while (i < lines.length && lines[i].startsWith('+') && !lines[i].startsWith('+++')) {
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
        leftNo: leftText === undefined ? '' : String(oldLine++),
        rightNo: rightText === undefined ? '' : String(newLine++),
        leftText: leftText ?? '',
        rightText: rightText ?? '',
        leftType: leftText === undefined ? 'empty' : 'removed',
        rightType: rightText === undefined ? 'empty' : 'added',
      });
    }
  }

  return rows;
}

function renderPatchDiff(path, stat, patch) {
  const cleanPath = String(path || '').trim();
  const segments = cleanPath.split('/').filter(Boolean);
  const fileName = segments.length ? segments[segments.length - 1] : cleanPath || 'Diff';
  const parentPath = segments.length > 1 ? segments.slice(0, -1).join('/') : '(root)';
  const statLine =
    String(stat || '')
      .split('\n')
      .map((line) => line.trim())
      .find(Boolean) || '';

  const rows = buildSideBySideRows(patch);
  const rowsHtml = rows.length
    ? rows
        .map(
          (row) => `
            <div class="diff-sbs-row">
              <div class="diff-cell left ${row.leftType}">
                <span class="diff-ln">${escapeHtml(row.leftNo || '')}</span>
                <span class="diff-code">${escapeHtml(row.leftText || ' ')}</span>
              </div>
              <div class="diff-cell right ${row.rightType}">
                <span class="diff-ln">${escapeHtml(row.rightNo || '')}</span>
                <span class="diff-code">${escapeHtml(row.rightText || ' ')}</span>
              </div>
            </div>
          `,
        )
        .join('')
    : `<div class="diff-empty">No line-level changes available for this selection.</div>`;

  return `
        <div class="diff-editor-head">
          <div class="diff-head-main">
            <div class="diff-file-name">${escapeHtml(fileName)}</div>
            <div class="diff-file-path">${escapeHtml(parentPath)}</div>
          </div>
          <div class="diff-head-right">
            <span class="diff-head-mode">Changes</span>
            ${statLine ? `<span class="diff-head-stat">${escapeHtml(statLine)}</span>` : ''}
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
    headers: { 'Content-Type': 'application/json' },
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

function workspaceId(workspace) {
  return String(workspace?.id || '').trim();
}

function getWorkspace(id) {
  const key = String(id || '')
    .trim()
    .toLowerCase();
  return workspaces.find((workspace) => workspaceId(workspace).toLowerCase() === key) || null;
}

function workspaceIdByName(name) {
  const key = String(name || '')
    .trim()
    .toLowerCase();
  if (!key) return '';
  const workspace = workspaces.find(
    (item) =>
      String(item?.name || '')
        .trim()
        .toLowerCase() === key,
  );
  return workspaceId(workspace);
}

function taskRootId(task) {
  const rootTaskID = String(task?.root_task_id || '').trim();
  const taskID = String(task?.id || '').trim();
  return rootTaskID || taskID;
}

function closedTabsForGroup(groupID) {
  const key = String(groupID || '').trim();
  if (!key) return new Set();
  if (!closedTabsByGroup.has(key)) {
    closedTabsByGroup.set(key, new Set());
  }
  return closedTabsByGroup.get(key);
}

function pruneClosedTabsByGroup() {
  const groupTaskIDs = new Map();
  for (const task of tasksCache) {
    const groupID = taskRootId(task);
    const taskID = String(task?.id || '').trim();
    if (!groupID || !taskID) continue;
    if (!groupTaskIDs.has(groupID)) {
      groupTaskIDs.set(groupID, new Set());
    }
    groupTaskIDs.get(groupID).add(taskID);
  }

  for (const [groupID, closedSet] of closedTabsByGroup.entries()) {
    const validTaskIDs = groupTaskIDs.get(groupID);
    if (!validTaskIDs) {
      closedTabsByGroup.delete(groupID);
      continue;
    }
    for (const tabID of [...closedSet]) {
      if (!validTaskIDs.has(tabID)) {
        closedSet.delete(tabID);
      }
    }
    if (closedSet.size === 0) {
      closedTabsByGroup.delete(groupID);
    }
  }
}

function tabsForTaskGroup(rootTaskID) {
  const key = String(rootTaskID || '').trim();
  if (!key) return [];
  return tasksCache
    .filter((task) => taskRootId(task) === key)
    .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
}

function activeWorkspaceRepoPath(workspaceName = activeWorkspace) {
  const workspace = getWorkspace(workspaceName);
  return workspace?.repo_path || '';
}

function syncRepoInputToActiveWorkspace(force = false) {
  const repoPath = activeWorkspaceRepoPath();
  if (!repoPath) {
    if (force) {
      repoInputEl.value = '';
    }
    return;
  }
  if (force || !repoInputEl.value.trim()) {
    repoInputEl.value = repoPath;
  }
}

function isWorkspaceModalOpen() {
  return !workspaceModalBackdropEl.classList.contains('hidden');
}

function setWorkspaceModalError(message) {
  const text = String(message || '').trim();
  workspaceModalErrorEl.textContent = text;
  workspaceModalErrorEl.classList.toggle('hidden', !text);
}

function workspaceModalSnapshot() {
  const name = String(workspaceModalNameEl.value || '').trim();
  const repoPath = String(workspaceModalRepoEl.value || '').trim();
  const repoValidationMatches = workspaceRepoValidation.path === repoPath;
  const repoValid =
    Boolean(repoPath) && repoValidationMatches && workspaceRepoValidation.valid && !workspaceRepoValidation.checking;
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
  workspaceModalCreateSpinnerEl.classList.toggle('hidden', !workspaceModalCreating);
  workspaceModalCreateSpinnerEl.classList.toggle('animate-spin', workspaceModalCreating);
  workspaceModalCreateLabelEl.textContent = workspaceModalCreating ? 'Creating…' : 'Create Workspace';
  updateWorkspaceModalValidityUI();
}

function updateWorkspaceModalValidityUI() {
  const state = workspaceModalSnapshot();

  const showNameError = (workspaceModalNameTouched || workspaceModalSubmitAttempted) && !state.nameValid;
  workspaceModalNameEl.classList.toggle('workspace-modal-input-invalid', showNameError);
  workspaceModalNameEl.setAttribute('aria-invalid', showNameError ? 'true' : 'false');
  workspaceModalNameHelpEl.textContent = showNameError ? 'Workspace name is required.' : '';
  workspaceModalNameHelpEl.classList.toggle('workspace-modal-help-error', showNameError);

  const showRepoValidationError =
    (workspaceModalRepoTouched || workspaceModalSubmitAttempted) &&
    state.repoPath &&
    !workspaceRepoValidation.checking &&
    workspaceRepoValidation.path === state.repoPath &&
    !workspaceRepoValidation.valid;
  const showRepoRequiredError = (workspaceModalRepoTouched || workspaceModalSubmitAttempted) && !state.repoPath;
  const showRepoError = showRepoValidationError || showRepoRequiredError;
  workspaceModalRepoEl.classList.toggle('workspace-modal-input-invalid', showRepoError);
  workspaceModalRepoEl.setAttribute('aria-invalid', showRepoError ? 'true' : 'false');

  let repoHelpText = 'Select the root folder of your git repository.';
  let repoHelpError = false;
  if (showRepoRequiredError) {
    repoHelpText = 'Git repo path is required.';
    repoHelpError = true;
  } else if (state.repoPath && (workspaceRepoValidation.checking || workspaceRepoValidation.path !== state.repoPath)) {
    repoHelpText = 'Validating path...';
  } else if (showRepoValidationError) {
    repoHelpText = workspaceRepoValidation.message || 'Path does not exist.';
    repoHelpError = true;
  }
  workspaceModalRepoHelpEl.textContent = repoHelpText;
  workspaceModalRepoHelpEl.classList.toggle('workspace-modal-help-error', repoHelpError);

  workspaceModalCreateBtnEl.disabled = !state.canSubmit || workspaceRepoValidation.checking;
}

async function validateWorkspaceRepoPath(path) {
  const repoPath = String(path || '').trim();
  if (!repoPath) {
    workspaceRepoValidation = { path: '', valid: false, checking: false, message: '' };
    updateWorkspaceModalValidityUI();
    return;
  }

  const seq = ++workspaceRepoValidationSeq;
  workspaceRepoValidation = { path: repoPath, valid: false, checking: true, message: '' };
  updateWorkspaceModalValidityUI();

  try {
    const data = await api('/api/local/validate-directory', {
      method: 'POST',
      body: JSON.stringify({ path: repoPath }),
    });
    if (seq !== workspaceRepoValidationSeq) return;
    workspaceRepoValidation = {
      path: repoPath,
      valid: Boolean(data.valid),
      checking: false,
      message: String(data.message || (data.valid ? '' : 'Path does not exist.')),
    };
  } catch (error) {
    if (seq !== workspaceRepoValidationSeq) return;
    workspaceRepoValidation = {
      path: repoPath,
      valid: false,
      checking: false,
      message: String(error.message || error || 'Unable to validate path.'),
    };
  }
  updateWorkspaceModalValidityUI();
}

function queueWorkspaceRepoValidation({ immediate = false } = {}) {
  if (workspaceRepoValidationTimer) {
    clearTimeout(workspaceRepoValidationTimer);
    workspaceRepoValidationTimer = null;
  }
  const repoPath = String(workspaceModalRepoEl.value || '').trim();
  if (!repoPath) {
    workspaceRepoValidation = { path: '', valid: false, checking: false, message: '' };
    updateWorkspaceModalValidityUI();
    return;
  }
  if (immediate) {
    void validateWorkspaceRepoPath(repoPath);
    return;
  }
  workspaceRepoValidation = { path: repoPath, valid: false, checking: true, message: '' };
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
  workspaceRepoValidation = { path: '', valid: false, checking: false, message: '' };
  workspaceModalCreateSpinnerEl.classList.add('hidden');
  workspaceModalCreateSpinnerEl.classList.remove('animate-spin');
  workspaceModalCreateLabelEl.textContent = 'Create Workspace';
  setWorkspaceModalError('');
  workspaceModalNameHelpEl.textContent = '';
  workspaceModalNameHelpEl.classList.remove('workspace-modal-help-error');
  workspaceModalRepoHelpEl.textContent = 'Select the root folder of your git repository.';
  workspaceModalRepoHelpEl.classList.remove('workspace-modal-help-error');
  workspaceModalNameEl.classList.remove('workspace-modal-input-invalid');
  workspaceModalRepoEl.classList.remove('workspace-modal-input-invalid');
  workspaceModalNameEl.setAttribute('aria-invalid', 'false');
  workspaceModalRepoEl.setAttribute('aria-invalid', 'false');
  workspaceModalCreateBtnEl.disabled = true;
}

function hideWorkspaceInitPrompt() {
  pendingWorkspaceCreate = null;
  workspaceInitPromptEl.classList.add('hidden');
}

function showWorkspaceInitPrompt(name, repoPath) {
  pendingWorkspaceCreate = { name, repoPath };
  workspaceInitPromptEl.classList.remove('hidden');
}

function openWorkspaceModal() {
  workspaceModalNameEl.value = '';
  workspaceModalRepoEl.value = '';
  autoWorkspaceNameValue = '';
  resetWorkspaceModalValidationState();
  hideWorkspaceInitPrompt();
  workspaceModalBackdropEl.classList.remove('hidden');
  setTimeout(() => {
    workspaceModalNameEl.focus();
  }, 0);
}

function closeWorkspaceModal() {
  if (workspaceRepoValidationTimer) {
    clearTimeout(workspaceRepoValidationTimer);
    workspaceRepoValidationTimer = null;
  }
  workspaceModalBackdropEl.classList.add('hidden');
}

function isNewTaskModalOpen() {
  return Boolean(newTaskModalBackdropEl) && !newTaskModalBackdropEl.classList.contains('hidden');
}

function isNewTabTypeModalOpen() {
  return Boolean(newTabTypeModalBackdropEl) && !newTabTypeModalBackdropEl.classList.contains('hidden');
}

function isCloseTaskModalOpen() {
  return Boolean(closeTaskModalBackdropEl) && !closeTaskModalBackdropEl.classList.contains('hidden');
}

function setCloseTaskModalBusy(isBusy) {
  closeTaskModalBusy = Boolean(isBusy);
  const disabled = closeTaskModalBusy;
  if (closeTaskModalCancelBtnEl) closeTaskModalCancelBtnEl.disabled = disabled;
  if (closeTaskModalDeleteBtnEl) closeTaskModalDeleteBtnEl.disabled = disabled;
}

function closeCloseTaskModal(force = false) {
  if (!closeTaskModalBackdropEl) return;
  if (closeTaskModalBusy && !force) return;
  closeTaskModalBackdropEl.classList.add('hidden');
  closeTaskModalSelection = { rootTaskID: '', taskName: '' };
  if (closeTaskModalTaskNameEl) {
    closeTaskModalTaskNameEl.textContent = '';
  }
  setCloseTaskModalBusy(false);
}

function taskGroupTasks(rootTaskID) {
  const groupID = String(rootTaskID || '').trim();
  if (!groupID) return [];
  return tabsForTaskGroup(groupID);
}

function openCloseTaskModal(taskID) {
  if (!closeTaskModalBackdropEl) {
    closeTab(taskID);
    return;
  }

  const task = getTask(taskID);
  if (!task) return;

  const rootTaskID = taskRootId(task);
  if (!rootTaskID) return;

  const groupTasks = taskGroupTasks(rootTaskID);
  const rootTask = groupTasks.find((item) => String(item?.id || '').trim() === rootTaskID) || task;
  const taskName = String(rootTask?.name || task?.name || 'Untitled task').trim() || 'Untitled task';

  closeTaskModalSelection = { rootTaskID, taskName };
  if (closeTaskModalTaskNameEl) {
    closeTaskModalTaskNameEl.textContent = taskName;
    closeTaskModalTaskNameEl.title = taskName;
  }
  closeTaskModalBackdropEl.classList.remove('hidden');
  setCloseTaskModalBusy(false);
  setTimeout(() => {
    closeTaskModalCancelBtnEl?.focus();
  }, 0);
}

function resolveNewTabContext(options = {}) {
  const hasRootTaskOverride = Object.prototype.hasOwnProperty.call(options, 'rootTaskID');
  const activeTask = getTask(activeTabId);
  const defaultRootTaskID = String(activeTaskGroupId || taskRootId(activeTask) || '').trim();
  const rootTaskID = String(hasRootTaskOverride ? options.rootTaskID : defaultRootTaskID).trim();
  const rootTask = rootTaskID ? getTask(rootTaskID) : null;
  const fallbackWorkspaceID = rootTask ? workspaceIdByName(rootTask.workspace) : '';
  const preferredWorkspace = String(options.preferredWorkspace || fallbackWorkspaceID || activeWorkspace || '').trim();
  return { preferredWorkspace, rootTaskID };
}

function closeNewTabTypeModal() {
  if (!newTabTypeModalBackdropEl) return;
  newTabTypeModalBackdropEl.classList.add('hidden');
}

function openNewTabTypeModal(options = {}) {
  if (!newTabTypeModalBackdropEl) {
    openNewTaskModal(resolveNewTabContext(options));
    return;
  }
  if (!workspaces.length) {
    openWorkspaceModal();
    return;
  }
  newTabTypeSelection = resolveNewTabContext(options);
  newTabTypeModalBackdropEl.classList.remove('hidden');
  setTimeout(() => {
    newTabTypeTerminalBtnEl?.focus();
  }, 0);
}

async function createTerminalTab(options = {}) {
  const context = resolveNewTabContext(options);
  const rootTaskID = String(context.rootTaskID || '').trim();
  const rootTask = rootTaskID ? getTask(rootTaskID) : null;
  const targetWorkspaceID = String(context.preferredWorkspace || '').trim();
  if (!targetWorkspaceID) {
    openWorkspaceModal();
    return;
  }
  const targetWorkspace = getWorkspace(targetWorkspaceID);
  const targetWorkspaceName = String(targetWorkspace?.name || '').trim();
  if (!targetWorkspace || !targetWorkspaceName) {
    openWorkspaceModal();
    throw new Error('Selected workspace was not found.');
  }

  const rootWorkspaceID = rootTask ? workspaceIdByName(rootTask.workspace) : '';
  const sameWorkspaceRoot = Boolean(
    rootTaskID && rootTask && rootWorkspaceID && rootWorkspaceID.toLowerCase() === targetWorkspaceID.toLowerCase(),
  );
  const normalizedRootTaskID = sameWorkspaceRoot ? rootTaskID : '';

  const workspaceRepoPath = String(targetWorkspace?.repo_path || '').trim();
  const manualRepoPath = String(repoInputEl.value || '').trim();
  const rootTaskPath = String(taskCodePath(rootTask) || '').trim();
  const activeTaskPath = String(taskCodePath(getTask(activeTabId)) || '').trim();
  const resolvedRepoPath = sameWorkspaceRoot
    ? rootTaskPath || workspaceRepoPath || manualRepoPath || activeTaskPath
    : workspaceRepoPath || manualRepoPath || activeTaskPath;
  if (!resolvedRepoPath && !normalizedRootTaskID) {
    throw new Error('Repo path is required. Select a workspace with a repo, or set Repo Path first.');
  }

  const payload = {
    name: 'Terminal',
    workspace: targetWorkspaceName,
    tags: [],
    repo_path: resolvedRepoPath,
    command: TERMINAL_TAB_COMMAND,
    prompt: '',
    preset: 'none',
    direct_repo: true,
    root_task_id: normalizedRootTaskID,
    ...taskStartTerminalSize(),
  };

  const result = await api('/api/tasks', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  await loadTasks({ keepTab: true });
  await loadWorkspaces();
  if (result.task && result.task.id) {
    openTab(result.task.id);
  }
}

function openExistingNewTabFlow() {
  const options = {
    preferredWorkspace: newTabTypeSelection.preferredWorkspace,
    rootTaskID: newTabTypeSelection.rootTaskID,
  };
  closeNewTabTypeModal();
  openNewTaskModal(options);
}

function setNewTaskModalError(message) {
  if (!newTaskModalErrorEl) return;
  const text = String(message || '').trim();
  newTaskModalErrorEl.textContent = text;
  newTaskModalErrorEl.classList.toggle('hidden', !text);
}

function workspaceOptionsForNewTaskModal() {
  const options = [];
  const seen = new Set();

  function addWorkspace(workspace) {
    const id = workspaceId(workspace);
    const name = String(workspace?.name || '').trim();
    if (!id || !name) return;
    const key = id.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    options.push({ id, name });
  }

  addWorkspace(getWorkspace(activeWorkspace));
  for (const workspace of workspaces) {
    addWorkspace(workspace);
  }

  return options;
}

function populateNewTaskModalWorkspaceOptions(defaultWorkspace = activeWorkspace) {
  if (!newTaskModalWorkspaceEl) return '';
  const options = workspaceOptionsForNewTaskModal();
  if (!options.length) {
    newTaskModalWorkspaceEl.innerHTML = '';
    return '';
  }
  const preferred = String(defaultWorkspace || '')
    .trim()
    .toLowerCase();
  const preferredKey = preferred.toLowerCase();
  let selected = options[0]?.id || '';
  if (preferredKey) {
    const matched = options.find((option) => option.id.toLowerCase() === preferredKey);
    if (matched) selected = matched.id;
  }

  newTaskModalWorkspaceEl.innerHTML = options
    .map((option) => {
      const selectedAttr = option.id.toLowerCase() === selected.toLowerCase() ? ' selected' : '';
      return `<option value="${escapeHtml(option.id)}"${selectedAttr}>${escapeHtml(option.name)}</option>`;
    })
    .join('');
  return selected;
}

function newTaskModalSnapshot() {
  const prompt = String(newTaskModalPromptEl?.value || '').trim();
  const agent = String(newTaskModalAgentEl?.value || '').trim();
  const workspace = String(newTaskModalWorkspaceEl?.value || activeWorkspace || '').trim();
  const promptValid = Boolean(prompt);
  const agentValid = Boolean(AGENT_COMMANDS[agent]);
  const workspaceValid = Boolean(workspace);
  return {
    prompt,
    agent,
    workspace,
    promptValid,
    agentValid,
    workspaceValid,
    canSubmit: promptValid && agentValid && workspaceValid && !newTaskModalCreating && !launchingAgent,
  };
}

function setNewTaskModalCreateLoading(loading) {
  if (!newTaskModalCreateSpinnerEl || !newTaskModalCreateLabelEl || !newTaskModalCreateBtnEl) return;
  newTaskModalCreating = Boolean(loading);
  newTaskModalCreateSpinnerEl.classList.toggle('hidden', !newTaskModalCreating);
  newTaskModalCreateSpinnerEl.classList.toggle('animate-spin', newTaskModalCreating);
  newTaskModalCreateLabelEl.textContent = newTaskModalCreating ? 'Starting…' : 'Start Task';
  updateNewTaskModalValidityUI();
}

function updateNewTaskModalValidityUI() {
  if (!newTaskModalPromptEl || !newTaskModalPromptHelpEl || !newTaskModalCreateBtnEl) return;
  const state = newTaskModalSnapshot();
  const showPromptError = (newTaskModalPromptTouched || newTaskModalSubmitAttempted) && !state.promptValid;
  newTaskModalPromptEl.classList.toggle('new-task-modal-input-invalid', showPromptError);
  newTaskModalPromptEl.setAttribute('aria-invalid', showPromptError ? 'true' : 'false');
  newTaskModalPromptHelpEl.textContent = showPromptError ? 'Task instructions are required.' : '';
  newTaskModalPromptHelpEl.classList.toggle('workspace-modal-help-error', showPromptError);
  newTaskModalCreateBtnEl.disabled = !state.canSubmit;
}

function resetNewTaskModalState() {
  if (
    !newTaskModalPromptEl ||
    !newTaskModalPromptHelpEl ||
    !newTaskModalCreateBtnEl ||
    !newTaskModalCreateLabelEl ||
    !newTaskModalCreateSpinnerEl
  )
    return;
  newTaskModalPromptTouched = false;
  newTaskModalSubmitAttempted = false;
  newTaskModalCreating = false;
  setNewTaskModalError('');
  newTaskModalPromptHelpEl.textContent = '';
  newTaskModalPromptHelpEl.classList.remove('workspace-modal-help-error');
  newTaskModalPromptEl.classList.remove('new-task-modal-input-invalid');
  newTaskModalPromptEl.setAttribute('aria-invalid', 'false');
  newTaskModalCreateSpinnerEl.classList.add('hidden');
  newTaskModalCreateSpinnerEl.classList.remove('animate-spin');
  newTaskModalCreateLabelEl.textContent = 'Start Task';
  updateNewTaskModalValidityUI();
}

function openNewTaskModal({ preferredWorkspace = activeWorkspace, rootTaskID = '' } = {}) {
  if (!newTaskModalBackdropEl || !newTaskModalPromptEl || !newTaskModalAgentEl) return;
  if (!workspaces.length) {
    openWorkspaceModal();
    return;
  }
  newTaskModalPromptEl.value = String(promptInputEl.value || '');
  const selectedAgent = AGENT_COMMANDS[agentSelectEl.value] ? agentSelectEl.value : 'claude';
  newTaskModalAgentEl.value = selectedAgent;
  populateNewTaskModalWorkspaceOptions(preferredWorkspace);
  newTaskModalRootTaskId = String(rootTaskID || '').trim();
  resetNewTaskModalState();
  newTaskModalBackdropEl.classList.remove('hidden');
  setTimeout(() => {
    newTaskModalPromptEl.focus();
  }, 0);
}

function closeNewTaskModal() {
  if (!newTaskModalBackdropEl) return;
  newTaskModalBackdropEl.classList.add('hidden');
}

async function submitNewTaskModal() {
  if (!newTaskModalPromptEl) return;
  setNewTaskModalError('');
  newTaskModalSubmitAttempted = true;
  updateNewTaskModalValidityUI();
  const state = newTaskModalSnapshot();
  if (!state.promptValid) {
    newTaskModalPromptTouched = true;
    updateNewTaskModalValidityUI();
    newTaskModalPromptEl.focus();
    return;
  }
  if (!state.agentValid) {
    setNewTaskModalError('Choose a valid agent.');
    newTaskModalAgentEl?.focus();
    return;
  }
  if (!state.workspaceValid) {
    setNewTaskModalError('Choose a workspace.');
    newTaskModalWorkspaceEl?.focus();
    return;
  }
  if (!state.canSubmit) {
    return;
  }

  setNewTaskModalCreateLoading(true);
  try {
    const rootTask = getTask(newTaskModalRootTaskId);
    const rootWorkspaceID = rootTask ? workspaceIdByName(rootTask.workspace) : '';
    const rootTaskID = rootWorkspaceID && rootWorkspaceID === state.workspace ? newTaskModalRootTaskId : '';
    await createQuickTaskForAgent(state.agent, {
      prompt: state.prompt,
      workspace: state.workspace,
      rootTaskID,
      keepPromptInput: true,
    });
    closeNewTaskModal();
  } catch (error) {
    setNewTaskModalError(error.message || String(error));
  } finally {
    setNewTaskModalCreateLoading(false);
  }
}

async function browseWorkspaceRepoIntoModal() {
  setWorkspaceModalError('');
  const picked = await api('/api/local/browse-directory', { method: 'POST' });
  const path = String(picked.path || '').trim();
  if (!path) {
    throw new Error('No folder selected.');
  }
  workspaceModalRepoEl.value = path;
  syncWorkspaceNameWithRepoPath(path);
  workspaceModalRepoTouched = true;
  queueWorkspaceRepoValidation({ immediate: true });
  return path;
}

function inferWorkspaceNameFromRepoPath(repoPath) {
  const normalized = String(repoPath || '')
    .trim()
    .replaceAll('\\', '/')
    .replace(/\/+$/, '');
  if (!normalized) return '';
  const parts = normalized.split('/').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '';
}

function normalizeRepoPathKey(path) {
  return String(path || '')
    .trim()
    .replaceAll('\\', '/')
    .replace(/\/+$/, '')
    .toLowerCase();
}

function findExistingWorkspace(name, repoPath) {
  const nameKey = String(name || '')
    .trim()
    .toLowerCase();
  const repoKey = normalizeRepoPathKey(repoPath);
  return (
    workspaces.find((workspace) => {
      const wsName = String(workspace?.name || '')
        .trim()
        .toLowerCase();
      const wsRepo = normalizeRepoPathKey(workspace?.repo_path || '');
      return (nameKey && wsName === nameKey) || (repoKey && wsRepo === repoKey);
    }) || null
  );
}

function syncWorkspaceNameWithRepoPath(repoPath) {
  const suggested = inferWorkspaceNameFromRepoPath(repoPath);
  const currentName = String(workspaceModalNameEl.value || '').trim();
  if (!suggested) {
    if (currentName === autoWorkspaceNameValue) {
      workspaceModalNameEl.value = '';
    }
    autoWorkspaceNameValue = '';
    return;
  }
  // Only auto-fill when the name is empty or still using the previous auto value.
  if (!currentName || currentName === autoWorkspaceNameValue) {
    workspaceModalNameEl.value = suggested;
  }
  autoWorkspaceNameValue = suggested;
}

function tasksForWorkspace(workspaceID) {
  const workspace = getWorkspace(workspaceID);
  const workspaceName = String(workspace?.name || '').trim();
  if (!workspaceName) return [];
  return tasksCache
    .filter(
      (task) =>
        String(task.workspace || '')
          .trim()
          .toLowerCase() === workspaceName.toLowerCase(),
    )
    .sort((a, b) => {
      const createdA = new Date(a.created_at || 0).getTime() || 0;
      const createdB = new Date(b.created_at || 0).getTime() || 0;
      if (createdB !== createdA) return createdB - createdA;
      return String(b.id || '').localeCompare(String(a.id || ''));
    });
}

function openFirstTaskForWorkspace(workspaceID) {
  const tasks = tasksForWorkspace(workspaceID);
  if (!tasks.length) return;
  const firstTask = tasks[0];
  openTaskGroup(taskRootId(firstTask), firstTask.id);
}

async function openOrCreateDefaultTaskForWorkspace(workspaceID) {
  const tasks = tasksForWorkspace(workspaceID);
  if (tasks.length) {
    const firstTask = tasks[0];
    openTaskGroup(taskRootId(firstTask), firstTask.id);
    return;
  }
  await createTerminalTab({ preferredWorkspace: workspaceID, rootTaskID: '' });
}

function taskGroupsForWorkspace(workspaceID) {
  const grouped = new Map();
  for (const task of tasksForWorkspace(workspaceID)) {
    const rootTaskID = taskRootId(task);
    if (!rootTaskID) continue;
    const existing = grouped.get(rootTaskID) || {
      rootTaskID,
      tasks: [],
      latestUpdatedAt: '',
      latestUpdatedAtMs: 0,
      latestCreatedAtMs: 0,
    };
    existing.tasks.push(task);
    const updatedAtMs = new Date(task.updated_at).getTime() || 0;
    if (updatedAtMs >= existing.latestUpdatedAtMs) {
      existing.latestUpdatedAtMs = updatedAtMs;
      existing.latestUpdatedAt = task.updated_at;
    }
    const createdAtMs = new Date(task.created_at).getTime() || 0;
    if (createdAtMs >= existing.latestCreatedAtMs) {
      existing.latestCreatedAtMs = createdAtMs;
    }
    grouped.set(rootTaskID, existing);
  }
  return [...grouped.values()]
    .map((group) => {
      const rootTask = group.tasks.find((task) => task.id === group.rootTaskID) || group.tasks[0] || null;
      const rootCreatedAtMs = new Date(rootTask?.created_at || 0).getTime() || 0;
      return {
        ...group,
        rootTask,
        sortCreatedAtMs: rootCreatedAtMs || group.latestCreatedAtMs,
      };
    })
    .sort((a, b) => {
      if (b.sortCreatedAtMs !== a.sortCreatedAtMs) {
        return b.sortCreatedAtMs - a.sortCreatedAtMs;
      }
      return String(b.rootTaskID || '').localeCompare(String(a.rootTaskID || ''));
    });
}

function ensureTerminal() {
  if (terminalReady) return;
  terminal = new Terminal({
    convertEol: false,
    cursorBlink: true,
    cursorStyle: 'block',
    cursorInactiveStyle: 'outline',
    fontFamily: '"JetBrains Mono", "SF Mono", "Roboto Mono", ui-monospace, monospace',
    fontSize: 12,
    lineHeight: 1.2,
    allowProposedApi: true,
    macOptionIsMeta: false,
    screenReaderMode: false,
    scrollback: 5000,
    scrollbar: { showScrollbar: false },
    theme: buildTerminalTheme(),
  });
  watchThemeChanges();

  fitAddon = new FitAddon.FitAddon();
  terminal.loadAddon(fitAddon);
  terminal.open(document.getElementById('terminal'));
  fitTerminalViewport();
  if (document.fonts?.ready) {
    document.fonts.ready
      .then(() => {
        scheduleTerminalFitAndResize(0);
      })
      .catch(() => {});
  }
  if (typeof ResizeObserver !== 'undefined') {
    terminalResizeObserver = new ResizeObserver(() => {
      scheduleTerminalFitAndResize();
    });
    const terminalHost = document.getElementById('terminal');
    if (terminalHost) {
      terminalResizeObserver.observe(terminalHost);
    }
  }

  // Suppress terminal query responses (CSI R, I, O, $y) from showing as visible text
  try {
    const parser = terminal.parser;
    if (parser) {
      parser.registerCsiHandler({ final: 'R' }, () => true);
      parser.registerCsiHandler({ final: 'I' }, () => true);
      parser.registerCsiHandler({ final: 'O' }, () => true);
      parser.registerCsiHandler({ intermediates: '$', final: 'y' }, () => true);
    }
  } catch (_) {}

  // Copy handler: trim trailing whitespace from copied text
  const xtermElement = terminal.element;
  if (xtermElement) {
    xtermElement.addEventListener('copy', (event) => {
      const selection = terminal.getSelection();
      if (!selection) return;
      const trimmed = selection
        .split('\n')
        .map((line) => line.trimEnd())
        .join('\n');
      if (event.clipboardData) {
        event.preventDefault();
        event.clipboardData.setData('text/plain', trimmed);
      }
    });
  }

  terminal.onData((data) => {
    if (!activeTabId) return;
    const task = getTask(activeTabId);
    if (!task || task.status !== 'running') return;
    // Signal characters (Ctrl+C, Ctrl+Z, Ctrl+\) must bypass the
    // debounced buffer and be sent immediately so interrupts aren't delayed.
    if (data === '\x03' || data === '\x1a' || data === '\x1c') {
      flushInputImmediately(data);
      return;
    }
    inputBuffer += data;
    scheduleInputFlush();
  });

  // Keyboard handler: Cmd+Backspace, Cmd+Left/Right, Option+Left/Right
  const isMac = navigator.platform.toLowerCase().includes('mac');
  terminal.attachCustomKeyEventHandler((event) => {
    if (event.type !== 'keydown') return true;

    // Force Ctrl+C to PTY to preserve terminal interrupt behavior in webview.
    if (isCtrlC(event)) {
      if (interruptOrStopActiveTask()) {
        lastInterruptHandledAt = Date.now();
        event.preventDefault();
        return false;
      }
    }

    // Cmd+Backspace: clear line (Ctrl+U + left arrow)
    if (event.key === 'Backspace' && event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) {
      event.preventDefault();
      sendTerminalInput('\x15\x1b[D');
      return false;
    }
    // Cmd+Left: beginning of line (Ctrl+A)
    if (event.key === 'ArrowLeft' && event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) {
      event.preventDefault();
      sendTerminalInput('\x01');
      return false;
    }
    // Cmd+Right: end of line (Ctrl+E)
    if (event.key === 'ArrowRight' && event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) {
      event.preventDefault();
      sendTerminalInput('\x05');
      return false;
    }
    // Option+Left (macOS): backward word (Meta+B)
    if (event.key === 'ArrowLeft' && event.altKey && isMac && !event.metaKey && !event.ctrlKey && !event.shiftKey) {
      sendTerminalInput('\x1bb');
      return false;
    }
    // Option+Right (macOS): forward word (Meta+F)
    if (event.key === 'ArrowRight' && event.altKey && isMac && !event.metaKey && !event.ctrlKey && !event.shiftKey) {
      sendTerminalInput('\x1bf');
      return false;
    }
    return true;
  });

  // Click-to-move cursor on the current prompt line
  if (terminal.element) {
    terminal.element.addEventListener('click', (event) => {
      if (terminal.buffer.active !== terminal.buffer.normal) return;
      if (event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
      if (terminal.hasSelection()) return;

      const rect = terminal.element.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      const dims = terminal._core?._renderService?.dimensions;
      if (!dims?.css?.cell) return;
      const cellW = dims.css.cell.width;
      const cellH = dims.css.cell.height;
      if (cellW <= 0 || cellH <= 0) return;

      const col = Math.max(0, Math.min(terminal.cols - 1, Math.floor(x / cellW)));
      const row = Math.max(0, Math.min(terminal.rows - 1, Math.floor(y / cellH)));
      const buf = terminal.buffer.active;
      const clickRow = row + buf.viewportY;
      if (clickRow !== buf.cursorY + buf.viewportY) return;

      const delta = col - buf.cursorX;
      if (delta === 0) return;
      const arrow = delta > 0 ? '\x1b[C' : '\x1b[D';
      sendTerminalInput(arrow.repeat(Math.abs(delta)));
    });
  }

  terminalReady = true;
}

// Helper to send raw data directly to the active task's PTY
function sendTerminalInput(data) {
  const taskId = String(activeTabId || '').trim();
  if (!taskId) return;
  api(`/api/tasks/${taskId}/terminal/input`, {
    method: 'POST',
    body: JSON.stringify({ input: data, append_newline: false }),
  }).catch((err) => console.error(err));
}

function fitTerminalViewport() {
  if (!terminal || !fitAddon) return;
  try {
    fitAddon.fit();
  } catch (_) {}
}

function taskStartTerminalSize() {
  fitTerminalViewport();
  const cols = Math.max(40, Number(terminal?.cols) || 120);
  const rows = Math.max(12, Number(terminal?.rows) || 40);
  return { cols, rows };
}

function scheduleTerminalFitAndResize(delay = 150) {
  if (terminalFitTimer) clearTimeout(terminalFitTimer);
  terminalFitTimer = setTimeout(() => {
    fitTerminalViewport();
  }, delay);

  if (terminalBackendResizeTimer) clearTimeout(terminalBackendResizeTimer);
  terminalBackendResizeTimer = setTimeout(() => {
    resizeTerminalForActiveTab().catch(() => {});
  }, delay + 40);
}

// Send signal characters (Ctrl+C etc.) immediately, bypassing the debounce buffer.
// These must not be delayed or batched — they need to reach the PTY as fast as possible.
// If the task is not running, we silently drop the signal (no resume/restart).
async function flushInputImmediately(data) {
  // Also flush any pending buffered input first so ordering is preserved.
  if (inputBuffer) {
    const pending = inputBuffer;
    inputBuffer = '';
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    const taskId = String(activeTabId || '').trim();
    if (pending && taskId) {
      try {
        await api(`/api/tasks/${taskId}/terminal/input`, {
          method: 'POST',
          body: JSON.stringify({ input: pending, append_newline: false }),
        });
      } catch (_) {}
    }
  }
  const taskId = String(activeTabId || '').trim();
  if (!data || !taskId) return;
  try {
    await api(`/api/tasks/${taskId}/terminal/input`, {
      method: 'POST',
      body: JSON.stringify({ input: data, append_newline: false }),
    });
  } catch (_) {
    if (data === '\x03') {
      try {
        await api(`/api/tasks/${taskId}/terminal/interrupt`, { method: 'POST' });
      } catch (_) {}
    }
    // Signal on a non-running task is intentionally dropped — don't restart.
  }
}

function scheduleInputFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(async () => {
    flushTimer = null;
    const chunk = inputBuffer;
    inputBuffer = '';
    const taskId = String(activeTabId || '').trim();
    if (!chunk || !taskId) return;
    try {
      await api(`/api/tasks/${taskId}/terminal/input`, {
        method: 'POST',
        body: JSON.stringify({ input: chunk, append_newline: false }),
      });
    } catch (error) {
      const message = String(error?.message || '').toLowerCase();
      const notRunning = message.includes('not running');
      if (!notRunning) {
        console.error(error);
      }
    }
  }, 25);
}

function setTerminalOverlay(message, show = true) {
  terminalOverlayTextEl.textContent = message;
  terminalOverlayEl.classList.toggle('hidden', !show);
}

async function resizeTerminalForActiveTab() {
  if (centerViewMode !== 'terminal') return;
  fitTerminalViewport();
  const task = getTask(activeTabId);
  if (!task || task.status !== 'running' || !terminalReady) return;
  if (terminal.cols === lastPtyCols && terminal.rows === lastPtyRows) return;
  lastPtyCols = terminal.cols;
  lastPtyRows = terminal.rows;
  await api(`/api/tasks/${activeTabId}/terminal/resize`, {
    method: 'POST',
    body: JSON.stringify({ cols: terminal.cols, rows: terminal.rows }),
  });
}

function workspaceInitial(name) {
  return String(name || 'W')
    .charAt(0)
    .toUpperCase();
}

function WorkspaceHeader(id, name, taskCount, isOpen) {
  return `
        <summary class="workspace-summary" data-workspace-summary="${escapeHtml(id)}">
          <span class="workspace-avatar">${workspaceInitial(name)}</span>
          <span class="workspace-name">${escapeHtml(name)}</span>
          <span class="workspace-count">(${taskCount})</span>
          <div class="workspace-actions">
            <button
              class="icon-btn ghost-action workspace-add-tab-btn p-1 rounded hover:bg-muted transition-colors shrink-0 ml-1"
              type="button"
              data-new-workspace-tab="${escapeHtml(id)}"
              aria-label="New tab in ${escapeHtml(name)}"
              data-state="closed"
              data-slot="tooltip-trigger"
              title="New tab in ${escapeHtml(name)}"
            ><svg stroke="currentColor" fill="currentColor" stroke-width="0" viewBox="0 0 20 20" aria-hidden="true" class="workspace-add-tab-icon size-4 text-muted-foreground" height="1em" width="1em" xmlns="http://www.w3.org/2000/svg"><path d="M10.75 4.75a.75.75 0 0 0-1.5 0v4.5h-4.5a.75.75 0 0 0 0 1.5h4.5v4.5a.75.75 0 0 0 1.5 0v-4.5h4.5a.75.75 0 0 0 0-1.5h-4.5v-4.5Z"></path></svg></button>
            <button
              class="icon-btn ghost-action workspace-delete-btn"
              type="button"
              data-delete-workspace="${escapeHtml(id)}"
              aria-label="Delete workspace ${escapeHtml(name)}"
              title="Delete workspace ${escapeHtml(name)}"
            ><svg stroke="currentColor" fill="currentColor" stroke-width="0" viewBox="0 0 20 20" aria-hidden="true" class="sidebar-task-close-icon size-3.5" height="1em" width="1em" xmlns="http://www.w3.org/2000/svg"><path d="M6.28 5.22a.75.75 0 0 0-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 1 0 1.06 1.06L10 11.06l3.72 3.72a.75.75 0 1 0 1.06-1.06L11.06 10l3.72-3.72a.75.75 0 0 0-1.06-1.06L10 8.94 6.28 5.22Z"></path></svg></button>
          </div>
        </summary>`;
}

function healthDotColor(status) {
  switch (String(status || '').toLowerCase()) {
    case 'running':
      return 'status-running';
    case 'pending':
      return 'status-pending';
    case 'failed':
      return 'status-failed';
    case 'stopped':
    case 'completed':
      return 'status-stopped';
    default:
      return 'status-stopped';
  }
}

function healthDotTooltip(status, updatedAt) {
  const state = status || 'unknown';
  const time = updatedAt ? new Date(updatedAt).toLocaleTimeString() : '–';
  return `${state} \u00b7 last active ${time}`;
}

function SidebarRow({ id, title, subtitle, isSelected, dataAttr, status, updatedAt, canCloseWorktree, closeTaskID }) {
  const selectedClass = isSelected ? 'selected' : '';
  const attr = dataAttr || '';
  const closeBtn = canCloseWorktree
    ? `<button class="sidebar-task-close flex items-center justify-center text-muted-foreground hover:text-foreground" type="button" data-close-worktree-task="${escapeHtml(closeTaskID || id)}" aria-label="Close ${escapeHtml(title)}" data-state="closed" data-slot="tooltip-trigger" title="Close ${escapeHtml(title)}"><svg stroke="currentColor" fill="currentColor" stroke-width="0" viewBox="0 0 20 20" aria-hidden="true" class="sidebar-task-close-icon size-3.5" height="1em" width="1em" xmlns="http://www.w3.org/2000/svg"><path d="M6.28 5.22a.75.75 0 0 0-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 1 0 1.06 1.06L10 11.06l3.72 3.72a.75.75 0 1 0 1.06-1.06L11.06 10l3.72-3.72a.75.75 0 0 0-1.06-1.06L10 8.94 6.28 5.22Z"></path></svg></button>`
    : '';
  const dot = status
    ? `<span class="sidebar-status-dot ${healthDotColor(status)}" title="${escapeHtml(healthDotTooltip(status, updatedAt))}"></span>`
    : '';
  return `
        <div class="sidebar-row ${selectedClass}" ${attr}>
          <div class="sidebar-row-content">
            <span class="sidebar-row-title">${escapeHtml(title)}</span>
            ${subtitle ? `<span class="sidebar-row-subtitle">${escapeHtml(subtitle)}</span>` : ''}
          </div>
          ${dot}
          ${closeBtn}
        </div>`;
}

function renderWorkspaces() {
  const rows = workspaces
    .map((workspace, idx) => {
      const id = workspaceId(workspace);
      const name = String(workspace.name || '').trim();
      if (!id || !name) {
        return null;
      }
      const isActive = id === activeWorkspace;
      const isOpen = expandedWorkspaces.has(id);
      const taskGroups = taskGroupsForWorkspace(id);
      const workspaceUpdatedAtMs = new Date(workspace.updated_at || workspace.created_at || 0).getTime() || 0;
      const latestUpdatedAtMs = taskGroups.reduce(
        (max, group) => Math.max(max, Number(group.latestUpdatedAtMs || 0)),
        workspaceUpdatedAtMs,
      );
      const tasks = taskGroups
        .map((group) => {
          const task = group.rootTask;
          if (!task) return null;
          return {
            rootTaskID: group.rootTaskID,
            title: task.name || 'untitled',
            subtitle: String(task.branch || '').trim() || '-',
            isSelected: group.rootTaskID === activeTaskGroupId,
            canCloseWorktree: !Boolean(task.direct_repo),
            closeTaskID: group.rootTaskID,
            rawStatus: task.status || '',
            dotClass: healthDotColor(task.status || ''),
            dotTooltip: healthDotTooltip(task.status, group.latestUpdatedAt),
          };
        })
        .filter(Boolean);

      return {
        id,
        name,
        initial: workspaceInitial(name),
        isActive,
        isOpen,
        taskCount: taskGroups.length,
        showDivider: idx > 0,
        tasks,
        latestUpdatedAtMs,
        originalIndex: idx,
      };
    })
    .filter(Boolean);

  const sortedRows = rows.sort((a, b) => {
    if (b.latestUpdatedAtMs !== a.latestUpdatedAtMs) {
      return b.latestUpdatedAtMs - a.latestUpdatedAtMs;
    }
    return a.originalIndex - b.originalIndex;
  });

  const bridge = reactBridge();
  if (bridge?.renderWorkspaces) {
    const payload = {
      empty: sortedRows.length === 0,
      rows: sortedRows.map((row) => ({
        id: row.id,
        name: row.name,
        initial: row.initial,
        isActive: row.isActive,
        isOpen: row.isOpen,
        taskCount: row.taskCount,
        showDivider: row.showDivider,
        tasks: row.tasks,
      })),
    };
    const signature = JSON.stringify(payload);
    if (signature === lastWorkspaceListHTML) return;
    bridge.renderWorkspaces(payload);
    lastWorkspaceListHTML = signature;
    return;
  }

  if (!sortedRows.length) {
    const html = `<div class="sidebar-empty">No workspaces</div>`;
    if (html === lastWorkspaceListHTML) return;
    workspaceListEl.innerHTML = html;
    lastWorkspaceListHTML = html;
    return;
  }

  const html = sortedRows
    .map((row) => {
      const divider = row.showDivider ? `<div class="workspace-divider"></div>` : '';
      const tasksHtml = row.tasks.length
        ? row.tasks
            .map((task) =>
              SidebarRow({
                id: task.rootTaskID,
                title: task.title,
                subtitle: task.subtitle,
                isSelected: task.isSelected,
                dataAttr: `data-open-task="${task.rootTaskID}"`,
                canCloseWorktree: task.canCloseWorktree,
                closeTaskID: task.closeTaskID,
                status: task.rawStatus,
                updatedAt: '',
              }),
            )
            .join('')
        : `<div class="sidebar-empty sidebar-empty-tasks">No tasks</div>`;

      return `
            ${divider}
            <details class="workspace-node ${row.isActive ? 'active' : ''}" data-workspace-node="${escapeHtml(row.id)}" ${row.isOpen ? 'open' : ''}>
              ${WorkspaceHeader(row.id, row.name, row.taskCount, row.isOpen)}
              <div class="workspace-children">
                ${tasksHtml}
              </div>
            </details>
          `;
    })
    .join('');
  if (html === lastWorkspaceListHTML) return;
  workspaceListEl.innerHTML = html;
  lastWorkspaceListHTML = html;
}

function renderWorkspaceTasks() {
  // tasks are rendered inline under each workspace node
}

function tabLabel(task, index) {
  const name = task.name || 'untitled';
  const hint = task.command ? task.command.split(' ')[0] : '';
  const suffix = hint ? ` \u00b7 ${hint}` : ` #${index + 1}`;
  const full = name + suffix;
  const truncated = full.length > 24 ? full.slice(0, 22) + '\u2026' : full;
  return { truncated, full };
}

function renderTabs() {
  const tasksWithIndex = openTabs.map((taskId, idx) => ({ task: getTask(taskId), idx })).filter(({ task }) => task);
  const MAX_VISIBLE_TABS = 6;
  const allTabs = tasksWithIndex.map(({ task, idx }) => {
    const label = tabLabel(task, idx);
    return {
      id: task.id,
      label: label.truncated,
      title: label.full,
      active: task.id === activeTabId,
      name: task.name || 'untitled',
    };
  });

  const bridge = reactBridge();
  if (tasksWithIndex.length > MAX_VISIBLE_TABS) {
    const overflowCount = tasksWithIndex.length - MAX_VISIBLE_TABS;
    const payload = {
      tabs: allTabs.slice(0, MAX_VISIBLE_TABS),
      overflow: allTabs.slice(MAX_VISIBLE_TABS).map((tab) => ({ id: tab.id, name: tab.name })),
      overflowCount,
      showEmptyHint: false,
    };

    if (bridge?.renderTabs) {
      const signature = JSON.stringify(payload);
      if (signature === lastTabBarHTML) return;
      bridge.renderTabs(payload);
      lastTabBarHTML = signature;
      return;
    }

    const visibleHtml = payload.tabs
      .map(
        (tab) => `
          <div class="tab ${tab.active ? 'active' : ''}" data-tab="${tab.id}" title="${escapeHtml(tab.title)}">
            <span class="tab-label">${escapeHtml(tab.label)}</span>
            <button class="tab-close" data-close-tab="${tab.id}" type="button" aria-label="Close tab">&times;</button>
          </div>
        `,
      )
      .join('');
    const overflowItems = payload.overflow
      .map(
        (tab) =>
          `<button class="tab-overflow-item" data-overflow-tab="${tab.id}" type="button">${escapeHtml(tab.name)}</button>`,
      )
      .join('');
    const html = `
          <div class="tab-list">
            ${visibleHtml}
            <div class="tab-overflow-wrap">
              <button class="tab-overflow-btn" type="button" aria-label="More tabs">+${overflowCount} more</button>
              <div class="tab-overflow-menu hidden">
                ${overflowItems}
              </div>
            </div>
            <button class="tab plus-tab" type="button" aria-label="New tab">+</button>
          </div>
        `;
    if (html === lastTabBarHTML) return;
    tabBarEl.innerHTML = html;
    lastTabBarHTML = html;
    return;
  }

  const payload = {
    tabs: allTabs,
    overflow: [],
    overflowCount: 0,
    showEmptyHint: !openTabs.length,
  };

  if (bridge?.renderTabs) {
    const signature = JSON.stringify(payload);
    if (signature === lastTabBarHTML) return;
    bridge.renderTabs(payload);
    lastTabBarHTML = signature;
    return;
  }

  const dynamicTabs = payload.tabs
    .map(
      (tab) => `
          <div class="tab ${tab.active ? 'active' : ''}" data-tab="${tab.id}" title="${escapeHtml(tab.title)}">
            <span class="tab-label">${escapeHtml(tab.label)}</span>
            <button class="tab-close" data-close-tab="${tab.id}" type="button" aria-label="Close tab">&times;</button>
          </div>
        `,
    )
    .join('');

  const emptyHint = payload.showEmptyHint ? `<div class="tabs-empty">No open tabs</div>` : '';
  const html = `
        <div class="tab-list">
          ${dynamicTabs}
          <button class="tab plus-tab" type="button" aria-label="New tab">+</button>
        </div>
        ${emptyHint}
      `;
  if (html === lastTabBarHTML) return;
  tabBarEl.innerHTML = html;
  lastTabBarHTML = html;
}

function closeTab(taskId) {
  const task = getTask(taskId);
  const groupID = taskRootId(task) || activeTaskGroupId;
  if (groupID) {
    closedTabsForGroup(groupID).add(taskId);
  }
  releaseTabMemory(taskId);
  openTabs = openTabs.filter((id) => id !== taskId);
  if (activeTabId !== taskId) {
    renderTabs();
    return;
  }
  if (!openTabs.length) {
    activeTaskGroupId = '';
    detachStream();
    activeTabId = '';
    if (terminal) {
      terminal.clear();
    }
    if (gitTaskLabelEl) {
      gitTaskLabelEl.textContent = 'No task';
    }
    currentGitStatus = { staged: [], unstaged: [] };
    currentGitCommits = [];
    currentGitCommitsTotal = 0;
    renderGitStatus();
    setPatchPreviewMessage('Select a changed file to open a diff view.');
    updateTaskHeader(null);
    setTerminalOverlay('', false);
    setMainViewMode('terminal');
    updateTaskContextBar(null);
    renderTabs();
    if (rightPanelMode === 'files') {
      loadRepoFiles().catch((error) => console.error(error));
    }
    return;
  }
  selectTab(openTabs[openTabs.length - 1]).catch((error) => alert(error.message || String(error)));
}

function openTaskGroup(rootTaskID, preferredTabID = '') {
  const groupID = String(rootTaskID || '').trim();
  if (!groupID) return;

  activeTaskGroupId = groupID;
  const tabs = tabsForTaskGroup(groupID);
  const closedSet = closedTabsForGroup(groupID);
  openTabs = tabs.map((task) => task.id).filter((id) => !closedSet.has(id));

  if (!openTabs.length) {
    detachStream();
    activeTabId = '';
    if (terminal) {
      terminal.clear();
    }
    setTerminalOverlay('', false);
    renderWorkspaces();
    renderTabs();
    setMainViewMode('terminal');
    updateTaskHeader(null);
    updateTaskContextBar(null);
    return;
  }

  const workspaceMatch = tabs[0] ? workspaceIdByName(tabs[0].workspace) : '';
  if (workspaceMatch) {
    activeWorkspace = workspaceMatch;
  }
  if (activeWorkspace) {
    expandedWorkspaces.add(activeWorkspace);
  }

  renderWorkspaces();
  renderWorkspaceTasks();

  const target = openTabs.includes(preferredTabID)
    ? preferredTabID
    : openTabs.includes(activeTabId)
      ? activeTabId
      : openTabs[0];
  selectTab(target).catch((error) => alert(error.message || String(error)));
}

function openTab(taskId) {
  const task = getTask(taskId);
  if (!task) return;
  openTaskGroup(taskRootId(task), task.id);
}

function detachStream() {
  if (activeStream) {
    activeStream.close();
    activeStream = null;
  }
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (terminalFormatter) {
    terminalFormatter.reset();
  }
  inputBuffer = '';
}

async function selectTab(taskId) {
  const task = getTask(taskId);
  if (!task) return;

  // Skip full teardown+rebuild when the terminal is already showing this task.
  const isAlreadyActive = activeTabId === taskId && activeStream;
  activeTaskGroupId = taskRootId(task);
  activeTabId = taskId;
  renderTabs();

  if (isAlreadyActive) {
    // Just refresh metadata — no terminal clear/re-bootstrap needed.
    updateTaskHeader(task);
    updateTaskContextBar(task);
    if (terminal) terminal.focus();
    return;
  }

  ensureTerminal();
  // Clear previous task output so the terminal shows only this task's content.
  terminal.clear();
  // Allow re-bootstrap so the new task's logs are written after clear.
  bootstrappedTerminalTasks.delete(taskId);
  scheduleTerminalFitAndResize(0);
  detachStream();
  selectedPatchFile = '';
  setPatchPreviewMessage('Select a changed file to open a diff view.');
  setMainViewMode('terminal');

  updateTaskHeader(task);
  updateTaskContextBar(task);

  if (task.status === 'running') {
    setTerminalOverlay('Connecting…', true);
  } else {
    setTerminalOverlay('', false);
  }

  attachStream(taskId);
  // Defer focus so DOM updates (overlay, tabs) settle first.
  setTimeout(() => {
    if (terminal) terminal.focus();
  }, 50);
  await refreshGitStatus();
  if (rightPanelMode === 'files') {
    await loadRepoFiles();
  }
  await resizeTerminalForActiveTab().catch(() => {});
  // Re-focus after all async work to ensure typing works.
  if (terminal && activeTabId === taskId) terminal.focus();
}

function attachStream(taskId) {
  activeStream = new EventSource(`/api/tasks/${taskId}/events`);
  // Track the end of bootstrap content to suppress duplicate log events
  // that overlap with the bootstrap tail.
  let bootstrapTail = '';
  let bootstrapDone = false;

  activeStream.addEventListener('bootstrap', (event) => {
    if (activeTabId !== taskId) return;
    const data = JSON.parse(event.data || '{}');
    if (typeof data.logs === 'string' && data.logs.length > 0 && !bootstrappedTerminalTasks.has(taskId)) {
      const output = colorizeTerminalOutput(data.logs);
      terminal.write(output);
      bootstrappedTerminalTasks.add(taskId);
      // Keep last 256 chars of bootstrap to detect overlap with early log events
      const raw = String(data.logs || '');
      bootstrapTail = raw.slice(-256);
    }
    bootstrapDone = true;
    const task = getTask(taskId);
    if (task && task.status === 'running') {
      setTerminalOverlay('', false);
    }
  });

  activeStream.addEventListener('log', (event) => {
    if (activeTabId !== taskId) return;
    const data = JSON.parse(event.data || '{}');
    if (!data.message) return;
    // Suppress log events whose content was already in the bootstrap payload.
    // This prevents the "duplicate welcome block" when the SSE subscribe channel
    // has buffered events that overlap with the bootstrap log tail.
    if (bootstrapTail && bootstrapDone) {
      const msg = String(data.message || '');
      if (bootstrapTail.includes(msg.slice(0, 128))) {
        return;
      }
      // After the first non-overlapping log event, stop checking.
      bootstrapTail = '';
    }
    terminal.write(colorizeTerminalOutput(data.message));
    setTerminalOverlay('', false);
  });

  activeStream.addEventListener('status', async () => {
    await loadTasks({ keepTab: true });
    if (activeTabId !== taskId) return;
    const task = getTask(taskId);
    if (!task) return;

    updateTaskHeader(task);
    updateTaskContextBar(task);

    if (task.status === 'running') {
      setTerminalOverlay('', false);
      await resizeTerminalForActiveTab().catch(() => {});
    } else {
      setTerminalOverlay('', false);
    }

    await refreshGitStatus();
    if (rightPanelMode === 'files') {
      await loadRepoFiles();
    }
  });

  activeStream.onerror = () => {
    if (activeStream) {
      activeStream.close();
      activeStream = null;
    }
    if (activeTabId === taskId) {
      setTerminalOverlay('Stream disconnected — re-open tab to reconnect', true);
    }
  };
}

async function loadPresets() {
  const data = await api('/api/presets');
  const presets = data.presets || [];
  if (!presets.length) {
    presetSelectEl.innerHTML = `<option value="none">none</option>`;
    presetSelectEl.value = 'none';
    return;
  }
  const previousPreset = presetSelectEl.value;
  presetSelectEl.innerHTML = presets
    .map(
      (preset) =>
        `<option value="${escapeHtml(preset.name)}">${escapeHtml(preset.name)} - ${escapeHtml(preset.description || '')}</option>`,
    )
    .join('');
  const presetNames = new Set(presets.map((preset) => String(preset.name || '')));
  if (previousPreset && presetNames.has(previousPreset)) {
    presetSelectEl.value = previousPreset;
  } else if (presetNames.has('none')) {
    presetSelectEl.value = 'none';
  } else {
    presetSelectEl.value = String(presets[0]?.name || 'none');
  }
}

async function loadWorkspaces() {
  const data = await api('/api/workspaces');
  workspaces = Array.isArray(data.workspaces) ? data.workspaces : [];
  if (!workspaces.length) {
    activeWorkspace = '';
  } else if (!getWorkspace(activeWorkspace)) {
    activeWorkspace = workspaceId(workspaces[0]) || '';
    expandedWorkspaces.add(activeWorkspace);
  }
  if (!workspaceExpansionInitialized && activeWorkspace) {
    expandedWorkspaces.add(activeWorkspace);
    workspaceExpansionInitialized = true;
  }
  renderWorkspaces();
  renderWorkspaceTasks();
  syncRepoInputToActiveWorkspace(true);
  updateTaskContextBar();
  if (rightPanelMode === 'files' && !activeTabId) {
    loadRepoFiles().catch((error) => console.error(error));
  }
}

async function loadTasks({ keepTab = true } = {}) {
  const data = await api('/api/tasks');
  tasksCache = data.tasks || [];
  pruneClosedTabsByGroup();

  const currentWorkspace = getWorkspace(activeWorkspace);
  const currentWorkspaceName = String(currentWorkspace?.name || '')
    .trim()
    .toLowerCase();
  if (
    activeWorkspace &&
    currentWorkspaceName &&
    !tasksCache.some(
      (task) =>
        String(task.workspace || '')
          .trim()
          .toLowerCase() === currentWorkspaceName,
    )
  ) {
    if (currentWorkspace) {
      // keep active workspace even if empty
    } else {
      activeWorkspace = workspaceId(workspaces[0]) || '';
      if (activeWorkspace) {
        expandedWorkspaces.add(activeWorkspace);
      }
    }
  }

  if (!keepTab) {
    activeTabId = '';
  } else if (activeTabId && !getTask(activeTabId)) {
    activeTabId = '';
  }

  if (activeTabId) {
    const activeTask = getTask(activeTabId);
    if (activeTask) {
      activeTaskGroupId = taskRootId(activeTask);
    }
  }

  if (activeTaskGroupId && tabsForTaskGroup(activeTaskGroupId).length === 0) {
    activeTaskGroupId = '';
  }

  const groups = activeWorkspace ? taskGroupsForWorkspace(activeWorkspace) : [];
  if (activeTaskGroupId && !groups.some((group) => group.rootTaskID === activeTaskGroupId)) {
    activeTaskGroupId = '';
  }

  if (activeTaskGroupId) {
    const groupTabIds = tabsForTaskGroup(activeTaskGroupId).map((task) => task.id);
    const closedSet = closedTabsForGroup(activeTaskGroupId);
    // Add new tabs from the group that weren't manually closed.
    for (const id of groupTabIds) {
      if (!openTabs.includes(id) && !closedSet.has(id)) {
        openTabs.push(id);
      }
    }
    // Remove tabs that no longer exist in the group (deleted/moved tasks).
    openTabs = openTabs.filter((id) => groupTabIds.includes(id));
  } else {
    openTabs = [];
  }

  if (!openTabs.length) {
    activeTabId = '';
  } else if (!openTabs.includes(activeTabId)) {
    activeTabId = openTabs[0];
  }

  renderWorkspaces();
  renderWorkspaceTasks();
  renderTabs();
  updateTaskHeader();
  updateTaskContextBar();
  if (!activeTabId) {
    detachStream();
    if (terminal) {
      terminal.clear();
    }
    setTerminalOverlay('', false);
    setMainViewMode('terminal');
    setPatchPreviewMessage('Select a changed file to open a diff view.');
  }
}

async function refreshGitStatus() {
  const taskId = String(activeTabId || '').trim();
  const refreshSeq = ++gitStatusRefreshSeq;
  if (!taskId) {
    currentGitStatus = { staged: [], unstaged: [] };
    currentGitCommits = [];
    currentGitCommitsTotal = 0;
    renderGitStatus();
    return;
  }

  const [statusResult, commitsResult] = await Promise.allSettled([
    api(`/api/tasks/${taskId}/git/status`),
    api(`/api/tasks/${taskId}/git/commits`),
  ]);
  if (refreshSeq !== gitStatusRefreshSeq) {
    return;
  }
  if (String(activeTabId || '').trim() !== taskId) {
    return;
  }

  if (statusResult.status === 'fulfilled') {
    const data = statusResult.value || {};
    currentGitStatus = {
      staged: data.staged || [],
      unstaged: data.unstaged || [],
    };
  } else {
    currentGitStatus = { staged: [], unstaged: [] };
    console.error(statusResult.reason);
  }

  if (commitsResult.status === 'fulfilled') {
    const data = commitsResult.value || {};
    currentGitCommits = Array.isArray(data.commits) ? data.commits : [];
    currentGitCommitsTotal = Number(data.commits_total || currentGitCommits.length || 0);
  } else {
    currentGitCommits = [];
    currentGitCommitsTotal = 0;
    console.error(commitsResult.reason);
  }
  renderGitStatus();
}

function serializeGitChanges(list) {
  return (Array.isArray(list) ? list : [])
    .map((item) => {
      const path = String(item?.path || '');
      const status = String(item?.status || '');
      const add = Number(item?.added || 0);
      const del = Number(item?.deleted || 0);
      return `${path}|${status}|${add}|${del}`;
    })
    .join(';');
}

function serializeGitCommits(list) {
  return (Array.isArray(list) ? list : [])
    .map((commit) => {
      const hash = String(commit?.hash || '');
      const message = String(commit?.message || '');
      const files = (Array.isArray(commit?.files) ? commit.files : [])
        .map((file) => {
          const path = String(file?.path || '');
          const add = Number(file?.added || 0);
          const del = Number(file?.deleted || 0);
          return `${path}|${add}|${del}`;
        })
        .join(',');
      return `${hash}|${message}|${files}`;
    })
    .join(';');
}

function gitRenderSignature(taskLabel, staged, unstaged) {
  const commitsTotal = Number(currentGitCommitsTotal || currentGitCommits.length || 0);
  return [
    String(activeTabId || ''),
    String(taskLabel || ''),
    String(changesViewMode || ''),
    String(selectedPatchFile || ''),
    String(commitsTotal),
    serializeGitChanges(staged),
    serializeGitChanges(unstaged),
    serializeGitCommits(currentGitCommits),
  ].join('::');
}

function SidebarSectionHeader(title, count) {
  const safeTitle = String(title || '').trim();
  const safeCount = Number(count) || 0;
  return safeCount > 0 ? `${safeTitle} (${safeCount})` : safeTitle;
}

function renderChangeViewModeButton() {
  if (!changeViewModeBtnEl) return;
  const isTree = changesViewMode === 'tree';
  changeViewModeBtnEl.textContent = isTree ? '\u2637' : '\u2630';
  const nextLabel = isTree ? 'Switch to grouped view' : 'Switch to tree view';
  changeViewModeBtnEl.title = nextLabel;
  changeViewModeBtnEl.setAttribute('aria-label', nextLabel);
}

function TreeChevron() {
  return `
        <svg stroke="currentColor" fill="currentColor" stroke-width="0" viewBox="0 0 16 16" class="tree-chevron size-3 text-muted-foreground shrink-0 transition-transform duration-150" height="1em" width="1em" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
          <path fill-rule="evenodd" clip-rule="evenodd" d="M10.072 8.024L5.715 3.667l.618-.62L11 7.716v.618L6.333 13l-.618-.619 4.357-4.357z"></path>
        </svg>
      `;
}

function IconStagePlus() {
  return `<span class="tree-action-icon icon-stage-plus" aria-hidden="true"></span>`;
}

function IconUnstageMinus() {
  return `<span class="tree-action-icon icon-unstage-minus" aria-hidden="true"></span>`;
}

function IconDiscard() {
  return `<span class="tree-action-icon icon-discard" aria-hidden="true"></span>`;
}

function ChangeRowActions(path, mode) {
  const safePath = escapeHtml(path);
  const actions = [];
  if (mode === 'unstaged') {
    actions.push(`
          <button class="tree-action-btn stage" type="button" data-stage-file="${safePath}" title="Stage file" aria-label="Stage file">
            ${IconStagePlus()}
          </button>
        `);
  }
  if (mode === 'staged') {
    actions.push(`
          <button class="tree-action-btn unstage" type="button" data-unstage-file="${safePath}" title="Unstage file" aria-label="Unstage file">
            ${IconUnstageMinus()}
          </button>
        `);
  }
  actions.push(`
        <button class="tree-action-btn discard" type="button" data-discard-file="${safePath}" title="Discard changes" aria-label="Discard changes">
          ${IconDiscard()}
        </button>
      `);
  return `<span class="tree-row-right">${actions.join('')}</span>`;
}

function fileIconType(name, kind = 'file') {
  if (kind === 'dir') {
    return { label: 'dir', cls: 'dir' };
  }
  const lower = String(name || '').toLowerCase();
  if (lower === 'go.mod') return { label: 'mod', cls: 'go' };
  if (lower === 'go.sum') return { label: 'sum', cls: 'go' };
  if (lower === 'readme.md' || lower.endsWith('.md')) return { label: 'md', cls: 'doc' };
  if (lower === '.env' || lower.startsWith('.env.')) return { label: 'env', cls: 'cfg' };
  if (lower === '.gitignore') return { label: 'git', cls: 'cfg' };
  if (lower === 'dockerfile') return { label: 'dk', cls: 'cfg' };
  if (lower === 'makefile') return { label: 'mk', cls: 'cfg' };
  if (lower.endsWith('.go')) return { label: 'go', cls: 'go' };
  if (lower.endsWith('.json')) return { label: 'js', cls: 'cfg' };
  if (lower.endsWith('.yaml') || lower.endsWith('.yml')) return { label: 'yl', cls: 'cfg' };
  if (lower.endsWith('.toml') || lower.endsWith('.ini')) return { label: 'cf', cls: 'cfg' };
  if (lower.endsWith('.lock')) return { label: 'lk', cls: 'cfg' };
  return { label: 'f', cls: '' };
}

function FileIcon(name, kind = 'file') {
  const icon = fileIconType(name, kind);
  const cls = icon.cls ? ` ${icon.cls}` : '';
  return `<span class="file-icon${cls}" aria-hidden="true">${icon.label}</span>`;
}

function FolderGroupLabel(label) {
  return `
        <div class="change-group-label">
          ${FileIcon(label, 'dir')}
          <span class="tree-row-label">${escapeHtml(label)}</span>
        </div>
      `;
}

function ChangedFileRow(change, mode, depth = 0) {
  const path = String(change.path || '');
  const parts = path.split('/').filter(Boolean);
  const name = parts.length ? parts[parts.length - 1] : path;
  const statusClassName = statusBadgeClass(change.status || 'modified');
  const add = Number(change.added || 0);
  const del = Number(change.deleted || 0);
  const selectedClass = selectedPatchFile === path ? ' selected' : '';

  return `
        <div class="change-file-row${selectedClass}" data-patch-file="${escapeHtml(path)}" style="--change-depth:${depth};">
          <div class="change-file-main">
            <span class="change-status-icon ${statusClassName}" aria-hidden="true"></span>
            <span class="change-file-name">${escapeHtml(name)}</span>
            <span class="change-inline-counts">
              <span class="add">+${add}</span>
              <span class="del">-${del}</span>
            </span>
          </div>
          ${ChangeRowActions(path, mode)}
        </div>
      `;
}

function groupChangesByFolder(list) {
  const grouped = new Map();
  (list || []).forEach((change) => {
    const path = String(change.path || '').trim();
    if (!path) return;
    const parts = path.split('/').filter(Boolean);
    const folder = parts.length > 1 ? parts.slice(0, -1).join('/') : '(root)';
    if (!grouped.has(folder)) {
      grouped.set(folder, []);
    }
    grouped.get(folder).push(change);
  });

  const folders = [...grouped.keys()].sort((a, b) => {
    if (a === '(root)') return -1;
    if (b === '(root)') return 1;
    return a.localeCompare(b);
  });

  return folders.map((folder) => ({
    folder,
    changes: grouped
      .get(folder)
      .slice()
      .sort((a, b) => String(a.path || '').localeCompare(String(b.path || ''))),
  }));
}

function renderChangeList(list, mode) {
  if (!list.length) {
    return `<div class="empty">No ${mode} changes.</div>`;
  }

  if (changesViewMode === 'tree') {
    return renderTreeChangeList(list, mode);
  }

  return groupChangesByFolder(list)
    .map(
      (group) => `
        <div class="change-group">
          ${FolderGroupLabel(group.folder)}
          <div class="change-group-files">
            ${group.changes.map((change) => ChangedFileRow(change, mode)).join('')}
          </div>
        </div>
      `,
    )
    .join('');
}

function CommitFileRow(change, depth = 0) {
  const path = String(change.path || '');
  const parts = path.split('/').filter(Boolean);
  const name = parts.length ? parts[parts.length - 1] : path;
  const add = Number(change.added || 0);
  const del = Number(change.deleted || 0);
  return `
        <div class="change-file-row commit-file-row" style="--change-depth:${depth};" title="${escapeHtml(path)}">
          <div class="change-file-main">
            <span class="change-status-icon modified" aria-hidden="true"></span>
            <span class="change-file-name">${escapeHtml(name)}</span>
            <span class="change-inline-counts">
              <span class="add">+${add}</span>
              <span class="del">-${del}</span>
            </span>
          </div>
        </div>
      `;
}

function renderCommitFiles(files, depth = 0) {
  const list = Array.isArray(files) ? files : [];
  if (!list.length) {
    return `<div class="empty">No files changed.</div>`;
  }
  return `
        <div class="change-group-files">
          ${list.map((file) => CommitFileRow(file, depth + 1)).join('')}
        </div>
      `;
}

function commitDisplayLabel(commit) {
  const hash = String(commit?.hash || '')
    .trim()
    .slice(0, 8);
  const message = String(commit?.message || '').trim();
  if (!hash) return message || 'unknown';
  if (!message) return hash;
  return `${hash}_${message}`;
}

function renderCommitsList(commits) {
  const list = Array.isArray(commits) ? commits : [];
  if (!list.length) {
    return `<div class="empty">No commits in this branch.</div>`;
  }
  return list
    .map((commit) => {
      const files = Array.isArray(commit.files) ? commit.files : [];
      return `
          <details class="commit-history-item change-tree-dir">
            <summary class="commit-history-summary">
              ${TreeChevron()}
              <span class="commit-history-label tree-row-label mono">${escapeHtml(commitDisplayLabel(commit))}</span>
            </summary>
            <div class="change-tree-children">
              ${renderCommitFiles(files, 0)}
            </div>
          </details>
        `;
    })
    .join('');
}

function createChangeTreeNode(name = '') {
  return { name, dirs: new Map(), files: [] };
}

function buildChangeTree(list) {
  const root = createChangeTreeNode();
  (list || []).forEach((change) => {
    const path = String(change.path || '').trim();
    if (!path) return;
    const parts = path.split('/').filter(Boolean);
    if (!parts.length) return;

    let node = root;
    for (let i = 0; i < parts.length; i += 1) {
      const part = parts[i];
      const isLast = i === parts.length - 1;
      if (isLast) {
        node.files.push(change);
        continue;
      }
      if (!node.dirs.has(part)) {
        node.dirs.set(part, createChangeTreeNode(part));
      }
      node = node.dirs.get(part);
    }
  });
  return root;
}

function renderChangeTreeNode(name, node, depth, mode) {
  const dirs = [...node.dirs.entries()].sort(([a], [b]) => a.localeCompare(b));
  const files = [...node.files].sort((a, b) => String(a.path || '').localeCompare(String(b.path || '')));
  const childParts = [];

  dirs.forEach(([dirName, dirNode]) => {
    childParts.push(renderChangeTreeNode(dirName, dirNode, depth + 1, mode));
  });
  files.forEach((file) => {
    childParts.push(ChangedFileRow(file, mode, depth + 1));
  });

  return `
        <details class="change-tree-dir" ${depth < 1 ? 'open' : ''} style="--change-depth:${depth};">
          <summary>
            ${TreeChevron()}
            ${FileIcon(name, 'dir')}
            <span class="tree-row-label">${escapeHtml(name)}</span>
          </summary>
          <div class="change-tree-children">${childParts.join('')}</div>
        </details>
      `;
}

function renderTreeChangeList(list, mode) {
  const tree = buildChangeTree(list);
  const parts = [];
  const rootFiles = [...tree.files].sort((a, b) => String(a.path || '').localeCompare(String(b.path || '')));
  const rootDirs = [...tree.dirs.entries()].sort(([a], [b]) => a.localeCompare(b));

  if (rootFiles.length) {
    parts.push(`
          <div class="change-group">
            ${FolderGroupLabel('(root)')}
            <div class="change-group-files">
              ${rootFiles.map((change) => ChangedFileRow(change, mode, 0)).join('')}
            </div>
          </div>
        `);
  }

  rootDirs.forEach(([dirName, dirNode]) => {
    parts.push(renderChangeTreeNode(dirName, dirNode, 0, mode));
  });

  return parts.join('');
}

function toChangeFileModel(change, mode, depth = 0) {
  const path = String(change?.path || '');
  const parts = path.split('/').filter(Boolean);
  const name = parts.length ? parts[parts.length - 1] : path;
  return {
    path,
    name,
    statusClass: statusBadgeClass(change?.status || 'modified'),
    added: Number(change?.added || 0),
    deleted: Number(change?.deleted || 0),
    selected: selectedPatchFile === path,
    depth,
    mode,
  };
}

function buildGroupedChangeModel(list, mode) {
  return {
    view: 'grouped',
    groups: groupChangesByFolder(list).map((group) => ({
      folder: group.folder,
      files: group.changes.map((change) => toChangeFileModel(change, mode, 0)),
    })),
  };
}

function buildChangeTreeNodeModel(name, node, depth, mode) {
  const dirs = [...node.dirs.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([dirName, dirNode]) => buildChangeTreeNodeModel(dirName, dirNode, depth + 1, mode));
  const files = [...node.files]
    .sort((a, b) => String(a.path || '').localeCompare(String(b.path || '')))
    .map((file) => toChangeFileModel(file, mode, depth + 1));

  return {
    name,
    depth,
    open: depth < 1,
    dirs,
    files,
  };
}

function buildTreeChangeModel(list, mode) {
  const tree = buildChangeTree(list);
  const rootFiles = [...tree.files]
    .sort((a, b) => String(a.path || '').localeCompare(String(b.path || '')))
    .map((change) => toChangeFileModel(change, mode, 0));
  const dirs = [...tree.dirs.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([dirName, dirNode]) => buildChangeTreeNodeModel(dirName, dirNode, 0, mode));

  return {
    view: 'tree',
    rootFiles,
    dirs,
  };
}

function buildChangeListModel(list, mode) {
  const safeList = Array.isArray(list) ? list : [];
  if (!safeList.length) {
    return {
      empty: true,
      emptyText: `No ${mode} changes.`,
    };
  }
  return changesViewMode === 'tree' ? buildTreeChangeModel(safeList, mode) : buildGroupedChangeModel(safeList, mode);
}

function buildCommitsModel(commits) {
  const list = Array.isArray(commits) ? commits : [];
  if (!list.length) {
    return {
      empty: true,
      emptyText: 'No commits in this branch.',
    };
  }
  return {
    empty: false,
    items: list.map((commit, commitIndex) => {
      const files = Array.isArray(commit?.files) ? commit.files : [];
      return {
        key: `${String(commit?.hash || 'commit')}-${commitIndex}`,
        label: commitDisplayLabel(commit),
        files: files.map((file) => ({
          ...toChangeFileModel(file, 'staged', 1),
          selected: false,
        })),
      };
    }),
  };
}

function createRepoTreeNode(name = '') {
  return { name, dirs: new Map(), files: [] };
}

function buildRepoTree(entries) {
  const root = createRepoTreeNode();
  (entries || []).forEach((entry) => {
    const kind = String(entry.kind || 'file').toLowerCase();
    const path = String(entry.path || '').trim();
    if (!path) return;
    const parts = path.split('/').filter(Boolean);
    if (!parts.length) return;

    let node = root;
    for (let i = 0; i < parts.length; i += 1) {
      const part = parts[i];
      const isLast = i === parts.length - 1;
      if (isLast) {
        if (kind === 'dir') {
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

function FileTreeRow({ name, kind = 'file', depth = 0, open = false, children = '' }) {
  if (kind === 'dir') {
    return `
          <details class="repo-tree-dir" ${open ? 'open' : ''} style="--depth:${depth};">
            <summary>
              ${TreeChevron()}
              ${FileIcon(name, 'dir')}
              <span class="tree-row-label">${escapeHtml(name)}</span>
            </summary>
            <div class="repo-tree-children">${children}</div>
          </details>
        `;
  }
  return `
        <div class="repo-tree-file" style="--depth:${depth};">
          ${FileIcon(name, 'file')}
          <span class="tree-row-label">${escapeHtml(name)}</span>
        </div>
      `;
}

function renderRepoTreeNode(name, node, depth = 0) {
  const dirs = [...node.dirs.values()].sort((a, b) => a.name.localeCompare(b.name));
  const files = [...node.files].sort((a, b) => a.localeCompare(b));
  const children = [
    ...dirs.map((child) => renderRepoTreeNode(child.name, child, depth + 1)),
    ...files.map((file) => FileTreeRow({ name: file, kind: 'file', depth: depth + 1 })),
  ].join('');
  return FileTreeRow({ name, kind: 'dir', depth, open: depth < 2, children });
}

function buildRepoTreeNodeModel(name, node, depth = 0, keyPrefix = '') {
  const dirs = [...node.dirs.values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((child) => buildRepoTreeNodeModel(child.name, child, depth + 1, `${keyPrefix}/${name}`));
  const files = [...node.files].sort((a, b) => a.localeCompare(b)).map((file) => ({ name: file, depth: depth + 1 }));

  return {
    key: `${keyPrefix}/${name}`.replace(/^\/+/, ''),
    name,
    depth,
    open: depth < 2,
    dirs,
    files,
  };
}

function buildRepoFilesTreeModel(entries) {
  const safeEntries = Array.isArray(entries) ? entries : [];
  if (!safeEntries.length) {
    return {
      empty: true,
      emptyText: 'No files found.',
      nodes: [],
    };
  }

  const rootTree = buildRepoTree(safeEntries);
  const nodes = [];

  if (rootTree.files.length) {
    const rootNode = createRepoTreeNode('(root)');
    rootNode.files = [...rootTree.files];
    nodes.push(buildRepoTreeNodeModel('(root)', rootNode, 0, 'root'));
  }

  const topDirs = [...rootTree.dirs.values()].sort((a, b) => a.name.localeCompare(b.name));
  topDirs.forEach((node) => {
    nodes.push(buildRepoTreeNodeModel(node.name, node, 0, 'root'));
  });

  return {
    empty: false,
    nodes,
  };
}

function renderRepoFilesTree(entries) {
  const bridge = reactBridge();
  if (bridge?.renderRepoFilesTree) {
    bridge.renderRepoFilesTree(buildRepoFilesTreeModel(entries));
    return;
  }
  if (!entries?.length) {
    repoFilesTreeEl.innerHTML = `<div class="empty">No files found.</div>`;
    return;
  }
  const rootTree = buildRepoTree(entries);
  const parts = [];

  if (rootTree.files.length) {
    const rootNode = createRepoTreeNode('(root)');
    rootNode.files = [...rootTree.files];
    parts.push(renderRepoTreeNode('(root)', rootNode, 0));
  }

  const topDirs = [...rootTree.dirs.values()].sort((a, b) => a.name.localeCompare(b.name));
  topDirs.forEach((node) => {
    parts.push(renderRepoTreeNode(node.name, node, 0));
  });

  repoFilesTreeEl.innerHTML = parts.join('');
}

function filteredRepoEntries() {
  const term = String(repoFilesSearchEl?.value || '')
    .trim()
    .toLowerCase();
  if (!term) return repoFilesEntriesCache;
  return (repoFilesEntriesCache || []).filter((entry) => {
    const path = String(entry?.path || '').toLowerCase();
    return path.includes(term);
  });
}

function renderFilteredRepoFilesTree() {
  renderRepoFilesTree(filteredRepoEntries());
}

async function loadRepoFiles() {
  const workspace = getWorkspace(activeWorkspace);
  const workspaceID = workspaceId(workspace) || activeWorkspace;
  const workspaceRepo = workspace?.repo_path || activeWorkspaceRepoPath();
  const activeTask = getTask(activeTabId);
  const activeTaskWorkspaceID = activeTask ? workspaceIdByName(activeTask.workspace) : '';
  const useActiveTaskFiles = Boolean(
    activeTask &&
    activeTabId &&
    activeTaskWorkspaceID &&
    workspaceID &&
    activeTaskWorkspaceID.toLowerCase() === workspaceID.toLowerCase(),
  );

  let endpoint = '';
  if (useActiveTaskFiles) {
    endpoint = `/api/tasks/${activeTabId}/files`;
  } else if (workspaceID) {
    endpoint = `/api/workspaces/${encodeURIComponent(workspaceID)}/files`;
  }

  if (!endpoint) {
    repoFilesMetaEl.textContent = 'No active workspace';
    repoFilesMetaEl.title = 'No active workspace';
    repoFilesEntriesCache = [];
    const bridge = reactBridge();
    if (bridge?.renderRepoFilesTree) {
      bridge.renderRepoFilesTree({ empty: true, emptyText: 'Select a workspace to view files.', nodes: [] });
    } else {
      repoFilesTreeEl.innerHTML = `<div class="empty">Select a workspace to view files.</div>`;
    }
    return;
  }

  repoFilesMetaEl.textContent = 'Loading files...';
  repoFilesMetaEl.title = 'Loading files...';
  try {
    const data = await api(endpoint);
    const root = String(data.root || activeTask?.repo_path || workspaceRepo || '');
    repoFilesMetaEl.textContent = root || 'Repository files';
    repoFilesMetaEl.title = root || 'Repository files';
    repoFilesEntriesCache = data.entries || [];
    renderFilteredRepoFilesTree();
  } catch (error) {
    repoFilesMetaEl.textContent = 'Files';
    repoFilesMetaEl.title = 'Files';
    repoFilesEntriesCache = [];
    const bridge = reactBridge();
    if (bridge?.renderRepoFilesTree) {
      bridge.renderRepoFilesTree({
        empty: true,
        emptyText: String(error.message || String(error)),
        nodes: [],
      });
    } else {
      repoFilesTreeEl.innerHTML = `<div class="empty">${escapeHtml(error.message || String(error))}</div>`;
    }
  }
}

function setRightPanelMode(mode) {
  rightPanelMode = mode === 'files' ? 'files' : 'changes';
  const filesActive = rightPanelMode === 'files';
  rightTabFilesEl.classList.toggle('active', filesActive);
  rightTabChangesEl.classList.toggle('active', !filesActive);
  filesPanelEl.classList.toggle('hidden', !filesActive);
  changesPanelEl.classList.toggle('hidden', filesActive);
  if (changeViewModeBtnEl) {
    changeViewModeBtnEl.classList.toggle('hidden', filesActive);
  }
  if (filesActive) {
    loadRepoFiles().catch((error) => console.error(error));
  } else {
    renderChangeViewModeButton();
  }
}

function renderGitStatus() {
  const task = getTask(activeTabId);
  const taskLabel = task ? task.name : 'No task';
  const staged = currentGitStatus.staged || [];
  const unstaged = currentGitStatus.unstaged || [];
  renderPublishActionControls();
  const signature = gitRenderSignature(taskLabel, staged, unstaged);
  if (signature === lastGitRenderSignature) {
    return;
  }
  lastGitRenderSignature = signature;

  if (gitTaskLabelEl) {
    gitTaskLabelEl.textContent = taskLabel;
  }

  if (stagedCountChipEl) {
    stagedCountChipEl.textContent = SidebarSectionHeader('Staged', staged.length);
  }
  if (unstagedCountChipEl) {
    unstagedCountChipEl.textContent = SidebarSectionHeader('Unstaged', unstaged.length);
  }
  if (stagedSectionLabelEl) {
    stagedSectionLabelEl.textContent = SidebarSectionHeader('Staged', staged.length);
  }
  if (unstagedSectionLabelEl) {
    unstagedSectionLabelEl.textContent = SidebarSectionHeader('Unstaged', unstaged.length);
  }
  if (commitsSectionLabelEl) {
    const total = Number(currentGitCommitsTotal || currentGitCommits.length || 0);
    commitsSectionLabelEl.textContent = `Commits ${total}`;
  }
  const stageAllBtn = document.getElementById('stageAllBtn');
  if (stageAllBtn) {
    stageAllBtn.disabled = unstaged.length === 0;
  }
  const unstageAllBtn = document.getElementById('unstageAllBtn');
  if (unstageAllBtn) {
    unstageAllBtn.disabled = staged.length === 0;
  }
  renderChangeViewModeButton();

  const bridge = reactBridge();
  if (bridge?.renderStagedChanges && bridge?.renderUnstagedChanges && bridge?.renderCommits) {
    bridge.renderStagedChanges(buildChangeListModel(staged, 'staged'));
    bridge.renderUnstagedChanges(buildChangeListModel(unstaged, 'unstaged'));
    bridge.renderCommits(buildCommitsModel(currentGitCommits));
  } else {
    stagedListEl.innerHTML = renderChangeList(staged, 'staged');
    unstagedListEl.innerHTML = renderChangeList(unstaged, 'unstaged');
    if (commitsListEl) {
      commitsListEl.innerHTML = renderCommitsList(currentGitCommits);
    }
  }
}

async function loadPatch(path) {
  if (!activeTabId) return;
  const targetPath = String(path || '').trim();
  selectedPatchFile = targetPath;
  renderGitStatus();
  if (!targetPath) {
    setMainViewMode('terminal');
    return;
  }
  try {
    const query = `?file=${encodeURIComponent(targetPath)}`;
    const data = await api(`/api/tasks/${activeTabId}/diff${query}`);
    const stat = data.stat || `Diff: ${targetPath}`;
    patchPreviewEl.innerHTML = renderPatchDiff(targetPath, stat, data.patch || '');
    setMainViewMode('diff');
  } catch (error) {
    setPatchPreviewMessage(error.message || String(error));
    setMainViewMode('diff');
  }
}

function setRunAgentBtnState(running) {
  const labelEl = document.getElementById('runAgentLabel');
  if (running) {
    if (labelEl)
      labelEl.innerHTML = `<span class="inline-block w-3 h-3 border-2 border-text-dim border-t-text-primary rounded-full animate-spin"></span> Running\u2026`;
    if (runAgentBtnEl) runAgentBtnEl.disabled = true;
  } else {
    if (labelEl) labelEl.textContent = 'Run Agent';
    if (runAgentBtnEl) runAgentBtnEl.disabled = false;
  }
}

function taskNameFromPrompt(prompt, fallback = 'task') {
  const normalized = String(prompt || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return fallback;
  return normalized.slice(0, 80);
}

async function createQuickTaskForAgent(agent, options = {}) {
  if (launchingAgent) return;
  launchingAgent = true;
  setRunAgentBtnState(true);
  const promptSnapshot = String(options.prompt ?? promptInputEl.value ?? '');

  try {
    const selectedAgent = AGENT_COMMANDS[agent] ? agent : agentSelectEl.value;
    if (!AGENT_COMMANDS[selectedAgent]) {
      throw new Error('Agent is required. Choose one in "Run with" first.');
    }
    agentSelectEl.value = selectedAgent;
    syncProviderPills();
    const command = AGENT_COMMANDS[selectedAgent] || commandInputEl.value.trim();
    commandInputEl.value = command;

    const hasRootTaskOverride = Object.prototype.hasOwnProperty.call(options, 'rootTaskID');
    const defaultRootTaskID = String(activeTaskGroupId || taskRootId(getTask(activeTabId)) || '').trim();
    const rootTaskID = String(hasRootTaskOverride ? options.rootTaskID : defaultRootTaskID).trim();
    const rootTask = rootTaskID ? getTask(rootTaskID) : null;
    const useExistingWorktree = Boolean(rootTaskID && rootTask);
    const fallbackWorkspaceID = rootTask ? workspaceIdByName(rootTask.workspace) : '';
    const targetWorkspaceID = String(options.workspace || fallbackWorkspaceID || activeWorkspace || '').trim();
    if (!targetWorkspaceID) {
      openWorkspaceModal();
      return;
    }
    const targetWorkspace = getWorkspace(targetWorkspaceID);
    const targetWorkspaceName = String(targetWorkspace?.name || '').trim();
    if (!targetWorkspace || !targetWorkspaceName) {
      openWorkspaceModal();
      throw new Error('Selected workspace was not found.');
    }
    const workspaceRepoPath = String(targetWorkspace?.repo_path || '').trim();
    const manualRepoPath = String(repoInputEl.value || '').trim();
    const rootTaskPath = String(taskCodePath(rootTask) || '').trim();
    const activeTaskPath = String(taskCodePath(getTask(activeTabId)) || '').trim();
    const resolvedRepoPath = useExistingWorktree
      ? rootTaskPath || workspaceRepoPath || manualRepoPath || activeTaskPath
      : workspaceRepoPath || manualRepoPath || activeTaskPath;
    if (!resolvedRepoPath && !rootTaskID) {
      throw new Error('Repo path is required. Select a workspace with a repo, or set Repo Path first.');
    }

    const payload = {
      name: taskNameFromPrompt(promptSnapshot, `${selectedAgent}-session`),
      workspace: targetWorkspaceName,
      tags: parseTags(tagInputEl.value),
      repo_path: resolvedRepoPath,
      command,
      prompt: promptSnapshot,
      preset: presetSelectEl.value,
      direct_repo: useExistingWorktree,
      root_task_id: rootTaskID,
      ...taskStartTerminalSize(),
    };

    const result = await api('/api/tasks', {
      method: 'POST',
      body: JSON.stringify(payload),
    });

    await loadTasks({ keepTab: true });
    await loadWorkspaces();
    if (result.task && result.task.id) {
      openTab(result.task.id);
      if (!options.keepPromptInput && String(promptSnapshot || '').trim()) {
        promptInputEl.value = '';
      }
    }
  } finally {
    launchingAgent = false;
    setRunAgentBtnState(false);
  }
}

async function createTaskFromNewTab() {
  const activeTask = getTask(activeTabId);
  const rootTaskID = activeTaskGroupId || taskRootId(activeTask);
  openNewTabTypeModal({
    preferredWorkspace: activeWorkspace,
    rootTaskID,
  });
}

async function runTaskAction(action, taskId) {
  if (!taskId) return;
  try {
    if (action === 'stop') {
      await api(`/api/tasks/${taskId}/stop`, { method: 'POST' });
    }
    if (action === 'resume') {
      await api(`/api/tasks/${taskId}/resume`, { method: 'POST' });
    }
    if (action === 'open-editor') {
      await api(`/api/tasks/${taskId}/open-editor`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
    }
    await loadTasks({ keepTab: true });
    await refreshGitStatus();
  } catch (error) {
    alert(error.message || String(error));
  }
}

function sortTaskGroupForDelete(tasks, rootTaskID) {
  const rootID = String(rootTaskID || '').trim();
  return [...tasks].sort((a, b) => {
    const aID = String(a?.id || '').trim();
    const bID = String(b?.id || '').trim();
    if (aID === rootID && bID !== rootID) return -1;
    if (bID === rootID && aID !== rootID) return 1;
    const createdA = new Date(a?.created_at || 0).getTime() || 0;
    const createdB = new Date(b?.created_at || 0).getTime() || 0;
    if (createdA !== createdB) return createdA - createdB;
    return aID.localeCompare(bID);
  });
}

async function runCloseTaskModalAction() {
  const rootTaskID = String(closeTaskModalSelection.rootTaskID || '').trim();
  if (!rootTaskID || closeTaskModalBusy) return;

  const groupTasks = taskGroupTasks(rootTaskID);
  if (!groupTasks.length) {
    closeCloseTaskModal(true);
    return;
  }

  setCloseTaskModalBusy(true);
  try {
    const ordered = sortTaskGroupForDelete(groupTasks, rootTaskID);
    for (const task of ordered) {
      const taskID = String(task?.id || '').trim();
      if (!taskID) continue;
      await api(`/api/tasks/${encodeURIComponent(taskID)}`, { method: 'DELETE' });
    }

    closeCloseTaskModal(true);
    await loadTasks({ keepTab: true });
    await loadWorkspaces();
    await refreshGitStatus();
  } catch (error) {
    setCloseTaskModalBusy(false);
    alert(error.message || String(error));
  }
}

async function deleteWorkspace(workspaceID) {
  const target = String(workspaceID || '').trim();
  if (!target) return;
  await api(`/api/workspaces/${encodeURIComponent(target)}`, { method: 'DELETE' });
  if (activeWorkspace === target) {
    activeWorkspace = '';
  }
  await loadWorkspaces();
  await loadTasks({ keepTab: true });
  if (!workspaces.length) {
    openWorkspaceModal();
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
  const moved = moveChangeBetweenLists(path, 'unstaged', 'staged');
  try {
    await api(`/api/tasks/${activeTabId}/git/stage`, {
      method: 'POST',
      body: JSON.stringify({ path }),
    });
    if (selectedPatchFile === path) {
      await loadPatch(path);
    }
  } catch (error) {
    if (moved) {
      moveChangeBetweenLists(path, 'staged', 'unstaged');
    }
    alert(error.message || String(error));
  } finally {
    await refreshGitStatus();
  }
}

async function unstageFile(path) {
  if (!activeTabId) return;
  const moved = moveChangeBetweenLists(path, 'staged', 'unstaged');
  try {
    await api(`/api/tasks/${activeTabId}/git/unstage`, {
      method: 'POST',
      body: JSON.stringify({ path }),
    });
    if (selectedPatchFile === path) {
      await loadPatch(path);
    }
  } catch (error) {
    if (moved) {
      moveChangeBetweenLists(path, 'unstaged', 'staged');
    }
    alert(error.message || String(error));
  } finally {
    await refreshGitStatus();
  }
}

async function discardFile(path) {
  if (!activeTabId) return;
  const targetPath = String(path || '').trim();
  if (!targetPath) return;
  try {
    await api(`/api/tasks/${activeTabId}/git/discard`, {
      method: 'POST',
      body: JSON.stringify({ path: targetPath }),
    });
    if (selectedPatchFile === targetPath) {
      selectedPatchFile = '';
      await loadPatch('');
    }
  } catch (error) {
    alert(error.message || String(error));
  } finally {
    await refreshGitStatus();
  }
}

async function stageAllFiles() {
  if (!activeTabId) return;
  const unstaged = [...(currentGitStatus.unstaged || [])];
  if (!unstaged.length) return;
  try {
    for (const change of unstaged) {
      await api(`/api/tasks/${activeTabId}/git/stage`, {
        method: 'POST',
        body: JSON.stringify({ path: change.path }),
      });
    }
  } finally {
    await refreshGitStatus();
  }
}

async function unstageAllFiles() {
  if (!activeTabId) return;
  const staged = [...(currentGitStatus.staged || [])];
  if (!staged.length) return;
  try {
    for (const change of staged) {
      await api(`/api/tasks/${activeTabId}/git/unstage`, {
        method: 'POST',
        body: JSON.stringify({ path: change.path }),
      });
    }
  } finally {
    await refreshGitStatus();
  }
}

async function commitChanges() {
  if (!activeTabId) return;
  const message = document.getElementById('commitMessage').value.trim();
  if (!message) {
    alert('Commit message is required.');
    return;
  }
  try {
    const result = await api(`/api/tasks/${activeTabId}/git/commit`, {
      method: 'POST',
      body: JSON.stringify({ message }),
    });
    document.getElementById('commitMessage').value = '';
    await refreshGitStatus();
    await loadPatch(selectedPatchFile);
    alert(result.commit || 'Committed');
  } catch (error) {
    alert(error.message || String(error));
  }
}

function installEventHandlers() {
  document.getElementById('createWorkspaceBtn').addEventListener('click', () => {
    openWorkspaceModal();
  });

  workspaceModalCloseBtnEl.addEventListener('click', closeWorkspaceModal);
  workspaceModalCancelBtnEl.addEventListener('click', closeWorkspaceModal);
  workspaceModalBackdropEl.addEventListener('click', (event) => {
    if (event.target === workspaceModalBackdropEl) {
      closeWorkspaceModal();
    }
  });
  newTaskModalCloseBtnEl.addEventListener('click', closeNewTaskModal);
  newTaskModalCancelBtnEl.addEventListener('click', closeNewTaskModal);
  newTaskModalBackdropEl.addEventListener('click', (event) => {
    if (event.target === newTaskModalBackdropEl) {
      closeNewTaskModal();
    }
  });
  newTabTypeModalCloseBtnEl?.addEventListener('click', closeNewTabTypeModal);
  newTabTypeModalCancelBtnEl?.addEventListener('click', closeNewTabTypeModal);
  newTabTypeModalBackdropEl?.addEventListener('click', (event) => {
    if (event.target === newTabTypeModalBackdropEl) {
      closeNewTabTypeModal();
    }
  });
  closeTaskModalCancelBtnEl?.addEventListener('click', closeCloseTaskModal);
  closeTaskModalBackdropEl?.addEventListener('click', (event) => {
    if (event.target === closeTaskModalBackdropEl) {
      closeCloseTaskModal();
    }
  });
  closeTaskModalDeleteBtnEl?.addEventListener('click', async (event) => {
    event.preventDefault();
    await runCloseTaskModalAction();
  });
  newTabTypeTaskBtnEl?.addEventListener('click', (event) => {
    event.preventDefault();
    openExistingNewTabFlow();
  });
  newTabTypeTerminalBtnEl?.addEventListener('click', async (event) => {
    event.preventDefault();
    const options = {
      preferredWorkspace: newTabTypeSelection.preferredWorkspace,
      rootTaskID: newTabTypeSelection.rootTaskID,
    };
    closeNewTabTypeModal();
    try {
      await createTerminalTab(options);
    } catch (error) {
      alert(error.message || String(error));
    }
  });
  newTaskModalPromptEl.addEventListener('input', () => {
    newTaskModalPromptTouched = true;
    setNewTaskModalError('');
    updateNewTaskModalValidityUI();
  });
  newTaskModalAgentEl.addEventListener('change', () => {
    setNewTaskModalError('');
    updateNewTaskModalValidityUI();
  });
  newTaskModalWorkspaceEl.addEventListener('change', () => {
    setNewTaskModalError('');
    updateNewTaskModalValidityUI();
  });
  newTaskModalCreateBtnEl.addEventListener('click', async () => {
    await submitNewTaskModal();
  });

  workspaceModalBrowseBtnEl.addEventListener('click', async () => {
    hideWorkspaceInitPrompt();
    setWorkspaceModalError('');
    try {
      await browseWorkspaceRepoIntoModal();
    } catch (error) {
      setWorkspaceModalError(error.message || String(error));
    }
  });

  workspaceModalNameEl.addEventListener('input', () => {
    workspaceModalNameTouched = true;
    setWorkspaceModalError('');
    updateWorkspaceModalValidityUI();
  });
  workspaceModalNameEl.addEventListener('blur', () => {
    workspaceModalNameTouched = true;
    updateWorkspaceModalValidityUI();
  });

  workspaceModalRepoEl.addEventListener('input', () => {
    workspaceModalRepoTouched = true;
    setWorkspaceModalError('');
    syncWorkspaceNameWithRepoPath(workspaceModalRepoEl.value);
    queueWorkspaceRepoValidation();
  });
  workspaceModalRepoEl.addEventListener('blur', () => {
    workspaceModalRepoTouched = true;
    queueWorkspaceRepoValidation({ immediate: true });
  });

  workspaceModalCreateBtnEl.addEventListener('click', async () => {
    const cleanName = String(workspaceModalNameEl.value || '').trim();
    const repoPath = String(workspaceModalRepoEl.value || '').trim();
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

    setWorkspaceModalError('');
    const existingWorkspace = findExistingWorkspace(cleanName, repoPath);
    if (existingWorkspace) {
      activeWorkspace = workspaceId(existingWorkspace) || activeWorkspace;
      if (activeWorkspace) {
        expandedWorkspaces.add(activeWorkspace);
      }
      closeWorkspaceModal();
      await loadWorkspaces();
      await loadTasks({ keepTab: true });
      openFirstTaskForWorkspace(activeWorkspace);
      return;
    }
    setWorkspaceModalCreateLoading(true);
    try {
      const data = await api('/api/workspaces', {
        method: 'POST',
        body: JSON.stringify({ name: cleanName, repo_path: repoPath, init_git: false }),
      });

      workspaces = data.workspaces || workspaces;
      activeWorkspace = workspaceId(data.workspace) || activeWorkspace;
      expandedWorkspaces.add(activeWorkspace);
      closeWorkspaceModal();
      await loadWorkspaces();
      await loadTasks({ keepTab: true });
      await openOrCreateDefaultTaskForWorkspace(activeWorkspace);
    } catch (error) {
      const message = error.message || String(error);
      const isNotGitRepo = message.toLowerCase().includes('not a git repo');
      if (isNotGitRepo) {
        setWorkspaceModalError('Selected folder is not a git repo.');
        showWorkspaceInitPrompt(cleanName, repoPath);
        return;
      }

      setWorkspaceModalError(message);
    } finally {
      setWorkspaceModalCreateLoading(false);
    }
  });

  workspaceModalRepoEl.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      workspaceModalSubmitAttempted = true;
      updateWorkspaceModalValidityUI();
      if (!workspaceModalCreateBtnEl.disabled) {
        workspaceModalCreateBtnEl.click();
      }
    }
  });
  workspaceInitPromptYesBtnEl.addEventListener('click', async () => {
    if (!pendingWorkspaceCreate) return;
    const { name, repoPath } = pendingWorkspaceCreate;
    setWorkspaceModalError('');
    workspaceInitPromptYesBtnEl.disabled = true;
    try {
      const data = await api('/api/workspaces', {
        method: 'POST',
        body: JSON.stringify({ name, repo_path: repoPath, init_git: true }),
      });
      workspaces = data.workspaces || workspaces;
      activeWorkspace = workspaceId(data.workspace) || activeWorkspace;
      expandedWorkspaces.add(activeWorkspace);
      closeWorkspaceModal();
      await loadWorkspaces();
      await loadTasks({ keepTab: true });
      await openOrCreateDefaultTaskForWorkspace(activeWorkspace);
    } catch (error) {
      setWorkspaceModalError(error.message || String(error));
    } finally {
      workspaceInitPromptYesBtnEl.disabled = false;
    }
  });
  workspaceInitPromptBrowseBtnEl.addEventListener('click', async () => {
    hideWorkspaceInitPrompt();
    setWorkspaceModalError('');
    try {
      await browseWorkspaceRepoIntoModal();
    } catch (error) {
      setWorkspaceModalError(error.message || String(error));
    }
  });
  workspaceModalNameEl.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      workspaceModalRepoEl.focus();
    }
  });

  if (publishPrimaryBtnEl) {
    publishPrimaryBtnEl.addEventListener('click', async (event) => {
      event.preventDefault();
      const action = normalizePublishPrimaryAction();
      const available = publishActionAvailability();
      if (!available[action]) return;
      try {
        await runPublishAction(action);
      } catch (error) {
        alert(error.message || String(error));
      } finally {
        renderPublishActionControls();
      }
    });
  }

  if (publishDropdownBtnEl) {
    publishDropdownBtnEl.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (!publishActionMenuEl || !publishBranchSplitEl) return;
      const isHidden = publishActionMenuEl.classList.contains('hidden');
      if (!isHidden) {
        closePublishActionMenu();
        return;
      }
      publishActionMenuEl.classList.remove('hidden');
      publishDropdownBtnEl.setAttribute('aria-expanded', 'true');
    });
  }

  if (publishActionMenuEl) {
    publishActionMenuEl.addEventListener('click', async (event) => {
      const option = closestFromEvent(event, '[data-publish-action]');
      if (!option) return;
      event.preventDefault();
      event.stopPropagation();
      const action = String(option.getAttribute('data-publish-action') || '').trim();
      if (!action) return;
      const available = publishActionAvailability();
      if (!available[action]) return;
      selectedPublishAction = action;
      closePublishActionMenu();
      renderPublishActionControls();
      try {
        await runPublishAction(action);
      } catch (error) {
        alert(error.message || String(error));
      } finally {
        renderPublishActionControls();
      }
    });
  }

  taskContextBranchEl.addEventListener('click', (event) => {
    event.preventDefault();
    if (taskContextBranchEl.disabled) return;
    taskContextBranchMenuEl.classList.toggle('hidden');
  });
  taskContextOpenPrBtnEl.addEventListener('click', async (event) => {
    event.preventDefault();
    event.stopPropagation();
    const opened = await openExternalUrl(taskContextOpenPrBtnEl.dataset.url);
    if (!opened) {
      alert('Unable to open link in browser.');
    }
    closeTaskContextBranchMenu();
  });
  taskContextOpenBranchBtnEl.addEventListener('click', async (event) => {
    event.preventDefault();
    event.stopPropagation();
    const opened = await openExternalUrl(taskContextOpenBranchBtnEl.dataset.url);
    if (!opened) {
      alert('Unable to open link in browser.');
    }
    closeTaskContextBranchMenu();
  });
  openIdeBtnEl?.addEventListener('click', (event) => {
    event.preventDefault();
    if (openIdeBtnEl.disabled || !openIdeMenuEl) return;
    const nextHidden = !openIdeMenuEl.classList.contains('hidden');
    if (nextHidden) {
      closeOpenIdeMenu();
      return;
    }
    openIdeMenuEl.classList.remove('hidden');
    openIdeBtnEl.setAttribute('aria-expanded', 'true');
  });
  openIdeMenuEl?.addEventListener('click', async (event) => {
    const target = closestFromEvent(event, '[data-open-ide], [data-open-action]');
    if (!target) return;
    event.preventDefault();
    event.stopPropagation();
    closeOpenIdeMenu();
    const action = target.getAttribute('data-open-action') || target.dataset.openAction || '';
    if (action === 'open-terminal') {
      await openCurrentCodebaseInTerminal();
      return;
    }
    if (action === 'copy-path') {
      await copyCurrentCodebasePath();
      return;
    }
    const ide = target.getAttribute('data-open-ide') || target.dataset.openIde || '';
    await openCurrentCodebaseInIDE(ide);
  });
  document.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof Element)) {
      closeTaskContextBranchMenu();
      closePublishActionMenu();
      closeOpenIdeMenu();
      return;
    }
    const inBranchMenu = Boolean(target.closest('#taskContextBranch') || target.closest('#taskContextBranchMenu'));
    const inPublishActionMenu = Boolean(target.closest('#publishBranchSplit') || target.closest('#publishActionMenu'));
    const inOpenIdeMenu = Boolean(target.closest('#openIdeWrap'));
    if (!inBranchMenu) closeTaskContextBranchMenu();
    if (!inPublishActionMenu) closePublishActionMenu();
    if (!inOpenIdeMenu) closeOpenIdeMenu();
  });

  // Capture-phase Ctrl+C handler to guarantee interrupt delivery even when
  // focus/propagation inside xterm or overlays is inconsistent.
  document.addEventListener(
    'keydown',
    (event) => {
      if (Date.now() - lastInterruptHandledAt < 25) return;
      if (!isCtrlC(event)) return;

      const target = event.target instanceof Element ? event.target : null;
      const inTerminal = !!target?.closest('#terminalPanel');
      const activeElement = document.activeElement instanceof Element ? document.activeElement : null;
      const terminalFocused = !!activeElement?.closest('#terminalPanel');
      if (inTerminal || terminalFocused) return;
      const isEditable =
        !inTerminal && !!target?.closest("input, textarea, select, [contenteditable='true'], [contenteditable='']");
      const shouldInterrupt =
        centerViewMode === 'terminal' &&
        Boolean(activeTabId) &&
        !isWorkspaceModalOpen() &&
        !isNewTaskModalOpen() &&
        !isNewTabTypeModalOpen() &&
        !isCloseTaskModalOpen() &&
        !isEditable;

      if (!shouldInterrupt) return;
      if (!interruptOrStopActiveTask()) return;
      lastInterruptHandledAt = Date.now();
      event.preventDefault();
      event.stopPropagation();
    },
    true,
  );

  taskContextPathEl.addEventListener('click', async () => {
    const path = String(taskContextPathEl.dataset.path || '').trim();
    if (!path) return;
    try {
      await api('/api/local/open-directory', {
        method: 'POST',
        body: JSON.stringify({ path }),
      });
    } catch (error) {
      alert(error.message || String(error));
    }
  });

  window.addEventListener('keydown', (event) => {
    if (Date.now() - lastInterruptHandledAt < 25) return;
    const key = String(event.key || '').toLowerCase();

    // Global fallback: Ctrl+C should still interrupt the active terminal task
    // even if the xterm textarea temporarily lost focus.
    if (isCtrlC(event)) {
      const target = event.target instanceof Element ? event.target : null;
      const inTerminal = !!target?.closest('#terminalPanel');
      const activeElement = document.activeElement instanceof Element ? document.activeElement : null;
      const terminalFocused = !!activeElement?.closest('#terminalPanel');
      if (inTerminal || terminalFocused) return;
      const isEditableOutsideTerminal =
        !inTerminal && !!target?.closest("input, textarea, select, [contenteditable='true'], [contenteditable='']");
      const shouldInterrupt =
        centerViewMode === 'terminal' &&
        Boolean(activeTabId) &&
        !isWorkspaceModalOpen() &&
        !isNewTaskModalOpen() &&
        !isNewTabTypeModalOpen() &&
        !isCloseTaskModalOpen() &&
        !isEditableOutsideTerminal;

      if (!shouldInterrupt) return;
      if (!interruptOrStopActiveTask()) return;
      lastInterruptHandledAt = Date.now();
      event.preventDefault();
      return;
    }

    if ((event.metaKey || event.ctrlKey) && key === 'n') {
      event.preventDefault();
      openWorkspaceModal();
      return;
    }

    const isMetaShortcut = (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey;
    if (isMetaShortcut && key === 't') {
      if (isWorkspaceModalOpen() || isNewTaskModalOpen() || isNewTabTypeModalOpen() || isCloseTaskModalOpen()) return;
      event.preventDefault();
      const activeTask = getTask(activeTabId);
      const rootTaskID = String(activeTaskGroupId || taskRootId(activeTask) || '').trim();
      const preferredWorkspace = rootTaskID
        ? String(workspaceIdByName(activeTask?.workspace) || activeWorkspace || '').trim()
        : String(activeWorkspace || '').trim();
      createTerminalTab({ preferredWorkspace, rootTaskID }).catch((error) => alert(error.message || String(error)));
      return;
    }
    if (isMetaShortcut && key === 'w') {
      if (isWorkspaceModalOpen() || isNewTaskModalOpen() || isNewTabTypeModalOpen() || isCloseTaskModalOpen()) return;
      const currentTab = String(activeTabId || '').trim();
      if (!currentTab) return;
      event.preventDefault();
      closeTab(currentTab);
      return;
    }

    if (event.key === 'Escape') {
      const branchMenuOpen = !taskContextBranchMenuEl.classList.contains('hidden');
      const publishMenuOpen = publishActionMenuEl ? !publishActionMenuEl.classList.contains('hidden') : false;
      const ideMenuOpen = openIdeMenuEl ? !openIdeMenuEl.classList.contains('hidden') : false;
      if (branchMenuOpen) closeTaskContextBranchMenu();
      if (publishMenuOpen) closePublishActionMenu();
      if (ideMenuOpen) closeOpenIdeMenu();
      if (
        (branchMenuOpen || publishMenuOpen || ideMenuOpen) &&
        !isWorkspaceModalOpen() &&
        !isNewTaskModalOpen() &&
        !isCloseTaskModalOpen()
      ) {
        return;
      }
    }

    if (isCloseTaskModalOpen()) {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeCloseTaskModal();
      }
      return;
    }

    if (isNewTaskModalOpen()) {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeNewTaskModal();
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
        event.preventDefault();
        submitNewTaskModal().catch((error) => {
          setNewTaskModalError(error.message || String(error));
        });
        return;
      }
      return;
    }

    if (!isWorkspaceModalOpen()) return;

    if (event.key === 'Escape') {
      event.preventDefault();
      closeWorkspaceModal();
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault();
      workspaceModalSubmitAttempted = true;
      updateWorkspaceModalValidityUI();
      if (!workspaceModalCreateBtnEl.disabled) {
        workspaceModalCreateBtnEl.click();
      }
    }
  });

  workspaceListEl.addEventListener('click', async (event) => {
    const closeWorktreeTaskBtn = closestFromEvent(event, 'button[data-close-worktree-task]');
    if (closeWorktreeTaskBtn) {
      event.preventDefault();
      event.stopPropagation();
      const taskID = String(closeWorktreeTaskBtn.dataset.closeWorktreeTask || '').trim();
      if (taskID) {
        openCloseTaskModal(taskID);
      }
      return;
    }

    const openBtn = closestFromEvent(event, '[data-open-task]');
    if (openBtn) {
      openTaskGroup(openBtn.dataset.openTask);
      return;
    }

    const newWorkspaceTabBtn = closestFromEvent(event, 'button[data-new-workspace-tab]');
    if (newWorkspaceTabBtn) {
      event.preventDefault();
      event.stopPropagation();
      const workspaceID = String(newWorkspaceTabBtn.dataset.newWorkspaceTab || '').trim();
      openNewTabTypeModal({ preferredWorkspace: workspaceID || activeWorkspace, rootTaskID: '' });
      return;
    }

    const deleteWorkspaceBtn = closestFromEvent(event, 'button[data-delete-workspace]');
    if (deleteWorkspaceBtn) {
      event.preventDefault();
      event.stopPropagation();
      const workspaceName = String(deleteWorkspaceBtn.dataset.deleteWorkspace || '').trim();
      if (!workspaceName) return;
      try {
        await deleteWorkspace(workspaceName);
      } catch (error) {
        alert(error.message || String(error));
      }
      return;
    }

    const editorBtn = closestFromEvent(event, 'button[data-open-editor]');
    if (editorBtn) {
      await runTaskAction('open-editor', editorBtn.dataset.openEditor);
      return;
    }

    const stopBtn = closestFromEvent(event, 'button[data-stop]');
    if (stopBtn) {
      await runTaskAction('stop', stopBtn.dataset.stop);
      return;
    }

    const resumeBtn = closestFromEvent(event, 'button[data-resume]');
    if (resumeBtn) {
      await runTaskAction('resume', resumeBtn.dataset.resume);
      return;
    }

    const summary = closestFromEvent(event, 'summary[data-workspace-summary]');
    if (!summary) return;
    event.preventDefault();
    const workspaceID = String(summary.dataset.workspaceSummary || '').trim();
    const details = summary.closest('details[data-workspace-node]');
    if (!workspaceID || !details) return;
    if (details.open) {
      expandedWorkspaces.delete(workspaceID);
    } else {
      expandedWorkspaces.add(workspaceID);
    }
    activeWorkspace = workspaceID;
    renderWorkspaces();
    renderWorkspaceTasks();
    syncRepoInputToActiveWorkspace(true);
    updateTaskContextBar();
    if (rightPanelMode === 'files') {
      loadRepoFiles().catch((error) => console.error(error));
    }
  });

  tabBarEl.addEventListener('click', async (event) => {
    const closeBtn = event.target.closest('button[data-close-tab]');
    if (closeBtn) {
      event.stopPropagation();
      closeTab(closeBtn.dataset.closeTab);
      return;
    }

    // P2-B: overflow menu toggle
    const overflowBtn = event.target.closest('.tab-overflow-btn');
    if (overflowBtn) {
      const menu = overflowBtn.parentElement.querySelector('.tab-overflow-menu');
      if (menu) menu.classList.toggle('hidden');
      return;
    }
    const overflowTab = event.target.closest('[data-overflow-tab]');
    if (overflowTab) {
      openTab(overflowTab.dataset.overflowTab);
      const menu = overflowTab.closest('.tab-overflow-menu');
      if (menu) menu.classList.add('hidden');
      return;
    }

    const tab = event.target.closest('[data-tab]');
    if (tab) {
      openTab(tab.dataset.tab);
      return;
    }

    const plusTab = event.target.closest('.plus-tab');
    if (plusTab) {
      try {
        await createTaskFromNewTab();
      } catch (error) {
        alert(error.message || String(error));
      }
    }
  });

  agentSelectEl.addEventListener('change', () => {
    commandInputEl.value = AGENT_COMMANDS[agentSelectEl.value] || '';
    syncProviderPills();
  });
  providerBarEl.addEventListener('click', async (event) => {
    const pill = event.target.closest('[data-provider-pill]');
    if (!pill) return;
    try {
      await createQuickTaskForAgent(pill.dataset.providerPill);
    } catch (error) {
      alert(error.message || String(error));
    }
  });
  runAgentBtnEl.addEventListener('click', async () => {
    try {
      await createQuickTaskForAgent(agentSelectEl.value);
    } catch (error) {
      alert(error.message || String(error));
    }
  });
  promptInputEl.addEventListener('keydown', async (event) => {
    // Plain Enter or ⌘Enter both submit
    if (event.key !== 'Enter' || event.shiftKey) return;
    event.preventDefault();
    try {
      await createQuickTaskForAgent(agentSelectEl.value);
    } catch (error) {
      alert(error.message || String(error));
    }
  });
  // ⌘↵ global shortcut
  window.addEventListener('keydown', async (event) => {
    if (isWorkspaceModalOpen() || isNewTaskModalOpen() || isNewTabTypeModalOpen() || isCloseTaskModalOpen()) return;
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault();
      try {
        await createQuickTaskForAgent(agentSelectEl.value);
      } catch (error) {
        alert(error.message || String(error));
      }
    }
  });

  document.getElementById('createTaskForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      await createQuickTaskForAgent(agentSelectEl.value);
    } catch (error) {
      alert(error.message || String(error));
    }
  });
  document.getElementById('refreshGitBtn').addEventListener('click', () => {
    refreshGitStatus()
      .then(async () => {
        if (rightPanelMode === 'files') {
          await loadRepoFiles();
        }
      })
      .catch((error) => alert(error.message || String(error)));
  });

  const commitBtn = document.getElementById('commitBtn');
  if (commitBtn) {
    commitBtn.addEventListener('click', () => {
      commitChanges().catch((error) => alert(error.message || String(error)));
    });
  }

  const suggestCommitBtn = document.getElementById('suggestCommitBtn');
  if (suggestCommitBtn) {
    suggestCommitBtn.addEventListener('click', () => {
      const staged = currentGitStatus.staged || [];
      if (staged.length === 0) return;
      const files = staged.map((f) => f.path.split('/').pop()).slice(0, 5);
      const prefix = staged.some((f) => f.status === 'A') ? 'feat' : 'fix';
      const msg = `${prefix}: update ${files.join(', ')}`;
      const el = document.getElementById('commitMessage');
      if (!el) return;
      el.value = msg;
      el.style.fontStyle = 'normal';
    });
  }

  rightTabChangesEl.addEventListener('click', () => {
    setRightPanelMode('changes');
  });
  rightTabFilesEl.addEventListener('click', () => {
    setRightPanelMode('files');
  });
  if (changeViewModeBtnEl) {
    changeViewModeBtnEl.addEventListener('click', (event) => {
      event.preventDefault();
      changesViewMode = changesViewMode === 'tree' ? 'grouped' : 'tree';
      renderGitStatus();
    });
  }

  const stageAllBtn = document.getElementById('stageAllBtn');
  if (stageAllBtn) {
    stageAllBtn.addEventListener('click', async (event) => {
      event.preventDefault();
      event.stopPropagation();
      await stageAllFiles();
    });
  }
  const unstageAllBtn = document.getElementById('unstageAllBtn');
  if (unstageAllBtn) {
    unstageAllBtn.addEventListener('click', async (event) => {
      event.preventDefault();
      event.stopPropagation();
      await unstageAllFiles();
    });
  }
  if (repoFilesSearchEl) {
    repoFilesSearchEl.addEventListener('input', () => {
      renderFilteredRepoFilesTree();
    });
  }

  unstagedListEl.addEventListener('click', async (event) => {
    const stageBtn = closestFromEvent(event, 'button[data-stage-file]');
    if (stageBtn) {
      event.preventDefault();
      event.stopPropagation();
      const path = stageBtn.getAttribute('data-stage-file') || stageBtn.dataset.stageFile || '';
      if (path) {
        await stageFile(path);
      }
      return;
    }
    const discardBtn = closestFromEvent(event, 'button[data-discard-file]');
    if (discardBtn) {
      event.preventDefault();
      event.stopPropagation();
      const path = discardBtn.getAttribute('data-discard-file') || discardBtn.dataset.discardFile || '';
      if (path) {
        await discardFile(path);
      }
      return;
    }
    const patchTarget = closestFromEvent(event, '[data-patch-file]');
    if (patchTarget) {
      const path = patchTarget.getAttribute('data-patch-file') || patchTarget.dataset.patchFile || '';
      if (path) {
        await loadPatch(path);
      }
    }
  });

  stagedListEl.addEventListener('click', async (event) => {
    const unstageBtn = closestFromEvent(event, 'button[data-unstage-file]');
    if (unstageBtn) {
      event.preventDefault();
      event.stopPropagation();
      const path = unstageBtn.getAttribute('data-unstage-file') || unstageBtn.dataset.unstageFile || '';
      if (path) {
        await unstageFile(path);
      }
      return;
    }
    const discardBtn = closestFromEvent(event, 'button[data-discard-file]');
    if (discardBtn) {
      event.preventDefault();
      event.stopPropagation();
      const path = discardBtn.getAttribute('data-discard-file') || discardBtn.dataset.discardFile || '';
      if (path) {
        await discardFile(path);
      }
      return;
    }
    const patchTarget = closestFromEvent(event, '[data-patch-file]');
    if (patchTarget) {
      const path = patchTarget.getAttribute('data-patch-file') || patchTarget.dataset.patchFile || '';
      if (path) {
        await loadPatch(path);
      }
    }
  });

  patchPreviewEl.addEventListener('click', (event) => {
    const closeBtn = closestFromEvent(event, 'button[data-diff-close]');
    if (!closeBtn) return;
    event.preventDefault();
    setMainViewMode('terminal');
  });

  terminalPanelEl.addEventListener('click', () => {
    if (terminal) terminal.focus();
  });

  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      scheduleTerminalFitAndResize(0);
    }, 180);
  });
}

async function boot() {
  renderUiBuildVersion();
  ensureTerminal();
  setTerminalOverlay('Open a task in this workspace to attach terminal.', true);
  setPatchPreviewMessage('Select a changed file to open a diff view.');
  setMainViewMode('terminal');
  updateTaskHeader(null);
  updateTaskContextBar(null);

  commandInputEl.value = AGENT_COMMANDS[agentSelectEl.value] || '';
  syncProviderPills();
  renderChangeViewModeButton();

  installEventHandlers();
  await loadPresets();
  await loadWorkspaces();
  await loadTasks({ keepTab: true });
  setRightPanelMode('changes');

  if (!workspaces.length) {
    openWorkspaceModal();
  }

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
