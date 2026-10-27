import { expect, type Page, request as playwrightRequest, test } from '@playwright/test';

test.describe.configure({ mode: 'serial' });

const PASSWORD = 'Demo1234!';
const ADMIN = { email: 'admin@pulse.demo', name: '林晓' };
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAABBUlEQVR4nO3QAUYgAABE0Q77D5IkSZIkSZIkSVaSJEmSfEmSJGslWUmSJEnSdI6Yd4Q3MIgZwgxjRjCjmDHMOGYCM4mZwkxjZjCzmDnMPGYBs4hZwixjVjCrmDXMOuYPZgOzidnCbGN2MLuYPcw+5gBziDnCHGPEnGBOMWeYc8wF5hJzhbnG/MX8w9xgbjF3mP+Ye8wD5hHzhHnGvGBeMW+Yd8wH5hPzhfnGDDSgAQ1oQAMa0IAGNKABDWhAAxrQgAY0oAENaEADGtCABjSgAQ1oQAMa0IAGNKABDWhAAxrQgAY0oAENaEADGtCABjSgAQ1oQAMa0IAGNKABDWhAAxrw+wN+AD5IorNHRjWnAAAAAElFTkSuQmCC';

async function login(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('邮箱', { exact: true }).fill(ADMIN.email);
  await page.getByLabel('密码', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page).not.toHaveURL(/\/login$/);
  await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible();
}

async function adminApi(page: Page) {
  const api = await playwrightRequest.newContext({ baseURL: new URL(page.url()).origin });
  const response = await api.post('/api/auth/login', {
    data: { email: ADMIN.email, password: PASSWORD },
  });
  expect(response.ok()).toBeTruthy();
  return api;
}

test('attachments upload, signed download and delete; avatars crop and remove', async ({
  page,
}) => {
  await login(page);
  const api = await adminApi(page);
  const created = await api.post('/api/projects', {
    data: { name: `E2E 附件项目 ${Date.now().toString(36)}` },
  });
  expect(created.ok()).toBeTruthy();
  const project = (await created.json()) as { id: string };
  const fileName = `e2e-notes-${Date.now().toString(36)}.md`;

  try {
    await page.goto(`/projects/${project.id}`);
    await expect(page.getByRole('heading', { name: '附件', exact: true })).toBeVisible();

    await page.locator('#attachment-file').setInputFiles({
      name: fileName,
      mimeType: 'text/markdown',
      buffer: Buffer.from('# E2E notes\n\nAttachment body.'),
    });
    await expect(page.getByRole('status')).toContainText(`已上传「${fileName}」`);

    const link = page.getByRole('link', { name: fileName, exact: true });
    await expect(link).toBeVisible();
    const href = await link.getAttribute('href');
    expect(href).toMatch(/^\/files\/attachments\/.+\?expires=\d+&sig=[0-9a-f]+$/);
    const download = await page.request.get(href!);
    expect(download.status()).toBe(200);
    expect(await download.text()).toContain('Attachment body.');
    await expect(page.locator('.attachment-usage')).toContainText('1/50');

    await page.getByRole('button', { name: `删除 ${fileName}` }).click();
    const dialog = page.getByRole('dialog', { name: '删除附件' });
    await dialog.getByRole('button', { name: '确认删除' }).click();
    await expect(page.getByRole('status')).toContainText(`已删除「${fileName}」`);
    await expect(page.getByRole('link', { name: fileName, exact: true })).toHaveCount(0);
    expect((await page.request.get(href!)).status()).toBe(404);

    await page.goto('/settings');
    await expect(page.getByRole('heading', { name: '头像', exact: true })).toBeVisible();
    await page.locator('#avatar-file').setInputFiles({
      name: 'e2e-avatar.png',
      mimeType: 'image/png',
      buffer: Buffer.from(PNG_BASE64, 'base64'),
    });
    await expect(page.getByRole('status')).toContainText('头像已更新');
    await expect(page.locator('.avatar-editor img.avatar-image')).toBeVisible();

    const editor = page.locator('.avatar-editor');
    await editor.getByRole('button', { name: '移除', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('头像已移除');
    await expect(editor.locator('img.avatar-image')).toHaveCount(0);
    await expect(editor.getByRole('button', { name: '上传头像' })).toBeVisible();
  } finally {
    await api.delete(`/api/projects/${project.id}`);
    await api.dispose();
  }
});
