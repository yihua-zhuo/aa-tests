import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ActivityPage, ProjectDetail } from '../shared/types.ts';
import { DEMO, getJson, login, sendJson, testApp, testStore } from './helpers.ts';

async function createProject(
  app: Parameters<typeof getJson>[0],
  cookie: string,
  name: string,
): Promise<ProjectDetail> {
  const res = await sendJson<ProjectDetail>(app, cookie, 'POST', '/api/projects', { name });
  assert.equal(res.status, 201);
  return res.body;
}

test('activities page backwards with a cursor', async () => {
  const store = testStore({ demo: false });
  try {
    const { app } = testApp(store);
    const cookie = await login(app, DEMO.admin.email);
    await createProject(app, cookie, '活动一');
    await createProject(app, cookie, '活动二');
    const third = await createProject(app, cookie, '活动三');

    const first = await getJson<ActivityPage>(app, cookie, '/api/activities?limit=2');
    assert.equal(first.activities.length, 2);
    assert.ok(first.activities[0]!.seq > first.activities[1]!.seq);
    assert.equal(first.nextCursor, first.activities[1]!.seq);
    assert.equal(first.activities[0]!.project?.id, third.id);

    const second = await getJson<ActivityPage>(
      app,
      cookie,
      `/api/activities?limit=2&cursor=${first.nextCursor}`,
    );
    assert.equal(second.activities.length, 1);
    assert.equal(second.nextCursor, null);
    assert.ok(second.activities[0]!.seq < first.activities[1]!.seq);
    assert.ok(second.activities[0]!.createdAt);

    const larger = await getJson<ActivityPage>(app, cookie, '/api/activities?limit=50');
    assert.deepEqual(
      larger.activities.map((activity) => activity.seq),
      [...larger.activities.map((activity) => activity.seq)].sort((a, b) => b - a),
    );
  } finally {
    store.close();
  }
});

test('activities can be filtered by project and type', async () => {
  const store = testStore({ demo: false });
  try {
    const { app } = testApp(store);
    const cookie = await login(app, DEMO.admin.email);
    const target = await createProject(app, cookie, '筛选目标');
    const other = await createProject(app, cookie, '其他项目');

    const completed = await sendJson<ProjectDetail>(
      app,
      cookie,
      'PATCH',
      `/api/projects/${target.id}`,
      {
        version: 1,
        status: 'completed',
      },
    );
    assert.equal(completed.status, 200);
    await sendJson(app, cookie, 'PATCH', `/api/projects/${other.id}`, {
      version: 1,
      progress: 40,
    });

    const byProject = await getJson<ActivityPage>(
      app,
      cookie,
      `/api/activities?limit=50&projectId=${target.id}`,
    );
    assert.ok(byProject.activities.length >= 2);
    assert.ok(byProject.activities.every((activity) => activity.project?.id === target.id));

    const byType = await getJson<ActivityPage>(
      app,
      cookie,
      '/api/activities?limit=50&type=project.completed',
    );
    assert.equal(byType.activities.length, 1);
    assert.equal(byType.activities[0]!.type, 'project.completed');
    assert.equal(byType.activities[0]!.project?.id, target.id);

    const invalid = await app.request('/api/activities?limit=51', { headers: { cookie } });
    assert.equal(invalid.status, 400);
    const zero = await app.request('/api/activities?limit=0', { headers: { cookie } });
    assert.equal(zero.status, 400);
    const badProject = await app.request('/api/activities?projectId=nope', { headers: { cookie } });
    assert.equal(badProject.status, 400);
  } finally {
    store.close();
  }
});

test('activity feeds are scoped to visible projects', async () => {
  const store = testStore({ demo: false });
  try {
    const { app } = testApp(store);
    const adminCookie = await login(app, DEMO.admin.email);
    const pmCookie = await login(app, DEMO.pm.email);

    const adminOnly = await createProject(app, adminCookie, '管理员项目');
    const pmProject = await createProject(app, pmCookie, 'PM 项目');

    const adminFeed = await getJson<ActivityPage>(app, adminCookie, '/api/activities?limit=50');
    const adminProjects = new Set(adminFeed.activities.map((activity) => activity.project?.id));
    assert.ok(adminProjects.has(adminOnly.id));
    assert.ok(adminProjects.has(pmProject.id));

    const pmFeed = await getJson<ActivityPage>(app, pmCookie, '/api/activities?limit=50');
    assert.ok(pmFeed.activities.length > 0);
    assert.ok(pmFeed.activities.every((activity) => activity.project?.id === pmProject.id));
    assert.ok(pmFeed.activities.every((activity) => activity.project?.id !== adminOnly.id));

    const adminOnlyPaged = await getJson<ActivityPage>(
      app,
      pmCookie,
      `/api/activities?projectId=${adminOnly.id}`,
    );
    assert.deepEqual(adminOnlyPaged.activities, []);
  } finally {
    store.close();
  }
});

test('activity search is scoped and escapes wildcards', async () => {
  const store = testStore({ demo: false });
  try {
    const { app } = testApp(store);
    const adminCookie = await login(app, DEMO.admin.email);
    const pmCookie = await login(app, DEMO.pm.email);

    await createProject(app, adminCookie, 'Secret Roadmap');
    const pmProject = await createProject(app, pmCookie, '100% PM');

    type Result = { activities: { project?: { id: string } | null }[] };
    const admin = await getJson<Result>(app, adminCookie, '/api/search?q=Roadmap');
    assert.ok(admin.activities.length > 0);

    const multiWord = await getJson<Result & { activities: { highlight?: string | null }[] }>(
      app,
      adminCookie,
      `/api/search?q=${encodeURIComponent('Secret Roadmap')}`,
    );
    assert.ok(multiWord.activities.length > 0, 'FTS matches all query terms');
    assert.match(multiWord.activities[0]?.highlight ?? '', /<mark>/);

    const pm = await getJson<Result>(app, pmCookie, '/api/search?q=Roadmap');
    assert.deepEqual(pm.activities, []);

    const wildcard = await getJson<Result>(app, pmCookie, '/api/search?q=100%25');
    assert.ok(wildcard.activities.some((activity) => activity.project?.id === pmProject.id));

    const noWildcardBleed = await getJson<Result>(app, pmCookie, '/api/search?q=Secr_t');
    assert.deepEqual(noWildcardBleed.activities, []);
  } finally {
    store.close();
  }
});
