import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Hono } from 'hono';
import { auditActionLabel, auditCategory } from '../shared/audit.ts';
import type { AuditPage, ProjectDetail } from '../shared/types.ts';
import type { AppEnv } from '../src/app-env.ts';
import { DEMO, getJson, login, sendJson, testApp, testStore } from './helpers.ts';

async function createProject(
  app: Hono<AppEnv>,
  cookie: string,
  name: string,
): Promise<ProjectDetail> {
  const result = await sendJson<ProjectDetail>(app, cookie, 'POST', '/api/projects', { name });
  assert.equal(result.status, 201, JSON.stringify(result.body));
  return result.body;
}

test('project lifecycle is audited with filters, facets and CSV export', async () => {
  const store = testStore();
  const { app } = testApp(store);
  const cookie = await login(app);
  try {
    const name = '审计生命周期项目';
    const project = await createProject(app, cookie, name);
    const updated = await sendJson<ProjectDetail>(
      app,
      cookie,
      'PATCH',
      `/api/projects/${project.id}`,
      { description: '审计描述', version: project.version },
    );
    assert.equal(updated.status, 200, JSON.stringify(updated.body));
    assert.equal(
      (await sendJson(app, cookie, 'DELETE', `/api/projects/${project.id}`, {})).status,
      204,
    );
    assert.equal(
      (await sendJson(app, cookie, 'POST', `/api/projects/${project.id}/restore`, {})).status,
      200,
    );
    assert.equal(
      (await sendJson(app, cookie, 'DELETE', `/api/projects/${project.id}/purge`, {})).status,
      204,
    );

    const page = await getJson<AuditPage>(app, cookie, '/api/audit?pageSize=50');
    const actions = page.entries.map((entry) => entry.action);
    for (const action of [
      'project.created',
      'project.updated',
      'project.deleted',
      'project.restored',
      'project.purged',
    ]) {
      assert.ok(actions.includes(action), `expected ${action} in ${actions.join(', ')}`);
    }

    const created = page.entries.find((entry) => entry.action === 'project.created');
    assert.ok(created);
    assert.equal(created.target, name);
    assert.equal((created.detail as { projectId?: string }).projectId, project.id);
    assert.equal(created.actorName, DEMO.admin.name);
    assert.ok(page.retention.maxRows > 0);
    assert.ok(page.retention.days > 0);
    assert.ok(
      page.actions.some((entry) => entry.action === 'project.created' && entry.count >= 1),
      'facets count the created action',
    );
    assert.equal(auditCategory('project.created'), 'project');
    assert.equal(auditActionLabel('project.created'), '创建项目');

    const filtered = await getJson<AuditPage>(
      app,
      cookie,
      `/api/audit?q=${encodeURIComponent(name)}&action=project.updated`,
    );
    assert.equal(filtered.total, 1);
    const updatedEntry = filtered.entries[0];
    assert.ok(updatedEntry);
    assert.equal(updatedEntry.action, 'project.updated');
    const detail = updatedEntry.detail as { fields?: string[]; projectId?: string };
    assert.deepEqual(detail.fields, ['description']);
    assert.equal(detail.projectId, project.id);

    const paged = await getJson<AuditPage>(app, cookie, '/api/audit?page=2&pageSize=2');
    assert.equal(paged.entries.length, 2);
    assert.equal(paged.page, 2);
    assert.equal(paged.pageSize, 2);
    assert.ok(paged.total >= 5);

    const csv = await app.request('/api/audit/export.csv?action=project.created', {
      headers: { cookie },
    });
    assert.equal(csv.status, 200);
    assert.match(csv.headers.get('content-type') ?? '', /text\/csv/);
    assert.match(csv.headers.get('content-disposition') ?? '', /clay-audit\.csv/);
    const bytes = new Uint8Array(await csv.arrayBuffer());
    assert.deepEqual([...bytes.slice(0, 3)], [0xef, 0xbb, 0xbf]);
    const text = new TextDecoder().decode(bytes);
    assert.ok(text.includes('project.created'));
    assert.ok(text.includes(name));
    assert.ok(!text.includes('project.updated'));
  } finally {
    store.close();
  }
});

test('audit access is admin-only and preference changes are attributed', async () => {
  const store = testStore();
  const { app } = testApp(store);
  try {
    const manager = await login(app, DEMO.manager.email);
    const viewer = await login(app, DEMO.viewer.email);
    for (const cookie of [manager, viewer]) {
      assert.equal((await app.request('/api/audit', { headers: { cookie } })).status, 403);
      assert.equal(
        (await app.request('/api/audit/export.csv', { headers: { cookie } })).status,
        403,
      );
      assert.equal((await sendJson(app, cookie, 'POST', '/api/audit/cleanup', {})).status, 403);
    }
    assert.equal((await app.request('/api/audit')).status, 401);

    const admin = await login(app);
    const pref = await sendJson(app, admin, 'PATCH', '/api/preferences', {
      emailNotifications: false,
    });
    assert.equal(pref.status, 200, JSON.stringify(pref.body));
    const page = await getJson<AuditPage>(app, admin, '/api/audit?action=preferences.updated');
    assert.equal(page.total, 1);
    const prefEntry = page.entries[0];
    assert.ok(prefEntry);
    assert.equal(prefEntry.target, DEMO.admin.email);
    assert.deepEqual((prefEntry.detail as { fields: string[] }).fields, ['emailNotifications']);

    assert.equal(
      (await app.request('/api/audit?from=2026-02-31', { headers: { cookie: admin } })).status,
      400,
    );
    assert.equal(
      (await sendJson(app, admin, 'POST', '/api/audit/cleanup', { days: 0 })).status,
      400,
    );
  } finally {
    store.close();
  }
});

test('retention cleanup removes only logs older than the window and audits itself', async () => {
  const store = testStore();
  const { app } = testApp(store);
  const admin = await login(app);
  try {
    const insert = store.db.stmt(
      'INSERT INTO audit_log (actor_id, action, target, detail, created_at) VALUES (?, ?, ?, ?, ?)',
    );
    const dayMs = 24 * 60 * 60 * 1000;
    insert.run(
      null,
      'legacy.old',
      'old-target',
      '{}',
      new Date(Date.now() - 400 * dayMs).toISOString(),
    );
    insert.run(
      DEMO.admin.id,
      'legacy.recent',
      'recent-target',
      '{}',
      new Date(Date.now() - 10 * dayMs).toISOString(),
    );

    const result = await sendJson<{ removed: number; days: number }>(
      app,
      admin,
      'POST',
      '/api/audit/cleanup',
      { days: 180 },
    );
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.removed, 1);
    assert.equal(result.body.days, 180);

    const page = await getJson<AuditPage>(app, admin, '/api/audit?pageSize=50');
    assert.ok(page.entries.some((entry) => entry.action === 'legacy.recent'));
    assert.ok(!page.entries.some((entry) => entry.action === 'legacy.old'));
    const self = page.entries.find((entry) => entry.action === 'audit.cleanup');
    assert.ok(self, 'cleanup writes its own audit entry');
    assert.equal((self.detail as { removed: number }).removed, 1);
  } finally {
    store.close();
  }
});

test('imports, exports, templates and duplication are audited', async () => {
  const store = testStore();
  const { app } = testApp(store);
  const admin = await login(app);
  try {
    const form = new FormData();
    form.set(
      'file',
      new File(['name,status\n审计导入项目,active\n'], 'audit-import.csv', { type: 'text/csv' }),
    );
    const imported = await app.request('/api/projects/import', {
      method: 'POST',
      headers: { cookie: admin },
      body: form,
    });
    assert.equal(imported.status, 200);
    assert.match(await imported.text(), /"imported":1/);

    const exported = await app.request('/api/projects/export.csv', { headers: { cookie: admin } });
    assert.equal(exported.status, 200);
    await exported.text();

    const scaffold = await sendJson<{ project: ProjectDetail }>(
      app,
      admin,
      'POST',
      '/api/projects/from-template',
      { templateId: 'team-sprint' },
    );
    assert.equal(scaffold.status, 201, JSON.stringify(scaffold.body));
    const duplicated = await sendJson<{ project: ProjectDetail }>(
      app,
      admin,
      'POST',
      `/api/projects/${scaffold.body.project.id}/duplicate`,
      {},
    );
    assert.equal(duplicated.status, 201, JSON.stringify(duplicated.body));

    const page = await getJson<AuditPage>(app, admin, '/api/audit?pageSize=50');
    const byAction = new Map(page.entries.map((entry) => [entry.action, entry]));
    const importedEntry = byAction.get('project.imported');
    assert.ok(importedEntry);
    assert.equal(importedEntry.target, 'audit-import.csv');
    assert.equal((importedEntry.detail as { imported: number }).imported, 1);
    const exportedEntry = byAction.get('project.exported');
    assert.ok(exportedEntry);
    assert.ok((exportedEntry.detail as { count: number }).count > 0);
    const templateEntry = byAction.get('project.template_applied');
    assert.ok(templateEntry);
    assert.equal((templateEntry.detail as { templateId: string }).templateId, 'team-sprint');
    const duplicatedEntry = byAction.get('project.duplicated');
    assert.ok(duplicatedEntry);
    assert.equal(
      (duplicatedEntry.detail as { sourceId: string }).sourceId,
      scaffold.body.project.id,
    );
  } finally {
    store.close();
  }
});
