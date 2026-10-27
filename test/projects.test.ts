import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Hono } from 'hono';
import type {
  ActivityPage,
  ImportResult,
  Project,
  ProjectDetail,
  ProjectListResult,
} from '../shared/types.ts';
import type { AppEnv } from '../src/app-env.ts';
import { MAX_IMPORT_BYTES } from '../src/csv.ts';
import { DEMO, getJson, login, multipart, sendJson, testApp, testStore } from './helpers.ts';

async function setup(
  options: { demo?: boolean } = {},
): Promise<{ store: ReturnType<typeof testStore>; app: Hono<AppEnv>; cookie: string }> {
  const store = testStore(options);
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
  assert.equal(result.status, 201, `project create failed: ${JSON.stringify(result.body)}`);
  return result.body;
}

test('projects support create, read, update and delete', async () => {
  const { store, app, cookie } = await setup({ demo: false });
  try {
    const created = await createProject(app, cookie, {
      name: 'Roadmap 2027',
      description: '年度路线图',
      status: 'active',
      progress: 35,
      dueDate: '2027-01-31',
    });
    assert.equal(created.name, 'Roadmap 2027');
    assert.equal(created.status, 'active');
    assert.equal(created.progress, 35);
    assert.equal(created.ownerId, DEMO.admin.id);
    assert.equal(created.ownerName, DEMO.admin.name);
    assert.equal(created.isDemo, false);
    assert.equal(created.version, 1);
    assert.deepEqual(created.members, []);

    const detail = await getJson<ProjectDetail>(app, cookie, `/api/projects/${created.id}`);
    assert.equal(detail.name, 'Roadmap 2027');

    const updated = await sendJson<ProjectDetail>(
      app,
      cookie,
      'PATCH',
      `/api/projects/${created.id}`,
      {
        version: 1,
        name: 'Roadmap 2028',
        status: 'completed',
        progress: 100,
      },
    );
    assert.equal(updated.status, 200);
    assert.equal(updated.body.name, 'Roadmap 2028');
    assert.equal(updated.body.status, 'completed');
    assert.equal(updated.body.version, 2);

    const activities = await getJson<ActivityPage>(app, cookie, '/api/activities?limit=20');
    assert.ok(
      activities.activities.some(
        (activity) => activity.type === 'project.completed' && activity.project?.id === created.id,
      ),
    );

    const removed = await app.request(`/api/projects/${created.id}`, {
      method: 'DELETE',
      headers: { cookie },
    });
    assert.equal(removed.status, 204);
    const tombstone = await app.request(`/api/projects/${created.id}`, {
      headers: { cookie },
    });
    assert.equal(tombstone.status, 410, 'deleted projects return a tombstone');

    const trash = await getJson<{ projects: Project[] }>(app, cookie, '/api/projects/trash');
    assert.ok(trash.projects.some((item) => item.id === created.id));

    const restored = await sendJson<ProjectDetail>(
      app,
      cookie,
      'POST',
      `/api/projects/${created.id}/restore`,
      {},
    );
    assert.equal(restored.status, 200);
    assert.equal(restored.body.deletedAt, null);
    assert.equal(
      (await app.request(`/api/projects/${created.id}`, { headers: { cookie } })).status,
      200,
    );
  } finally {
    store.close();
  }
});

test('stale versions return 409 with the current project', async () => {
  const { store, app, cookie } = await setup({ demo: false });
  try {
    const project = await createProject(app, cookie, { name: '并发编辑' });

    const first = await sendJson<ProjectDetail>(
      app,
      cookie,
      'PATCH',
      `/api/projects/${project.id}`,
      {
        version: 1,
        name: '第一次编辑',
      },
    );
    assert.equal(first.status, 200);

    const stale = await sendJson<{
      error: string;
      message: string;
      current: Project;
    }>(app, cookie, 'PATCH', `/api/projects/${project.id}`, {
      version: 1,
      name: '过期编辑',
    });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error, 'conflict');
    assert.match(stale.body.message, /最新版本/);
    assert.equal(stale.body.current.name, '第一次编辑');
    assert.equal(stale.body.current.version, 2);

    const retried = await sendJson<ProjectDetail>(
      app,
      cookie,
      'PATCH',
      `/api/projects/${project.id}`,
      {
        version: 2,
        name: '重试成功',
      },
    );
    assert.equal(retried.status, 200);
    assert.equal(retried.body.version, 3);
  } finally {
    store.close();
  }
});

test('project payloads are validated', async () => {
  const { store, app, cookie } = await setup({ demo: false });
  try {
    store.users.update(DEMO.viewer.id, { status: 'disabled' });
    const cases: Record<string, unknown>[] = [
      { name: '   ' },
      { name: 'x'.repeat(121) },
      { name: '进度越界', progress: 101 },
      { name: '坏日期', dueDate: '2026-02-30' },
      { name: '日期倒置', startDate: '2026-05-01', dueDate: '2026-04-01' },
      { name: '未知成员', memberIds: ['00000000-0000-4000-8000-000000000000'] },
      { name: '停用成员', memberIds: [DEMO.viewer.id] },
    ];
    for (const body of cases) {
      const res = await sendJson(app, cookie, 'POST', '/api/projects', body);
      assert.equal(res.status, 400, `${JSON.stringify(body)} should be rejected`);
    }

    const project = await createProject(app, cookie, { name: '版本校验' });
    const missingVersion = await sendJson(app, cookie, 'PATCH', `/api/projects/${project.id}`, {
      name: '没有版本号',
    });
    assert.equal(missingVersion.status, 400);
  } finally {
    store.close();
  }
});

test('list filters, sorting, pagination, search and counts agree', async () => {
  const { store, app, cookie } = await setup({ demo: false });
  try {
    await createProject(app, cookie, { name: 'Release Pipeline', status: 'active', progress: 30 });
    await createProject(app, cookie, { name: 'Quarterly Planning', status: 'planning' });
    await createProject(app, cookie, { name: '100% coverage', status: 'planning', progress: 10 });
    await createProject(app, cookie, {
      name: 'Mobile Refresh',
      status: 'completed',
      progress: 100,
    });
    await createProject(app, cookie, { name: 'Release Notes', status: 'on_hold', progress: 50 });

    const all = await getJson<ProjectListResult>(app, cookie, '/api/projects?pageSize=50');
    assert.equal(all.total, 5);
    assert.deepEqual(all.counts, {
      all: 5,
      planning: 2,
      active: 1,
      on_hold: 1,
      completed: 1,
      archived: 0,
    });

    const active = await getJson<ProjectListResult>(app, cookie, '/api/projects?status=active');
    assert.deepEqual(
      active.projects.map((project) => project.name),
      ['Release Pipeline'],
    );

    const fts = await getJson<ProjectListResult>(app, cookie, '/api/projects?q=Release');
    assert.deepEqual(fts.projects.map((project) => project.name).sort(), [
      'Release Notes',
      'Release Pipeline',
    ]);

    const combined = await getJson<ProjectListResult>(
      app,
      cookie,
      '/api/projects?q=Release&status=on_hold',
    );
    assert.deepEqual(
      combined.projects.map((project) => project.name),
      ['Release Notes'],
    );

    const literal = await getJson<ProjectListResult>(app, cookie, '/api/projects?q=%25');
    assert.deepEqual(
      literal.projects.map((project) => project.name),
      ['100% coverage'],
      'LIKE fallback escapes the % wildcard',
    );

    const page = await getJson<ProjectListResult>(
      app,
      cookie,
      '/api/projects?sort=name&pageSize=2&page=1',
    );
    assert.equal(page.total, 5);
    assert.equal(page.projects.length, 2);
    assert.deepEqual(
      page.projects.map((project) => project.name),
      ['100% coverage', 'Mobile Refresh'],
    );
    const page3 = await getJson<ProjectListResult>(
      app,
      cookie,
      '/api/projects?sort=name&pageSize=2&page=3',
    );
    assert.deepEqual(
      page3.projects.map((project) => project.name),
      ['Release Pipeline'],
    );

    const mine = await getJson<ProjectListResult>(app, cookie, '/api/projects?owner=me');
    assert.equal(mine.total, 5);

    const invalid = await app.request('/api/projects?status=unknown', { headers: { cookie } });
    assert.equal(invalid.status, 400);
    const invalidSort = await app.request('/api/projects?sort=nope', { headers: { cookie } });
    assert.equal(invalidSort.status, 400);
  } finally {
    store.close();
  }
});

test('membership grants read access and can be revoked', async () => {
  const { store, app, cookie } = await setup({ demo: false });
  try {
    const project = await createProject(app, cookie, {
      name: '成员协作',
      memberIds: [DEMO.pm.id],
    });
    assert.deepEqual(
      project.members.map((member) => member.name),
      [DEMO.pm.name],
    );

    const pmCookie = await login(app, DEMO.pm.email);
    assert.equal(
      (await app.request(`/api/projects/${project.id}`, { headers: { cookie: pmCookie } })).status,
      200,
    );

    const revoked = await sendJson<ProjectDetail>(
      app,
      cookie,
      'PATCH',
      `/api/projects/${project.id}`,
      {
        version: 1,
        memberIds: [],
      },
    );
    assert.equal(revoked.status, 200);
    assert.deepEqual(revoked.body.members, []);
    assert.equal(
      (await app.request(`/api/projects/${project.id}`, { headers: { cookie: pmCookie } })).status,
      404,
    );
  } finally {
    store.close();
  }
});

test('CSV export streams a BOM and neutralizes formulas', async () => {
  const { store, app, cookie } = await setup({ demo: false });
  try {
    await createProject(app, cookie, {
      name: '=2+2',
      description: '+SUM(A1)',
      status: 'active',
      progress: 20,
    });

    const res = await app.request('/api/projects/export.csv', { headers: { cookie } });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/csv/);
    assert.match(
      res.headers.get('content-disposition') ?? '',
      /attachment; filename="clay-projects.csv"/,
    );
    assert.equal(res.headers.get('cache-control'), 'no-store');

    const bytes = new Uint8Array(await res.arrayBuffer());
    assert.deepEqual([...bytes.slice(0, 3)], [0xef, 0xbb, 0xbf]);
    const text = new TextDecoder().decode(bytes);
    assert.ok(text.startsWith('name,description,status,progress,owner,startDate,dueDate'));
    assert.ok(text.includes("'=2+2,'+SUM(A1),active,20,"));
  } finally {
    store.close();
  }
});

test('CSV and JSON imports insert valid rows and skip invalid ones', async () => {
  const { store, app, cookie } = await setup({ demo: false });
  try {
    const csv = [
      'name,description,status,progress,startDate,dueDate',
      '导入项目一,说明,进行中,40,2026-01-01,2026-03-01',
      '导入项目二,,completed,100,,',
      ',没有名称,active,0,,',
      '坏状态,说明,unknown,10,,',
      '坏日期,说明,active,10,2026-02-30,',
    ].join('\n');
    const csvRes = await app.request('/api/projects/import', {
      method: 'POST',
      headers: { cookie },
      body: multipart(new File([csv], 'projects.csv', { type: 'text/csv' })),
    });
    assert.equal(csvRes.status, 200);
    assert.deepEqual((await csvRes.json()) as ImportResult, {
      preview: false,
      imported: 2,
      skipped: 3,
      duplicates: 0,
      errors: [
        { row: 4, message: '名称不能为空' },
        { row: 5, message: '状态值无效' },
        { row: 6, message: '开始日期格式无效' },
      ],
      items: [],
    });

    const jsonRes = await app.request('/api/projects/import', {
      method: 'POST',
      headers: { cookie },
      body: multipart(
        new File(
          [
            JSON.stringify({
              projects: [
                { name: 'JSON 导入', status: 'planning' },
                { title: 'JSON 标题别名', status: 'active', progress: '50%' },
                { name: '坏进度', progress: 300 },
              ],
            }),
          ],
          'projects.json',
          { type: 'application/json' },
        ),
      ),
    });
    assert.equal(jsonRes.status, 200);
    assert.deepEqual((await jsonRes.json()) as ImportResult, {
      preview: false,
      imported: 2,
      skipped: 1,
      duplicates: 0,
      errors: [{ row: 4, message: '进度需为 0-100 之间的数字' }],
      items: [],
    });

    const list = await getJson<ProjectListResult>(app, cookie, '/api/projects?pageSize=50');
    assert.equal(list.total, 4);
    assert.ok(list.projects.every((project) => project.ownerName === DEMO.admin.name));

    const activities = await getJson<ActivityPage>(app, cookie, '/api/activities?limit=10');
    assert.ok(activities.activities.some((activity) => activity.type === 'project.imported'));

    const empty = await app.request('/api/projects/import', {
      method: 'POST',
      headers: { cookie },
      body: multipart(new File(['name,status\n'], 'empty.csv', { type: 'text/csv' })),
    });
    assert.equal(empty.status, 400);

    const broken = await app.request('/api/projects/import', {
      method: 'POST',
      headers: { cookie },
      body: multipart(new File(['{"projects": 42}'], 'broken.json', { type: 'application/json' })),
    });
    assert.equal(broken.status, 400);

    const noFile = await app.request('/api/projects/import', {
      method: 'POST',
      headers: { cookie },
      body: new FormData(),
    });
    assert.equal(noFile.status, 400);

    const pmCookie = await login(app, DEMO.pm.email);
    const pmImport = await app.request('/api/projects/import', {
      method: 'POST',
      headers: { cookie: pmCookie },
      body: multipart(new File(['name\nx'], 'pm.csv', { type: 'text/csv' })),
    });
    assert.equal(pmImport.status, 403);
  } finally {
    store.close();
  }
});

test('import preview reports duplicates and owner/member mapping without writing', async () => {
  const { store, app, cookie } = await setup({ demo: false });
  try {
    await createProject(app, cookie, { name: '已存在项目' });

    const csv = [
      'name,status,progress,owner,members',
      '预览项目,active,30,manager@pulse.demo,pm@pulse.demo;viewer@pulse.demo',
      '已存在项目,active,10,,',
      '预览项目,active,20,,',
      '未知负责人,active,0,nobody@pulse.demo,',
      '未知成员,active,0,,nobody@pulse.demo',
    ].join('\n');

    const upload = () => multipart(new File([csv], 'preview.csv', { type: 'text/csv' }));

    const previewRes = await app.request('/api/projects/import?preview=1', {
      method: 'POST',
      headers: { cookie },
      body: upload(),
    });
    assert.equal(previewRes.status, 200);
    const preview = (await previewRes.json()) as ImportResult;
    assert.equal(preview.preview, true);
    assert.equal(preview.imported, 0);
    assert.equal(preview.duplicates, 2);
    assert.equal(preview.skipped, 4);
    assert.deepEqual(preview.items, [
      {
        row: 2,
        name: '预览项目',
        status: 'active',
        ownerEmail: 'manager@pulse.demo',
        members: ['pm@pulse.demo', 'viewer@pulse.demo'],
      },
    ]);
    assert.deepEqual(
      preview.errors.map((issue) => issue.message),
      [
        '同名项目已存在',
        '同名项目已存在',
        '负责人 nobody@pulse.demo 不存在或已停用',
        '成员 nobody@pulse.demo 不存在或已停用',
      ],
    );

    let list = await getJson<ProjectListResult>(app, cookie, '/api/projects?pageSize=50');
    assert.equal(list.total, 1, 'preview must not write');

    const importRes = await app.request('/api/projects/import', {
      method: 'POST',
      headers: { cookie },
      body: upload(),
    });
    assert.equal(importRes.status, 200);
    const confirmed = (await importRes.json()) as ImportResult;
    assert.equal(confirmed.preview, false);
    assert.equal(confirmed.imported, 1);
    assert.deepEqual(confirmed.items, []);

    list = await getJson<ProjectListResult>(app, cookie, '/api/projects?pageSize=50');
    assert.equal(list.total, 2);
    const created = list.projects.find((project) => project.name === '预览项目');
    assert.ok(created);
    assert.equal(created.ownerName, DEMO.manager.name);

    const detail = await getJson<ProjectDetail>(app, cookie, `/api/projects/${created.id}`);
    assert.deepEqual(
      detail.members.map((member) => member.name).sort(),
      [DEMO.pm.name, DEMO.viewer.name].sort(),
    );

    const filtered = await app.request(
      `/api/projects/export.csv?status=active&q=${encodeURIComponent('预览')}`,
      { headers: { cookie } },
    );
    assert.equal(filtered.status, 200);
    const filteredText = await filtered.text();
    assert.ok(filteredText.includes('预览项目'));
    assert.ok(!filteredText.includes('已存在项目'));

    const byId = await app.request(`/api/projects/export.csv?ids=${created.id}`, {
      headers: { cookie },
    });
    assert.equal(byId.status, 200);
    const byIdText = await byId.text();
    assert.ok(byIdText.includes('预览项目'));
    assert.ok(!byIdText.includes('已存在项目'));
  } finally {
    store.close();
  }
});

test('import rejects files above the row cap', async () => {
  const { store, app, cookie } = await setup({ demo: false });
  try {
    const rows = ['name,status'];
    for (let index = 0; index < 5_001; index++) rows.push(`row ${index},active`);
    const res = await app.request('/api/projects/import', {
      method: 'POST',
      headers: { cookie },
      body: multipart(new File([rows.join('\n')], 'huge.csv', { type: 'text/csv' })),
    });
    assert.equal(res.status, 413);
    assert.equal(((await res.json()) as { error: string }).error, 'too_many_rows');
  } finally {
    store.close();
  }
});

test('import measures the file in bytes, not characters', async () => {
  const { store, app, cookie } = await setup({ demo: false });
  try {
    const csv = `name,description\nbig,${'a'.repeat(MAX_IMPORT_BYTES)}`;
    const res = await app.request('/api/projects/import', {
      method: 'POST',
      headers: { cookie },
      body: multipart(new File([csv], 'big.csv', { type: 'text/csv' })),
    });
    assert.equal(res.status, 413);
    assert.equal(((await res.json()) as { error: string }).error, 'file_too_large');
  } finally {
    store.close();
  }
});

test('CSV export refuses to stream beyond the configured row budget', async () => {
  const { store, app, cookie } = await setup({ demo: false });
  const previous = process.env.EXPORT_MAX_ROWS;
  try {
    await createProject(app, cookie, { name: 'Export A' });
    await createProject(app, cookie, { name: 'Export B' });

    process.env.EXPORT_MAX_ROWS = '1';
    const refused = await app.request('/api/projects/export.csv', { headers: { cookie } });
    assert.equal(refused.status, 413);
    assert.equal(((await refused.json()) as { error: string }).error, 'export_too_large');

    process.env.EXPORT_MAX_ROWS = '10';
    const ok = await app.request('/api/projects/export.csv', { headers: { cookie } });
    assert.equal(ok.status, 200);
    const text = await ok.text();
    assert.match(text, /Export A/);
    assert.match(text, /Export B/);
  } finally {
    if (previous === undefined) delete process.env.EXPORT_MAX_ROWS;
    else process.env.EXPORT_MAX_ROWS = previous;
    store.close();
  }
});
