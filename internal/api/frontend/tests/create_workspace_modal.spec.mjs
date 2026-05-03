import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function openCreateWorkspaceModal(page) {
  await page.goto('/');
  await page.waitForLoadState('domcontentloaded');

  const modal = page.locator('#workspaceModalBackdrop');
  if (!(await modal.isVisible())) {
    try {
      await page.locator('#createWorkspaceBtn').click({ timeout: 1_500 });
    } catch (error) {
      if (!(await modal.isVisible())) throw error;
    }
  }

  await expect(modal).toBeVisible();
  await expect(page.locator('#workspaceModalName')).toBeFocused();
  return modal;
}

async function modalMetrics(page) {
  return page.evaluate(() => {
    const rect = (selector) => {
      const node = document.querySelector(selector);
      if (!node) throw new Error(`Missing selector: ${selector}`);
      const bounds = node.getBoundingClientRect();
      return {
        top: bounds.top,
        right: bounds.right,
        bottom: bounds.bottom,
        left: bounds.left,
        width: bounds.width,
        height: bounds.height,
        centerX: bounds.left + bounds.width / 2,
        centerY: bounds.top + bounds.height / 2,
      };
    };
    const head = rect('#workspaceModalBackdrop .modal-head');
    const titleBlock = rect('#workspaceModalBackdrop .modal-head > .grid');
    const close = rect('#workspaceModalCloseBtn');
    const name = rect('#workspaceModalName');
    const repo = rect('#workspaceModalRepo');
    const browse = rect('#workspaceModalBrowseBtn');
    const footer = rect('#workspaceModalBackdrop .modal-foot');
    const cancel = rect('#workspaceModalCancelBtn');
    const create = rect('#workspaceModalCreateBtn');
    const headerStyle = getComputedStyle(document.querySelector('#workspaceModalBackdrop .modal-head'));

    return {
      headerGridColumns: headerStyle.gridTemplateColumns.split(' ').filter(Boolean).length,
      closeCenterDelta: Math.abs(close.centerY - head.centerY),
      titleCenterDelta: Math.abs(titleBlock.centerY - head.centerY),
      titleClearOfClose: titleBlock.right < close.left,
      inputHeightDelta: Math.abs(name.height - repo.height),
      browseHeightDelta: Math.abs(browse.height - repo.height),
      inputWidthDelta: Math.abs(name.width - repo.width),
      footerRightDelta: Math.abs(create.right - repo.right),
      cancelCreateHeightDelta: Math.abs(cancel.height - create.height),
      footerBelowInputs: footer.top > repo.bottom,
    };
  });
}

function expectAligned(metrics) {
  expect(metrics.headerGridColumns).toBe(3);
  expect(metrics.closeCenterDelta).toBeLessThanOrEqual(1.5);
  expect(metrics.titleCenterDelta).toBeLessThanOrEqual(3);
  expect(metrics.titleClearOfClose).toBe(true);
  expect(metrics.inputHeightDelta).toBeLessThanOrEqual(1);
  expect(metrics.browseHeightDelta).toBeLessThanOrEqual(3);
  expect(metrics.inputWidthDelta).toBeLessThanOrEqual(1);
  expect(metrics.footerRightDelta).toBeLessThanOrEqual(1);
  expect(metrics.cancelCreateHeightDelta).toBeLessThanOrEqual(1);
  expect(metrics.footerBelowInputs).toBe(true);
}

test.describe('create workspace modal', () => {
  test('is aligned and handles core states', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1366, height: 860 });
    await openCreateWorkspaceModal(page);

    await expect(page.locator('#workspaceModalCreateBtn')).toBeDisabled();
    expectAligned(await modalMetrics(page));
    await page.screenshot({
      path: testInfo.outputPath('create-workspace-modal-empty-desktop.png'),
      fullPage: true,
    });

    await page.locator('#workspaceModalCloseBtn').click();
    await expect(page.locator('#workspaceModalBackdrop')).toBeHidden();

    await openCreateWorkspaceModal(page);
    await page.locator('#workspaceModalCancelBtn').click();
    await expect(page.locator('#workspaceModalBackdrop')).toBeHidden();

    await openCreateWorkspaceModal(page);
    await page.locator('#workspaceModalName').fill('playwright-modal');
    await page.locator('#workspaceModalName').focus();
    await page.screenshot({
      path: testInfo.outputPath('create-workspace-modal-focused-desktop.png'),
      fullPage: true,
    });

    const invalidPath = join(tmpdir(), `phasr-missing-${Date.now()}`);
    await page.locator('#workspaceModalRepo').fill(invalidPath);
    await page.locator('#workspaceModalRepo').blur();
    await expect(page.locator('#workspaceModalRepo')).toHaveAttribute('aria-invalid', 'true');
    await expect(page.locator('#workspaceModalRepoHelp')).not.toHaveText(
      'Select the root folder of your git repository.',
    );

    const repoPath = mkdtempSync(join(tmpdir(), 'phasr-valid-repo-'));
    execFileSync('git', ['init'], { cwd: repoPath, stdio: 'ignore' });
    await page.locator('#workspaceModalRepo').fill(repoPath);
    await expect(page.locator('#workspaceModalCreateBtn')).toBeEnabled();
    expectAligned(await modalMetrics(page));

    await page.setViewportSize({ width: 720, height: 760 });
    expectAligned(await modalMetrics(page));
    await page.screenshot({
      path: testInfo.outputPath('create-workspace-modal-valid-narrow.png'),
      fullPage: true,
    });

    const browseState = await page.locator('#workspaceModalBrowseBtn').evaluate((button) => {
      const style = getComputedStyle(button);
      return {
        disabled: button.disabled,
        pointerEvents: style.pointerEvents,
        width: button.getBoundingClientRect().width,
        height: button.getBoundingClientRect().height,
      };
    });
    expect(browseState.disabled).toBe(false);
    expect(browseState.pointerEvents).not.toBe('none');
    expect(browseState.width).toBeGreaterThanOrEqual(44);
    expect(browseState.height).toBeGreaterThanOrEqual(44);
  });
});
