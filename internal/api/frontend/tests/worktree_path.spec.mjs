import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function run(command, args, options = {}) {
  execFileSync(command, args, { stdio: 'pipe', ...options });
}

function createCommittedRepo() {
  const repoPath = mkdtempSync(join(tmpdir(), 'phasr-ui-worktree-repo-'));
  run('git', ['init', '-b', 'main'], { cwd: repoPath });
  run('git', ['config', 'user.email', 'qa@example.test'], { cwd: repoPath });
  run('git', ['config', 'user.name', 'QA'], { cwd: repoPath });
  writeFileSync(join(repoPath, 'README.md'), 'qa repo\n');
  run('git', ['add', 'README.md'], { cwd: repoPath });
  run('git', ['commit', '-m', 'seed'], { cwd: repoPath });
  return repoPath;
}

async function json(response) {
  expect(response.ok()).toBe(true);
  return response.json();
}

test('agent tasks show managed worktree path and same-task tabs reuse it', async ({ page, request }) => {
  const repoPath = createCommittedRepo();
  const suffix = Date.now().toString(36);
  const workspaceName = `ui-worktree-${suffix}`;
  const createdTaskIds = [];

  try {
    await json(
      await request.post('/api/workspaces', {
        data: { name: workspaceName, repo_path: repoPath, init_git: false },
      }),
    );

    const rootData = await json(
      await request.post('/api/tasks', {
        data: {
          name: 'agent root task',
          workspace: workspaceName,
          repo_path: repoPath,
          command: 'sleep 30',
          prompt: 'verify managed worktree path',
          preset: 'none',
          direct_repo: false,
          new_branch_name: `task/${workspaceName}`,
        },
      }),
    );
    const rootTask = rootData.task;
    createdTaskIds.push(rootTask.id);

    expect(rootTask.direct_repo).toBe(false);
    expect(rootTask.worktree_path).toBeTruthy();
    expect(rootTask.worktree_path).not.toBe(rootTask.repo_path);

    await page.goto('/');
    await expect(page.locator('#taskContextTask')).toHaveText(rootTask.name);
    await expect(page.locator('#taskContextPath')).toHaveText(rootTask.worktree_path);

    await page.locator('.plus-tab').click();
    await expect(page.locator('#newTabTypeModalBackdrop')).toBeVisible();
    await page.locator('#newTabTypeTerminalBtn').click();

    await expect
      .poll(async () => {
        const data = await json(await request.get('/api/tasks'));
        return data.tasks.filter((task) => task.workspace === workspaceName).length;
      })
      .toBe(2);

    const tasksData = await json(await request.get('/api/tasks'));
    const childTask = tasksData.tasks.find((task) => task.workspace === workspaceName && task.id !== rootTask.id);
    expect(childTask).toBeTruthy();
    createdTaskIds.push(childTask.id);
    expect(childTask.root_task_id).toBe(rootTask.id);
    expect(childTask.direct_repo).toBe(true);
    expect(childTask.worktree_path).toBe(rootTask.worktree_path);
    expect(childTask.repo_path).toBe(rootTask.worktree_path);

    await expect(page.locator('#taskContextPath')).toHaveText(rootTask.worktree_path);
  } finally {
    for (const taskId of createdTaskIds) {
      await request.post(`/api/tasks/${encodeURIComponent(taskId)}/stop`).catch(() => {});
    }
    for (const taskId of createdTaskIds.reverse()) {
      await request.delete(`/api/tasks/${encodeURIComponent(taskId)}`).catch(() => {});
    }
  }
});
