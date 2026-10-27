import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { createApp } from '../src/app.ts';
import { log } from '../src/logger.ts';
import { EventHub } from '../src/sse.ts';
import { DEMO, login, testStore } from './helpers.ts';

function makeApp(options: Parameters<typeof createApp>[2] = {}) {
  const store = testStore();
  const hub = new EventHub();
  return { store, app: createApp(store, hub, options) };
}

describe('security headers and docs', () => {
  test('responses carry a strict CSP and hardening headers', async () => {
    const { store, app } = makeApp();
    try {
      const res = await app.request('/api/health');
      assert.equal(res.status, 200);
      const csp = res.headers.get('content-security-policy') ?? '';
      assert.match(csp, /default-src 'self'/);
      assert.match(csp, /script-src 'self'/);
      assert.doesNotMatch(csp, /script-src[^;]*unsafe-inline/);
      assert.match(csp, /frame-ancestors 'none'/);
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(res.headers.get('x-frame-options'), 'DENY');
      assert.match(res.headers.get('permissions-policy') ?? '', /camera=\(\)/);
      assert.ok(res.headers.get('x-request-id'));
    } finally {
      store.close();
    }
  });

  test('OpenAPI JSON and Scalar docs expose the v2 routes', async () => {
    const { store, app } = makeApp();
    try {
      const spec = (await (await app.request('/api/openapi.json')).json()) as {
        openapi: string;
        paths: Record<string, unknown>;
      };
      assert.equal(spec.openapi, '3.1.0');
      for (const path of [
        '/api/auth/login',
        '/api/dashboard/summary',
        '/api/projects',
        '/api/projects/{id}',
        '/api/activities',
        '/api/users',
      ]) {
        assert.ok(spec.paths[path], `expected ${path} in the OpenAPI document`);
      }
      assert.equal(spec.paths['/api/tasks'], undefined, 'task endpoints are gone');

      const doc = await app.request('/api/doc');
      assert.equal(doc.status, 200);
      assert.match(doc.headers.get('content-type') ?? '', /text\/html/);
      assert.match(doc.headers.get('content-security-policy') ?? '', /cdn\.jsdelivr\.net/);
      assert.match(await doc.text(), /api\/openapi\.json/);
    } finally {
      store.close();
    }
  });
});

describe('request limits', () => {
  test('rate limiting returns 429 once the window is exhausted', async () => {
    const { store, app } = makeApp({ rateLimitMax: 3 });
    try {
      for (let index = 0; index < 3; index++) {
        const ok = await app.request('/api/health');
        assert.equal(ok.status, 200);
        assert.equal(ok.headers.get('x-ratelimit-limit'), '3');
      }
      const limited = await app.request('/api/health');
      assert.equal(limited.status, 429);
      assert.equal(limited.headers.get('x-ratelimit-remaining'), '0');
      assert.ok(Number(limited.headers.get('retry-after')) > 0);
      assert.equal(((await limited.json()) as { error: string }).error, 'rate_limited');

      const docs = await app.request('/api/openapi.json');
      assert.equal(docs.status, 200, 'docs bypass the general limit');
    } finally {
      store.close();
    }
  });

  test('oversized bodies are rejected with 413 before authentication', async () => {
    const { store, app } = makeApp();
    try {
      const body = JSON.stringify({ name: 'x'.repeat(70 * 1024) });
      const res = await app.request('/api/projects', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': String(body.length) },
        body,
      });
      assert.equal(res.status, 413);
      assert.equal(((await res.json()) as { error: string }).error, 'payload_too_large');

      const chunked = await app.request('/api/projects', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'transfer-encoding': 'chunked' },
        body,
      });
      assert.equal(chunked.status, 413);
    } finally {
      store.close();
    }
  });
});

test('metrics fold unknown paths and count traffic', async () => {
  const { store, app } = makeApp();
  try {
    await app.request('/api/health');
    await app.request('/api/projects');
    await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: DEMO.admin.email, password: 'wrong-password' }),
    });
    const cookie = await login(app, DEMO.admin.email);
    await app.request('/api/projects/does-not-exist', { headers: { cookie } });
    for (let index = 0; index < 5; index++) await app.request(`/api/probe-${index}`);
    await app.request('/assets/random-file.js');

    const res = await app.request('/metrics');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/plain/);
    const body = await res.text();
    assert.match(
      body,
      /node_pulse_http_requests_total\{method="GET",route="\/api\/health",status="200"\} 1/,
    );
    assert.match(
      body,
      /node_pulse_http_requests_total\{method="GET",route="\/api\/projects",status="401"\} 1/,
    );
    assert.match(
      body,
      /node_pulse_http_requests_total\{method="GET",route="\/api\/projects\/:id",status="404"\} 1/,
    );
    assert.match(body, /route="\/api\/\(other\)"/);
    assert.match(body, /route="\/assets\/:file"/);
    assert.doesNotMatch(body, /probe-/);
    assert.match(body, /node_pulse_http_request_duration_ms_count\{route="\/api\/health"\} 1/);
    assert.match(body, /node_pulse_http_request_duration_ms_sum\{route="\/api\/health"\} \d/);
    assert.match(body, /node_pulse_sse_clients 0/);
    assert.match(body, /node_pulse_ws_clients 0/);
    assert.match(body, /node_pulse_login_failures_total 1/);
    assert.match(body, /node_pulse_slow_queries_total \d+/);
  } finally {
    store.close();
  }
});

test('liveness stays cheap while readiness verifies the database', async () => {
  const { store, app } = makeApp();
  try {
    const live = await app.request('/api/health');
    assert.equal(live.status, 200);
    const liveBody = (await live.json()) as { ok: boolean; status: string };
    assert.equal(liveBody.ok, true);
    assert.equal(liveBody.status, 'live');

    const ready = await app.request('/api/health/ready');
    assert.equal(ready.status, 200);
    const body = (await ready.json()) as {
      status: string;
      checks: { database: string; lifecycle: string };
      runtime: { node: string } | null;
    };
    assert.equal(body.status, 'ready');
    assert.equal(body.checks.database, 'ok');
    assert.equal(body.checks.lifecycle, 'ok');
    assert.ok(body.runtime?.node);
  } finally {
    store.close();
  }
});

test('readiness fails while draining but liveness keeps answering', async () => {
  let ready = true;
  const { store, app } = makeApp({ isReady: () => ready });
  try {
    assert.equal((await app.request('/api/health/ready')).status, 200);
    ready = false;
    const draining = await app.request('/api/health/ready');
    assert.equal(draining.status, 503);
    const body = (await draining.json()) as {
      ok: boolean;
      checks: { database: string; lifecycle: string };
    };
    assert.equal(body.ok, false);
    assert.equal(body.checks.lifecycle, 'draining');
    assert.equal(body.checks.database, 'ok');
    assert.equal((await app.request('/api/health')).status, 200);
  } finally {
    store.close();
  }
});

test('readiness reports a broken database as unready', async () => {
  const { store, app } = makeApp();
  store.close();
  assert.equal(store.db.quickCheck(), false);
  const res = await app.request('/api/health/ready');
  assert.equal(res.status, 503);
  const body = (await res.json()) as {
    ok: boolean;
    checks: { database: string };
    runtime: unknown;
  };
  assert.equal(body.ok, false);
  assert.equal(body.checks.database, 'failed');
  assert.equal(body.runtime, null);
});

test('log fields redact credentials and nested secrets', () => {
  const lines: string[] = [];
  const original = console.error;
  const previousLevel = process.env.LOG_LEVEL;
  process.env.LOG_LEVEL = 'error';
  console.error = (line: unknown) => {
    lines.push(String(line));
  };
  try {
    log('error', 'test.redact', {
      reqId: 'abc',
      cookie: 'session=secret',
      password: 'hunter2',
      nested: { resetToken: 'token-value', safe: 'visible' },
    });
  } finally {
    console.error = original;
    if (previousLevel === undefined) delete process.env.LOG_LEVEL;
    else process.env.LOG_LEVEL = previousLevel;
  }
  const entry = JSON.parse(lines[0]!) as Record<string, unknown>;
  assert.equal(entry.cookie, '[redacted]');
  assert.equal(entry.password, '[redacted]');
  assert.deepEqual(entry.nested, { resetToken: '[redacted]', safe: 'visible' });
  assert.equal(entry.reqId, 'abc');
});

test('metrics can be token protected and rate limited', async () => {
  const secured = makeApp({ metricsToken: 's3cret-token' });
  try {
    assert.equal((await secured.app.request('/metrics')).status, 401);
    assert.equal(
      (
        await secured.app.request('/metrics', {
          headers: { authorization: 'Bearer nope' },
        })
      ).status,
      401,
    );
    const ok = await secured.app.request('/metrics', {
      headers: { authorization: 'Bearer s3cret-token' },
    });
    assert.equal(ok.status, 200);
  } finally {
    secured.store.close();
  }

  const limited = makeApp({ rateLimitMax: 1 });
  try {
    const first = await limited.app.request('/metrics');
    assert.equal(first.status, 200);
    assert.match(first.headers.get('permissions-policy') ?? '', /camera=\(\)/);
    assert.equal((await limited.app.request('/metrics')).status, 429);
  } finally {
    limited.store.close();
  }
});

test('responses are gzip-compressed when the client accepts it', async () => {
  const { store, app } = makeApp();
  try {
    const res = await app.request('/api/openapi.json', {
      headers: { 'accept-encoding': 'gzip' },
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-encoding'), 'gzip');
    assert.match(res.headers.get('vary') ?? '', /accept-encoding/i);
    await res.body?.cancel();
  } finally {
    store.close();
  }
});

test('static assets cache immutably, HTML revalidates and deep links fall back', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'clay-static-'));
  mkdirSync(join(dir, 'assets'), { recursive: true });
  writeFileSync(join(dir, 'assets', 'app.js'), 'console.log(1);');
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>Clay</title>');
  const { store, app } = makeApp({ staticDir: dir });

  try {
    const asset = await app.request('/assets/app.js');
    assert.equal(asset.status, 200);
    assert.equal(asset.headers.get('cache-control'), 'public, max-age=31536000, immutable');

    const index = await app.request('/index.html');
    assert.equal(index.status, 200);
    assert.equal(index.headers.get('cache-control'), 'no-cache');

    const root = await app.request('/');
    assert.equal(root.status, 200);
    assert.match(await root.text(), /<title>Clay<\/title>/);
    assert.equal(root.headers.get('cache-control'), 'no-cache');

    const deepLink = await app.request('/projects/some-id/settings');
    assert.equal(deepLink.status, 200);
    assert.match(await deepLink.text(), /<title>Clay<\/title>/);

    const missingAsset = await app.request('/assets/missing.js');
    assert.equal(missingAsset.status, 404);

    const dotted = await app.request('/projects/a.file');
    assert.equal(dotted.status, 404, 'paths that look like files do not fall back to the SPA');

    const unknownApi = await app.request('/api/unknown/route');
    assert.equal(unknownApi.status, 401, 'API paths never fall back to HTML');
    assert.match(unknownApi.headers.get('content-type') ?? '', /application\/json/);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
