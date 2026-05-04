import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const QA_REPO_URL = process.env.PHASR_QA_REPO_URL || 'https://github.com/irishabh96/test-repo';

test.skip(process.env.PHASR_FULL_E2E !== '1', 'Set PHASR_FULL_E2E=1 to run the full app QA suite.');

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  });
}

function runMaybe(command, args, options = {}) {
  try {
    return { ok: true, out: run(command, args, options) };
  } catch (error) {
    return {
      ok: false,
      out: String(error.stdout || '') + String(error.stderr || '') || error.message,
    };
  }
}

function safeFileURL(path) {
  return `file://${path.replaceAll(' ', '%20')}`;
}

function seedQARepo() {
  const baseDir = mkdtempSync(join(tmpdir(), 'phasr-full-e2e-'));
  const repoPath = join(baseDir, 'test-repo');
  const barePath = join(baseDir, 'test-repo-remote.git');
  const remoteClonePath = join(baseDir, 'remote-clone');

  run('git', ['clone', QA_REPO_URL, repoPath]);
  run('git', ['-C', repoPath, 'checkout', '-B', 'main']);
  run('git', ['-C', repoPath, 'config', 'user.email', 'qa@example.test']);
  run('git', ['-C', repoPath, 'config', 'user.name', 'Phasr QA']);

  mkdirSync(join(repoPath, 'src', 'lib'), { recursive: true });
  mkdirSync(join(repoPath, 'docs'), { recursive: true });
  mkdirSync(join(repoPath, 'config'), { recursive: true });
  writeFileSync(join(repoPath, 'README.md'), '# QA test repo\n\nSeeded for phasr end-to-end testing.\n');
  writeFileSync(
    join(repoPath, 'package.json'),
    `${JSON.stringify({ name: 'phasr-qa-test-repo', version: '1.0.0', private: true }, null, 2)}\n`,
  );
  writeFileSync(join(repoPath, 'src', 'index.js'), "const { log } = require('./lib/logger');\nlog('ready');\n");
  writeFileSync(join(repoPath, 'src', 'lib', 'logger.js'), "exports.log = (message) => console.log(message);\n");
  writeFileSync(join(repoPath, 'docs', 'guide.md'), '# Guide\n');
  writeFileSync(join(repoPath, 'config', 'settings.json'), `${JSON.stringify({ enabled: true }, null, 2)}\n`);
  run('git', ['-C', repoPath, 'add', '-A']);
  runMaybe('git', ['-C', repoPath, 'commit', '-m', 'qa: seed test repo']);

  run('git', ['init', '--bare', barePath]);
  run('git', ['-C', barePath, 'symbolic-ref', 'HEAD', 'refs/heads/main']);
  run('git', ['-C', repoPath, 'remote', 'set-url', 'origin', 'https://github.com/irishabh96/test-repo.git']);
  run('git', ['-C', repoPath, 'config', '--add', `url.${safeFileURL(barePath)}.insteadOf`, 'https://github.com/irishabh96/test-repo.git']);
  run('git', ['-C', repoPath, 'config', '--add', `url.${safeFileURL(barePath)}.insteadOf`, 'https://github.com/irishabh96/test-repo']);
  run('git', ['-C', repoPath, 'push', '-u', 'origin', 'main']);

  return { baseDir, repoPath, barePath, remoteClonePath };
}

function writeJSONReport(testInfo, payload) {
  const jsonPath = testInfo.outputPath('full-e2e-report.json');
  const markdownPath = testInfo.outputPath('full-e2e-report.md');
  writeFileSync(jsonPath, JSON.stringify(payload, null, 2));
  writeFileSync(
    markdownPath,
    [
      '# Full App E2E QA Report',
      '',
      '| Area | Feature | Status | Evidence |',
      '| --- | --- | --- | --- |',
      ...payload.results.map(
        (item) =>
          `| ${escapeCell(item.area)} | ${escapeCell(item.feature)} | ${escapeCell(item.status)} | ${escapeCell(item.evidence)} |`,
      ),
      '',
      '## Local API calls',
      '',
      '```json',
      JSON.stringify(payload.localCalls, null, 2),
      '```',
      '',
      '## Notes',
      '',
      ...payload.notes.map((note) => `- ${note}`),
      '',
    ].join('\n'),
  );
  console.log(`[full-e2e-report] ${jsonPath}`);
  console.log(`[full-e2e-report] ${markdownPath}`);
}

function escapeCell(value) {
  return String(value || '')
    .replaceAll('|', '\\|')
    .replaceAll('\n', '<br>');
}

async function getJSON(response) {
  expect(response.ok()).toBe(true);
  return response.json();
}

async function maybeDialog(page, action, timeout = 2500) {
  const dialogPromise = page
    .waitForEvent('dialog', { timeout })
    .then(async (dialog) => {
      const message = dialog.message();
      await dialog.accept();
      return message;
    })
    .catch(() => null);
  await action();
  return dialogPromise;
}

function requestJSON(request) {
  try {
    return request.postDataJSON();
  } catch {
    return {};
  }
}

async function runPublishAction(page, action) {
  const menu = page.locator('#publishActionMenu');
  const menuHidden = await menu.evaluate((node) => node.classList.contains('hidden')).catch(() => true);
  if (menuHidden) {
    await page.locator('#publishDropdownBtn').click();
  }
  await expect(menu).toBeVisible();
  const item = page.locator(`#publishActionMenu [data-publish-action="${action}"]`);
  await expect(item).toBeVisible();
  if (await item.isDisabled()) {
    await page.locator('#publishDropdownBtn').click();
    return { disabled: true, dialog: null };
  }
  const dialog = await maybeDialog(page, () => item.click());
  return { disabled: false, dialog };
}

async function refreshChanges(page) {
  await page.locator('#refreshGitBtn').click();
  await page.waitForTimeout(350);
}

async function changedRow(page, listSelector, filename) {
  const row = page.locator(`${listSelector} .change-file-row`).filter({ hasText: filename }).first();
  await expect(row).toBeVisible();
  return row;
}

test('full application E2E QA with git operations and button coverage', async ({ page, request, context }, testInfo) => {
  test.setTimeout(300_000);
  page.setDefaultTimeout(10_000);

  const results = [];
  const notes = [];
  const localCalls = [];
  const dialogs = [];
  const createdTaskIds = [];
  const env = seedQARepo();

  const record = (area, feature, status, evidence = '') => {
    results.push({ area, feature, status, evidence });
  };

  const check = async (area, feature, fn) => {
    try {
      const evidence = await fn();
      record(area, feature, 'PASS', evidence || 'Verified');
      return evidence;
    } catch (error) {
      record(area, feature, 'FAIL', error?.message || String(error));
      return undefined;
    }
  };

  await context.grantPermissions(['clipboard-read', 'clipboard-write']);

  for (const endpoint of ['open-directory', 'open-in-ide', 'open-in-terminal', 'open-url']) {
    await page.route(`**/api/local/${endpoint}`, async (route) => {
      const body = requestJSON(route.request());
      localCalls.push({ endpoint, body });
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true }),
      });
    });
  }
  await page.route('**/api/local/browse-directory', async (route) => {
    localCalls.push({ endpoint: 'browse-directory', body: {} });
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ path: env.repoPath }),
    });
  });

  await page.goto('/');
  await page.waitForLoadState('domcontentloaded');

  await check('Workspace modal', 'Initial empty-state modal opens', async () => {
    await expect(page.locator('#workspaceModalBackdrop')).toBeVisible();
    return 'Create Workspace modal visible on first launch';
  });

  await check('Workspace modal', 'Close button', async () => {
    await page.locator('#workspaceModalCloseBtn').click();
    await expect(page.locator('#workspaceModalBackdrop')).toBeHidden();
    return 'Modal closed without workspace creation';
  });

  await check('Workspace modal', 'New Workspace button and Cancel', async () => {
    await page.locator('#createWorkspaceBtn').click();
    await expect(page.locator('#workspaceModalBackdrop')).toBeVisible();
    await page.locator('#workspaceModalCancelBtn').click();
    await expect(page.locator('#workspaceModalBackdrop')).toBeHidden();
    return 'New Workspace opens modal; Cancel closes it';
  });

  const workspaceName = `qa-${Date.now().toString(36)}`;
  await page.locator('#createWorkspaceBtn').click();
  await check('Workspace modal', 'Browse folder button', async () => {
    await page.locator('#workspaceModalBrowseBtn').click();
    await expect(page.locator('#workspaceModalRepo')).toHaveValue(env.repoPath);
    return `Browse populated ${env.repoPath}`;
  });

  await check('Workspace modal', 'Create workspace button', async () => {
    await page.locator('#workspaceModalName').fill(workspaceName);
    await expect(page.locator('#workspaceModalCreateBtn')).toBeEnabled();
    await page.locator('#workspaceModalCreateBtn').click();
    await expect(page.locator('#workspaceModalBackdrop')).toBeHidden();
    await expect(page.locator('#newTaskModalBackdrop')).toBeVisible();
    return 'Workspace created; new task modal opened';
  });

  await check('New task modal', 'Auto-open close button', async () => {
    await page.locator('#newTaskModalCloseBtn').click();
    await expect(page.locator('#newTaskModalBackdrop')).toBeHidden();
    return 'New task modal closed without task creation';
  });

  const workspaceData = await getJSON(await request.get('/api/workspaces'));
  const workspace = workspaceData.workspaces.find((item) => item.name === workspaceName);
  expect(workspace).toBeTruthy();

  const rootData = await getJSON(
    await request.post('/api/tasks', {
      data: {
        name: 'qa root agent',
        workspace: workspaceName,
        repo_path: env.repoPath,
        command: 'sleep 90',
        prompt: 'Full E2E root task',
        preset: 'none',
        direct_repo: false,
        new_branch_name: `task/${workspaceName}`,
      },
    }),
  );
  const rootTask = rootData.task;
  createdTaskIds.push(rootTask.id);

  await page.reload();
  await expect(page.locator('#taskContextTask')).toHaveText(rootTask.name);

  await check('Task/worktree', 'Top-level agent task worktree and bottom PATH', async () => {
    expect(rootTask.direct_repo).toBe(false);
    expect(rootTask.worktree_path).toBeTruthy();
    expect(rootTask.worktree_path).not.toBe(rootTask.repo_path);
    await expect(page.locator('#taskContextPath')).toHaveText(rootTask.worktree_path);
    return rootTask.worktree_path;
  });

  await check('Workspace sidebar', 'Workspace row expand/collapse', async () => {
    const summary = page.locator(`[data-workspace-summary="${workspace.id}"]`);
    await expect(summary).toBeVisible();
    await summary.click();
    await expect(page.locator(`[data-workspace-node="${workspace.id}"]`)).not.toHaveAttribute('open', '');
    await summary.click();
    await expect(page.locator(`[data-workspace-node="${workspace.id}"]`)).toHaveAttribute('open', '');
    return 'Workspace toggles open/closed';
  });

  await check('Workspace sidebar', 'Workspace add-tab button', async () => {
    await page.locator(`[data-new-workspace-tab="${workspace.id}"]`).click();
    await expect(page.locator('#newTabTypeModalBackdrop')).toBeVisible();
    await page.locator('#newTabTypeModalCloseBtn').click();
    await expect(page.locator('#newTabTypeModalBackdrop')).toBeHidden();
    return 'Workspace plus opens new tab type modal';
  });

  await check('Provider bar', 'Provider icons and click payloads', async () => {
    const captured = [];
    await page.route('**/api/tasks', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      captured.push(requestJSON(route.request()));
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ task: { id: `fake-${captured.length}`, name: 'fake' } }),
      });
    });
    for (const provider of ['claude', 'codex', 'copilot', 'opencode', 'gemini']) {
      const pill = page.locator(`[data-provider-pill="${provider}"]`);
      await expect(pill).toBeVisible();
      await expect(pill.locator('.provider-icon')).toBeVisible();
      await pill.click();
    }
    await expect.poll(() => captured.length).toBe(5);
    await page.unroute('**/api/tasks');
    return captured.map((payload) => `${payload.name}:${payload.command.split(' ')[0]}`).join(', ');
  });

  await check('New tab flow', 'Plus tab close, Agent Task modal, and Start Task payload', async () => {
    const captured = [];
    await page.route('**/api/tasks', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      captured.push(requestJSON(route.request()));
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ task: { id: 'fake-new-task', name: 'fake new task' } }),
      });
    });
    await page.locator('.plus-tab').click();
    await expect(page.locator('#newTabTypeModalBackdrop')).toBeVisible();
    await page.locator('#newTabTypeModalCloseBtn').click();
    await expect(page.locator('#newTabTypeModalBackdrop')).toBeHidden();

    await page.locator('.plus-tab').click();
    await page.locator('#newTabTypeTaskBtn').click();
    await expect(page.locator('#newTaskModalBackdrop')).toBeVisible();
    await page.locator('#newTaskModalAgent').selectOption('gemini');
    await page.locator('#newTaskModalPrompt').fill('QA modal task payload');
    await page.locator('#newTaskModalBranchPrefix').selectOption('feature');
    await page.locator('#newTaskModalBranchName').fill('qa-modal-task');
    await page.locator('#newTaskModalCreateBtn').click();
    await expect.poll(() => captured.length).toBe(1);
    await expect(page.locator('#newTaskModalBackdrop')).toBeHidden();
    await page.unroute('**/api/tasks');
    const payload = captured[0];
    expect(payload.command).toContain('gemini');
    expect(payload.root_task_id).toBe(rootTask.id);
    expect(payload.new_branch_name).toBe('feature/qa-modal-task');
    return `Captured ${payload.command}; branch ${payload.new_branch_name}`;
  });

  let terminalTask;
  await check('New tab flow', 'Terminal tab reuses root worktree', async () => {
    await page.locator('.plus-tab').click();
    await expect(page.locator('#newTabTypeModalBackdrop')).toBeVisible();
    await page.locator('#newTabTypeTerminalBtn').click();
    await expect
      .poll(async () => {
        const data = await getJSON(await request.get('/api/tasks'));
        return data.tasks.filter((task) => task.workspace === workspaceName).length;
      })
      .toBe(2);
    const data = await getJSON(await request.get('/api/tasks'));
    terminalTask = data.tasks.find((task) => task.workspace === workspaceName && task.id !== rootTask.id);
    createdTaskIds.push(terminalTask.id);
    expect(terminalTask.root_task_id).toBe(rootTask.id);
    expect(terminalTask.worktree_path).toBe(rootTask.worktree_path);
    await expect(page.locator('#taskContextPath')).toHaveText(rootTask.worktree_path);
    return `Terminal task ${terminalTask.id} uses ${terminalTask.worktree_path}`;
  });

  await check('Tabs', 'Tab close button hides active tab without deleting task', async () => {
    const activeClose = page.locator('.tab.active [data-close-tab]');
    await expect(activeClose).toBeVisible();
    await activeClose.click();
    const data = await getJSON(await request.get('/api/tasks'));
    expect(data.tasks.some((task) => task.id === terminalTask.id)).toBe(true);
    return 'Active tab closed; task remains in backend';
  });

  await check('Files panel', 'Files tab, search, folder tree, refresh', async () => {
    await page.locator('#rightTabFiles').click();
    await expect(page.locator('#repoFilesMeta')).toContainText(rootTask.worktree_path);
    await expect(page.locator('#repoFilesTree')).toContainText('src');
    const srcSummary = page.locator('#repoFilesTree summary').filter({ hasText: 'src' }).first();
    await srcSummary.click();
    await srcSummary.click();
    await page.locator('#repoFilesSearch').fill('logger');
    await expect(page.locator('#repoFilesTree')).toContainText('logger.js');
    await page.locator('#repoFilesSearch').fill('');
    await page.locator('#refreshGitBtn').click();
    await page.locator('#rightTabChanges').click();
    return 'Files tree, active worktree path, search, folder toggles, and refresh verified';
  });

  await check('Local open actions', 'PATH click, IDE menu, terminal, copy path', async () => {
    const before = localCalls.length;
    await page.locator('#taskContextPath').click();
    for (const ide of ['Cursor', 'Visual Studio Code', 'Zed', 'Windsurf', 'IntelliJ IDEA', 'WebStorm', 'Sublime Text', 'Xcode']) {
      await page.locator('#openIdeBtn').click();
      await page.locator(`[data-open-ide="${ide}"]`).click();
    }
    await page.locator('#openIdeBtn').click();
    await page.locator('[data-open-action="open-terminal"]').click();
    await page.locator('#openIdeBtn').click();
    await page.locator('[data-open-action="copy-path"]').click();
    await expect.poll(() => localCalls.length).toBeGreaterThanOrEqual(before + 10);
    const clipboard = await page.evaluate(() => navigator.clipboard.readText());
    expect(clipboard).toBe(rootTask.worktree_path);
    return 'All Open menu items emitted local actions; clipboard matches worktree path';
  });

  await check('Branch links', 'Branch menu Open Branch and Open PR', async () => {
    await expect(page.locator('#taskContextBranch')).toBeEnabled();
    await expect(page.locator('#taskContextOpenBranchBtn')).toBeEnabled({ timeout: 6000 });
    await page.locator('#taskContextBranch').click();
    await page.locator('#taskContextOpenBranchBtn').click();
    await expect(page.locator('#taskContextOpenPrBtn')).toBeEnabled({ timeout: 6000 });
    await page.locator('#taskContextBranch').click();
    await page.locator('#taskContextOpenPrBtn').click();
    const urls = localCalls.filter((call) => call.endpoint === 'open-url').map((call) => call.body.url);
    expect(urls.some((url) => String(url).includes('/tree/task/'))).toBe(true);
    expect(urls.some((url) => String(url).includes('/compare/main...task/'))).toBe(true);
    return urls.slice(-2).join(' ; ');
  });

  await check('Git changes', 'Refresh and view mode toggle', async () => {
    appendFileSync(join(rootTask.worktree_path, 'README.md'), '\nlocal qa readme change\n');
    appendFileSync(join(rootTask.worktree_path, 'src', 'lib', 'logger.js'), "\nexports.warn = console.warn;\n");
    writeFileSync(join(rootTask.worktree_path, 'src', 'feature.js'), "exports.feature = true;\n");
    writeFileSync(join(rootTask.worktree_path, 'discard-me.txt'), 'discard me\n');
    await page.locator('#rightTabChanges').click();
    await refreshChanges(page);
    await expect(page.locator('#unstagedList')).toContainText('README.md');
    const beforeMode = await page.locator('#changeViewModeBtn').getAttribute('data-view-mode');
    await page.locator('#changeViewModeBtn').click();
    const afterMode = await page.locator('#changeViewModeBtn').getAttribute('data-view-mode');
    expect(afterMode).not.toBe(beforeMode);
    await page.locator('#changeViewModeBtn').click();
    return `Mode toggled ${beforeMode} -> ${afterMode}`;
  });

  await check('Git changes', 'Discard row action with confirmation', async () => {
    const row = await changedRow(page, '#unstagedList', 'discard-me.txt');
    await maybeDialog(page, () => row.locator('[data-discard-file]').click(), 3000);
    await expect(page.locator('#unstagedList')).not.toContainText('discard-me.txt');
    expect(existsSync(join(rootTask.worktree_path, 'discard-me.txt'))).toBe(false);
    return 'Untracked file discarded and removed from disk';
  });

  await check('Git changes', 'Stage row and unstage row actions', async () => {
    const readmeRow = await changedRow(page, '#unstagedList', 'README.md');
    await readmeRow.locator('[data-stage-file]').click();
    await expect(page.locator('#stagedList')).toContainText('README.md');
    const stagedReadme = await changedRow(page, '#stagedList', 'README.md');
    await stagedReadme.locator('[data-unstage-file]').click();
    await expect(page.locator('#unstagedList')).toContainText('README.md');
    return 'README moved unstaged -> staged -> unstaged';
  });

  await check('Git changes', 'Stage all, suggest commit, diff actions, unstage all', async () => {
    await page.locator('#stageAllBtn').click();
    await expect(page.locator('#stagedList')).toContainText('README.md');
    await page.locator('#suggestCommitBtn').click();
    await expect(page.locator('#commitMessage')).not.toHaveValue('');
    const stagedReadme = await changedRow(page, '#stagedList', 'README.md');
    await stagedReadme.click();
    await expect(page.locator('#patchPreview')).toBeVisible();
    await page.locator('[data-diff-copy-path]').click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('README.md');
    await page.locator('[data-diff-reveal]').click();
    await page.locator('[data-diff-close]').click();
    await expect(page.locator('#terminalPanel')).toBeVisible();
    await page.locator('#unstageAllBtn').click();
    await expect(page.locator('#stagedList')).not.toContainText('README.md');
    return 'Stage all, suggest, diff copy/reveal/close, and unstage all verified';
  });

  await check('Git commit', 'Commit via publish dropdown', async () => {
    await page.locator('#stageAllBtn').click();
    await expect(page.locator('#stagedList')).toContainText('README.md');
    await page.locator('#commitMessage').fill('qa: app commit');
    const result = await runPublishAction(page, 'commit');
    expect(result.disabled).toBe(false);
    expect(result.dialog || '').toContain('qa: app commit');
    await refreshChanges(page);
    await expect(page.locator('#stagedList')).not.toContainText('README.md');
    await expect(page.locator('#commitsSectionLabel')).toContainText('Commits');
    return 'Commit action completed with success dialog';
  });

  await check('Git publish', 'First push on new task branch', async () => {
    const result = await runPublishAction(page, 'push');
    if (result.dialog) {
      record('Git publish', 'First push upstream behavior', 'WARN', result.dialog);
      return `Push returned dialog: ${result.dialog}`;
    }
    return 'Push completed without dialog';
  });

  const upstream = runMaybe('git', ['-C', rootTask.worktree_path, 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  if (!upstream.ok) {
    run('git', ['-C', rootTask.worktree_path, 'push', '-u', 'origin', rootTask.branch]);
    notes.push('Established upstream manually after testing first-push behavior so Fetch/Pull/Push success paths could be tested safely.');
  }

  await check('Git publish', 'Push button with upstream configured', async () => {
    appendFileSync(join(rootTask.worktree_path, 'src', 'feature.js'), '\nexports.pushed = true;\n');
    run('git', ['-C', rootTask.worktree_path, 'add', 'src/feature.js']);
    run('git', ['-C', rootTask.worktree_path, 'commit', '-m', 'qa: push from app']);
    await refreshChanges(page);
    const result = await runPublishAction(page, 'push');
    expect(result.disabled).toBe(false);
    expect(result.dialog).toBeNull();
    return 'Push completed after upstream was configured';
  });

  await check('Git publish', 'Fetch primary and dropdown action', async () => {
    const menuResult = await runPublishAction(page, 'fetch');
    expect(menuResult.disabled).toBe(false);
    expect(menuResult.dialog).toBeNull();
    const primaryDialog = await maybeDialog(page, () => page.locator('#publishPrimaryBtn').click());
    expect(primaryDialog).toBeNull();
    return 'Fetch succeeded from menu and primary split button';
  });

  await check('Git publish', 'Pull remote commit', async () => {
    run('git', ['clone', safeFileURL(env.barePath), env.remoteClonePath]);
    run('git', ['-C', env.remoteClonePath, 'config', 'user.email', 'qa@example.test']);
    run('git', ['-C', env.remoteClonePath, 'config', 'user.name', 'Remote QA']);
    run('git', ['-C', env.remoteClonePath, 'checkout', '-B', rootTask.branch, `origin/${rootTask.branch}`]);
    writeFileSync(join(env.remoteClonePath, 'remote-pull.txt'), 'remote pull content\n');
    run('git', ['-C', env.remoteClonePath, 'add', 'remote-pull.txt']);
    run('git', ['-C', env.remoteClonePath, 'commit', '-m', 'qa: remote pull']);
    run('git', ['-C', env.remoteClonePath, 'push', 'origin', rootTask.branch]);
    const result = await runPublishAction(page, 'pull');
    expect(result.disabled).toBe(false);
    expect(result.dialog).toBeNull();
    expect(readFileSync(join(rootTask.worktree_path, 'remote-pull.txt'), 'utf8')).toContain('remote pull content');
    return 'Remote commit pulled into active worktree';
  });

  await check('Git publish', 'Create PR action', async () => {
    const beforeURLs = localCalls.filter((call) => call.endpoint === 'open-url').length;
    const result = await runPublishAction(page, 'create-pr');
    expect(result.disabled).toBe(false);
    expect(result.dialog).toBeNull();
    const urls = localCalls.filter((call) => call.endpoint === 'open-url');
    expect(urls.length).toBeGreaterThan(beforeURLs);
    expect(urls.at(-1).body.url).toContain('github.com/irishabh96/test-repo/compare/main...');
    return urls.at(-1).body.url;
  });

  await check('Tabs', 'Overflow menu for many tabs', async () => {
    for (let i = 0; i < 6; i += 1) {
      const taskData = await getJSON(
        await request.post('/api/tasks', {
          data: {
            name: `overflow-${i}`,
            workspace: workspaceName,
            repo_path: rootTask.worktree_path,
            command: 'true',
            prompt: '',
            preset: 'none',
            direct_repo: true,
            root_task_id: rootTask.id,
          },
        }),
      );
      createdTaskIds.push(taskData.task.id);
    }
    await page.reload();
    await expect(page.locator('.tab-overflow-btn')).toBeVisible();
    await page.locator('.tab-overflow-btn').click();
    await expect(page.locator('.tab-overflow-menu')).toBeVisible();
    await page.locator('.tab-overflow-item').first().click();
    return 'Created >6 tabs and selected an overflow menu item';
  });

  await check('Center empty state', 'Close all tabs and reopen existing task', async () => {
    while ((await page.locator('[data-close-tab]').count()) > 0) {
      await page.locator('[data-close-tab]').first().click();
      await page.waitForTimeout(100);
    }
    await expect(page.locator('#centerEmptyState')).toBeVisible();
    const openTask = page.locator('[data-center-empty-action="open-task"]');
    await expect(openTask).toBeVisible();
    await openTask.click();
    await expect(page.locator('#taskContextTask')).not.toHaveText('none');
    return 'No-open-tabs state appears and Open task reopens a group';
  });

  await check('Task delete', 'Task close modal cancel and delete', async () => {
    const closeBtn = page.locator('[data-close-worktree-task]').first();
    await expect(closeBtn).toBeVisible();
    await closeBtn.click();
    await expect(page.locator('#closeTaskModalBackdrop')).toBeVisible();
    await page.locator('#closeTaskModalCancelBtn').click();
    await expect(page.locator('#closeTaskModalBackdrop')).toBeHidden();
    await closeBtn.click();
    await page.locator('#closeTaskModalDeleteBtn').click();
    await expect(page.locator('[data-open-task]')).toHaveCount(0, { timeout: 10_000 });
    return 'Task delete confirmation cancel and confirm both verified';
  });

  await check('Workspace delete', 'Workspace delete modal cancel and delete', async () => {
    const deleteBtn = page.locator(`[data-delete-workspace="${workspace.id}"]`);
    await expect(deleteBtn).toBeVisible();
    await deleteBtn.click();
    await expect(page.locator('#deleteWorkspaceModalBackdrop')).toBeVisible();
    await page.locator('#deleteWorkspaceModalCancelBtn').click();
    await expect(page.locator('#deleteWorkspaceModalBackdrop')).toBeHidden();
    await deleteBtn.click();
    await page.locator('#deleteWorkspaceModalDeleteBtn').click();
    await expect(page.locator(`[data-workspace-node="${workspace.id}"]`)).toHaveCount(0, { timeout: 10_000 });
    await expect(page.locator('#workspaceModalBackdrop')).toBeVisible();
    return 'Workspace delete confirmation cancel and confirm both verified';
  });

  const failCount = results.filter((item) => item.status === 'FAIL').length;
  const warnCount = results.filter((item) => item.status === 'WARN').length;
  notes.push(`Used disposable clone of ${QA_REPO_URL} at ${env.repoPath}.`);
  notes.push(`GitHub remote URL was preserved, with git operations redirected to local bare remote ${env.barePath}.`);
  notes.push(`Result summary: ${results.length - failCount - warnCount} pass, ${warnCount} warning, ${failCount} fail.`);

  writeJSONReport(testInfo, {
    repo: QA_REPO_URL,
    disposableRepoPath: env.repoPath,
    localBareRemote: env.barePath,
    results,
    localCalls,
    dialogs,
    notes,
  });

  if (failCount > 0) {
    throw new Error(`${failCount} E2E checks failed. See full-e2e-report.json.`);
  }

  rmSync(env.baseDir, { recursive: true, force: true });
});
