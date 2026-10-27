import { expect, type Page, test } from '@playwright/test';

test.use({ viewport: { width: 390, height: 844 } });

const PASSWORD = 'Demo1234!';

async function login(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('邮箱', { exact: true }).fill('viewer@pulse.demo');
  await page.getByLabel('密码', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('navigation', { name: '移动端导航' })).toBeVisible();
}

async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
}

test('mobile layout navigates with the bottom bar and never scrolls sideways', async ({ page }) => {
  await login(page);
  const nav = page.getByRole('navigation', { name: '移动端导航' });
  await expect(nav.getByRole('link')).toHaveCount(6);
  await expect.poll(() => horizontalOverflow(page)).toBeLessThanOrEqual(1);

  await nav.getByRole('link', { name: /Projects/ }).click();
  await expect(page.getByRole('heading', { name: '项目空间' })).toBeVisible();
  await expect.poll(() => horizontalOverflow(page)).toBeLessThanOrEqual(1);

  await page.getByRole('button', { name: '打开导航菜单' }).click();
  await expect(page.locator('.sidebar')).toHaveClass(/is-open/);
  await page.getByRole('button', { name: '关闭菜单' }).click();
  await expect(page.locator('.sidebar')).not.toHaveClass(/is-open/);

  await nav.getByRole('link', { name: /Settings/ }).click();
  await expect(page.getByRole('heading', { name: '账户设置' })).toBeVisible();
  await expect.poll(() => horizontalOverflow(page)).toBeLessThanOrEqual(1);
});

test('the shell honors reduced motion and logs no console errors', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await login(page);

  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));

  await expect(page.locator('.kpi-label')).toHaveCount(3);

  const motion = await page.evaluate(() => {
    const orb = document.querySelector('.clay-orb');
    if (!orb) return null;
    const style = getComputedStyle(orb);
    return { duration: style.animationDuration, iterations: style.animationIterationCount };
  });
  expect(motion).not.toBeNull();
  expect(Number.parseFloat(motion!.duration)).toBeLessThan(0.001);
  expect(motion!.iterations).toBe('1');

  expect(errors).toEqual([]);
});
