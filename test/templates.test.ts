import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Hono } from 'hono';
import { type ProjectTemplate, templateTaskCount } from '../shared/templates.ts';
import type {
  ActivityPage,
  ProjectDetail,
  ProjectListResult,
  ProjectScaffoldResult,
  ProjectTasks,
  Task,
} from '../shared/types.ts';
import type { AppEnv } from '../src/app-env.ts';
import { DEMO, getJson, login, sendJson, testApp, testStore } from './helpers.ts';

async function setup(
  demo = false,
): Promise<{ store: ReturnType<typeof testStore>; app: Hono<AppEnv>; cookie: string }> {
  const store = testStore({ demo });
  const { app } = testApp(store);
  const cookie = await login(app, DEMO.admin.email);
  return { store, app, cookie };
}

async function createProject(
  app: Hono<AppEnv>,
  cookie: string,
  body: Record<string, unknown>,
): Promise<ProjectDetail> {
  const result = await sendJson<ProjectDetail>(app, cookie, 'POST', '/api/projects', body);
  assert.equal(result.status, 201, JSON.stringify(result.body));
  return result.body;
}

async function createTask(
  app: Hono<AppEnv>,
  cookie: string,
  projectId: string,
  body: Record<string, unknown>,
): Promise<Task> {
  const result = await sendJson<Task>(
    app,
    cookie,
    'POST',
    `/api/projects/${projectId}/tasks`,
    body,
  );
  assert.equal(result.status, 201, JSON.stringify(result.body));
  return result.body;
}

test('built-in templates create milestones and nested tasks with shifted dates', async () => {
  const { store, app, cookie } = await setup();
  try {
    const catalog = await getJson<{ templates: ProjectTemplate[] }>(
      app,
      cookie,
      '/api/project-templates',
    );
    assert.equal(catalog.templates.length, 4);
    const template = catalog.templates.find((item) => item.id === 'product-launch');
    assert.ok(template, 'product-launch template is available');
    assert.ok(template.milestones.length >= 3);

    const result = await sendJson<ProjectScaffoldResult>(
      app,
      cookie,
      'POST',
      '/api/projects/from-template',
      {
        templateId: template.id,
        name: 'E2E 发布计划',
        startDate: '2026-07-01',
        memberIds: [DEMO.manager.id],
      },
    );
    assert.equal(result.status, 201, JSON.stringify(result.body));
    const created = result.body.project;
    assert.equal(created.name, 'E2E 发布计划');
    assert.equal(created.status, 'planning');
    assert.equal(created.progress, 0);
    assert.equal(created.startDate, '2026-07-01');
    assert.equal(created.dueDate, '2026-08-15');
    assert.deepEqual(
      created.members.map((member) => member.id),
      [DEMO.manager.id],
    );
    assert.equal(result.body.tasks, templateTaskCount(template));
    assert.equal(result.body.milestones, template.milestones.length);

    const tasks = await getJson<ProjectTasks>(app, cookie, `/api/projects/${created.id}/tasks`);
    assert.equal(tasks.tasks.length, templateTaskCount(template));
    assert.equal(tasks.milestones.length, template.milestones.length);
    assert.equal(tasks.progress, 0);
    assert.ok(tasks.tasks.every((task) => task.status === 'todo' && task.assigneeId === null));

    const kickoff = tasks.tasks.find((task) => task.title === '项目启动会');
    assert.ok(kickoff);
    const children = tasks.tasks.filter((task) => task.parentId === kickoff.id);
    assert.equal(children.length, 2);
    assert.equal(new Set(tasks.tasks.map((task) => task.id)).size, tasks.tasks.length);

    const discovery = tasks.milestones.find((milestone) => milestone.title === '调研与立项');
    assert.ok(discovery);
    assert.equal(discovery.dueDate, '2026-07-08');
    assert.ok(children.every((task) => task.milestoneId === kickoff.milestoneId));

    const detail = await getJson<ProjectDetail>(app, cookie, `/api/projects/${created.id}`);
    assert.equal(detail.progress, 0);

    const activities = await getJson<ActivityPage>(app, cookie, '/api/activities?limit=30');
    const applied = activities.activities.find(
      (activity) =>
        activity.type === 'project.template_applied' && activity.project?.id === created.id,
    );
    assert.ok(applied);
    assert.equal(applied.meta?.templateId, template.id);
    assert.equal(applied.meta?.tasks, templateTaskCount(template));
  } finally {
    store.close();
  }
});

test('template creation validates permissions, template ids and dates', async () => {
  const { store, app } = await setup();
  try {
    const viewer = await login(app, DEMO.viewer.email);
    const denied = await sendJson(app, viewer, 'POST', '/api/projects/from-template', {
      templateId: 'team-sprint',
    });
    assert.equal(denied.status, 403);

    const pm = await login(app, DEMO.pm.email);
    const escalated = await sendJson(app, pm, 'POST', '/api/projects/from-template', {
      templateId: 'team-sprint',
      ownerId: DEMO.admin.id,
    });
    assert.equal(escalated.status, 403);

    const pmsOwn = await sendJson<ProjectScaffoldResult>(
      app,
      pm,
      'POST',
      '/api/projects/from-template',
      {
        templateId: 'team-sprint',
        name: 'PM 迭代',
        startDate: '2026-07-06',
      },
    );
    assert.equal(pmsOwn.status, 201, JSON.stringify(pmsOwn.body));
    assert.equal(pmsOwn.body.project.ownerId, DEMO.pm.id);
    assert.equal(pmsOwn.body.project.dueDate, '2026-07-20');

    const unknown = await sendJson(app, pm, 'POST', '/api/projects/from-template', {
      templateId: 'missing-template',
    });
    assert.equal(unknown.status, 404);

    const invalidDate = await sendJson(app, pm, 'POST', '/api/projects/from-template', {
      templateId: 'team-sprint',
      startDate: '2026-13-40',
    });
    assert.equal(invalidDate.status, 400);

    const missingMember = await sendJson(app, pm, 'POST', '/api/projects/from-template', {
      templateId: 'team-sprint',
      memberIds: ['00000000-0000-4000-8000-000000000000'],
    });
    assert.equal(missingMember.status, 400);
  } finally {
    store.close();
  }
});

test('duplicating a project copies members, tasks and milestones with a date offset', async () => {
  const { store, app, cookie } = await setup();
  try {
    const source = await createProject(app, cookie, {
      name: '复制源项目',
      description: '用于复制验收',
      status: 'active',
      startDate: '2026-07-01',
      dueDate: '2026-08-01',
      memberIds: [DEMO.manager.id],
    });
    const milestone = await sendJson<{ id: string }>(
      app,
      cookie,
      'POST',
      `/api/projects/${source.id}/milestones`,
      { title: '阶段一', dueDate: '2026-07-10' },
    );
    assert.equal(milestone.status, 201);

    const parent = await createTask(app, cookie, source.id, {
      title: '父任务',
      priority: 'high',
      assigneeId: DEMO.manager.id,
      dueDate: '2026-07-05',
      milestoneId: milestone.body.id,
    });
    await createTask(app, cookie, source.id, {
      title: '子任务',
      parentId: parent.id,
      dueDate: '2026-07-06',
      milestoneId: milestone.body.id,
    });
    const done = await createTask(app, cookie, source.id, {
      title: '已完成任务',
      dueDate: '2026-07-07',
    });
    const completed = await sendJson<Task>(app, cookie, 'PATCH', `/api/tasks/${done.id}`, {
      status: 'done',
      version: done.version,
    });
    assert.equal(completed.status, 200);

    const result = await sendJson<ProjectScaffoldResult>(
      app,
      cookie,
      'POST',
      `/api/projects/${source.id}/duplicate`,
      {
        name: '复制副本',
        dateOffsetDays: 10,
        includeMembers: true,
        includeTasks: true,
      },
    );
    assert.equal(result.status, 201, JSON.stringify(result.body));
    const copy = result.body.project;
    assert.notEqual(copy.id, source.id);
    assert.equal(copy.name, '复制副本');
    assert.equal(copy.status, 'planning');
    assert.equal(copy.description, '用于复制验收');
    assert.equal(copy.startDate, '2026-07-11');
    assert.equal(copy.dueDate, '2026-08-11');
    assert.equal(copy.ownerId, DEMO.admin.id);
    assert.deepEqual(
      copy.members.map((member) => member.id),
      [DEMO.manager.id],
    );
    assert.equal(result.body.tasks, 3);
    assert.equal(result.body.milestones, 1);

    const copyTasks = await getJson<ProjectTasks>(app, cookie, `/api/projects/${copy.id}/tasks`);
    assert.equal(copyTasks.tasks.length, 3);
    assert.equal(copyTasks.milestones.length, 1);
    assert.equal(copyTasks.progress, 50, 'leaf done state is preserved and recomputed');

    const copiedMilestone = copyTasks.milestones[0];
    assert.ok(copiedMilestone);
    assert.notEqual(copiedMilestone.id, milestone.body.id);
    assert.equal(copiedMilestone.dueDate, '2026-07-20');

    const copiedParent = copyTasks.tasks.find((task) => task.title === '父任务');
    const copiedChild = copyTasks.tasks.find((task) => task.title === '子任务');
    const copiedDone = copyTasks.tasks.find((task) => task.title === '已完成任务');
    assert.ok(copiedParent && copiedChild && copiedDone);
    assert.notEqual(copiedParent.id, parent.id);
    assert.equal(copiedChild.parentId, copiedParent.id);
    assert.equal(copiedParent.milestoneId, copiedMilestone.id);
    assert.equal(copiedChild.milestoneId, copiedMilestone.id);
    assert.equal(copiedParent.assigneeId, DEMO.manager.id);
    assert.equal(copiedParent.priority, 'high');
    assert.equal(copiedParent.dueDate, '2026-07-15');
    assert.equal(copiedChild.dueDate, '2026-07-16');
    assert.equal(copiedDone.status, 'done');
    assert.equal(copiedDone.dueDate, '2026-07-17');

    const activities = await getJson<ActivityPage>(app, cookie, '/api/activities?limit=30');
    const duplicated = activities.activities.find(
      (activity) => activity.type === 'project.duplicated' && activity.project?.id === copy.id,
    );
    assert.ok(duplicated);
    assert.equal(duplicated.meta?.sourceId, source.id);
    assert.equal(duplicated.meta?.offsetDays, 10);

    const bare = await sendJson<ProjectScaffoldResult>(
      app,
      cookie,
      'POST',
      `/api/projects/${source.id}/duplicate`,
      {
        dateOffsetDays: -1,
        includeMembers: false,
        includeTasks: false,
      },
    );
    assert.equal(bare.status, 201, JSON.stringify(bare.body));
    assert.equal(bare.body.project.name, '复制源项目 副本');
    assert.equal(bare.body.project.startDate, '2026-06-30');
    assert.deepEqual(bare.body.project.members, []);
    assert.equal(bare.body.tasks, 0);
    assert.equal(bare.body.milestones, 0);
    const bareTasks = await getJson<ProjectTasks>(
      app,
      cookie,
      `/api/projects/${bare.body.project.id}/tasks`,
    );
    assert.equal(bareTasks.tasks.length, 0);
    assert.equal(bareTasks.milestones.length, 0);
  } finally {
    store.close();
  }
});

test('duplicate honours project permissions and archived projects restore in one step', async () => {
  const { store, app, cookie } = await setup();
  try {
    const project = await createProject(app, cookie, {
      name: '权限与归档',
      memberIds: [DEMO.pm.id],
    });

    const pm = await login(app, DEMO.pm.email);
    const denied = await sendJson(app, pm, 'POST', `/api/projects/${project.id}/duplicate`, {
      name: '越权副本',
    });
    assert.equal(denied.status, 403);

    const missing = await sendJson(app, cookie, 'POST', '/api/projects/missing/duplicate', {});
    assert.equal(missing.status, 404);

    const archived = await sendJson<ProjectDetail>(
      app,
      cookie,
      'PATCH',
      `/api/projects/${project.id}`,
      { status: 'archived', version: project.version },
    );
    assert.equal(archived.status, 200);
    assert.equal(archived.body.status, 'archived');

    const archivedList = await getJson<ProjectListResult>(
      app,
      cookie,
      '/api/projects?status=archived',
    );
    assert.ok(archivedList.projects.some((item) => item.id === project.id));

    const restored = await sendJson<ProjectDetail>(
      app,
      cookie,
      'PATCH',
      `/api/projects/${project.id}`,
      { status: 'active', version: archived.body.version },
    );
    assert.equal(restored.status, 200);
    assert.equal(restored.body.status, 'active');

    const stillArchived = await getJson<ProjectListResult>(
      app,
      cookie,
      '/api/projects?status=archived',
    );
    assert.ok(!stillArchived.projects.some((item) => item.id === project.id));

    const activities = await getJson<ActivityPage>(app, cookie, '/api/activities?limit=30');
    const types = activities.activities
      .filter((activity) => activity.project?.id === project.id)
      .map((activity) => activity.type);
    assert.ok(types.includes('project.archived'));
    assert.ok(types.includes('project.restored'));
  } finally {
    store.close();
  }
});
