import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Hono } from 'hono';
import type {
  ActivityPage,
  Milestone,
  ProjectDetail,
  ProjectTasks,
  Task,
} from '../shared/types.ts';
import type { AppEnv } from '../src/app-env.ts';
import { DEMO, getJson, login, sendJson, testApp, testStore } from './helpers.ts';

async function setup(
  demo = true,
): Promise<{ store: ReturnType<typeof testStore>; app: Hono<AppEnv>; cookie: string }> {
  const store = testStore({ demo });
  const { app } = testApp(store);
  const cookie = await login(app, DEMO.admin.email);
  return { store, app, cookie };
}

async function createProject(
  app: Hono<AppEnv>,
  cookie: string,
  name: string,
  extra: Record<string, unknown> = {},
): Promise<ProjectDetail> {
  const result = await sendJson<ProjectDetail>(app, cookie, 'POST', '/api/projects', {
    name,
    ...extra,
  });
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

test('tasks roll up leaf progress and record activity', async () => {
  const { store, app, cookie } = await setup(false);
  try {
    const project = await createProject(app, cookie, '任务与进度');
    const parent = await createTask(app, cookie, project.id, {
      title: '设计阶段',
      priority: 'high',
      assigneeId: DEMO.admin.id,
      dueDate: '2027-03-01',
    });
    assert.equal(parent.status, 'todo');
    assert.equal(parent.assigneeName, DEMO.admin.name);
    assert.equal(parent.priority, 'high');

    const child = await createTask(app, cookie, project.id, {
      title: '完成视觉稿',
      parentId: parent.id,
    });
    assert.equal(child.parentId, parent.id);

    const other = await createTask(app, cookie, project.id, { title: '技术方案' });

    let tasks = await getJson<ProjectTasks>(app, cookie, `/api/projects/${project.id}/tasks`);
    assert.equal(tasks.tasks.length, 3);
    assert.equal(tasks.progress, 0);

    const done = await sendJson<Task>(app, cookie, 'PATCH', `/api/tasks/${child.id}`, {
      status: 'done',
      version: child.version,
    });
    assert.equal(done.status, 200);
    assert.equal(done.body.status, 'done');
    assert.ok(done.body.completedAt);

    tasks = await getJson<ProjectTasks>(app, cookie, `/api/projects/${project.id}/tasks`);
    assert.equal(tasks.progress, 50, 'only leaf tasks count toward progress');

    const detail = await getJson<ProjectDetail>(app, cookie, `/api/projects/${project.id}`);
    assert.equal(detail.progress, 50);

    const activities = await getJson<ActivityPage>(app, cookie, '/api/activities?limit=30');
    const types = activities.activities.map((activity) => activity.type);
    assert.ok(types.includes('task.created'));
    assert.ok(types.includes('task.completed'));
    assert.ok(
      activities.activities.some(
        (activity) => activity.project?.id === project.id && activity.type === 'task.completed',
      ),
    );

    const removed = await app.request(`/api/tasks/${other.id}`, {
      method: 'DELETE',
      headers: { cookie },
    });
    assert.equal(removed.status, 204);
    tasks = await getJson<ProjectTasks>(app, cookie, `/api/projects/${project.id}/tasks`);
    assert.equal(tasks.progress, 100, 'remaining leaf task is done');

    await app.request(`/api/tasks/${parent.id}`, { method: 'DELETE', headers: { cookie } });
    tasks = await getJson<ProjectTasks>(app, cookie, `/api/projects/${project.id}/tasks`);
    assert.equal(tasks.tasks.length, 0, 'deleting a parent cascades its subtasks');
    assert.equal(tasks.progress, 0);
  } finally {
    store.close();
  }
});

test('stale task versions return 409 with the current task', async () => {
  const { store, app, cookie } = await setup(false);
  try {
    const project = await createProject(app, cookie, '并发任务');
    const task = await createTask(app, cookie, project.id, { title: '并发编辑' });

    const first = await sendJson<Task>(app, cookie, 'PATCH', `/api/tasks/${task.id}`, {
      status: 'in_progress',
      version: 1,
    });
    assert.equal(first.status, 200);
    assert.equal(first.body.version, 2);

    const second = await sendJson<{ error: string; current: Task }>(
      app,
      cookie,
      'PATCH',
      `/api/tasks/${task.id}`,
      { status: 'review', version: 1 },
    );
    assert.equal(second.status, 409);
    assert.equal(second.body.error, 'conflict');
    assert.equal(second.body.current.status, 'in_progress');
    assert.equal(second.body.current.version, 2);
  } finally {
    store.close();
  }
});

test('milestones group task counts and unlink cleanly on delete', async () => {
  const { store, app, cookie } = await setup(false);
  try {
    const project = await createProject(app, cookie, '里程碑项目');
    const created = await sendJson<Milestone>(
      app,
      cookie,
      'POST',
      `/api/projects/${project.id}/milestones`,
      { title: 'Beta 发布', dueDate: '2027-06-30' },
    );
    assert.equal(created.status, 201);
    assert.equal(created.body.taskCount, 0);

    const task = await createTask(app, cookie, project.id, {
      title: '发布检查',
      milestoneId: created.body.id,
    });

    let tasks = await getJson<ProjectTasks>(app, cookie, `/api/projects/${project.id}/tasks`);
    assert.equal(tasks.milestones.length, 1);
    assert.equal(tasks.milestones[0]?.taskCount, 1);
    assert.equal(tasks.milestones[0]?.doneCount, 0);

    await sendJson(app, cookie, 'PATCH', `/api/tasks/${task.id}`, {
      status: 'done',
      version: task.version,
    });
    tasks = await getJson<ProjectTasks>(app, cookie, `/api/projects/${project.id}/tasks`);
    assert.equal(tasks.milestones[0]?.doneCount, 1);

    const removed = await app.request(`/api/milestones/${created.body.id}`, {
      method: 'DELETE',
      headers: { cookie },
    });
    assert.equal(removed.status, 204);
    tasks = await getJson<ProjectTasks>(app, cookie, `/api/projects/${project.id}/tasks`);
    assert.equal(tasks.milestones.length, 0);
    assert.equal(tasks.tasks[0]?.milestoneId, null, 'tasks survive a milestone deletion');
  } finally {
    store.close();
  }
});

test('task references are validated across projects and multi-level nesting is allowed', async () => {
  const { store, app, cookie } = await setup(false);
  try {
    const project = await createProject(app, cookie, '校验项目');
    const other = await createProject(app, cookie, '另一个项目');
    const otherTask = await createTask(app, cookie, other.id, { title: '外部任务' });

    const crossParent = await sendJson(app, cookie, 'POST', `/api/projects/${project.id}/tasks`, {
      title: '跨项目子任务',
      parentId: otherTask.id,
    });
    assert.equal(crossParent.status, 400);

    const unknownAssignee = await sendJson(
      app,
      cookie,
      'POST',
      `/api/projects/${project.id}/tasks`,
      { title: '未知负责人', assigneeId: crypto.randomUUID() },
    );
    assert.equal(unknownAssignee.status, 400);

    const unknownMilestone = await sendJson(
      app,
      cookie,
      'POST',
      `/api/projects/${project.id}/tasks`,
      { title: '未知里程碑', milestoneId: crypto.randomUUID() },
    );
    assert.equal(unknownMilestone.status, 400);

    const parent = await createTask(app, cookie, project.id, { title: '父任务' });
    const child = await createTask(app, cookie, project.id, {
      title: '子任务',
      parentId: parent.id,
    });
    const nested = await sendJson<Task>(app, cookie, 'POST', `/api/projects/${project.id}/tasks`, {
      title: '孙任务',
      parentId: child.id,
    });
    assert.equal(nested.status, 201);
    assert.equal(nested.body.parentId, child.id);

    const promote = await sendJson(app, cookie, 'PATCH', `/api/tasks/${parent.id}`, {
      parentId: otherTask.id,
      version: parent.version,
    });
    assert.equal(promote.status, 400);
  } finally {
    store.close();
  }
});

test('task writes follow project visibility and ownership', async () => {
  const { store, app } = await setup(true);
  try {
    const admin = await login(app, DEMO.admin.email);
    const pm = await login(app, DEMO.pm.email);
    const viewer = await login(app, DEMO.viewer.email);
    const project = await createProject(app, admin, '管理员项目');

    const hidden = await app.request(`/api/projects/${project.id}/tasks`, {
      headers: { cookie: viewer },
    });
    assert.equal(hidden.status, 404, 'viewers cannot see projects they did not join');

    await sendJson(app, admin, 'PATCH', `/api/projects/${project.id}`, {
      memberIds: [DEMO.pm.id, DEMO.viewer.id],
      version: project.version,
    });

    const readable = await app.request(`/api/projects/${project.id}/tasks`, {
      headers: { cookie: viewer },
    });
    assert.equal(readable.status, 200, 'members can read tasks');

    const adminWrite = await sendJson<Task>(
      app,
      admin,
      'POST',
      `/api/projects/${project.id}/tasks`,
      { title: '管理员任务' },
    );
    assert.equal(adminWrite.status, 201);

    const viewerWrite = await sendJson(app, viewer, 'POST', `/api/projects/${project.id}/tasks`, {
      title: '只读成员任务',
    });
    assert.equal(viewerWrite.status, 403);

    const pmWrite = await sendJson(app, pm, 'POST', `/api/projects/${project.id}/tasks`, {
      title: '非负责人任务',
    });
    assert.equal(pmWrite.status, 403, 'project members cannot edit unless they own the project');

    const own = await createProject(app, pm, 'PM 自己的项目');
    const created = await sendJson<Task>(app, pm, 'POST', `/api/projects/${own.id}/tasks`, {
      title: 'PM 任务',
    });
    assert.equal(created.status, 201);
  } finally {
    store.close();
  }
});
