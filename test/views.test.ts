import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Hono } from 'hono';
import type {
  ActivityPage,
  ProjectBatchResult,
  ProjectDetail,
  ProjectListResult,
  SavedView,
} from '../shared/types.ts';
import type { AppEnv } from '../src/app-env.ts';
import { DEMO, getJson, login, sendJson, testApp, testStore } from './helpers.ts';

async function setup() {
  const store = testStore({ demo: false });
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

function dayOffset(days: number): string {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

test('project tags are normalized, filterable and expose facets', async () => {
  const { store, app, cookie } = await setup();
  try {
    const design = await createProject(app, cookie, {
      name: 'Brand refresh',
      tags: ['Design', 'Q4', 'Design'],
    });
    assert.deepEqual(design.tags, ['Design', 'Q4']);

    const dev = await createProject(app, cookie, { name: 'API cleanup', tags: ['Dev'] });

    const faceted = await getJson<ProjectListResult>(app, cookie, '/api/projects');
    assert.equal(faceted.tags.find((item) => item.tag === 'Design')?.count, 1);
    assert.equal(faceted.tags.find((item) => item.tag === 'Dev')?.count, 1);

    const filtered = await getJson<ProjectListResult>(app, cookie, '/api/projects?tag=Design');
    assert.deepEqual(
      filtered.projects.map((project) => project.id),
      [design.id],
    );
    assert.equal(filtered.total, 1);

    const updated = await sendJson<ProjectDetail>(app, cookie, 'PATCH', `/api/projects/${dev.id}`, {
      version: dev.version,
      tags: ['Infra', 'Q4'],
    });
    assert.equal(updated.status, 200);
    assert.deepEqual(updated.body.tags, ['Infra', 'Q4']);

    const cleared = await sendJson<ProjectDetail>(app, cookie, 'PATCH', `/api/projects/${dev.id}`, {
      version: updated.body.version,
      tags: [],
    });
    assert.deepEqual(cleared.body.tags, []);

    const none = await getJson<ProjectListResult>(app, cookie, '/api/projects?tag=Dev');
    assert.equal(none.total, 0);

    const tooMany = await sendJson(app, cookie, 'POST', '/api/projects', {
      name: 'Too many tags',
      tags: ['a', 'b', 'c', 'd', 'e', 'f'],
    });
    assert.equal(tooMany.status, 400);
  } finally {
    store.close();
  }
});

test('due date filters and page size are server-side', async () => {
  const { store, app, cookie } = await setup();
  try {
    const overdue = await createProject(app, cookie, {
      name: 'Overdue',
      dueDate: dayOffset(-2),
      status: 'active',
    });
    const soon = await createProject(app, cookie, {
      name: 'Soon',
      dueDate: dayOffset(3),
      status: 'active',
    });
    const later = await createProject(app, cookie, {
      name: 'Later',
      dueDate: dayOffset(20),
      status: 'active',
    });
    await createProject(app, cookie, {
      name: 'Far',
      dueDate: dayOffset(90),
      status: 'active',
    });
    await createProject(app, cookie, {
      name: 'Overdue but done',
      dueDate: dayOffset(-5),
      status: 'completed',
    });

    const overdueList = await getJson<ProjectListResult>(app, cookie, '/api/projects?due=overdue');
    assert.deepEqual(
      overdueList.projects.map((project) => project.id),
      [overdue.id],
    );

    const weekList = await getJson<ProjectListResult>(app, cookie, '/api/projects?due=week');
    assert.deepEqual(
      weekList.projects.map((project) => project.id),
      [soon.id],
    );

    const monthList = await getJson<ProjectListResult>(app, cookie, '/api/projects?due=month');
    assert.deepEqual(
      monthList.projects.map((project) => project.id).sort(),
      [soon.id, later.id].sort(),
    );

    const sized = await getJson<ProjectListResult>(
      app,
      cookie,
      '/api/projects?pageSize=24&sort=name',
    );
    assert.equal(sized.pageSize, 24);
    assert.equal(sized.projects.length, 5);

    const tooLarge = await sendJson(app, cookie, 'POST', '/api/projects', {
      name: 'Bad page size',
    });
    assert.equal(tooLarge.status, 201);
    const invalid = await app.request('/api/projects?pageSize=99', { headers: { cookie } });
    assert.equal(invalid.status, 400);
  } finally {
    store.close();
  }
});

test('favorites are per-user, filterable and reflected in detail', async () => {
  const { store, app, cookie } = await setup();
  try {
    const shared = await createProject(app, cookie, {
      name: 'Shared project',
      ownerId: DEMO.pm.id,
      memberIds: [DEMO.pm.id],
    });
    const other = await createProject(app, cookie, { name: 'Other project' });

    const favorite = await sendJson<{ favorite: boolean }>(
      app,
      cookie,
      'POST',
      `/api/projects/${shared.id}/favorite`,
      {},
    );
    assert.equal(favorite.status, 200);
    assert.equal(favorite.body.favorite, true);

    const detail = await getJson<ProjectDetail>(app, cookie, `/api/projects/${shared.id}`);
    assert.equal(detail.favorite, true);

    const filtered = await getJson<ProjectListResult>(app, cookie, '/api/projects?favorite=1');
    assert.deepEqual(
      filtered.projects.map((project) => project.id),
      [shared.id],
    );
    assert.equal(filtered.projects[0]?.favorite, true);

    const pmCookie = await login(app, DEMO.pm.email);
    const pmBefore = await getJson<ProjectListResult>(app, pmCookie, '/api/projects?favorite=1');
    assert.equal(pmBefore.total, 0);

    await sendJson(app, pmCookie, 'POST', `/api/projects/${shared.id}/favorite`, {});
    const pmAfter = await getJson<ProjectListResult>(app, pmCookie, '/api/projects?favorite=1');
    assert.deepEqual(
      pmAfter.projects.map((project) => project.id),
      [shared.id],
    );

    const adminList = await getJson<ProjectListResult>(app, cookie, '/api/projects?favorite=1');
    assert.deepEqual(
      adminList.projects.map((project) => project.id),
      [shared.id],
    );

    const removed = await sendJson(
      app,
      cookie,
      'DELETE',
      `/api/projects/${shared.id}/favorite`,
      {},
    );
    assert.equal(removed.status, 200);
    const after = await getJson<ProjectListResult>(app, cookie, '/api/projects?favorite=1');
    assert.equal(after.total, 0);

    const hidden = await sendJson(app, pmCookie, 'POST', `/api/projects/${other.id}/favorite`, {});
    assert.equal(hidden.status, 404, 'favorites require project visibility');
  } finally {
    store.close();
  }
});

test('saved views validate, dedupe, update and isolate by user', async () => {
  const { store, app, cookie } = await setup();
  try {
    const created = await sendJson<SavedView>(app, cookie, 'POST', '/api/saved-views', {
      name: '逾期重点',
      query: {
        status: 'active',
        tag: 'Q4',
        due: 'overdue',
        favorite: true,
        sort: 'due',
        pageSize: 24,
      },
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.query.tag, 'Q4');
    assert.equal(created.body.query.pageSize, 24);

    const duplicate = await sendJson(app, cookie, 'POST', '/api/saved-views', {
      name: '逾期重点',
      query: { status: 'active' },
    });
    assert.equal(duplicate.status, 409);

    const list = await getJson<{ views: SavedView[] }>(app, cookie, '/api/saved-views');
    assert.deepEqual(
      list.views.map((view) => view.id),
      [created.body.id],
    );

    const renamed = await sendJson<SavedView>(
      app,
      cookie,
      'PATCH',
      `/api/saved-views/${created.body.id}`,
      { name: 'Q4 重点', query: { tag: 'Q4' } },
    );
    assert.equal(renamed.status, 200);
    assert.equal(renamed.body.name, 'Q4 重点');
    assert.deepEqual(renamed.body.query, { tag: 'Q4' });

    const invalid = await sendJson(app, cookie, 'POST', '/api/saved-views', {
      name: 'Bad',
      query: { pageSize: 999 },
    });
    assert.equal(invalid.status, 400);

    const pmCookie = await login(app, DEMO.pm.email);
    const pmList = await getJson<{ views: SavedView[] }>(app, pmCookie, '/api/saved-views');
    assert.equal(pmList.views.length, 0);
    const pmDelete = await sendJson(
      app,
      pmCookie,
      'DELETE',
      `/api/saved-views/${created.body.id}`,
      {},
    );
    assert.equal(pmDelete.status, 404, 'users cannot delete other users saved views');

    const removed = await sendJson(
      app,
      cookie,
      'DELETE',
      `/api/saved-views/${created.body.id}`,
      {},
    );
    assert.equal(removed.status, 204);
    const empty = await getJson<{ views: SavedView[] }>(app, cookie, '/api/saved-views');
    assert.equal(empty.views.length, 0);
  } finally {
    store.close();
  }
});

test('batch status and archive respect permissions and record activities', async () => {
  const { store, app, cookie } = await setup();
  try {
    const first = await createProject(app, cookie, { name: 'Batch A', status: 'planning' });
    const second = await createProject(app, cookie, { name: 'Batch B', status: 'planning' });
    const third = await createProject(app, cookie, { name: 'Batch C', status: 'active' });

    const completed = await sendJson<ProjectBatchResult>(
      app,
      cookie,
      'POST',
      '/api/projects/batch',
      { ids: [first.id, second.id], action: 'status', status: 'completed' },
    );
    assert.equal(completed.status, 200);
    assert.equal(completed.body.updated, 2);
    assert.deepEqual(completed.body.skipped, []);

    const afterFirst = await getJson<ProjectDetail>(app, cookie, `/api/projects/${first.id}`);
    assert.equal(afterFirst.status, 'completed');
    assert.equal(afterFirst.version, 2);

    const noop = await sendJson<ProjectBatchResult>(app, cookie, 'POST', '/api/projects/batch', {
      ids: [first.id],
      action: 'status',
      status: 'completed',
    });
    assert.equal(noop.body.updated, 0);
    assert.deepEqual(noop.body.skipped, [first.id]);

    const archived = await sendJson<ProjectBatchResult>(
      app,
      cookie,
      'POST',
      '/api/projects/batch',
      { ids: [third.id], action: 'archive' },
    );
    assert.equal(archived.body.updated, 1);
    const afterThird = await getJson<ProjectDetail>(app, cookie, `/api/projects/${third.id}`);
    assert.equal(afterThird.status, 'archived');

    const activities = await getJson<ActivityPage>(app, cookie, '/api/activities?limit=50');
    assert.ok(
      activities.activities.some(
        (activity) => activity.type === 'project.completed' && activity.project?.id === first.id,
      ),
    );
    assert.ok(
      activities.activities.some(
        (activity) => activity.type === 'project.archived' && activity.project?.id === third.id,
      ),
    );

    const viewerCookie = await login(app, DEMO.viewer.email);
    const denied = await sendJson(app, viewerCookie, 'POST', '/api/projects/batch', {
      ids: [first.id],
      action: 'status',
      status: 'active',
    });
    assert.equal(denied.status, 403);

    const missingStatus = await sendJson(app, cookie, 'POST', '/api/projects/batch', {
      ids: [first.id],
      action: 'status',
    });
    assert.equal(missingStatus.status, 400);
  } finally {
    store.close();
  }
});

test('batch owner transfer validates the target and skips inaccessible projects', async () => {
  const { store, app, cookie } = await setup();
  try {
    const owned = await createProject(app, cookie, { name: 'Owned by manager' });
    const pmCookie = await login(app, DEMO.pm.email);
    const pmProject = await createProject(app, pmCookie, { name: 'PM project' });

    const transferred = await sendJson<ProjectBatchResult>(
      app,
      cookie,
      'POST',
      '/api/projects/batch',
      { ids: [owned.id], action: 'owner', ownerId: DEMO.manager.id },
    );
    assert.equal(transferred.status, 200);
    assert.equal(transferred.body.updated, 1);
    const detail = await getJson<ProjectDetail>(app, cookie, `/api/projects/${owned.id}`);
    assert.equal(detail.ownerId, DEMO.manager.id);
    assert.equal(detail.ownerName, DEMO.manager.name);

    const mixed = await sendJson<ProjectBatchResult>(app, pmCookie, 'POST', '/api/projects/batch', {
      ids: [pmProject.id, owned.id],
      action: 'status',
      status: 'active',
    });
    assert.equal(mixed.status, 200);
    assert.equal(mixed.body.updated, 1);
    assert.deepEqual(mixed.body.skipped, [owned.id]);

    const escalation = await sendJson(app, pmCookie, 'POST', '/api/projects/batch', {
      ids: [pmProject.id],
      action: 'owner',
      ownerId: DEMO.manager.id,
    });
    assert.equal(escalation.status, 403);

    const offline = await sendJson(app, cookie, 'POST', '/api/projects/batch', {
      ids: [owned.id],
      action: 'owner',
      ownerId: '00000000-0000-4000-8000-000000000000',
    });
    assert.equal(offline.status, 400);
  } finally {
    store.close();
  }
});
