import { expect, type Page, request as playwrightRequest, test } from '@playwright/test';

test.describe.configure({ mode: 'serial' });

const PASSWORD = 'Demo1234!';
const ADMIN = { email: 'admin@pulse.demo', name: '林晓' };

async function login(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('邮箱', { exact: true }).fill(ADMIN.email);
  await page.getByLabel('密码', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page).not.toHaveURL(/\/login$/);
}

test('personal access tokens are created once, scoped and revocable', async ({ page }) => {
  await login(page);
  await page.goto('/settings');
  await page.getByRole('button', { name: '登录与安全' }).click();
  await expect(page.getByRole('heading', { name: '个人访问令牌' })).toBeVisible();

  const name = `E2E 令牌 ${Date.now().toString(36)}`;
  await page.getByLabel('名称', { exact: true }).fill(name);
  await page.getByLabel('权限范围', { exact: true }).selectOption('read');
  await page.getByLabel('有效期', { exact: true }).selectOption('30');
  await page.getByRole('button', { name: '创建令牌' }).click();

  const secretBanner = page.locator('.secret-banner').filter({ hasText: name });
  await expect(secretBanner).toContainText('仅显示一次');
  const token = (await secretBanner.locator('.secret-value').textContent())?.trim() ?? '';
  expect(token).toMatch(/^clp_/);

  const api = await playwrightRequest.newContext({
    baseURL: new URL(page.url()).origin,
    extraHTTPHeaders: { authorization: `Bearer ${token}` },
  });
  try {
    const read = await api.get('/api/projects');
    expect(read.status()).toBe(200);
    expect(read.headers()['x-ratelimit-limit']).toBeTruthy();

    const write = await api.post('/api/projects', { data: { name: '令牌不应创建' } });
    expect(write.status()).toBe(403);
    expect((await write.json()).error).toBe('insufficient_scope');
  } finally {
    await api.dispose();
  }

  await secretBanner.getByRole('button', { name: '关闭' }).click();
  const row = page.locator('.integration-row').filter({ hasText: name });
  await expect(row).toContainText('只读');

  page.once('dialog', (dialog) => void dialog.accept());
  await row.getByRole('button', { name: '吊销' }).click();
  await expect(row).toContainText('已吊销');

  const revokedApi = await playwrightRequest.newContext({
    baseURL: new URL(page.url()).origin,
    extraHTTPHeaders: { authorization: `Bearer ${token}` },
  });
  try {
    expect((await revokedApi.get('/api/projects')).status()).toBe(401);
  } finally {
    await revokedApi.dispose();
  }
});

test('webhooks can be created, paused and deleted from settings', async ({ page }) => {
  await login(page);
  await page.goto('/settings');
  await page.getByRole('button', { name: '集成' }).click();
  await expect(page.getByRole('heading', { name: 'Webhook 集成' })).toBeVisible();

  const url = `https://hooks.example.com/e2e-${Date.now().toString(36)}`;
  await page.getByLabel('回调地址', { exact: true }).fill(url);
  await page.getByRole('button', { name: '添加 Webhook' }).click();

  const secretBanner = page.locator('.secret-banner').filter({ hasText: '签名密钥' });
  await expect(secretBanner).toBeVisible();
  const secret = (await secretBanner.locator('.secret-value').textContent())?.trim() ?? '';
  expect(secret).toMatch(/^whsec_/);

  const row = page.locator('.integration-row').filter({ hasText: url });
  await expect(row).toBeVisible();
  await expect(row).toContainText('已启用');
  await expect(row).toContainText('创建项目');

  await row.getByRole('button', { name: '停用' }).click();
  await expect(row).toContainText('已停用');

  await row.getByRole('button', { name: '投递记录' }).click();
  await expect(row.locator('.delivery-list')).toContainText('暂无投递记录');

  page.once('dialog', (dialog) => void dialog.accept());
  await row.getByRole('button', { name: '删除' }).click();
  await expect(page.locator('.integration-row').filter({ hasText: url })).toHaveCount(0);
});
