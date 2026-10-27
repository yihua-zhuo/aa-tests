import { expect, type Page, test } from '@playwright/test';

const PASSWORD = 'Demo1234!';
const ADMIN = { email: 'admin@pulse.demo' };

const unique = (label: string): string =>
  `${label} ${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;

async function login(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('邮箱', { exact: true }).fill(ADMIN.email);
  await page.getByLabel('密码', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page).not.toHaveURL(/\/login$/);
}

test('custom roles, workspaces and private project visibility', async ({ page }) => {
  await login(page);

  const roleName = unique('E2E 角色');
  await page.goto('/users');
  await page.getByRole('button', { name: '新建角色' }).click();
  const roleDialog = page.getByRole('dialog', { name: '新建自定义角色' });
  await roleDialog.getByLabel('角色名称').fill(roleName);
  await roleDialog.getByLabel('基础角色').selectOption('viewer');
  await roleDialog.getByLabel('创建项目').check();
  await roleDialog.getByRole('button', { name: '创建角色' }).click();
  await expect(page.getByRole('status')).toContainText('自定义角色已保存');

  const roleRow = page.locator('tr', { hasText: roleName });
  await expect(roleRow).toContainText('只读成员');
  await expect(roleRow).toContainText('创建项目');

  const userName = unique('E2E 成员');
  await page.getByRole('button', { name: '新建成员' }).click();
  const userDialog = page.getByRole('dialog', { name: '新建成员' });
  await userDialog.getByLabel('姓名').fill(userName);
  await userDialog.getByLabel('邮箱').fill(`e2e-${Date.now()}@example.test`);
  await userDialog.getByLabel('初始密码').fill('Passw0rd!23');
  await userDialog.getByLabel('自定义角色').selectOption({ label: `${roleName} · 只读成员` });
  await userDialog.getByRole('button', { name: '创建成员' }).click();
  await expect(page.getByRole('status')).toContainText(`已创建成员「${userName}」`);
  await expect(page.locator('tr', { hasText: userName })).toContainText(roleName);

  await page.goto('/settings');
  await page.getByRole('button', { name: '工作区' }).click();
  const workspaceName = unique('E2E 工作区');
  await page.getByLabel('新建工作区').fill(workspaceName);
  await page.getByRole('button', { name: '创建工作区' }).click();
  await expect(page.getByRole('status')).toContainText(`已创建工作区「${workspaceName}」`);

  const projectName = unique('E2E 私密项目');
  await page.goto('/projects');
  await page.getByRole('button', { name: '新建项目' }).click();
  const projectDialog = page.getByRole('dialog', { name: '新建项目' });
  await projectDialog.getByLabel('项目名称').fill(projectName);
  await projectDialog.getByLabel('可见范围').selectOption('private');
  await projectDialog.getByRole('button', { name: '创建项目' }).click();
  await expect(page.getByRole('status')).toContainText('项目已创建');

  await page.getByLabel('搜索项目').fill(projectName);
  const card = page.locator('.project-card', { hasText: projectName });
  await expect(card.getByText('仅成员')).toBeVisible();
  await card.getByRole('link', { name: projectName }).click();
  await expect(page.locator('.detail-badges')).toContainText('仅成员');
});
