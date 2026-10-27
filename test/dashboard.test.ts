import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DashboardSummary, KpiValue, RangeInfo, RevenueReport } from '../shared/types.ts';
import { DEMO, getJson, login, sendJson, testApp, testStore } from './helpers.ts';

type ChannelsReport = {
  channels: { channel: string; sessions: number; share: number; delta: number | null }[];
  total: number;
};

type AudienceReport = {
  range: RangeInfo;
  customers: number;
  visitors: number;
  conversion: number;
  conversionDelta: number | null;
  daily: { date: string; value: number }[];
};

async function adminContext() {
  const store = testStore();
  const { app } = testApp(store);
  const cookie = await login(app, DEMO.admin.email);
  return { store, app, cookie };
}

test('dashboard summary resolves ranges and returns comparison KPIs', async () => {
  const { store, app, cookie } = await adminContext();
  try {
    const summary = await getJson<DashboardSummary>(app, cookie, '/api/dashboard/summary?range=7d');

    assert.equal(summary.range.key, '7d');
    assert.equal(summary.range.from, '2026-06-09');
    assert.equal(summary.range.to, '2026-06-15');
    assert.equal(summary.range.days, 7);
    assert.equal(summary.range.previous.from, '2026-06-02');
    assert.equal(summary.range.previous.to, '2026-06-08');
    assert.equal(summary.demo, true);

    for (const key of ['revenue', 'customers', 'conversion'] as const) {
      const kpi: KpiValue = summary.kpis[key];
      assert.ok(kpi.value > 0, `${key} should have data`);
      assert.ok(kpi.previous !== null && kpi.previous > 0);
      assert.equal(typeof kpi.delta, 'number');
      assert.equal(kpi.sparkline.length, 7, `${key} sparkline covers every day`);
      assert.equal(kpi.sparkline.at(-1)?.date, '2026-06-15');
    }
    assert.equal(summary.kpis.revenue.format, 'currency');
    assert.equal(summary.kpis.conversion.format, 'percent');

    assert.equal(summary.revenue.length, 7);
    assert.ok(summary.revenue.every((point) => point.revenue > 0));

    assert.equal(summary.channels.length, 4);
    const share = summary.channels.reduce((sum, slice) => sum + slice.share, 0);
    assert.ok(Math.abs(share - 100) < 0.5, `channel shares add up to ${share}`);

    assert.equal(summary.projects.total, 8);
    assert.equal(summary.projects.completed, 1);
    assert.ok(summary.activities.length > 0);
    assert.ok(summary.runtime?.sqlite);
  } finally {
    store.close();
  }
});

test('month and last-month windows are resolved from the fixed clock', async () => {
  const { store, app, cookie } = await adminContext();
  try {
    const month = await getJson<DashboardSummary>(
      app,
      cookie,
      '/api/dashboard/summary?range=month',
    );
    assert.equal(month.range.from, '2026-06-01');
    assert.equal(month.range.to, '2026-06-15');
    assert.equal(month.range.days, 15);
    assert.equal(month.range.previous.from, '2026-05-17');
    assert.equal(month.range.previous.to, '2026-05-31');
    assert.equal(month.revenue.length, 15);

    const last = await getJson<DashboardSummary>(
      app,
      cookie,
      '/api/dashboard/summary?range=last_month',
    );
    assert.equal(last.range.from, '2026-05-01');
    assert.equal(last.range.to, '2026-05-31');
    assert.equal(last.range.previous.from, '2026-03-31');
    assert.equal(last.range.previous.to, '2026-04-30');
    assert.equal(last.range.days, 31);
  } finally {
    store.close();
  }
});

test('invalid custom ranges are rejected', async () => {
  const { store, app, cookie } = await adminContext();
  try {
    for (const query of [
      'range=bogus',
      'range=custom',
      'range=custom&from=2026-06-10',
      'range=custom&from=2026-06-10&to=2026-06-01',
      'range=custom&from=2026-02-30&to=2026-03-01',
      'range=custom&from=2025-01-01&to=2026-06-15',
    ]) {
      const res = await app.request(`/api/dashboard/summary?${query}`, {
        headers: { cookie },
      });
      assert.equal(res.status, 400, `${query} should be rejected`);
      assert.equal(((await res.json()) as { error: string }).error, 'invalid_request');
    }

    const valid = await app.request(
      '/api/dashboard/summary?range=custom&from=2026-06-01&to=2026-06-15',
      { headers: { cookie } },
    );
    assert.equal(valid.status, 200);
  } finally {
    store.close();
  }
});

test('an empty analytics dataset reports zero values without fake deltas', async () => {
  const store = testStore({ demo: false });
  try {
    const { app } = testApp(store);
    const cookie = await login(app, DEMO.admin.email);
    const summary = await getJson<DashboardSummary>(app, cookie, '/api/dashboard/summary?range=7d');

    assert.equal(summary.kpis.revenue.value, 0);
    assert.equal(summary.kpis.revenue.previous, null);
    assert.equal(summary.kpis.revenue.delta, null);
    assert.equal(summary.kpis.conversion.delta, null);
    assert.ok(summary.revenue.every((point) => point.revenue === 0));
    assert.ok(summary.channels.every((slice) => slice.sessions === 0 && slice.share === 0));
    assert.equal(summary.projects.total, 0);
  } finally {
    store.close();
  }
});

test('revenue reports bucket by day, week and month', async () => {
  const { store, app, cookie } = await adminContext();
  try {
    const daily = await getJson<RevenueReport>(app, cookie, '/api/analytics/revenue?range=7d');
    assert.equal(daily.granularity, 'day');
    assert.equal(daily.points.length, 7);
    assert.equal(daily.comparison, true);
    assert.ok(daily.points.every((point) => point.previous !== null));
    assert.ok(daily.total > 0 && daily.previousTotal !== null && daily.previousTotal > 0);

    const weekly = await getJson<RevenueReport>(
      app,
      cookie,
      '/api/analytics/revenue?range=30d&granularity=week',
    );
    assert.equal(weekly.granularity, 'week');
    assert.ok(weekly.points.length >= 4 && weekly.points.length <= 6);
    assert.match(weekly.points[0]?.label ?? '', /周/);

    const monthly = await getJson<RevenueReport>(
      app,
      cookie,
      '/api/analytics/revenue?range=month&granularity=month',
    );
    assert.equal(monthly.granularity, 'month');
    assert.equal(monthly.points.length, 1);
    assert.equal(monthly.points[0]?.bucket, '2026-06-01');
    assert.equal(monthly.points[0]?.label, '2026-06');

    const withoutComparison = await getJson<RevenueReport>(
      app,
      cookie,
      '/api/analytics/revenue?range=7d&compare=0',
    );
    assert.equal(withoutComparison.comparison, false);
    assert.equal(withoutComparison.previousTotal, null);
    assert.equal(withoutComparison.delta, null);
    assert.ok(withoutComparison.points.every((point) => point.previous === null));
  } finally {
    store.close();
  }
});

test('automatic granularity widens with the range', async () => {
  const { store, app, cookie } = await adminContext();
  try {
    const short = await getJson<RevenueReport>(
      app,
      cookie,
      '/api/analytics/revenue?range=custom&from=2026-05-01&to=2026-05-31',
    );
    assert.equal(short.granularity, 'day');

    const medium = await getJson<RevenueReport>(
      app,
      cookie,
      '/api/analytics/revenue?range=custom&from=2026-03-01&to=2026-04-30',
    );
    assert.equal(medium.granularity, 'week');

    const long = await getJson<RevenueReport>(
      app,
      cookie,
      '/api/analytics/revenue?range=custom&from=2025-12-01&to=2026-06-15',
    );
    assert.equal(long.granularity, 'month');
  } finally {
    store.close();
  }
});

test('channel and audience reports expose totals and deltas', async () => {
  const { store, app, cookie } = await adminContext();
  try {
    const channels = await getJson<ChannelsReport>(app, cookie, '/api/analytics/channels?range=7d');
    assert.equal(channels.channels.length, 4);
    assert.ok(channels.total > 0);
    assert.ok(channels.channels.every((slice) => slice.sessions > 0));
    assert.ok(channels.channels.every((slice) => slice.delta !== null));

    const audience = await getJson<AudienceReport>(app, cookie, '/api/analytics/audience?range=7d');
    assert.equal(audience.daily.length, 7);
    assert.ok(audience.customers > 0);
    assert.ok(audience.visitors > audience.customers);
    assert.ok(audience.conversion > 0 && audience.conversion < 100);
    assert.equal(typeof audience.conversionDelta, 'number');
  } finally {
    store.close();
  }
});

test('three 366-day reports finish within the synchronous budget', async () => {
  const { store, app, cookie } = await adminContext();
  try {
    const query = 'range=custom&from=2025-06-15&to=2026-06-15';
    const started = performance.now();
    const summary = await getJson<DashboardSummary>(app, cookie, `/api/dashboard/summary?${query}`);
    const audience = await getJson<AudienceReport>(app, cookie, `/api/analytics/audience?${query}`);
    const revenue = await getJson<RevenueReport>(app, cookie, `/api/analytics/revenue?${query}`);
    const elapsed = performance.now() - started;

    assert.equal(summary.range.days, 366);
    assert.equal(audience.daily.length, 366);
    assert.equal(audience.daily[0]?.date, '2025-06-15');
    assert.equal(audience.daily.at(-1)?.date, '2026-06-15');
    assert.ok(revenue.points.length >= 12);
    assert.ok(elapsed < 1_500, `three 366-day reports took ${elapsed.toFixed(0)}ms`);
  } finally {
    store.close();
  }
});

test('project analytics respect visibility', async () => {
  const store = testStore();
  try {
    const { app } = testApp(store);
    for (const [role, total] of [
      ['admin', 8],
      ['manager', 8],
      ['pm', 3],
      ['viewer', 5],
    ] as const) {
      const cookie = await login(app, DEMO[role].email);
      const report = await getJson<{ overview: { total: number }; counts: { all: number } }>(
        app,
        cookie,
        '/api/analytics/projects',
      );
      assert.equal(report.overview.total, total, `${role} project overview`);
      assert.equal(report.counts.all, total);
    }

    const viewerCookie = await login(app, DEMO.viewer.email);
    const blockedUpdate = await sendJson(app, viewerCookie, 'PATCH', '/api/profiles', {
      name: 'x',
    });
    assert.equal(blockedUpdate.status, 404, 'unknown API routes still return JSON 404');
  } finally {
    store.close();
  }
});

test('dashboard ranges follow WORKSPACE_TIMEZONE across midnight', async () => {
  const previous = process.env.WORKSPACE_TIMEZONE;
  process.env.WORKSPACE_TIMEZONE = 'America/New_York';
  const store = testStore({ now: new Date('2026-06-16T02:00:00.000Z') });
  const { app } = testApp(store);
  try {
    const cookie = await login(app, DEMO.admin.email);
    const summary = await getJson<DashboardSummary>(
      app,
      cookie,
      '/api/dashboard/summary?range=today',
    );

    assert.equal(summary.range.timezone, 'America/New_York');
    assert.equal(summary.range.from, '2026-06-15');
    assert.equal(summary.range.to, '2026-06-15');
    assert.equal(summary.kpis.revenue.sparkline.at(-1)?.date, '2026-06-15');
    assert.ok(summary.kpis.revenue.value > 0, 'demo data exists for the local day');
  } finally {
    store.close();
    if (previous === undefined) delete process.env.WORKSPACE_TIMEZONE;
    else process.env.WORKSPACE_TIMEZONE = previous;
  }
});
