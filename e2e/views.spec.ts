import { expect, type Page, request as playwrightRequest, test } from '@playwright/test';

test.describe.configure({ mode: 'serial' });

const PASSWORD = 'Demo1234!';
const ADMIN = { email: 'admin@pulse.demo', name: '林晓' };

const unique = (label: string): string =>
  `${label} ${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;

async function login(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('邮箱', { exact: true }).fill(ADMIN.email);
  await page.getByLabel('密码', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page).not.toHaveURL(/\/login$/);
}

async function adminApi(page: Page) {
  const api = await playwrightRequest.newContext({ baseURL: new URL(page.url()).origin });
  const response = await api.post('/api/auth/login', {
    data: { email: ADMIN.email, password: PASSWORD },
  });
  expect(response.ok()).toBeTruthy();
  return api;
}

test('favorites, tags, saved views and page size stay in the URL', async ({ page }) => {
  await login(page);
  const api = await adminApi(page);
  const name = unique('E2E 视图');
  const tag = unique('标签');
  const created = await api.post('/api/projects', {
    data: { name, tags: [tag], status: 'active' },
  });
  expect(created.ok()).toBeTruthy();
  const project = (await created.json()) as { id: string };

  try {
    await page.goto('/projects');
    await page.getByLabel('搜索项目').fill(name);
    const card = page.locator('.project-card', { hasText: name });
    await expect(card).toBeVisible();

    await card.getByRole('button', { name: `收藏 ${name}` }).click();
    await expect(page.getByRole('status')).toContainText(`已收藏「${name}」`);
    await expect(card.getByRole('button', { name: `取消收藏 ${name}` })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    await page.getByRole('button', { name: '只看收藏' }).click();
    await expect(page).toHaveURL(/favorite=1/);
    await expect(card).toBeVisible();

    await card.getByRole('button', { name: tag }).click();
    await expect(page).toHaveURL((url) => url.searchParams.get('tag') === tag);
    await expect(card).toBeVisible();

    await page.getByRole('button', { name: '保存当前视图' }).click();
    const dialog = page.getByRole('dialog', { name: '保存当前视图' });
    await expect(dialog).toBeVisible();
    const viewName = unique('我的视图');
    await dialog.getByLabel('视图名称').fill(viewName);
    await dialog.getByRole('button', { name: '保存视图' }).click();
    await expect(page.getByRole('status')).toContainText(`已保存视图「${viewName}」`);

    const select = page.getByLabel('我的视图');
    await expect(select.locator('option', { hasText: viewName })).toHaveCount(1);

    await page.getByRole('button', { name: '只看收藏' }).click();
    await page.getByLabel('搜索项目').fill('');
    await expect(page).not.toHaveURL(/favorite=1/);

    await select.selectOption({ label: viewName });
    await expect(page).toHaveURL(/favorite=1/);
    await expect(page).toHaveURL((url) => url.searchParams.get('tag') === tag);
    await expect(page.getByLabel('搜索项目')).toHaveValue(name);
    await expect(card).toBeVisible();

    await page.getByLabel('每页数量').selectOption('48');
    await expect(page).toHaveURL(/pageSize=48/);
    await expect(page.getByLabel('每页数量')).toHaveValue('48');

    await select.selectOption({ label: viewName });
    await expect(page.getByRole('button', { name: '删除视图' })).toBeVisible();
    page.once('dialog', (confirmation) => void confirmation.accept());
    await page.getByRole('button', { name: '删除视图' }).click();
    await expect(page.getByRole('status')).toContainText(`已删除视图「${viewName}」`);
    await expect(select.locator('option', { hasText: viewName })).toHaveCount(0);
  } finally {
    await api.delete(`/api/projects/${project.id}`);
    await api.dispose();
  }
});

test('batch archive updates the selected projects and clears the bar', async ({ page }) => {
  await login(page);
  const api = await adminApi(page);
  const prefix = unique('E2E 批量');
  const ids: string[] = [];
  const names = [`${prefix} A`, `${prefix} B`];

  try {
    for (const name of names) {
      const created = await api.post('/api/projects', { data: { name } });
      expect(created.ok()).toBeTruthy();
      ids.push(((await created.json()) as { id: string }).id);
    }

    await page.goto('/projects');
    await page.getByLabel('搜索项目').fill(prefix);
    await expect(page.locator('.project-card')).toHaveCount(2);

    for (const name of names) {
      await page.getByRole('checkbox', { name: `选择 ${name}`, exact: true }).check();
    }

    const bar = page.getByRole('region', { name: '批量操作' });
    await expect(bar).toContainText('已选 2 个项目');
    await bar.getByRole('button', { name: '归档' }).click();
    await expect(page.getByRole('status')).toContainText('已更新 2 个项目');
    await expect(bar).toHaveCount(0);

    for (const id of ids) {
      const detail = (await (await api.get(`/api/projects/${id}`)).json()) as { status: string };
      expect(detail.status).toBe('archived');
    }
  } finally {
    for (const id of ids) await api.delete(`/api/projects/${id}`);
    await api.dispose();
  }
});
