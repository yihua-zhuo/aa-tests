import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import type { Hono } from 'hono';
import type { AppEnv } from '../src/app-env.ts';
import { authHeaders, DEMO, login, testApp, testStore } from './helpers.ts';

async function json<T>(response: Response): Promise<T> {
  assert.ok(
    response.ok,
    `expected success, got ${response.status}: ${await response.clone().text()}`,
  );
  return (await response.json()) as T;
}

async function send(
  app: Hono<AppEnv>,
  cookie: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  return await app.request(path, {
    method,
    headers: authHeaders(cookie, { 'content-type': 'application/json' }),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe('workspaces, project visibility and custom roles', () => {
  const store = testStore();
  const { app } = testApp(store);

  after(() => store.close());

  test('legacy rows join the default workspace and sessions expose permissions', async () => {
    const admin = store.users.authByEmail(DEMO.admin.email);
    assert.ok(admin?.workspaceId);
    const users = store.users.list({ role: 'all', status: 'all', page: 1, pageSize: 50 });
    assert.ok(users.users.every((entry) => entry.workspaceId === admin.workspaceId));
    const projects = store.projects.list('admin', admin.id, {
      status: 'all',
      owner: 'all',
      sort: 'updated',
      page: 1,
      pageSize: 50,
    });
    assert.ok(projects.projects.every((project) => project.workspaceId === admin.workspaceId));

    const cookie = await login(app);
    const me = await json<{
      user: { workspaceId: string; workspaceName: string; permissions: string[] };
    }>(await app.request('/api/auth/me', { headers: authHeaders(cookie) }));
    assert.equal(me.user.workspaceId, admin.workspaceId);
    assert.ok(me.user.workspaceName.length > 0);
    assert.ok(me.user.permissions.includes('users.manage'));
  });

  test('custom roles add permissions without changing the base role', async () => {
    const adminCookie = await login(app);
    const created = await json<{
      role: { id: string; baseRole: string; permissions: string[] };
    }>(
      await send(app, adminCookie, 'POST', '/api/custom-roles', {
        name: '项目观察员',
        baseRole: 'viewer',
        permissions: ['projects.create', 'projects.view_all'],
      }),
    );
    assert.equal(created.role.baseRole, 'viewer');
    assert.deepEqual(created.role.permissions.sort(), ['projects.create', 'projects.view_all']);

    const email = `custom-${Date.now()}@clay.test`;
    const user = await json<{ id: string; role: string }>(
      await send(app, adminCookie, 'POST', '/api/users', {
        email,
        name: '自定义角色成员',
        role: 'viewer',
        password: 'Custom1234!',
        customRoleId: created.role.id,
      }),
    );
    assert.equal(user.role, 'viewer');

    const customCookie = await login(app, email, 'Custom1234!');
    const me = await json<{
      user: { permissions: string[]; customRole: { name: string } | null };
    }>(await app.request('/api/auth/me', { headers: authHeaders(customCookie) }));
    assert.ok(me.user.permissions.includes('projects.create'));
    assert.equal(me.user.customRole?.name, '项目观察员');

    const visible = await json<{ total: number }>(
      await app.request('/api/projects?pageSize=50', { headers: authHeaders(customCookie) }),
    );
    assert.ok(visible.total > 0, 'view_all should surface workspace projects');

    const createdProject = await json<{ name: string }>(
      await send(app, customCookie, 'POST', '/api/projects', {
        name: `自定义角色项目 ${Date.now()}`,
      }),
    );
    assert.ok(createdProject.name.startsWith('自定义角色项目'));

    await send(app, adminCookie, 'DELETE', `/api/custom-roles/${created.role.id}`);
    const refreshed = await json<{ user: { customRole: unknown; permissions: string[] } }>(
      await app.request('/api/auth/me', { headers: authHeaders(customCookie) }),
    );
    assert.equal(refreshed.user.customRole, null);
    assert.deepEqual(refreshed.user.permissions, []);
  });

  test('private projects stay hidden from managers while workspaces stay isolated', async () => {
    const adminCookie = await login(app);
    const managerCookie = await login(app, DEMO.manager.email);
    const name = `私有项目 ${Date.now()}`;
    const privateProject = await json<{ id: string; visibility: string }>(
      await send(app, adminCookie, 'POST', '/api/projects', { name, visibility: 'private' }),
    );
    assert.equal(privateProject.visibility, 'private');

    const adminList = await json<{ projects: { id: string }[] }>(
      await app.request('/api/projects?pageSize=50', { headers: authHeaders(adminCookie) }),
    );
    assert.ok(adminList.projects.some((project) => project.id === privateProject.id));

    const managerList = await json<{ projects: { id: string }[] }>(
      await app.request('/api/projects?pageSize=50', { headers: authHeaders(managerCookie) }),
    );
    assert.ok(!managerList.projects.some((project) => project.id === privateProject.id));
    const denied = await app.request(`/api/projects/${privateProject.id}`, {
      headers: authHeaders(managerCookie),
    });
    assert.equal(denied.status, 404);

    const workspace = await json<{ workspace: { id: string } }>(
      await send(app, adminCookie, 'POST', '/api/workspaces', {
        name: `隔离工作区 ${Date.now()}`,
      }),
    );
    const email = `workspace-${Date.now()}@clay.test`;
    await json<{ id: string }>(
      await send(app, adminCookie, 'POST', '/api/users', {
        email,
        name: '隔离成员',
        role: 'pm',
        password: 'Workspace1234!',
        workspaceId: workspace.workspace.id,
      }),
    );
    const memberCookie = await login(app, email, 'Workspace1234!');
    const memberProject = await json<{ id: string; workspaceId: string }>(
      await send(app, memberCookie, 'POST', '/api/projects', {
        name: `隔离项目 ${Date.now()}`,
      }),
    );
    assert.equal(memberProject.workspaceId, workspace.workspace.id);

    const defaultList = await json<{ projects: { id: string }[] }>(
      await app.request('/api/projects?pageSize=50', { headers: authHeaders(managerCookie) }),
    );
    assert.ok(!defaultList.projects.some((project) => project.id === memberProject.id));
    const memberList = await json<{ projects: { id: string }[] }>(
      await app.request('/api/projects?pageSize=50', { headers: authHeaders(memberCookie) }),
    );
    assert.ok(memberList.projects.some((project) => project.id === memberProject.id));
  });
});
