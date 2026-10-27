import assert from 'node:assert/strict';
import test from 'node:test';
import type { MetricDay, RevenueReport, SavedReport, WorkspaceSettings } from '../shared/types.ts';
import {
  DEMO,
  getJson,
  login,
  multipart,
  sendJson,
  TEST_NOW,
  testApp,
  testStore,
} from './helpers.ts';

test('workspace currency converts imported metrics and dashboard revenue', async () => {
  const store = testStore();
  const { app } = testApp(store);
  try {
    const admin = await login(app);
    const initial = await getJson<{ workspace: WorkspaceSettings }>(app, admin, '/api/workspace');
    assert.equal(initial.workspace.currency, 'USD');

    const imported = await sendJson(app, admin, 'POST', '/api/analytics/metrics', {
      records: [
        {
          date: '2026-06-14',
          revenue: 100,
          customers: 5,
          conversions: 2,
          visitors: 50,
          currency: 'USD',
        },
      ],
    });
    assert.equal(imported.status, 200);
    assert.equal(imported.body.imported, 1);

    const raw = await getJson<{ records: MetricDay[]; currency: string }>(
      app,
      admin,
      '/api/analytics/metrics?from=2026-06-14&to=2026-06-14',
    );
    assert.equal(raw.currency, 'USD');
    assert.equal(raw.records[0]?.revenue, 100);
    assert.equal(raw.records[0]?.source, 'api');

    const patched = await sendJson<{ workspace: WorkspaceSettings }>(
      app,
      admin,
      'PATCH',
      '/api/workspace',
      { currency: 'CNY', rate: 7.5 },
    );
    assert.equal(patched.status, 200);
    assert.equal(patched.body.workspace.currency, 'CNY');
    assert.equal(patched.body.workspace.rates.CNY, 7.5);

    const report = await getJson<RevenueReport>(
      app,
      admin,
      '/api/analytics/revenue?range=custom&from=2026-06-14&to=2026-06-14',
    );
    assert.equal(report.currency, 'CNY');
    assert.equal(report.total, 750);

    const sources = await getJson<{
      sources: { source: string; days: number; revenue: number }[];
      currency: string;
    }>(app, admin, '/api/analytics/sources');
    assert.equal(sources.currency, 'CNY');
    const api = sources.sources.find((source) => source.source === 'api');
    assert.ok(api);
    assert.equal(api.revenue, 750);
  } finally {
    store.close();
  }
});

test('metric CSV import reports row errors and members cannot change the workspace', async () => {
  const store = testStore();
  const { app } = testApp(store);
  try {
    const admin = await login(app);
    const csv = [
      'date,revenue,customers,conversions,visitors',
      '2026-06-13,200,10,4,80',
      '2026-06-12,oops,1,1,1',
    ].join('\n');
    const res = await app.request('/api/analytics/import', {
      method: 'POST',
      headers: { cookie: admin },
      body: multipart(new File([csv], 'metrics.csv', { type: 'text/csv' })),
    });
    assert.equal(res.status, 200);
    const result = (await res.json()) as {
      imported: number;
      skipped: number;
      errors: { row: number; message: string }[];
    };
    assert.equal(result.imported, 1);
    assert.equal(result.skipped, 1);
    assert.equal(result.errors[0]?.row, 3);

    const metrics = await getJson<{ records: MetricDay[] }>(
      app,
      admin,
      '/api/analytics/metrics?from=2026-06-13&to=2026-06-13',
    );
    assert.equal(metrics.records[0]?.source, 'csv');
    assert.equal(metrics.records[0]?.revenue, 200);

    const member = await login(app, DEMO.viewer.email);
    const forbidden = await sendJson(app, member, 'PATCH', '/api/workspace', { currency: 'EUR' });
    assert.equal(forbidden.status, 403);
    const hidden = await app.request('/api/analytics/metrics?from=2026-06-13&to=2026-06-13', {
      headers: { cookie: member },
    });
    assert.equal(hidden.status, 403);
  } finally {
    store.close();
  }
});

test('saved reports are owner scoped and export CSV', async () => {
  const store = testStore();
  const { app } = testApp(store);
  try {
    const admin = await login(app);
    const created = await sendJson<{ report: SavedReport }>(
      app,
      admin,
      'POST',
      '/api/analytics/reports',
      {
        name: '每周收入',
        query: { kind: 'revenue', range: '7d' },
        frequency: 'weekly',
      },
    );
    assert.equal(created.status, 201);
    assert.ok(created.body.report.nextRunAt);
    const id = created.body.report.id;

    const list = await getJson<{ reports: SavedReport[] }>(app, admin, '/api/analytics/reports');
    assert.equal(list.reports.length, 1);

    const exported = await app.request(`/api/analytics/reports/${id}/export.csv`, {
      headers: { cookie: admin },
    });
    assert.equal(exported.status, 200);
    assert.match(exported.headers.get('content-type') ?? '', /text\/csv/);
    const text = await exported.text();
    assert.ok(text.startsWith('bucket,label,revenue'));

    const member = await login(app, DEMO.viewer.email);
    const memberList = await getJson<{ reports: SavedReport[] }>(
      app,
      member,
      '/api/analytics/reports',
    );
    assert.equal(memberList.reports.length, 0);
    const hidden = await app.request(`/api/analytics/reports/${id}/export.csv`, {
      headers: { cookie: member },
    });
    assert.equal(hidden.status, 404);

    const updated = await sendJson<{ report: SavedReport }>(
      app,
      admin,
      'PATCH',
      `/api/analytics/reports/${id}`,
      { frequency: 'none', name: '每周收入（暂停）' },
    );
    assert.equal(updated.status, 200);
    assert.equal(updated.body.report.frequency, 'none');
    assert.equal(updated.body.report.nextRunAt, null);

    const removed = await app.request(`/api/analytics/reports/${id}`, {
      method: 'DELETE',
      headers: { cookie: admin },
    });
    assert.equal(removed.status, 204);
  } finally {
    store.close();
  }
});

test('due scheduled reports are queued once into the mail outbox', () => {
  const store = testStore();
  try {
    const admin = store.users.authByEmail(DEMO.admin.email);
    assert.ok(admin);
    const report = store.reports.create(
      admin.id,
      { name: '定时周报', query: { kind: 'revenue', range: '7d' }, frequency: 'weekly' },
      TEST_NOW,
    );
    assert.ok(report.nextRunAt);

    const now = new Date(TEST_NOW.getTime() + 8 * 86_400_000);
    assert.equal(store.reports.enqueueDue(now, store.notifications), 1);
    const mail = store.notifications
      .pendingMail(now, 50)
      .filter((row) => row.subject.includes('定时周报'));
    assert.equal(mail.length, 1);
    assert.match(mail[0]?.body ?? '', /^报表范围 \d{4}-\d{2}-\d{2} ~ \d{4}-\d{2}-\d{2}/);

    assert.equal(store.reports.enqueueDue(now, store.notifications), 0, 'the schedule advances');
    const [saved] = store.reports.list(admin.id);
    assert.ok(saved?.lastRunAt);
    assert.ok(saved?.nextRunAt && saved.nextRunAt > now.toISOString());
  } finally {
    store.close();
  }
});
