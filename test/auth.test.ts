import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createSessionToken, hashPassword, hashToken, verifyPassword } from '../src/auth.ts';
import { ensureBootstrapAdmin } from '../src/seed.ts';
import { Store } from '../src/store.ts';
import {
  DEMO,
  getJson,
  login,
  loginWithToken,
  PASSWORD,
  sendJson,
  TEST_NOW,
  testApp,
  testStore,
} from './helpers.ts';

function loginBody(email: string, password: string) {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  };
}

test('scrypt hashes verify and reject tampered values', async () => {
  const hash = await hashPassword('correct horse battery staple');
  assert.match(hash, /^scrypt\$16384\$8\$1\$/);
  assert.equal(await verifyPassword('correct horse battery staple', hash), true);
  assert.equal(await verifyPassword('wrong password', hash), false);
  assert.equal(await verifyPassword('anything', 'plain-text'), false);
  assert.equal(await verifyPassword('anything', ''), false);
  assert.equal(await verifyPassword('anything', 'scrypt$1$2$3$c2FsdA$a2V5'), false);
});

test('login sets an HttpOnly session cookie and restores the session', async () => {
  const store = testStore();
  try {
    const { app } = testApp(store);
    const res = await app.request('/api/auth/login', loginBody(DEMO.admin.email, PASSWORD));
    assert.equal(res.status, 200);

    const setCookie = res.headers.get('set-cookie') ?? '';
    assert.match(setCookie, /np_session=/);
    assert.match(setCookie, /HttpOnly/i);
    assert.match(setCookie, /SameSite=Lax/i);
    assert.match(setCookie, /Path=\//);
    assert.doesNotMatch(setCookie, /Secure/i, 'plain HTTP deployments keep the cookie non-Secure');

    const body = (await res.json()) as {
      user: { role: string; name: string; email: string };
      preferences: { defaultRange: string };
    };
    assert.equal(body.user.role, 'admin');
    assert.equal(body.user.email, 'admin@pulse.demo');
    assert.equal(body.preferences.defaultRange, '30d');

    const me = await app.request('/api/auth/me', { headers: { cookie: await login(app) } });
    assert.equal(me.status, 200);
    const meBody = (await me.json()) as { demo: boolean; user: { id: string } };
    assert.equal(meBody.demo, true);
    assert.equal(meBody.user.id, DEMO.admin.id);
  } finally {
    store.close();
  }
});

test('HTTPS requests receive a Secure host-prefixed cookie', async () => {
  const store = testStore();
  try {
    const { app } = testApp(store);
    const res = await app.request(
      'https://localhost/api/auth/login',
      loginBody(DEMO.manager.email, PASSWORD),
    );
    assert.equal(res.status, 200);
    const setCookie = res.headers.get('set-cookie') ?? '';
    assert.match(setCookie, /__Host-np_session=/);
    assert.match(setCookie, /Secure/i);
  } finally {
    store.close();
  }
});

test('proxied HTTPS marks the cookie Secure only when the proxy is trusted', async () => {
  const store = testStore();
  try {
    const untrusted = testApp(store).app;
    const plain = await untrusted.request('http://localhost/api/auth/login', {
      ...loginBody(DEMO.manager.email, PASSWORD),
      headers: {
        ...loginBody(DEMO.manager.email, PASSWORD).headers,
        'x-forwarded-proto': 'https',
      },
    });
    assert.equal(plain.status, 200);
    assert.doesNotMatch(
      plain.headers.get('set-cookie') ?? '',
      /Secure/i,
      'forwarded headers are ignored when proxy trust is off',
    );

    const trusted = testApp(store, { trustProxy: true }).app;
    const proxied = await trusted.request('http://localhost/api/auth/login', {
      ...loginBody(DEMO.manager.email, PASSWORD),
      headers: {
        ...loginBody(DEMO.manager.email, PASSWORD).headers,
        'x-forwarded-proto': 'https',
      },
    });
    assert.equal(proxied.status, 200);
    assert.match(proxied.headers.get('set-cookie') ?? '', /Secure/i);
  } finally {
    store.close();
  }
});

test('login limiter treats email casing as the same account', async () => {
  const store = testStore();
  try {
    const { app } = testApp(store);
    for (let attempt = 0; attempt < 10; attempt++) {
      const email = attempt % 2 === 0 ? DEMO.viewer.email : DEMO.viewer.email.toUpperCase();
      const res = await app.request('/api/auth/login', loginBody(email, 'wrong-password'));
      assert.equal(res.status, 401);
    }
    const blocked = await app.request(
      '/api/auth/login',
      loginBody(DEMO.viewer.email.toUpperCase(), 'wrong-password'),
    );
    assert.equal(blocked.status, 429, 'case changes must not reset the attempt bucket');
  } finally {
    store.close();
  }
});

test('demo accounts are published while demo mode is enabled', async () => {
  const store = testStore();
  try {
    const { app } = testApp(store);
    const res = await app.request('/api/auth/demo-users');
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      password: string;
      users: { email: string; role: string; name: string }[];
    };
    assert.equal(body.password, PASSWORD);
    assert.deepEqual(body.users.map((user) => user.role).sort(), [
      'admin',
      'manager',
      'pm',
      'viewer',
    ]);
    assert.ok(body.users.every((user) => user.email.endsWith('@pulse.demo')));

    const disabled = await (await app.request('/api/auth/me')).status;
    assert.equal(disabled, 401, 'me requires a session');
  } finally {
    store.close();
  }
});

test('non-demo deployments reject demo logins and expose only the bootstrap admin', async () => {
  const store = new Store(':memory:', {
    demo: false,
    demoAccounts: false,
    now: TEST_NOW,
    bootstrapAdmin: { email: 'Owner@Example.com', password: 'Owner1234!', name: 'Owner' },
  });
  try {
    const { app } = testApp(store);
    const demoAttempt = await app.request('/api/auth/login', loginBody(DEMO.admin.email, PASSWORD));
    assert.equal(demoAttempt.status, 401);
    assert.equal(
      ((await demoAttempt.json()) as { error: string }).error,
      'invalid_credentials',
      'demo credentials must not work when demo accounts are disabled',
    );

    const owner = await app.request(
      '/api/auth/login',
      loginBody('owner@example.com', 'Owner1234!'),
    );
    assert.equal(owner.status, 200);
    const ownerBody = (await owner.json()) as { user: { role: string }; demo: boolean };
    assert.equal(ownerBody.user.role, 'admin');
    assert.equal(ownerBody.demo, false);

    store.users.create({
      id: DEMO.viewer.id,
      email: DEMO.viewer.email,
      name: DEMO.viewer.name,
      role: 'viewer',
      passwordHash: 'not-a-real-hash',
      isDemo: true,
    });
    const { token } = createSessionToken();
    const now = new Date();
    store.sessions.create({
      tokenHash: hashToken(token),
      userId: DEMO.viewer.id,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 3_600_000).toISOString(),
      ip: null,
      userAgent: null,
    });
    const demoSession = await app.request('/api/auth/me', {
      headers: { cookie: `np_session=${token}` },
    });
    assert.equal(demoSession.status, 401, 'existing demo sessions are ignored');
  } finally {
    store.close();
  }
});

test('unknown emails and wrong passwords share the same 401 response', async () => {
  const store = testStore();
  try {
    const { app } = testApp(store);
    const unknown = await app.request('/api/auth/login', loginBody('ghost@pulse.demo', PASSWORD));
    assert.equal(unknown.status, 401);
    assert.deepEqual((await unknown.json()) as object, {
      error: 'invalid_credentials',
      message: '邮箱或密码不正确',
    });

    const wrong = await app.request(
      '/api/auth/login',
      loginBody(DEMO.pm.email, 'not-the-password'),
    );
    assert.equal(wrong.status, 401);
    assert.equal(((await wrong.json()) as { error: string }).error, 'invalid_credentials');
  } finally {
    store.close();
  }
});

test('disabled accounts are refused even with the right password', async () => {
  const store = testStore();
  try {
    store.users.update(DEMO.viewer.id, { status: 'disabled' });
    const { app } = testApp(store);
    const res = await app.request('/api/auth/login', loginBody(DEMO.viewer.email, PASSWORD));
    assert.equal(res.status, 403);
    assert.equal(((await res.json()) as { error: string }).error, 'account_disabled');
  } finally {
    store.close();
  }
});

test('logout revokes the server-side session', async () => {
  const store = testStore();
  try {
    const { app } = testApp(store);
    const cookie = await login(app);
    const logout = await app.request('/api/auth/logout', { method: 'POST', headers: { cookie } });
    assert.equal(logout.status, 204);
    assert.match(logout.headers.get('set-cookie') ?? '', /np_session=;/);

    const me = await app.request('/api/auth/me', { headers: { cookie } });
    assert.equal(me.status, 401);
    assert.equal(store.sessions.count(), 0);
  } finally {
    store.close();
  }
});

test('expired sessions are rejected and cleaned up', async () => {
  const store = testStore();
  try {
    const { app } = testApp(store);
    const { cookie, token } = await loginWithToken(app);
    store.db.raw
      .prepare('UPDATE sessions SET expires_at = ? WHERE token_hash = ?')
      .run('2020-01-01T00:00:00.000Z', hashToken(token));

    const me = await app.request('/api/auth/me', { headers: { cookie } });
    assert.equal(me.status, 401);
    assert.equal(store.sessions.count(), 0, 'the expired session row is removed');
  } finally {
    store.close();
  }
});

test('repeated failed logins are rate limited per account', async () => {
  const store = testStore();
  try {
    const { app } = testApp(store);
    for (let attempt = 0; attempt < 10; attempt++) {
      const res = await app.request('/api/auth/login', loginBody(DEMO.pm.email, 'wrong-password'));
      assert.equal(res.status, 401, `attempt ${attempt + 1} should be a normal failure`);
    }

    const blocked = await app.request('/api/auth/login', loginBody(DEMO.pm.email, PASSWORD));
    assert.equal(blocked.status, 429);
    assert.equal(((await blocked.json()) as { error: string }).error, 'rate_limited');
    assert.ok(Number(blocked.headers.get('retry-after')) > 0);

    const otherAccount = await app.request(
      '/api/auth/login',
      loginBody(DEMO.manager.email, PASSWORD),
    );
    assert.equal(otherAccount.status, 200, 'rate limits are scoped to the email + IP pair');
  } finally {
    store.close();
  }
});

test('unauthenticated APIs return 401 while public endpoints stay open', async () => {
  const store = testStore();
  try {
    const { app } = testApp(store);
    const guarded = await app.request('/api/projects');
    assert.equal(guarded.status, 401);
    assert.equal(((await guarded.json()) as { error: string }).error, 'unauthorized');

    for (const path of ['/api/health', '/api/auth/demo-users', '/api/openapi.json']) {
      const res = await app.request(path);
      assert.equal(res.status, 200, `${path} should stay public`);
    }

    const logout = await app.request('/api/auth/logout', { method: 'POST' });
    assert.equal(logout.status, 204);
  } finally {
    store.close();
  }
});

test('non-demo mode hides demo accounts and analytics', async () => {
  const store = testStore({ demo: false });
  try {
    const { app } = testApp(store);
    assert.equal((await app.request('/api/auth/demo-users')).status, 404);

    const cookie = await login(app);
    const me = (await (await app.request('/api/auth/me', { headers: { cookie } })).json()) as {
      demo: boolean;
    };
    assert.equal(me.demo, false);

    const projects = (await (
      await app.request('/api/projects', { headers: { cookie } })
    ).json()) as { total: number };
    assert.equal(projects.total, 0);
    const metrics = store.db.raw.prepare('SELECT COUNT(*) AS total FROM daily_metrics').get() as {
      total: number;
    };
    assert.equal(Number(metrics.total), 0);
  } finally {
    store.close();
  }
});

test('bootstrap admin configuration is validated at startup', () => {
  const store = testStore();
  try {
    assert.throws(
      () => ensureBootstrapAdmin(store.users, { email: 'not-an-email', password: 'Owner1234!' }),
      /邮箱/,
    );
    assert.throws(
      () => ensureBootstrapAdmin(store.users, { email: 'owner@clay.test', password: 'short' }),
      /至少/,
    );
    assert.throws(
      () => ensureBootstrapAdmin(store.users, { email: DEMO.pm.email, password: 'Owner1234!' }),
      /不是管理员/,
    );

    const existing = ensureBootstrapAdmin(store.users, {
      email: DEMO.admin.email,
      password: 'Owner1234!',
    });
    assert.equal(existing.email, DEMO.admin.email);
    assert.equal(existing.role, 'admin');
  } finally {
    store.close();
  }
});

test('failed logins are written to the audit log', async () => {
  const store = testStore();
  try {
    const { app } = testApp(store);
    const res = await app.request('/api/auth/login', loginBody(DEMO.pm.email, 'wrong-password'));
    assert.equal(res.status, 401);

    const entry = store.audit.list(5)[0];
    assert.equal(entry.action, 'auth.login_failed');
    assert.equal(entry.target, DEMO.pm.email);
    assert.equal(entry.actorId, null);
    assert.deepEqual(entry.detail, { reason: 'bad_password' });
  } finally {
    store.close();
  }
});

test('account lockouts survive a server restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'clay-lockout-'));
  const path = join(dir, 'db.sqlite');
  try {
    const first = new Store(path, { demo: true, demoAccounts: true, now: TEST_NOW });
    try {
      const { app } = testApp(first);
      for (let attempt = 0; attempt < 10; attempt++) {
        const res = await app.request(
          '/api/auth/login',
          loginBody(DEMO.pm.email, 'wrong-password'),
        );
        assert.equal(res.status, 401);
      }
    } finally {
      first.close();
    }

    const reopened = new Store(path, { demo: true, demoAccounts: true, now: TEST_NOW });
    try {
      const { app } = testApp(reopened);
      const blocked = await app.request('/api/auth/login', loginBody(DEMO.pm.email, PASSWORD));
      assert.equal(blocked.status, 429, 'the persistent counter still blocks after restart');
      const other = await app.request('/api/auth/login', loginBody(DEMO.manager.email, PASSWORD));
      assert.equal(other.status, 200, 'other accounts are unaffected');
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('password reset tokens are single-use and revoke old sessions', async () => {
  const store = testStore();
  try {
    const { app } = testApp(store);
    const cookie = await login(app, DEMO.pm.email);

    const unknown = await sendJson<{ resetToken?: string }>(
      app,
      '',
      'POST',
      '/api/auth/password-reset/request',
      { email: 'nobody@pulse.demo' },
    );
    assert.equal(unknown.status, 200, 'unknown emails get the same response');
    assert.equal(unknown.body.resetToken, undefined);

    const requested = await sendJson<{ resetToken?: string; expiresIn: number }>(
      app,
      '',
      'POST',
      '/api/auth/password-reset/request',
      { email: DEMO.pm.email },
    );
    assert.equal(requested.status, 200);
    assert.equal(requested.body.expiresIn, 1800);
    const token = requested.body.resetToken;
    assert.ok(token, 'development mode returns the token instead of sending mail');

    const weak = await sendJson(app, '', 'POST', '/api/auth/password-reset/confirm', {
      token,
      password: 'Password123!',
    });
    assert.equal(weak.status, 400);

    const confirmed = await sendJson(app, '', 'POST', '/api/auth/password-reset/confirm', {
      token,
      password: 'QaPass123!',
    });
    assert.equal(confirmed.status, 200);

    assert.equal(
      (await app.request('/api/auth/me', { headers: { cookie } })).status,
      401,
      'existing sessions are revoked',
    );
    const oldLogin = await app.request('/api/auth/login', loginBody(DEMO.pm.email, PASSWORD));
    assert.equal(oldLogin.status, 401);
    const newLogin = await app.request('/api/auth/login', loginBody(DEMO.pm.email, 'QaPass123!'));
    assert.equal(newLogin.status, 200);

    const reused = await sendJson(app, '', 'POST', '/api/auth/password-reset/confirm', {
      token,
      password: 'Another9!Pass',
    });
    assert.equal(reused.status, 400, 'tokens cannot be replayed');

    const audit = store.audit.list(50);
    assert.ok(audit.some((entry) => entry.action === 'auth.password_reset_requested'));
    assert.ok(audit.some((entry) => entry.action === 'auth.password_reset_completed'));
    const activities = await getJson<{ activities: { type: string }[] }>(
      app,
      await login(app, DEMO.manager.email),
      '/api/activities?limit=10',
    );
    assert.ok(activities.activities.some((item) => item.type === 'user.password_changed'));
  } finally {
    store.close();
  }
});
