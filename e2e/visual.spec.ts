import { expect, type Page, test } from '@playwright/test';

const PASSWORD = 'Demo1234!';

async function login(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('邮箱', { exact: true }).fill('viewer@pulse.demo');
  await page.getByLabel('密码', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible();
}

// Excluded from the default run. Refresh baselines with:
//   E2E_VISUAL=1 npx playwright test e2e/visual.spec.ts --update-snapshots
test('projects page visual baseline', async ({ page }) => {
  await login(page);
  await page.goto('/projects');
  await expect(page.locator('.project-card').first()).toBeVisible();
  await expect(page).toHaveScreenshot('projects.png', {
    animations: 'disabled',
    maxDiffPixelRatio: 0.02,
  });
});

test.describe('mobile', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('mobile shell visual baseline', async ({ page }) => {
    await login(page);
    await expect(page.getByRole('navigation', { name: '移动端导航' })).toBeVisible();
    await expect(page).toHaveScreenshot('mobile-shell.png', {
      animations: 'disabled',
      maxDiffPixelRatio: 0.02,
    });
  });
});
