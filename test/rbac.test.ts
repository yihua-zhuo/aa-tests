import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Hono } from 'hono';
import type { Project, ProjectListResult, Role } from '../shared/types.ts';
import type { AppEnv } from '../src/app-env.ts';
import {
  DEMO,
  getJson,
  login,
  multipart,
  PASSWORD,
  sendJson,
  testApp,
  testStore,
} from './helpers.ts';

type Ctx = { app: Hono<AppEnv>; cookies: Record<Role, string> };

async function setup(): Promise<Ctx & { store: ReturnType<typeof testStore> }> {
  const store = testStore();
  const { app } = testApp(store);
  const cookies = {} as Record<Role, string>;
  for (const role of ['admin', 'manager', 'pm', 'viewer'] as const) {
    cookies[role] = await login(app, DEMO[role].email, PASSWORD);
  }
  return { store, app, cookies };
}

async function listProjects(app: Hono<AppEnv>, cookie: string): Promise<ProjectListResult> {
  return getJson<ProjectListResult>(app, cookie, '/api/projects?pageSize=50');
}

function byName(projects: Project[], name: string): Project {
  const project = projects.find((item) => item.name === name);
  assert.ok(project, `expected project ${name}`);
  return project;
}

test('project lists are scoped by role', async () => {
  const { store, app, cookies } = await setup();
  try {
    const admin = await listProjects(app, cookies.admin);
    const manager = await listProjects(app, cookies.manager);
    const pm = await listProjects(app, cookies.pm);
    const viewer = await listProjects(app, cookies.viewer);

    assert.equal(admin.total, 8);
    assert.equal(manager.total, 8);
    assert.equal(pm.total, 3);
    assert.equal(viewer.total, 5);

    assert.deepEqual(
      pm.projects.map((project) => project.name).sort(),
      ['Q4 增长实验', '客户数据中台', '移动端 2.0'].sort(),
    );
    assert.deepEqual(
      viewer.projects.map((project) => project.name).sort(),
      ['Q4 增长实验', '帮助中心改版', '官网品牌重塑', '年度品牌视频', '移动端 2.0'].sort(),
    );

    assert.equal(admin.counts.all, 8);
    assert.equal(pm.counts.all, 3);
    assert.equal(viewer.counts.all, 5);
  } finally {
    store.close();
  }
});

test('viewers cannot mutate projects or import', async () => {
  const { store, app, cookies } = await setup();
  try {
    const create = await sendJson(app, cookies.viewer, 'POST', '/api/projects', {
      name: '只读成员的项目',
    });
    assert.equal(create.status, 403);

    const own = byName((await listProjects(app, cookies.viewer)).projects, '帮助中心改版');
    const patch = await sendJson(app, cookies.viewer, 'PATCH', `/api/projects/${own.id}`, {
      version: own.version,
      name: '改名尝试',
    });
    assert.equal(patch.status, 403);

    const remove = await app.request(`/api/projects/${own.id}`, {
      method: 'DELETE',
      headers: { cookie: cookies.viewer },
    });
    assert.equal(remove.status, 403);

    const form = multipart(new File(['name\n只读导入'], 'viewer.csv', { type: 'text/csv' }));
    const imported = await app.request('/api/projects/import', {
      method: 'POST',
      headers: { cookie: cookies.viewer },
      body: form,
    });
    assert.equal(imported.status, 403);
  } finally {
    store.close();
  }
});

test('project managers only own their assignments and can edit them', async () => {
  const { store, app, cookies } = await setup();
  try {
    const created = await sendJson<Project>(app, cookies.pm, 'POST', '/api/projects', {
      name: 'PM 自己的项目',
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.ownerId, DEMO.pm.id);

    const assigned = await sendJson(app, cookies.pm, 'POST', '/api/projects', {
      name: '越权归属',
      ownerId: DEMO.admin.id,
    });
    assert.equal(assigned.status, 403);

    const shared = byName((await listProjects(app, cookies.pm)).projects, 'Q4 增长实验');
    const denied = await sendJson(app, cookies.pm, 'PATCH', `/api/projects/${shared.id}`, {
      version: shared.version,
      progress: 50,
    });
    assert.equal(denied.status, 403, 'membership allows viewing but not editing');

    const own = byName((await listProjects(app, cookies.pm)).projects, '客户数据中台');
    const updated = await sendJson<Project>(app, cookies.pm, 'PATCH', `/api/projects/${own.id}`, {
      version: own.version,
      progress: 20,
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.progress, 20);
    assert.equal(updated.body.version, own.version + 1);
  } finally {
    store.close();
  }
});

test('invisible projects are indistinguishable from missing ones', async () => {
  const { store, app, cookies } = await setup();
  try {
    const adminProjects = (await listProjects(app, cookies.admin)).projects;
    const hiddenFromPm = byName(adminProjects, '官网品牌重塑');
    const hiddenFromViewer = byName(adminProjects, '客户数据中台');

    const pmGet = await app.request(`/api/projects/${hiddenFromPm.id}`, {
      headers: { cookie: cookies.pm },
    });
    assert.equal(pmGet.status, 404);
    const pmPatch = await sendJson(app, cookies.pm, 'PATCH', `/api/projects/${hiddenFromPm.id}`, {
      version: hiddenFromPm.version,
      name: '泄漏',
    });
    assert.equal(pmPatch.status, 404);

    const viewerGet = await app.request(`/api/projects/${hiddenFromViewer.id}`, {
      headers: { cookie: cookies.viewer },
    });
    assert.equal(viewerGet.status, 404);

    const visibleToPm = byName(adminProjects, '客户数据中台');
    assert.equal(
      (await app.request(`/api/projects/${visibleToPm.id}`, { headers: { cookie: cookies.pm } }))
        .status,
      200,
    );
  } finally {
    store.close();
  }
});

test('the user directory is limited to admins and managers', async () => {
  const { store, app, cookies } = await setup();
  try {
    assert.equal(
      (await app.request('/api/users', { headers: { cookie: cookies.viewer } })).status,
      403,
    );
    assert.equal(
      (await app.request('/api/users', { headers: { cookie: cookies.pm } })).status,
      403,
    );
    assert.equal(
      (await app.request('/api/users', { headers: { cookie: cookies.manager } })).status,
      200,
    );
    assert.equal(
      (await app.request('/api/users', { headers: { cookie: cookies.admin } })).status,
      200,
    );

    const options = await getJson<{ users: Record<string, unknown>[] }>(
      app,
      cookies.viewer,
      '/api/users/options',
    );
    assert.equal(options.users.length, 4);
    for (const option of options.users) {
      assert.deepEqual(Object.keys(option).sort(), ['id', 'name']);
    }
  } finally {
    store.close();
  }
});

test('search results never cross the visibility boundary', async () => {
  const { store, app, cookies } = await setup();
  try {
    type SearchResult = {
      projects: { name: string }[];
      activities: { message: string }[];
      users: { email?: string }[];
    };
    const pm = await getJson<SearchResult>(app, cookies.pm, '/api/search?q=%E5%93%81%E7%89%8C');
    assert.deepEqual(pm.projects, []);
    assert.deepEqual(pm.users, [], 'pm cannot search the user directory');

    const viewer = await getJson<SearchResult>(
      app,
      cookies.viewer,
      '/api/search?q=%E5%93%81%E7%89%8C',
    );
    assert.deepEqual(
      viewer.projects.map((project) => project.name).sort(),
      ['官网品牌重塑', '年度品牌视频'].sort(),
    );

    const admin = await getJson<SearchResult>(app, cookies.admin, '/api/search?q=pulse.demo');
    assert.equal(admin.users.length, 4);
  } finally {
    store.close();
  }
});

test('dashboard and CSV exports use the same project scope', async () => {
  const { store, app, cookies } = await setup();
  try {
    for (const role of ['admin', 'manager', 'pm', 'viewer'] as const) {
      const summary = await getJson<{ projects: { total: number }; activities: unknown[] }>(
        app,
        cookies[role],
        '/api/dashboard/summary?range=7d',
      );
      const expected = role === 'pm' ? 3 : role === 'viewer' ? 5 : 8;
      assert.equal(summary.projects.total, expected, `${role} dashboard scope`);
    }

    for (const [role, rows] of [
      ['admin', 8],
      ['manager', 8],
      ['pm', 3],
      ['viewer', 5],
    ] as const) {
      const res = await app.request('/api/projects/export.csv', {
        headers: { cookie: cookies[role] },
      });
      assert.equal(res.status, 200);
      const text = await res.text();
      const lines = text.split('\n').filter(Boolean);
      assert.equal(lines.length, rows + 1, `${role} export should contain ${rows} rows`);
    }
  } finally {
    store.close();
  }
});

test('managers can delete any project while PMs cannot delete at all', async () => {
  const { store, app, cookies } = await setup();
  try {
    const created = await sendJson<Project>(app, cookies.pm, 'POST', '/api/projects', {
      name: '待删除项目',
    });
    assert.equal(created.status, 201);

    const pmDelete = await app.request(`/api/projects/${created.body.id}`, {
      method: 'DELETE',
      headers: { cookie: cookies.pm },
    });
    assert.equal(pmDelete.status, 403);

    const managerDelete = await app.request(`/api/projects/${created.body.id}`, {
      method: 'DELETE',
      headers: { cookie: cookies.manager },
    });
    assert.equal(managerDelete.status, 204);

    const gone = await app.request(`/api/projects/${created.body.id}`, {
      headers: { cookie: cookies.admin },
    });
    assert.equal(gone.status, 410, 'soft-deleted projects report a tombstone');
  } finally {
    store.close();
  }
});
