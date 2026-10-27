import { readFileSync } from 'node:fs';
import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, request as playwrightRequest, test } from '@playwright/test';

test.describe.configure({ mode: 'serial' });

const PASSWORD = 'Demo1234!';
const NEW_PASSWORD = 'Changed1234!';
const ACCOUNTS = {
  admin: { email: 'admin@pulse.demo', name: '林晓' },
  manager: { email: 'manager@pulse.demo', name: '陈墨' },
  pm: { email: 'pm@pulse.demo', name: '周岚' },
  viewer: { email: 'viewer@pulse.demo', name: '顾言' },
};
const MEMBER_EMAIL = 'e2e.owner@clay.test';

const unique = (label: string): string =>
  `${label} ${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;

async function login(page: Page, email: string, password = PASSWORD): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('邮箱', { exact: true }).fill(email);
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page).not.toHaveURL(/\/login$/);
  await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible();
}

async function logout(page: Page): Promise<void> {
  await page.getByRole('button', { name: '退出登录' }).first().click();
  await expect(page).toHaveURL(/\/login$/);
}

async function adminApi(page: Page) {
  const api = await playwrightRequest.newContext({ baseURL: new URL(page.url()).origin });
  const response = await api.post('/api/auth/login', {
    data: { email: ACCOUNTS.admin.email, password: PASSWORD },
  });
  expect(response.ok()).toBeTruthy();
  return api;
}

function projectIdFromUrl(page: Page): string {
  const parts = new URL(page.url()).pathname.split('/');
  return parts[parts.length - 1] ?? '';
}

test('unauthenticated visitors are redirected and demo accounts sign in', async ({ page }) => {
  await page.goto('/projects');
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('heading', { name: '登录工作台' })).toBeVisible();
  await expect(page.getByText('Demo 模式')).toBeVisible();

  await page.getByLabel('邮箱', { exact: true }).fill('nobody@clay.test');
  await page.getByLabel('密码', { exact: true }).fill('wrong-password');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('邮箱或密码不正确');

  await page.locator('button.demo-account', { hasText: ACCOUNTS.admin.name }).click();
  await expect(page.getByLabel('邮箱', { exact: true })).toHaveValue(ACCOUNTS.admin.email);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page).toHaveURL(/\/projects$/);
  await expect(page.getByRole('heading', { name: '项目空间' })).toBeVisible();

  await logout(page);
});

test('overview shows demo KPIs, charts and receives live updates', async ({ page }) => {
  await login(page, ACCOUNTS.admin.email);
  await expect(page.getByRole('heading', { level: 1 })).toContainText(ACCOUNTS.admin.name);

  const kpiLabels = page.locator('.kpi-label');
  await expect(kpiLabels).toHaveCount(3);
  await expect(kpiLabels.nth(0)).toHaveText('收入');
  await expect(kpiLabels.nth(1)).toHaveText('新增客户');
  await expect(kpiLabels.nth(2)).toHaveText('转化率');
  await expect(page.getByText('Demo 数据', { exact: true }).first()).toBeVisible();
  await expect(page.locator('.page-sub')).toContainText('Asia/Shanghai');
  await expect(page.locator('.recharts-surface').first()).toBeVisible({ timeout: 15_000 });

  const total = page.locator('.project-overview-total strong');
  await expect(total).toHaveText('8');
  const before = Number(await total.textContent());

  await page.getByRole('button', { name: '7 天', exact: true }).click();
  await expect(page.locator('.page-sub')).toContainText('7 天');

  await expect(page.locator('.connection-pill')).toHaveText(/Live/);
  const created = await page.request.post('/api/projects', {
    data: { name: unique('E2E 实时') },
  });
  expect(created.status()).toBe(201);
  const project = (await created.json()) as { id: string };
  try {
    await expect(total).toHaveText(String(before + 1), { timeout: 15_000 });
  } finally {
    await page.request.delete(`/api/projects/${project.id}`);
  }
});

test('analytics tabs, granularity, comparison and range stay in the URL', async ({ page }) => {
  await login(page, ACCOUNTS.admin.email);
  await page.goto('/analytics');
  await expect(page.getByRole('heading', { name: '分析报表' })).toBeVisible();
  await expect(page.locator('.stat-label').filter({ hasText: '周期收入' })).toBeVisible();

  await page.getByRole('button', { name: '销售额', exact: true }).click();
  await expect(page.getByRole('heading', { name: '收入报告' })).toBeVisible();

  await page.getByRole('button', { name: '周', exact: true }).click();
  await expect(page).toHaveURL(/granularity=week/);

  await page.getByText('对比上一周期', { exact: true }).click();
  await expect(page).toHaveURL(/compare=0/);

  await page.getByRole('button', { name: '用户', exact: true }).click();
  await expect(page.locator('.stat-label').filter({ hasText: '新增客户' })).toBeVisible();
  await expect(page.locator('.stat-label').filter({ hasText: '转化率' })).toBeVisible();

  await page.getByRole('button', { name: '项目', exact: true }).click();
  await expect(page.getByRole('heading', { name: '项目完成度' })).toBeVisible();

  await page.getByRole('button', { name: '7 天', exact: true }).click();
  await expect(page).toHaveURL(/range=7d/);
});

test('viewer sees only joined projects and is blocked from admin areas', async ({ page }) => {
  await login(page, ACCOUNTS.viewer.email);
  await page.goto('/projects');

  await expect(page.locator('.page-sub')).toContainText('共 5 个可见项目');
  await expect(page.getByRole('button', { name: '新建项目' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '导入', exact: true })).toHaveCount(0);
  await expect(page.getByRole('link', { name: /导出 CSV/ })).toBeVisible();
  await expect(page.getByRole('link', { name: /Users/ })).toHaveCount(0);

  await expect(page.locator('.project-card', { hasText: '帮助中心改版' })).toBeVisible();
  await expect(page.locator('.project-card', { hasText: '客户数据中台' })).toHaveCount(0);

  await page.goto('/users');
  await expect(page.getByRole('heading', { name: '没有访问权限' })).toBeVisible();

  const api = await adminApi(page);
  try {
    const response = await api.get('/api/projects?pageSize=50');
    const data = (await response.json()) as { projects: { id: string; name: string }[] };
    const hidden = data.projects.find((item) => item.name === '客户数据中台');
    expect(hidden).toBeTruthy();

    await page.goto(`/projects/${hidden!.id}`);
    await expect(page.getByRole('heading', { name: '项目不存在' })).toBeVisible();
  } finally {
    await api.dispose();
  }
});

test('project manager sees three projects and can create one', async ({ page }) => {
  await login(page, ACCOUNTS.pm.email);
  await page.goto('/projects');
  await expect(page.locator('.page-sub')).toContainText('共 3 个可见项目');
  await expect(page.getByRole('button', { name: '导入', exact: true })).toHaveCount(0);

  const name = unique('E2E PM 项目');
  await page.getByRole('button', { name: '新建项目' }).click();
  await page.getByLabel('项目名称').fill(name);
  await page.getByLabel('描述').fill('由项目经理创建的 E2E 项目');
  await page.getByRole('button', { name: '创建项目' }).click();
  await expect(page.getByRole('status')).toContainText('项目已创建');

  await page.getByLabel('搜索项目').fill(name);
  await expect(page.locator('.project-card', { hasText: name })).toBeVisible();

  await page.goto('/users');
  await expect(page.getByRole('heading', { name: '没有访问权限' })).toBeVisible();
});

test('rapid search and status changes stay in sync and survive history', async ({ page }) => {
  await login(page, ACCOUNTS.admin.email);
  await page.goto('/projects');

  const search = page.getByLabel('搜索项目');
  await search.fill('品牌');
  await page
    .locator('.status-chips')
    .getByRole('button', { name: /^进行中/ })
    .click();

  await expect(page).toHaveURL(/q=%E5%93%81%E7%89%8C/);
  await expect(page).toHaveURL(/status=active/);
  await expect(page.locator('.project-card')).toHaveCount(1);
  await expect(page.locator('.project-card')).toContainText('官网品牌重塑');

  await page.locator('.project-card').getByRole('link', { name: '官网品牌重塑' }).click();
  await expect(page).toHaveURL(/\/projects\/[0-9a-f-]+$/);
  await page.goBack();

  await expect(page).toHaveURL(/q=%E5%93%81%E7%89%8C/);
  await expect(search).toHaveValue('品牌');
  await expect(page.locator('.project-card')).toHaveCount(1);
});

test('admin creates, edits and deletes a project and stale edits conflict', async ({ page }) => {
  await login(page, ACCOUNTS.admin.email);
  await page.goto('/projects');

  const name = unique('E2E 项目');
  await page.getByRole('button', { name: '新建项目' }).click();
  await page.getByLabel('项目名称').fill(name);
  await page.getByLabel('描述').fill('用于验证项目生命周期');
  await page.locator('#project-status').selectOption({ label: '进行中' });
  await page.getByRole('button', { name: '创建项目' }).click();
  await expect(page.getByRole('status')).toContainText('项目已创建');

  await page.getByLabel('搜索项目').fill(name);
  const card = page.locator('.project-card', { hasText: name });
  await expect(card).toBeVisible();
  await card.getByRole('link', { name, exact: true }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(name);
  const id = projectIdFromUrl(page);

  await page.getByRole('button', { name: '编辑项目' }).click();
  await page.getByLabel('项目名称').fill(`${name} 改`);
  await page.getByRole('button', { name: '保存修改' }).click();
  await expect(page.getByRole('status')).toContainText('项目已更新');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(`${name} 改`);

  await page.route(`**/api/projects/${id}`, async (route) => {
    if (route.request().method() !== 'PATCH') {
      await route.continue();
      return;
    }
    const body = (route.request().postDataJSON() ?? {}) as Record<string, unknown>;
    await route.continue({ postData: JSON.stringify({ ...body, version: 1 }) });
  });

  await page.getByRole('button', { name: '编辑项目' }).click();
  await page.getByLabel('项目名称').fill(`${name} 冲突`);
  await page.getByRole('button', { name: '保存修改' }).click();
  const conflict = page.locator('#project-form').getByRole('alert');
  await expect(conflict).toContainText('项目已被其他会话修改');
  await expect(page.getByRole('button', { name: /载入最新版本/ })).toBeVisible();
  await page.getByRole('button', { name: /载入最新版本/ }).click();
  await expect(conflict).toHaveCount(0);
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await page.unroute(`**/api/projects/${id}`);

  await page
    .getByRole('navigation', { name: '面包屑' })
    .getByRole('link', { name: 'Projects' })
    .click();
  await page.getByLabel('搜索项目').fill(`${name} 改`);
  await page
    .locator('.project-card', { hasText: `${name} 改` })
    .getByRole('link')
    .click();
  await page.getByRole('button', { name: '删除', exact: true }).click();
  await page.getByRole('button', { name: '确认删除' }).click();
  await expect(page).toHaveURL(/\/projects$/);
  await page.getByLabel('搜索项目').fill(`${name} 改`);
  await expect(page.locator('.project-card', { hasText: `${name} 改` })).toHaveCount(0);

  await page.getByRole('button', { name: '回收站' }).click();
  const trash = page.getByRole('dialog', { name: '回收站' });
  const trashRow = trash.locator('tr', { hasText: `${name} 改` });
  await expect(trashRow).toBeVisible();
  await trashRow.getByRole('button', { name: '恢复' }).click();
  await expect(page.getByRole('status')).toContainText('已恢复');
  await expect(trashRow).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(trash).toHaveCount(0);
  await expect(page.locator('.project-card', { hasText: `${name} 改` })).toBeVisible();
});

test('tasks, subtasks and milestones roll up project progress', async ({ page }) => {
  await login(page, ACCOUNTS.admin.email);
  const api = await adminApi(page);
  const projectName = unique('E2E 任务项目');
  const created = await api.post('/api/projects', { data: { name: projectName } });
  expect(created.ok()).toBeTruthy();
  const project = (await created.json()) as { id: string };
  const taskTitle = unique('任务');
  const milestoneTitle = unique('里程碑');

  await page.goto(`/projects/${project.id}`);
  await expect(page.getByRole('heading', { name: '任务与里程碑' })).toBeVisible();

  await page.getByLabel('新里程碑名称').fill(milestoneTitle);
  await page.getByRole('button', { name: '创建里程碑' }).click();
  await expect(page.getByRole('status')).toContainText('里程碑已创建');
  await expect(page.locator('.milestone-chip', { hasText: milestoneTitle })).toBeVisible();

  await page.getByLabel('新任务标题').fill(taskTitle);
  await page.getByRole('button', { name: '添加', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('任务已创建');
  const row = page.locator('.task-row', { hasText: taskTitle }).first();
  await expect(row).toBeVisible();

  await row.getByRole('button', { name: `完成任务：${taskTitle}` }).click();
  await expect(page.locator('.task-progress strong')).toHaveText('100%');
  await expect(page.getByText(`完成了任务「${taskTitle}」`)).toBeVisible();

  await page.getByRole('button', { name: `为「${taskTitle}」添加子任务` }).click();
  const dialog = page.getByRole('dialog', { name: '新建子任务' });
  await dialog.getByLabel('任务标题').fill(`${taskTitle} 子任务`);
  await dialog.getByRole('button', { name: '创建任务' }).click();
  await expect(page.getByRole('status')).toContainText('子任务已创建');
  await expect(page.locator('.task-children', { hasText: `${taskTitle} 子任务` })).toBeVisible();

  await page.getByRole('button', { name: `编辑任务「${taskTitle}」` }).click();
  const editDialog = page.getByRole('dialog', { name: '编辑任务' });
  await editDialog.getByLabel('负责人').selectOption({ label: ACCOUNTS.admin.name });
  await editDialog.getByLabel('截止日期').fill(new Date().toISOString().slice(0, 10));
  await editDialog.getByRole('button', { name: '保存修改' }).click();
  await expect(page.getByRole('status')).toContainText('任务已更新');
  await expect(row).toContainText(ACCOUNTS.admin.name);

  const views = page.getByRole('group', { name: '任务视图' });
  await views.getByRole('button', { name: '看板' }).click();
  const boardCard = page.locator('.task-card', { hasText: taskTitle }).first();
  await expect(boardCard).toBeVisible();
  await boardCard.getByLabel(`状态：${taskTitle}`).selectOption('in_progress');
  await expect(
    page.locator('.task-column[data-status="in_progress"]', { hasText: taskTitle }),
  ).toBeVisible();

  await views.getByRole('button', { name: '时间线' }).click();
  await expect(page.locator('.timeline-group', { hasText: taskTitle }).first()).toBeVisible();

  await views.getByRole('button', { name: '日历' }).click();
  await expect(page.locator('.task-calendar')).toBeVisible();
  await expect(
    page.locator('.task-calendar-day.is-today').getByRole('button', { name: taskTitle }),
  ).toBeVisible();

  await api.delete(`/api/projects/${project.id}`);
  await api.dispose();
});

test('templates create projects, duplication shifts dates and archived projects restore', async ({
  page,
}) => {
  await login(page, ACCOUNTS.admin.email);
  const api = await adminApi(page);
  const templateName = unique('E2E 模板项目');

  await page.goto('/projects');
  await page.getByRole('button', { name: '从模板创建' }).click();
  const dialog = page.getByRole('dialog', { name: '从模板创建项目' });
  await expect(dialog).toBeVisible();
  const sprint = dialog.getByRole('radio', { name: /双周迭代/ });
  await expect(sprint).toBeVisible();
  await sprint.click();
  await dialog.getByLabel('项目名称').fill(templateName);
  await dialog.getByLabel('开始日期').fill('2026-10-05');
  await dialog.getByRole('button', { name: '创建项目' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(templateName);
  const sourceId = projectIdFromUrl(page);
  await expect(page.getByRole('heading', { name: '任务与里程碑' })).toBeVisible();
  await expect(page.locator('.milestone-chip', { hasText: '计划' }).first()).toBeVisible();
  await expect(page.locator('.task-row', { hasText: '每日站会' }).first()).toBeVisible();

  const sourceDetail = (await (await api.get(`/api/projects/${sourceId}`)).json()) as {
    startDate: string;
    dueDate: string;
  };
  expect(sourceDetail.startDate).toBe('2026-10-05');
  const sourceTasks = (await (await api.get(`/api/projects/${sourceId}/tasks`)).json()) as {
    tasks: unknown[];
    milestones: unknown[];
  };

  const copyName = `${templateName} 副本`;
  await page.getByRole('button', { name: '复制项目', exact: true }).click();
  const duplicateDialog = page.getByRole('dialog', { name: '复制项目' });
  await expect(duplicateDialog).toBeVisible();
  await duplicateDialog.locator('#duplicate-offset').fill('7');
  await duplicateDialog.getByRole('button', { name: '复制项目' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(copyName);
  const copyId = projectIdFromUrl(page);

  const copyDetail = (await (await api.get(`/api/projects/${copyId}`)).json()) as {
    startDate: string;
    dueDate: string;
    status: string;
  };
  expect(copyDetail.startDate).toBe('2026-10-12');
  expect(copyDetail.dueDate).toBe('2026-10-26');
  expect(copyDetail.status).toBe('planning');
  const copyTasks = (await (await api.get(`/api/projects/${copyId}/tasks`)).json()) as {
    tasks: unknown[];
    milestones: unknown[];
  };
  expect(copyTasks.tasks).toHaveLength(sourceTasks.tasks.length);
  expect(copyTasks.milestones).toHaveLength(sourceTasks.milestones.length);
  await expect(page.locator('.task-row', { hasText: '每日站会' }).first()).toBeVisible();

  await page.getByRole('button', { name: '归档', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: '已归档' })).toBeVisible();
  await expect(page.locator('.detail-badges')).toContainText('已归档');

  await page.goto('/projects');
  await page.locator('.filter-chip', { hasText: '已归档' }).click();
  await expect(page).toHaveURL(/status=archived/);
  const archivedCard = page.locator('.project-card', { hasText: copyName });
  await expect(archivedCard).toBeVisible();
  await archivedCard.getByRole('button', { name: `恢复 ${copyName}` }).click();
  await expect(page.getByRole('status').filter({ hasText: '已恢复' })).toBeVisible();
  await expect(archivedCard).toHaveCount(0);

  const restored = (await (await api.get(`/api/projects/${copyId}`)).json()) as { status: string };
  expect(restored.status).toBe('active');

  for (const id of [sourceId, copyId]) {
    await api.delete(`/api/projects/${id}`);
    await api.delete(`/api/projects/${id}/purge`);
  }
  await api.dispose();
});

test('project and task comments mention members and notify through the bell', async ({ page }) => {
  await login(page, ACCOUNTS.admin.email);
  const api = await adminApi(page);
  try {
    const optionsResponse = await api.get('/api/users/options');
    expect(optionsResponse.ok()).toBeTruthy();
    const { users } = (await optionsResponse.json()) as {
      users: { id: string; name: string }[];
    };
    const manager = users.find((user) => user.name === ACCOUNTS.manager.name);
    const viewer = users.find((user) => user.name === ACCOUNTS.viewer.name);
    expect(manager && viewer).toBeTruthy();

    const projectName = unique('E2E 评论项目');
    const created = await api.post('/api/projects', {
      data: { name: projectName, memberIds: [manager!.id, viewer!.id] },
    });
    expect(created.ok()).toBeTruthy();
    const project = (await created.json()) as { id: string };
    const taskTitle = unique('评论任务');
    const taskResponse = await api.post(`/api/projects/${project.id}/tasks`, {
      data: { title: taskTitle },
    });
    expect(taskResponse.ok()).toBeTruthy();

    await page.goto(`/projects/${project.id}`);
    const projectComment = unique('项目评论');
    await page.getByLabel('评论内容').fill(`${projectComment} 请一起看下`);
    await page.getByRole('checkbox', { name: ACCOUNTS.manager.name }).check();
    await page.getByRole('button', { name: '发表评论' }).click();
    const projectItem = page.locator('.comment-item', { hasText: projectComment });
    await expect(projectItem).toBeVisible();
    await expect(projectItem.locator('.mention-chip')).toContainText(`@${ACCOUNTS.manager.name}`);

    await page.getByRole('button', { name: `评论任务「${taskTitle}」` }).click();
    const taskDialog = page.getByRole('dialog', { name: `任务评论 · ${taskTitle}` });
    await expect(taskDialog).toBeVisible();
    const taskComment = unique('任务评论');
    await taskDialog.getByLabel('评论内容').fill(taskComment);
    await taskDialog.getByRole('checkbox', { name: ACCOUNTS.manager.name }).check();
    await taskDialog.getByRole('button', { name: '发表评论' }).click();
    await expect(taskDialog.locator('.comment-item', { hasText: taskComment })).toBeVisible();
    await taskDialog.getByRole('button', { name: '关闭', exact: true }).last().click();

    const taskRow = page.locator('.task-row', { hasText: taskTitle }).first();
    await expect(taskRow.locator('.task-comment-count')).toHaveText('1');
    await page.keyboard.press('Escape');
    await logout(page);

    await login(page, ACCOUNTS.manager.email);
    const bell = page.getByRole('button', { name: /^通知中心/ });
    await bell.click();
    const panel = page.getByRole('dialog', { name: '通知中心' });
    await expect(panel).toBeVisible();
    const taskNotification = panel.locator('.notification-item', { hasText: taskTitle }).first();
    await expect(taskNotification).toBeVisible();
    await taskNotification.click();

    await expect(page).toHaveURL(new RegExp(`/projects/${project.id}\\?task=[0-9a-f-]+$`));
    await expect(page.getByRole('dialog', { name: `任务评论 · ${taskTitle}` })).toBeVisible();
    await page.keyboard.press('Escape');

    await page.getByRole('button', { name: /^通知中心/ }).click();
    await page.getByRole('button', { name: '全部已读' }).click();
    await expect(page.locator('.notification-badge')).toHaveCount(0);
    await page.keyboard.press('Escape');

    await logout(page);
    await login(page, ACCOUNTS.viewer.email);
    await page.goto(`/projects/${project.id}`);
    await expect(page.getByText('只读成员可以查看评论，但不能参与讨论。')).toBeVisible();
    await expect(page.locator('.comment-item', { hasText: projectComment })).toBeVisible();
    await expect(page.getByRole('button', { name: '发表评论' })).toHaveCount(0);

    await api.delete(`/api/projects/${project.id}`);
  } finally {
    await api.dispose();
  }
});

test('global search finds a project and deep-links to it', async ({ page }) => {
  await login(page, ACCOUNTS.manager.email);
  const search = page.getByLabel('全局搜索');
  await search.fill('官网品牌重塑');
  const hit = page.locator('.search-group', { hasText: 'Projects' }).locator('.search-hit').first();
  await expect(hit).toContainText('官网品牌重塑');
  await hit.click();
  await expect(page).toHaveURL(/\/projects\/[0-9a-f-]+$/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('官网品牌重塑');
});

test('activity feed paginates with a cursor and filters by type', async ({ page }) => {
  await login(page, ACCOUNTS.admin.email);
  const created = await page.request.post('/api/projects', {
    data: { name: unique('E2E 动态') },
  });
  expect(created.status()).toBe(201);
  const project = (await created.json()) as { id: string; version: number };

  try {
    let version = project.version;
    for (let index = 0; index < 22; index++) {
      const response = await page.request.patch(`/api/projects/${project.id}`, {
        data: { name: `E2E 动态 v${index + 1}`, version },
      });
      expect(response.ok()).toBeTruthy();
      version = ((await response.json()) as { version: number }).version;
    }

    await page.goto('/activity');
    const items = page.locator('.activity-item');
    await expect(items).toHaveCount(20);
    const loadMore = page.getByRole('button', { name: '加载更早的动态' });
    await expect(loadMore).toBeVisible();
    await loadMore.click();
    await expect(items.first()).toBeVisible();
    await expect.poll(() => items.count()).toBeGreaterThan(20);

    await page.getByRole('button', { name: '创建项目', exact: true }).click();
    await expect(page).toHaveURL(/type=project.created/);
    await expect(items.first()).toContainText('创建');
  } finally {
    await page.request.delete(`/api/projects/${project.id}`);
  }
});

test('manager has a read-only directory while admin creates a member', async ({ page }) => {
  await login(page, ACCOUNTS.manager.email);
  await page.goto('/users');
  await expect(page.getByRole('heading', { name: '成员管理' })).toBeVisible();
  await expect(page.getByRole('button', { name: '新建成员' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '编辑' })).toHaveCount(0);
  await logout(page);

  await login(page, ACCOUNTS.admin.email);
  await page.goto('/users');
  await page.getByRole('button', { name: '新建成员' }).click();
  await page.locator('#user-name').fill('E2E 成员');
  await page.locator('#user-email').fill(MEMBER_EMAIL);
  await page.locator('#user-role').selectOption({ label: '只读成员' });
  await page.locator('#user-password').fill(PASSWORD);
  await page.getByRole('button', { name: '创建成员' }).click();
  await expect(page.getByRole('status')).toContainText('已创建成员');
  await expect(page.locator('.users-table')).toContainText(MEMBER_EMAIL);
});

test('settings update the profile and rotate the password', async ({ page }) => {
  await login(page, MEMBER_EMAIL);
  await page.goto('/settings');
  await expect(page.getByRole('heading', { name: '账户设置' })).toBeVisible();

  await page.getByLabel('姓名').fill('E2E 成员改');
  await page.getByRole('button', { name: '保存资料' }).click();
  await expect(page.getByRole('status')).toContainText('个人资料已更新');
  await expect(page.locator('.sidebar-account strong')).toHaveText('E2E 成员改');

  await page.getByRole('button', { name: '登录与安全' }).click();
  await page.locator('#password-current').fill(PASSWORD);
  await page.locator('#password-new').fill(NEW_PASSWORD);
  await page.locator('#password-confirm').fill(NEW_PASSWORD);
  await page.getByRole('button', { name: '更新密码' }).click();
  await expect(page.getByRole('status')).toContainText('密码已更新');

  await logout(page);
  await login(page, MEMBER_EMAIL, NEW_PASSWORD);
  await expect(page.locator('.sidebar-account strong')).toHaveText('E2E 成员改');
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('E2E 成员改');
});

test('SSE replays missed activity through Last-Event-ID', async ({ page }) => {
  await login(page, ACCOUNTS.admin.email);
  await expect(page.locator('.connection-pill')).toHaveText(/Live/);

  const latest = await page.request.get('/api/activities?limit=1');
  const cursor =
    ((await latest.json()) as { activities: { seq: number }[] }).activities[0]?.seq ?? 0;

  const name = unique('E2E 补发');
  const created = await page.request.post('/api/projects', { data: { name } });
  expect(created.status()).toBe(201);
  const project = (await created.json()) as { id: string };

  try {
    const replay = await page.evaluate(async (lastEventId) => {
      const controller = new AbortController();
      const response = await fetch('/api/events', {
        headers: { 'Last-Event-ID': String(lastEventId) },
        signal: controller.signal,
      });
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      try {
        while (!buffer.includes('event: activity')) {
          const chunk = await reader.read();
          if (chunk.done) break;
          buffer += decoder.decode(chunk.value, { stream: true });
        }
        const block = buffer.split('\n\n').find((part) => part.includes('event: activity'));
        if (!block) return null;
        const data = block
          .split('\n')
          .filter((line) => line.startsWith('data: '))
          .map((line) => line.slice(6))
          .join('\n');
        return JSON.parse(data) as { message?: string; activity?: { message?: string } };
      } finally {
        controller.abort();
      }
    }, cursor);

    expect(replay).not.toBeNull();
    expect(JSON.stringify(replay)).toContain(name);
  } finally {
    await page.request.delete(`/api/projects/${project.id}`);
  }
});

test('typing in the edit dialog is visible to other project viewers', async ({ page, browser }) => {
  const managerContext = await browser.newContext();
  const managerPage = await managerContext.newPage();
  try {
    await login(managerPage, ACCOUNTS.manager.email);
    await managerPage.goto('/projects');
    const href = await managerPage
      .locator('.project-card .project-name')
      .first()
      .getAttribute('href');
    expect(href).toBeTruthy();
    await managerPage.goto(href ?? '');
    await expect(managerPage.getByRole('heading', { level: 1 })).toBeVisible();
    await managerPage.waitForTimeout(500);

    await login(page, ACCOUNTS.admin.email);
    await page.goto(href ?? '');
    await page.getByRole('button', { name: '编辑项目' }).click();
    await page.getByLabel('描述').fill('正在更新项目范围…');

    await expect(managerPage.locator('.typing-indicator')).toContainText(
      `${ACCOUNTS.admin.name} 正在编辑项目`,
      { timeout: 5_000 },
    );

    await page.getByRole('button', { name: '取消' }).click();
    await expect(managerPage.locator('.typing-indicator')).toBeHidden();
  } finally {
    await managerContext.close();
  }
});

test('modal traps keyboard focus and restores it to the trigger', async ({ page }) => {
  await login(page, ACCOUNTS.admin.email);
  await page.goto('/projects');

  const trigger = page.getByRole('button', { name: '新建项目' });
  await trigger.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(page.getByLabel('项目名称')).toBeFocused();

  await page.keyboard.press('Shift+Tab');
  await expect(page.getByRole('button', { name: '关闭' })).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(page.getByRole('button', { name: '创建项目' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: '关闭' })).toBeFocused();

  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test('account menu closes on Escape and returns focus', async ({ page }) => {
  await login(page, ACCOUNTS.admin.email);

  const trigger = page.locator('.account-button');
  await trigger.click();
  await expect(page.locator('#account-menu')).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(page.locator('#account-menu')).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test('mobile layout avoids horizontal overflow and console errors', async ({ page }) => {
  const errors: string[] = [];
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page, ACCOUNTS.viewer.email);
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));

  for (const path of ['/', '/analytics', '/projects', '/activity', '/settings']) {
    await page.goto(path);
    await expect(page.locator('.shell-main')).toBeVisible();
    await expect(page.locator('.skeleton'))
      .toHaveCount(0, { timeout: 10_000 })
      .catch(() => undefined);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, `horizontal overflow on ${path}`).toBeLessThanOrEqual(1);
  }

  expect(errors).toEqual([]);
});

test('CSV export downloads and CSV import creates a visible project', async ({ page }) => {
  await login(page, ACCOUNTS.admin.email);
  await page.goto('/projects');

  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('link', { name: '导出 CSV' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('clay-projects.csv');
  expect(await download.failure()).toBeNull();

  const name = unique('E2E 导入');
  const csv = `name,description,status,progress,startDate,dueDate\n"${name}","含, 逗号与\n换行",进行中,35,2026-01-01,2026-03-01\n`;
  await page.locator('input[type="file"]').setInputFiles({
    name: 'import.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(csv, 'utf8'),
  });
  const preview = page.getByRole('dialog', { name: '导入预览' });
  await expect(preview).toBeVisible();
  await expect(preview).toContainText('待导入 1');
  await expect(preview.getByRole('cell', { name })).toBeVisible();
  await preview.getByRole('button', { name: '确认导入' }).click();
  await expect(page.getByRole('status')).toContainText('导入完成：新增 1 个，跳过 0 行');

  await page.getByLabel('搜索项目').fill(name);
  await expect(page.locator('.project-card', { hasText: name })).toBeVisible();
});

test('expired sessions leave the live view and return to login', async ({ page }) => {
  await login(page, ACCOUNTS.viewer.email);
  await expect(page.locator('.connection-pill')).toHaveText(/Live/);

  const logout = await page.request.post('/api/auth/logout');
  expect(logout.ok()).toBeTruthy();

  await expect(page).toHaveURL(/\/login$/, { timeout: 20_000 });
  await expect(page.getByRole('heading', { name: '登录工作台' })).toBeVisible();
});

async function seriousViolations(
  page: Page,
): Promise<Array<{ id: string; impact?: string | null }>> {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.evaluate(async () => {
    await Promise.all(
      document.getAnimations().map((animation) => animation.finished.catch(() => undefined)),
    );
  });
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  return results.violations.filter(
    (item) => item.impact === 'serious' || item.impact === 'critical',
  );
}

test('key pages have no serious accessibility violations', async ({ page }) => {
  await page.goto('/login');
  await expect(page.getByRole('heading', { name: '登录工作台' })).toBeVisible();
  const loginSerious = await seriousViolations(page);
  expect(loginSerious, `/login: ${JSON.stringify(loginSerious, null, 2)}`).toEqual([]);

  await login(page, ACCOUNTS.admin.email);
  for (const path of [
    '/',
    '/projects',
    '/settings',
    '/settings?tab=security',
    '/settings?tab=notifications',
    '/settings?tab=integrations',
    '/settings?tab=workspace',
  ]) {
    await page.goto(path);
    await expect(page.locator('.shell-main')).toBeVisible();
    const serious = await seriousViolations(page);
    expect(serious, `${path}: ${JSON.stringify(serious, null, 2)}`).toEqual([]);
  }
});

test('deleting a project can be undone and charts export CSV and PNG', async ({ page }) => {
  await page.goto('/login');
  const api = await adminApi(page);
  const name = unique('E2E 撤销');
  const created = await api.post('/api/projects', {
    data: { name, status: 'active', progress: 10 },
  });
  expect(created.ok()).toBeTruthy();
  const project = (await created.json()) as { id: string };
  await api.dispose();

  await login(page, ACCOUNTS.admin.email);
  await page.goto(`/projects/${project.id}`);
  await page.getByRole('button', { name: '删除', exact: true }).click();
  await page.getByRole('button', { name: '确认删除' }).click();
  await expect(page).toHaveURL(/\/projects$/);

  const undoToast = page.locator('.toast', { hasText: '已删除' });
  await expect(undoToast).toBeVisible();
  await undoToast.getByRole('button', { name: '撤销' }).click();
  await expect(page.locator('.toast', { hasText: '已恢复' })).toBeVisible();

  await page.getByLabel('搜索项目').fill(name);
  await expect(page.locator('.project-card', { hasText: name })).toBeVisible();

  await page.goto('/');
  const csvPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出收入趋势数据为 CSV' }).click();
  const csvDownload = await csvPromise;
  expect(csvDownload.suggestedFilename()).toBe('收入-趋势.csv');
  expect(await csvDownload.failure()).toBeNull();

  const pngPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出收入趋势为 PNG 图片' }).click();
  const pngDownload = await pngPromise;
  expect(pngDownload.suggestedFilename()).toBe('收入-趋势.png');
  expect(await pngDownload.failure()).toBeNull();

  const channelPngPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出渠道份额图为 PNG 图片' }).click();
  const channelDownload = await channelPngPromise;
  expect(channelDownload.suggestedFilename()).toBe('渠道份额.png');
  expect(await channelDownload.failure()).toBeNull();
  const channelPath = await channelDownload.path();
  expect(channelPath).toBeTruthy();
  const channelPng = readFileSync(channelPath!);
  expect(channelPng.subarray(1, 4).toString()).toBe('PNG');
  // The exported canvas includes the center total and legend rows below the ring.
  expect(channelPng.readUInt32BE(20)).toBeGreaterThan(500);
});

test('audit center filters project actions, exports CSV and stays admin-only', async ({ page }) => {
  await login(page, ACCOUNTS.admin.email);
  const api = await adminApi(page);
  const name = unique('E2E 审计项目');
  const created = await api.post('/api/projects', { data: { name, status: 'active' } });
  expect(created.ok()).toBeTruthy();
  const project = (await created.json()) as { id: string; version: number };
  const patched = await api.patch(`/api/projects/${project.id}`, {
    data: { description: '审计更新', version: project.version },
  });
  expect(patched.ok()).toBeTruthy();

  await page.goto('/audit');
  await expect(page.getByRole('heading', { level: 1, name: '审计中心' })).toBeVisible();
  await page.getByLabel('搜索审计日志').fill(name);
  const createdRow = page.locator('.audit-row[data-action="project.created"]', { hasText: name });
  await expect(createdRow).toBeVisible();
  await expect(createdRow).toContainText('创建项目');
  await expect(
    page.locator('.audit-row[data-action="project.updated"]', { hasText: name }),
  ).toBeVisible();

  await page.getByLabel('按操作筛选').selectOption('project.updated');
  await expect(page.locator('.audit-row[data-action="project.created"]')).toHaveCount(0);
  const updatedRow = page.locator('.audit-row[data-action="project.updated"]', { hasText: name });
  await expect(updatedRow).toBeVisible();
  await updatedRow.locator('details summary').click();
  await expect(updatedRow.locator('pre')).toContainText(project.id);

  const csvResponse = await page.request.get(
    `/api/audit/export.csv?action=project.updated&q=${encodeURIComponent(name)}`,
  );
  expect(csvResponse.ok()).toBeTruthy();
  expect(csvResponse.headers()['content-type']).toContain('text/csv');
  const csv = await csvResponse.text();
  expect(csv).toContain('project.updated');
  expect(csv).toContain(name);
  expect(csv).not.toContain('project.created');

  await page.getByRole('button', { name: '清理过期日志' }).click();
  const dialog = page.getByRole('dialog', { name: '清理过期审计日志？' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: '清理日志' }).click();
  await expect(page.getByRole('status')).toContainText('已清理');

  expect((await api.delete(`/api/projects/${project.id}`)).ok()).toBeTruthy();
  await api.dispose();

  await logout(page);
  await login(page, ACCOUNTS.viewer.email);
  await page.goto('/audit');
  await expect(page.getByRole('heading', { level: 1, name: '没有访问权限' })).toBeVisible();
});
