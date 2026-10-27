import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { Hono } from 'hono';
import { bodyLimit, rateLimit } from '../src/middleware/limits.ts';
import { hostAllowed } from '../src/net.ts';
import { login, startServer, testApp, testStore, waitFor } from './helpers.ts';

process.env.LOG_LEVEL = 'silent';

after(() => {
  delete process.env.RATE_LIMIT_MAX;
});

function postJson(
  app: ReturnType<typeof testApp>['app'],
  body: unknown,
  headers: Record<string, string> = {},
) {
  return app.request('/api/projects', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

test('cross-origin mutations are rejected while same-origin requests pass', async () => {
  const store = testStore();
  try {
    const { app } = testApp(store);
    const cookie = await login(app);
    assert.equal(store.projects.total(), 8);

    const evil = await postJson(
      app,
      { name: 'csrf' },
      {
        cookie,
        origin: 'http://evil.example',
        host: 'localhost',
      },
    );
    assert.equal(evil.status, 403);
    assert.equal(((await evil.json()) as { error: string }).error, 'forbidden_origin');

    const sandboxed = await postJson(app, { name: 'null origin' }, { cookie, origin: 'null' });
    assert.equal(sandboxed.status, 403);

    const sameOrigin = await postJson(
      app,
      { name: 'same origin' },
      {
        cookie,
        origin: 'http://localhost',
        host: 'localhost',
      },
    );
    assert.equal(sameOrigin.status, 201);

    const native = await postJson(app, { name: 'no origin header' }, { cookie });
    assert.equal(native.status, 201, 'non-browser clients without Origin stay allowed');
    assert.equal(store.projects.total(), 10, 'rejected requests never touched the store');
  } finally {
    store.close();
  }
});

test('configured development origins are trusted', async () => {
  const store = testStore();
  try {
    const { app } = testApp(store, { allowedOrigins: ['http://localhost:5173'] });
    const cookie = await login(app);
    const res = await postJson(
      app,
      { name: 'vite dev' },
      {
        cookie,
        origin: 'http://localhost:5173',
        host: 'localhost:3000',
      },
    );
    assert.equal(res.status, 201);
  } finally {
    store.close();
  }
});

test('unknown Host names are rejected to block DNS rebinding', async () => {
  const store = testStore();
  try {
    const { app } = testApp(store);
    const blocked = await app.request('/api/health', { headers: { host: 'evil.example' } });
    assert.equal(blocked.status, 403);
    assert.equal(((await blocked.json()) as { error: string }).error, 'untrusted_host');

    for (const host of ['localhost:3000', '127.0.0.1:3000', '[::1]:3000']) {
      const res = await app.request('/api/health', { headers: { host } });
      assert.equal(res.status, 200, `${host} should be trusted`);
    }
  } finally {
    store.close();
  }
});

test('configured hostnames pass the host allowlist', async () => {
  const store = testStore();
  try {
    const { app } = testApp(store, { allowedHosts: ['intranet.local'] });
    assert.equal(
      (await app.request('/api/health', { headers: { host: 'intranet.local:3000' } })).status,
      200,
    );
    assert.equal(
      (await app.request('/api/health', { headers: { host: 'other.local:3000' } })).status,
      403,
    );
  } finally {
    store.close();
  }
});

test('host validation helper covers localhost, IPs and allowlists', () => {
  assert.equal(hostAllowed('localhost:3000', []), true);
  assert.equal(hostAllowed('app.localhost:3000', []), true);
  assert.equal(hostAllowed('127.0.0.1:3000', []), true);
  assert.equal(hostAllowed('[::1]:3000', []), true);
  assert.equal(hostAllowed('evil.example', []), false);
  assert.equal(hostAllowed('evil.example', ['*']), true);
  assert.equal(hostAllowed('evil.example', ['evil.example']), true);
  assert.equal(hostAllowed(undefined, []), true);
  assert.equal(hostAllowed('bad host', []), false);
});

test('rate limiting ignores spoofed forwarding headers by default', async () => {
  const store = testStore();
  try {
    const { app } = testApp(store, { rateLimitMax: 2 });
    for (let index = 0; index < 2; index++) {
      const res = await app.request('/api/health', {
        headers: { 'x-forwarded-for': `10.0.0.${index}` },
      });
      assert.equal(res.status, 200);
    }
    const blocked = await app.request('/api/health', {
      headers: { 'x-forwarded-for': '10.0.0.99' },
    });
    assert.equal(blocked.status, 429, 'rotating X-Forwarded-For must not reset the bucket');
  } finally {
    store.close();
  }
});

test('forwarding headers are honored when TRUST_PROXY is configured', async () => {
  const store = testStore();
  try {
    const { app } = testApp(store, { rateLimitMax: 1, trustProxy: true });
    for (const ip of ['10.0.0.1', '10.0.0.2', '10.0.0.3']) {
      const res = await app.request('/api/health', { headers: { 'x-forwarded-for': ip } });
      assert.equal(res.status, 200, `${ip} should get its own bucket`);
    }
    const repeated = await app.request('/api/health', {
      headers: { 'x-forwarded-for': '10.0.0.3' },
    });
    assert.equal(repeated.status, 429);
  } finally {
    store.close();
  }
});

test('chunked bodies are size-limited before parsing', async () => {
  const store = testStore();
  try {
    const { app } = testApp(store);
    const cookie = await login(app);
    const oversized = await app.request('/api/projects', {
      method: 'POST',
      headers: {
        cookie,
        'content-type': 'application/json',
        'transfer-encoding': 'chunked',
      },
      body: JSON.stringify({ name: 'x'.repeat(70 * 1024) }),
    });
    assert.equal(oversized.status, 413);

    const accepted = await app.request('/api/projects', {
      method: 'POST',
      headers: {
        cookie,
        'content-type': 'application/json',
        'transfer-encoding': 'chunked',
      },
      body: JSON.stringify({ name: 'chunked but small' }),
    });
    assert.equal(accepted.status, 201);
  } finally {
    store.close();
  }
});

test('SSE connection caps are enforced and released on disconnect', async () => {
  const store = testStore();
  const { app, hub } = testApp(store, { maxSseClients: 1 });
  const cookie = await login(app);
  const { base, close } = await startServer(app);
  const controller = new AbortController();

  try {
    const first = await fetch(`${base}/api/events`, {
      headers: { cookie },
      signal: controller.signal,
    });
    assert.equal(first.status, 200);
    const reader = first.body!.getReader();
    await reader.read();
    await waitFor(() => hub.size === 1);

    const second = await fetch(`${base}/api/events`, { headers: { cookie } });
    assert.equal(second.status, 429);
    assert.equal(((await second.json()) as { error: string }).error, 'too_many_connections');

    controller.abort();
    await reader.cancel().catch(() => {});
    await waitFor(() => hub.size === 0);

    const third = await fetch(`${base}/api/events`, {
      headers: { cookie },
      signal: AbortSignal.timeout(3_000),
    });
    assert.equal(third.status, 200);
    await third.body?.cancel();
  } finally {
    controller.abort();
    hub.closeAll();
    await close();
    store.close();
  }
});

test('unauthenticated SSE connections are refused', async () => {
  const store = testStore();
  const { app, hub } = testApp(store);
  const { base, close } = await startServer(app);
  try {
    const res = await fetch(`${base}/api/events`);
    assert.equal(res.status, 401);
    assert.equal(((await res.json()) as { error: string }).error, 'unauthorized');
    assert.equal(hub.size, 0);
  } finally {
    hub.closeAll();
    await close();
    store.close();
  }
});

test('rate limiter prunes the bucket map under address churn', async () => {
  const app = new Hono();
  app.use('*', rateLimit({ max: 1, trustProxy: true }));
  app.get('/ping', (c) => c.text('pong'));

  for (let index = 0; index < 5_001; index++) {
    const ip = `10.${(index >> 16) & 255}.${(index >> 8) & 255}.${index & 255}`;
    const res = await app.request('/ping', { headers: { 'x-forwarded-for': ip } });
    assert.equal(res.status, 200);
  }

  const fresh = { headers: { 'x-forwarded-for': '172.16.9.9' } };
  assert.equal(
    (await app.request('/ping', fresh)).status,
    200,
    'evicted map still admits new keys',
  );
  assert.equal((await app.request('/ping', fresh)).status, 429, 'new keys keep their own counters');
});

test('unreadable request streams are rejected with 400', async () => {
  const app = new Hono();
  app.use('*', bodyLimit({ defaultBytes: 1024 }));
  app.post('/echo', async (c) => c.text(await c.req.text()));

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.error(new Error('boom'));
    },
  });
  const res = await app.request('/echo', { method: 'POST', body, duplex: 'half' } as RequestInit);
  assert.equal(res.status, 400);
  assert.equal(((await res.json()) as { error: string }).error, 'invalid_body');
});

test('Fetch Metadata blocks cross-site mutations even without an Origin header', async () => {
  const store = testStore();
  try {
    const { app } = testApp(store);
    const cookie = await login(app);

    const crossSite = await postJson(
      app,
      { name: 'metadata csrf' },
      {
        cookie,
        'sec-fetch-site': 'cross-site',
      },
    );
    assert.equal(crossSite.status, 403);
    assert.equal(((await crossSite.json()) as { error: string }).error, 'forbidden_origin');

    const sameSite = await postJson(
      app,
      { name: 'metadata same origin' },
      {
        cookie,
        'sec-fetch-site': 'same-origin',
      },
    );
    assert.equal(sameSite.status, 201);
  } finally {
    store.close();
  }
});

test('production deployments hide metrics and API docs by default', async () => {
  const store = testStore();
  try {
    const { app } = testApp(store, { metricsPublic: false, enableDocs: false });
    assert.equal((await app.request('/metrics')).status, 404);
    assert.equal((await app.request('/api/openapi.json')).status, 404);
    assert.equal((await app.request('/api/doc')).status, 404);
  } finally {
    store.close();
  }
});

test('metrics require the configured bearer token', async () => {
  const store = testStore();
  try {
    const { app } = testApp(store, { metricsToken: 's3cret-token' });
    const denied = await app.request('/metrics');
    assert.equal(denied.status, 401);
    assert.equal(denied.headers.get('www-authenticate'), 'Bearer');

    const allowed = await app.request('/metrics', {
      headers: { authorization: 'Bearer s3cret-token' },
    });
    assert.equal(allowed.status, 200);
    assert.match(await allowed.text(), /node_pulse_http_requests_total|node_pulse_/);
  } finally {
    store.close();
  }
});
