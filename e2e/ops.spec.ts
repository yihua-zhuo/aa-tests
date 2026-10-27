import { expect, type Page, test } from '@playwright/test';

const PASSWORD = 'Demo1234!';
const ADMIN = { email: 'admin@pulse.demo' };

async function login(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('邮箱', { exact: true }).fill(ADMIN.email);
  await page.getByLabel('密码', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page).not.toHaveURL(/\/login$/);
}

test('admin ops panel runs integrity checks, backups and feature flags', async ({ page }) => {
  await login(page);

  await page.getByRole('link', { name: 'Ops' }).click();
  await expect(page.getByRole('heading', { name: '运维面板' })).toBeVisible();

  await page.getByRole('button', { name: '检查完整性' }).click();
  await expect(page.locator('.ops-integrity.is-ok')).toBeVisible();

  await page.getByRole('button', { name: '立即备份' }).click();
  await expect(page.locator('.toast').filter({ hasText: '已创建备份' })).toBeVisible();
  await expect(page.locator('.ops-backups tbody tr').first()).toBeVisible();

  const analyticsNav = page.getByRole('link', { name: 'Analytics' });
  await expect(analyticsNav).toBeVisible();
  const analyticsFlag = () =>
    page.locator('.ops-flag', { hasText: '分析报表' }).getByRole('checkbox');

  await analyticsFlag().click();
  await expect(page.locator('.toast').filter({ hasText: '分析报表已停用' })).toBeVisible();
  await expect(analyticsFlag()).not.toBeChecked();
  await expect(analyticsNav).toHaveCount(0);

  await analyticsFlag().click();
  await expect(page.locator('.toast').filter({ hasText: '分析报表已启用' })).toBeVisible();
  await expect(analyticsFlag()).toBeChecked();
  await expect(analyticsNav).toBeVisible();

  await expect(page.getByRole('heading', { name: 'GDPR 数据操作' })).toBeVisible();
  await expect(page.getByLabel('选择成员')).not.toHaveValue('');
});
