import { expect, type Page, test } from '@playwright/test';

test.describe.configure({ mode: 'serial' });

const PASSWORD = 'Demo1234!';
const ADMIN = { email: 'admin@pulse.demo' };

async function login(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('邮箱', { exact: true }).fill(ADMIN.email);
  await page.getByLabel('密码', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page).not.toHaveURL(/\/login$/);
}

test('serves the PWA manifest, icons and service worker', async ({ page, request }) => {
  const manifest = await request.get('/manifest.webmanifest');
  expect(manifest.status()).toBe(200);
  const manifestBody = (await manifest.json()) as {
    start_url: string;
    display: string;
    icons: { src: string; sizes: string }[];
  };
  expect(manifestBody.start_url).toBe('/');
  expect(manifestBody.display).toBe('standalone');
  expect(manifestBody.icons.length).toBeGreaterThanOrEqual(2);

  const worker = await request.get('/sw.js');
  expect(worker.status()).toBe(200);
  expect(worker.headers()['cache-control']).toContain('no-cache');

  const icon = await request.get('/icons/icon-192.png');
  expect(icon.status()).toBe(200);
  expect(icon.headers()['content-type']).toContain('image/png');

  await login(page);
  const state = await page.evaluate(async () => {
    if (!('serviceWorker' in navigator)) return 'unsupported';
    const registration = await navigator.serviceWorker.ready;
    return registration.active?.state ?? 'none';
  });
  expect(state).toBe('activated');

  await page.waitForFunction(() => localStorage.getItem('pulse:snapshot-user') !== null);
  const snapshots = await page.evaluate(() => {
    const user = localStorage.getItem('pulse:snapshot-user');
    return user ? localStorage.getItem(`pulse:snapshot:${user}:/api/auth/me`) : null;
  });
  expect(snapshots).toContain('"user"');
});

test('reloads offline from cached snapshots in read-only mode', async ({ page, context }) => {
  await login(page);
  await expect(page.locator('.page').first()).toBeVisible();
  await page.waitForFunction(() => localStorage.getItem('pulse:snapshot-user') !== null);
  await expect(page.locator('.offline-banner')).toHaveCount(0);

  await context.setOffline(true);
  await page.reload();
  await expect(page.locator('.offline-banner')).toContainText('离线只读模式', { timeout: 20_000 });
  await expect(page).not.toHaveURL(/\/login$/);
  await expect(page.locator('.page').first()).toBeVisible();

  await context.setOffline(false);
  await expect(page.locator('.offline-banner')).toHaveCount(0);
});
