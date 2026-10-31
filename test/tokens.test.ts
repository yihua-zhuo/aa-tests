import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Hono } from 'hono';
import type {
  AuditPage,
  TokenCreateResult,
  TokenList,
  WebhookCreateResult,
} from '../shared/types.ts';
import type { AppEnv } from '../src/app-env.ts';
import { DEMO, getJson, login, sendJson, testApp, testStore } from './helpers.ts';

async function createToken(
  app: Hono<AppEnv>,
  cookie: string,
  body: Record<string, unknown>,
): Promise<TokenCreateResult> {
  const result = await sendJson<TokenCreateResult>(
    app,
    cookie,
    'POST',
    '/api/profile/tokens',
    body,
  );
  assert.equal(result.status, 201, JSON.stringify(result.body));
  return result.body;
}

function bearer(
  app: Hono<AppEnv>,
  token: string,
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<Response> {
  return Promise.resolve(
    app.request(path, {
      method: init.method ?? 'GET',
      headers: {
        authorization: `Bearer ${token}`,
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    }),
  );
}

test('personal access tokens authenticate with read scope and enforce write scope', async () => {
  const store = testStore();
  const { app } = testApp(store, { tokenQuotaMax: 30 });
  const cookie = await login(app);
  try {
    const created = await createToken(app, cookie, {
      name: '报表只读',
      scopes: ['read'],
      expiresInDays: 30,
    });
    assert.match(created.token, /^clp_[A-Za-z0-9_-]{40,}$/);
    assert.equal(created.item.name, '报表只读');
    assert.deepEqual(created.item.scopes, ['read']);
    assert.ok(created.item.expiresAt);
    assert.equal(created.item.revokedAt, null);

    const list = await getJson<TokenList>(app, cookie, '/api/profile/tokens');
    assert.equal(list.tokens.length, 1);
    assert.equal(list.quota.max, 30);
    assert.ok(!JSON.stringify(list).includes(created.token), 'raw token is never stored');

    const read = await bearer(app, created.token, '/api/projects');
    assert.equal(read.status, 200);
    assert.equal(read.headers.get('x-ratelimit-limit'), '30');

    const denied = await bearer(app, created.token, '/api/projects', {
      method: 'POST',
      body: { name: '令牌不应创建' },
    });
    assert.equal(denied.status, 403);
    assert.equal(((await denied.json()) as { error: string }).error, 'insufficient_scope');

    const management = await bearer(app, created.token, '/api/profile/tokens');
    assert.equal(management.status, 403);
    assert.equal(((await management.json()) as { error: string }).error, 'session_required');

    const webhooks = await bearer(app, created.token, '/api/profile/webhooks');
    assert.equal(webhooks.status, 403);

    for (const path of ['/api/ocr/lab', '/api/ocr/registry', '/api/ocr/feedback']) {
      const ocr = await bearer(app, created.token, path);
      assert.equal(ocr.status, 403, path);
      assert.equal(((await ocr.json()) as { error: string }).error, 'session_required', path);
    }
    const ocrWrite = await bearer(app, created.token, '/api/ocr/registry/evaluate', {
      method: 'POST',
      body: {},
    });
    assert.equal(ocrWrite.status, 403);
    assert.equal(
      ((await ocrWrite.json()) as { error: string }).error,
      'session_required',
      'session-only check precedes scope checks',
    );

    const writer = await createToken(app, cookie, {
      name: '自动化写入',
      scopes: ['write'],
      expiresInDays: null,
    });
    const write = await bearer(app, writer.token, '/api/projects', {
      method: 'POST',
      body: { name: '令牌写入项目' },
    });
    assert.equal(write.status, 201, await write.text());

    const audit = await getJson<AuditPage>(app, cookie, '/api/audit?action=token.created');
    assert.equal(audit.total, 2);
    assert.ok(audit.entries.every((entry) => entry.action === 'token.created'));

    const refreshed = await getJson<TokenList>(app, cookie, '/api/profile/tokens');
    const readToken = refreshed.tokens.find((token) => token.id === created.item.id);
    assert.ok(readToken?.lastUsedAt, 'token usage updates lastUsedAt');
  } finally {
    store.close();
  }
});

test('tokens expire, can be revoked and respect disabled accounts', async () => {
  const store = testStore();
  const { app } = testApp(store);
  const cookie = await login(app);
  try {
    const expiring = await createToken(app, cookie, {
      name: '即将过期',
      scopes: ['read'],
      expiresInDays: 1,
    });
    store.db
      .stmt('UPDATE personal_access_tokens SET expires_at = ? WHERE id = ?')
      .run(new Date(Date.now() - 1000).toISOString(), expiring.item.id);
    assert.equal((await bearer(app, expiring.token, '/api/projects')).status, 401);

    const revoked = await createToken(app, cookie, {
      name: '待吊销',
      scopes: ['read'],
      expiresInDays: 30,
    });
    assert.equal((await bearer(app, revoked.token, '/api/projects')).status, 200);
    const revoke = await sendJson(
      app,
      cookie,
      'DELETE',
      `/api/profile/tokens/${revoked.item.id}`,
      {},
    );
    assert.equal(revoke.status, 204);
    assert.equal((await bearer(app, revoked.token, '/api/projects')).status, 401);

    const viewerCookie = await login(app, DEMO.viewer.email);
    const viewerToken = await createToken(app, viewerCookie, {
      name: '只读成员令牌',
      scopes: ['read'],
      expiresInDays: 30,
    });
    assert.equal((await bearer(app, viewerToken.token, '/api/projects')).status, 200);
    store.users.update(DEMO.viewer.id, { status: 'disabled' });
    assert.equal((await bearer(app, viewerToken.token, '/api/projects')).status, 401);

    assert.equal((await bearer(app, 'clp_invalid-token', '/api/projects')).status, 401);
    assert.equal(
      (await sendJson(app, cookie, 'DELETE', '/api/profile/tokens/not-a-uuid', {})).status,
      404,
    );
  } finally {
    store.close();
  }
});

test('token quota returns 429 after the per-token window is exhausted', async () => {
  const store = testStore();
  const { app } = testApp(store, { tokenQuotaMax: 3 });
  const cookie = await login(app);
  try {
    const created = await createToken(app, cookie, {
      name: '配额测试',
      scopes: ['read'],
      expiresInDays: 30,
    });
    for (let attempt = 1; attempt <= 3; attempt++) {
      const response = await bearer(app, created.token, '/api/projects');
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('x-ratelimit-remaining'), String(3 - attempt));
    }
    const limited = await bearer(app, created.token, '/api/projects');
    assert.equal(limited.status, 429);
    assert.ok(limited.headers.get('retry-after'));
    assert.equal(((await limited.json()) as { error: string }).error, 'quota_exceeded');

    const other = await createToken(app, cookie, {
      name: '独立配额',
      scopes: ['read'],
      expiresInDays: 30,
    });
    assert.equal((await bearer(app, other.token, '/api/projects')).status, 200);
  } finally {
    store.close();
  }
});

test('webhook management validates URLs and is limited to sessions', async () => {
  const store = testStore();
  const { app } = testApp(store);
  const cookie = await login(app);
  try {
    for (const url of ['not-a-url', 'ftp://example.com/hook', 'http://localhost:8080/hook']) {
      const result = await sendJson(app, cookie, 'POST', '/api/profile/webhooks', {
        url,
        events: ['project.created'],
      });
      assert.equal(result.status, 400, url);
    }
    const noEvents = await sendJson(app, cookie, 'POST', '/api/profile/webhooks', {
      url: 'https://hooks.example.com/clay',
      events: [],
    });
    assert.equal(noEvents.status, 400);

    const created = await sendJson<WebhookCreateResult>(
      app,
      cookie,
      'POST',
      '/api/profile/webhooks',
      { url: 'https://hooks.example.com/clay?tenant=1', events: ['project.created'] },
    );
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.match(created.body.secret, /^whsec_/);
    assert.ok(!JSON.stringify(created.body.webhook).includes('whsec_'));

    const list = await getJson<{ webhooks: { id: string; url: string; events: string[] }[] }>(
      app,
      cookie,
      '/api/profile/webhooks',
    );
    assert.equal(list.webhooks.length, 1);
    assert.equal(list.webhooks[0]?.url, 'https://hooks.example.com/clay?tenant=1');
    assert.deepEqual(list.webhooks[0]?.events, ['project.created']);

    const pat = await createToken(app, cookie, {
      name: '集成令牌',
      scopes: ['read'],
      expiresInDays: 30,
    });
    assert.equal((await bearer(app, pat.token, '/api/profile/webhooks')).status, 403);

    const id = created.body.webhook.id;
    const empty = await sendJson(app, cookie, 'PATCH', `/api/profile/webhooks/${id}`, {});
    assert.equal(empty.status, 400);
    const disabled = await sendJson<{ active: boolean }>(
      app,
      cookie,
      'PATCH',
      `/api/profile/webhooks/${id}`,
      { active: false },
    );
    assert.equal(disabled.status, 200);
    assert.equal(disabled.body.active, false);
    assert.equal(
      (await sendJson(app, cookie, 'DELETE', `/api/profile/webhooks/${id}`, {})).status,
      204,
    );
    assert.equal(
      (await sendJson(app, cookie, 'DELETE', `/api/profile/webhooks/${id}`, {})).status,
      404,
    );
  } finally {
    store.close();
  }
});
