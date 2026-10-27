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

test('enterprise workbench manages goals, scoring templates and permission simulation', async ({
  page,
}) => {
  await login(page);

  await page.getByRole('link', { name: 'Enterprise' }).click();
  await expect(page.getByRole('heading', { name: '企业工作台' })).toBeVisible();

  const goalName = unique('E2E 目标');
  await page.getByRole('button', { name: '新建目标' }).first().click();
  const goalDialog = page.getByRole('dialog', { name: '新建目标' });
  await goalDialog.getByLabel('目标名称').fill(goalName);
  await goalDialog.getByLabel('单位').fill('%');
  await goalDialog.getByLabel('目标值').fill('100');
  await goalDialog.getByLabel('当前值').fill('25');
  await goalDialog.getByRole('button', { name: '创建目标' }).click();
  await expect(page.getByRole('status')).toContainText(`已创建目标「${goalName}」`);

  const goalCard = page.locator('article', { hasText: goalName });
  await expect(goalCard).toContainText('25%');

  await goalCard.getByRole('button', { name: '更新进度' }).click();
  const progressDialog = page.getByRole('dialog', { name: `更新目标：${goalName}` });
  await progressDialog.getByLabel('实际值').fill('40');
  await progressDialog.getByLabel('更新原因').fill('E2E 季度复盘');
  await progressDialog.getByRole('button', { name: '预览影响' }).click();
  await expect(progressDialog.getByText('影响预览')).toBeVisible();
  await progressDialog.getByRole('button', { name: '保存' }).click();
  await expect(page.getByRole('status')).toContainText(`目标「${goalName}」已更新到 40%`);
  await expect(goalCard).toContainText('40%');

  await page.getByRole('button', { name: '项目组合' }).click();
  const configName = unique('E2E 模板');
  await page.getByRole('button', { name: '新建模板' }).first().click();
  const configDialog = page.getByRole('dialog', { name: '新建评分模板' });
  await configDialog.getByLabel('模板名称').fill(configName);
  await configDialog.getByRole('button', { name: '创建模板' }).click();
  await expect(page.getByRole('status')).toContainText(`已创建评分模板「${configName}」`);
  await expect(page.locator('.enterprise-config', { hasText: configName })).toBeVisible();

  await page.getByRole('button', { name: '权限治理' }).click();
  await expect(page.getByRole('heading', { name: '权限模拟' })).toBeVisible();
  await page.getByRole('button', { name: '运行模拟' }).click();
  await expect(page.locator('.enterprise-simulation')).toBeVisible();
  await expect(page.locator('.enterprise-simulation .badge').first()).toHaveText(/允许|拒绝/);
});

test('enterprise operations and insights run approvals, workflows, scenarios and reports', async ({
  page,
}) => {
  await login(page);

  const suffix = unique('E2E');
  const workflowName = `流程 ${suffix}`;
  const seeded = await page.evaluate(async (name) => {
    const res = await fetch('/api/workbench/workflows', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name,
        definition: {
          nodes: [
            { id: 'start', type: 'start' },
            { id: 'end', type: 'end' },
          ],
          edges: [{ from: 'start', to: 'end' }],
        },
      }),
    });
    return res.status;
  }, workflowName);
  expect(seeded).toBe(201);

  await page.goto('/enterprise?tab=operations');
  await expect(page.getByRole('heading', { name: '审批中心' })).toBeVisible();

  const workflowRow = page.locator('tr', { hasText: workflowName });
  await workflowRow.getByRole('button', { name: '发布', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: '工作流已发布' })).toBeVisible();
  await workflowRow.getByRole('button', { name: '测试', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: '沙箱测试完成' })).toBeVisible();
  await workflowRow.getByRole('button', { name: '运行', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: '工作流已运行' })).toBeVisible();

  const approvalTitle = `审批 ${suffix}`;
  await page.getByRole('button', { name: '发起审批' }).click();
  const approvalDialog = page.getByRole('dialog', { name: '发起审批' });
  await approvalDialog.getByLabel('标题').fill(approvalTitle);
  await approvalDialog.getByLabel('审批人').selectOption({ label: '林晓' });
  await approvalDialog.getByRole('button', { name: '提交审批' }).click();
  await expect(page.getByRole('status').filter({ hasText: '审批已发起' })).toBeVisible();

  const approvalRow = page.locator('tr', { hasText: approvalTitle });
  await expect(approvalRow).toContainText('pending');
  await approvalRow.getByRole('button', { name: '通过', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: '已通过' })).toBeVisible();
  await expect(approvalRow).toContainText('approved');

  await page.goto('/enterprise?tab=insights');
  const scenarioName = `情景 ${suffix}`;
  await page.getByRole('button', { name: '新建情景' }).click();
  const scenarioDialog = page.getByRole('dialog', { name: '新建情景' });
  await scenarioDialog.getByLabel('情景名称').fill(scenarioName);
  await scenarioDialog.getByRole('button', { name: '创建情景' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: `已创建情景「${scenarioName}」` }),
  ).toBeVisible();
  const scenarioRow = page.locator('li', { hasText: scenarioName });
  await scenarioRow.getByRole('button', { name: '评估' }).click();
  await expect(scenarioRow).toContainText('预测毛利');

  const reportName = `报表 ${suffix}`;
  await page.getByRole('button', { name: '新建报表' }).click();
  const reportDialog = page.getByRole('dialog', { name: '新建自助报表' });
  await reportDialog.getByLabel('报表名称').fill(reportName);
  await reportDialog.getByRole('button', { name: '创建报表' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: `已创建报表「${reportName}」` }),
  ).toBeVisible();
  const reportRow = page.locator('li', { hasText: reportName });
  await reportRow.getByRole('button', { name: '运行' }).click();
  await expect(page.getByRole('dialog', { name: `运行结果 · ${reportName}` })).toContainText('共');
});
