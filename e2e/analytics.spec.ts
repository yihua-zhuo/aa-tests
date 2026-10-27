import { readFileSync } from 'node:fs';
import { expect, type Page, request as playwrightRequest, test } from '@playwright/test';

test.describe.configure({ mode: 'serial' });

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

test('workspace currency, metric import and saved reports', async ({ page }) => {
  await page.goto('/login');
  const api = await playwrightRequest.newContext({ baseURL: new URL(page.url()).origin });
  const adminLogin = await api.post('/api/auth/login', {
    data: { email: ADMIN.email, password: PASSWORD },
  });
  expect(adminLogin.ok()).toBeTruthy();
  const patched = await api.patch('/api/workspace', {
    data: { currency: 'CNY', rate: 7.2 },
  });
  expect(patched.ok()).toBeTruthy();
  const reportName = unique('E2E 报表');

  try {
    await login(page);

    await page.goto('/analytics?tab=sales');
    await expect(page.locator('.sales-summary').getByText(/¥/).first()).toBeVisible();
    await expect(page.getByRole('link', { name: '导出 CSV' })).toHaveAttribute(
      'href',
      /kind=revenue/,
    );

    await page.goto('/analytics?tab=data');
    await expect(page.getByText('当前展示币种 CNY')).toBeVisible();
    await page.getByLabel('指标文件').setInputFiles({
      name: 'metrics.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from(
        'date,revenue,customers,conversions,visitors\n2026-10-20,100,8,3,60\n2026-10-19,bad,1,1,1\n',
      ),
    });
    await page.getByRole('button', { name: '上传并导入' }).click();
    await expect(page.getByText('已导入 1 行，跳过 1 行')).toBeVisible();
    await expect(page.locator('tr', { hasText: 'CSV 导入' })).toBeVisible();

    await page.locator('.segmented').getByRole('button', { name: '保存报表' }).click();
    await page.getByLabel('报表名称').fill(reportName);
    await page.getByLabel('指标').selectOption({ label: '收入' });
    await page.getByLabel('发送频率').selectOption({ label: '每周邮件' });
    const form = page.locator('.analytics-page form');
    await form.getByRole('button', { name: '保存报表' }).click();
    await expect(page.getByText('报表已保存')).toBeVisible();

    const row = page.locator('tr', { hasText: reportName });
    await expect(row).toBeVisible();
    await expect(row).toContainText('每周邮件');

    const downloadPromise = page.waitForEvent('download');
    await row.getByRole('link', { name: '导出' }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toContain('analytics-revenue');

    page.once('dialog', (dialog) => void dialog.accept());
    await row.getByRole('button', { name: '删除' }).click();
    await expect(page.locator('tr', { hasText: reportName })).toHaveCount(0);
  } finally {
    await api.patch('/api/workspace', { data: { currency: 'USD', rate: 1 } });
    await api.dispose();
  }
});

test('channel donut PNG export includes the ring and legend on first click', async ({ page }) => {
  await login(page);
  await page.goto('/analytics');
  const button = page.getByRole('button', { name: '导出渠道份额图为 PNG 图片' });
  await expect(button).toBeVisible();

  // Click before the entrance animation finishes: the export must wait for it
  // instead of serializing an empty ring.
  const downloadPromise = page.waitForEvent('download');
  await button.click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('渠道份额.png');
  const path = await download.path();
  expect(path).toBeTruthy();
  const png = readFileSync(path!);
  expect(png.subarray(1, 4).toString()).toBe('PNG');

  const pixels = await page.evaluate(async (base64) => {
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error('image decode failed'));
      image.src = `data:image/png;base64,${base64}`;
    });
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('no 2d context');
    context.drawImage(image, 0, 0);
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
    let ring = 0;
    let legend = 0;
    const ringEnd = Math.floor(canvas.height * 0.55);
    const legendStart = Math.floor(canvas.height * 0.7);
    for (let y = 0; y < canvas.height; y += 1) {
      for (let x = 0; x < canvas.width; x += 1) {
        const offset = (y * canvas.width + x) * 4;
        const saturation =
          Math.max(data[offset], data[offset + 1], data[offset + 2]) -
          Math.min(data[offset], data[offset + 1], data[offset + 2]);
        if (saturation < 40) continue;
        if (y < ringEnd) ring += 1;
        else if (y > legendStart) legend += 1;
      }
    }
    return { width: canvas.width, ring, legend };
  }, png.toString('base64'));

  expect(pixels.width).toBeGreaterThan(500);
  expect(pixels.ring).toBeGreaterThan(10_000);
  expect(pixels.legend).toBeGreaterThan(800);
});
