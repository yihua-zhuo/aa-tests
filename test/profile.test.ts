import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Preferences, Profile, Role, SessionInfo } from '../shared/types.ts';
import { hashPasswordSync } from '../src/auth.ts';
import { Store } from '../src/store.ts';
import { totpCode } from '../src/totp.ts';
import {
  authHeaders,
  DEMO,
  getJson,
  login,
  PASSWORD,
  sendJson,
  testApp,
  testStore,
} from './helpers.ts';

function addAccount(store: Store, email: string, role: Role = 'viewer'): string {
  const created = store.users.create({
    email,
    name: '邮箱测试成员',
    role,
    passwordHash: hashPasswordSync(PASSWORD),
  });
  assert.ok(created.ok);
  return created.user.id;
}

test('profiles can be read and updated by the signed-in user', async () => {
  const store = testStore();
  try {
    const { app } = testApp(store);
    const cookie = await login(app, DEMO.pm.email);

    const profile = await getJson<Profile>(app, cookie, '/api/profile');
    assert.equal(profile.email, DEMO.pm.email);
    assert.equal(profile.name, DEMO.pm.name);
    assert.equal(profile.role, 'pm');

    const updated = await sendJson<Profile>(app, cookie, 'PATCH', '/api/profile', {
      name: '周岚（新）',
      timezone: 'America/New_York',
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.name, '周岚（新）');
    assert.equal(updated.body.timezone, 'America/New_York');

    const me = await getJson<{ user: { name: string; timezone: string } }>(
      app,
      cookie,
      '/api/auth/me',
    );
    assert.equal(me.user.name, '周岚（新）');
    assert.equal(me.user.timezone, 'America/New_York');

    const invalid = await sendJson(app, cookie, 'PATCH', '/api/profile', { name: '   ' });
    assert.equal(invalid.status, 400);

    const badTimezone = await sendJson(app, cookie, 'PATCH', '/api/profile', {
      name: '周岚',
      timezone: 'Mars/Olympus',
    });
    assert.equal(badTimezone.status, 400);
    assert.equal(
      (await getJson<Profile>(app, cookie, '/api/profile')).timezone,
      'America/New_York',
      'an invalid timezone is rejected without touching the profile',
    );
  } finally {
    store.close();
  }
});

test('preferences persist per user', async () => {
  const store = testStore();
  try {
    const { app } = testApp(store);
    const pm = await login(app, DEMO.pm.email);
    const viewer = await login(app, DEMO.viewer.email);

    const defaults = await getJson<Preferences>(app, pm, '/api/preferences');
    assert.equal(defaults.defaultRange, '30d');
    assert.equal(defaults.emailNotifications, true);
    assert.equal(defaults.weeklyDigest, false);

    const patched = await sendJson<Preferences>(app, pm, 'PATCH', '/api/preferences', {
      defaultRange: '7d',
      emailNotifications: false,
      weeklyDigest: true,
      sidebarCollapsed: true,
    });
    assert.equal(patched.status, 200);
    assert.equal(patched.body.defaultRange, '7d');
    assert.equal(patched.body.emailNotifications, false);
    assert.equal(patched.body.weeklyDigest, true);
    assert.equal(patched.body.sidebarCollapsed, true);

    const stored = await getJson<Preferences>(app, pm, '/api/preferences');
    assert.deepEqual(stored, patched.body);

    const viewerPreferences = await getJson<Preferences>(app, viewer, '/api/preferences');
    assert.equal(viewerPreferences.defaultRange, '30d', 'preferences are per user');

    const invalid = await sendJson(app, pm, 'PATCH', '/api/preferences', {
      defaultRange: 'forever',
    });
    assert.equal(invalid.status, 400);
  } finally {
    store.close();
  }
});

test('TOTP MFA challenges logins and accepts one-time recovery codes', async () => {
  const store = testStore();
  try {
    const { app } = testApp(store);
    const cookie = await login(app, DEMO.pm.email);

    const setup = await sendJson<{
      secret: string;
      otpauth: string;
      recoveryCodes: string[];
    }>(app, cookie, 'POST', '/api/profile/mfa/setup', {});
    assert.equal(setup.status, 200);
    assert.match(setup.body.otpauth, /^otpauth:\/\/totp\//);
    assert.equal(setup.body.recoveryCodes.length, 8);

    const enable = await sendJson(app, cookie, 'POST', '/api/profile/mfa/enable', {
      code: totpCode(setup.body.secret),
    });
    assert.equal(enable.status, 200);
    assert.deepEqual(await getJson<{ enabled: boolean }>(app, cookie, '/api/profile/mfa'), {
      enabled: true,
    });

    const loginAttempt = await sendJson<Record<string, unknown>>(
      app,
      '',
      'POST',
      '/api/auth/login',
      {
        email: DEMO.pm.email,
        password: PASSWORD,
      },
    );
    assert.equal(loginAttempt.status, 200);
    assert.equal(loginAttempt.body.mfaRequired, true);
    assert.equal(typeof loginAttempt.body.ticket, 'string');

    const rejected = await sendJson(app, '', 'POST', '/api/auth/mfa', {
      ticket: loginAttempt.body.ticket,
      code: '000000',
    });
    assert.equal(rejected.status, 401);

    const verified = await sendJson<{ user: { email: string } }>(app, '', 'POST', '/api/auth/mfa', {
      ticket: loginAttempt.body.ticket,
      code: totpCode(setup.body.secret),
    });
    assert.equal(verified.status, 200);
    assert.equal(verified.body.user.email, DEMO.pm.email);
    assert.match(verified.res.headers.get('set-cookie') ?? '', /np_session=/);

    const second = await sendJson<{ ticket: string }>(app, '', 'POST', '/api/auth/login', {
      email: DEMO.pm.email,
      password: PASSWORD,
    });
    const recovery = setup.body.recoveryCodes[0]!;
    const recovered = await sendJson(app, '', 'POST', '/api/auth/mfa', {
      ticket: second.body.ticket,
      code: recovery,
    });
    assert.equal(recovered.status, 200);

    const third = await sendJson<{ ticket: string }>(app, '', 'POST', '/api/auth/login', {
      email: DEMO.pm.email,
      password: PASSWORD,
    });
    const reused = await sendJson(app, '', 'POST', '/api/auth/mfa', {
      ticket: third.body.ticket,
      code: recovery,
    });
    assert.equal(reused.status, 401, 'recovery codes are single-use');
  } finally {
    store.close();
  }
});

test('idle sessions expire even before the absolute TTL', async () => {
  const store = testStore();
  try {
    const { app } = testApp(store);
    const cookie = await login(app, DEMO.pm.email);
    store.db.raw.prepare("UPDATE sessions SET last_seen_at = '2020-01-01T00:00:00.000Z'").run();
    const response = await app.request('/api/auth/me', { headers: { cookie } });
    assert.equal(response.status, 401);
    assert.equal(store.sessions.count(), 0, 'the idle session is deleted');
  } finally {
    store.close();
  }
});

test('changing the password revokes other sessions and rotates the cookie', async () => {
  const store = testStore();
  try {
    const { app } = testApp(store);
    const first = await login(app, DEMO.admin.email);
    const second = await login(app, DEMO.admin.email);
    assert.equal(store.sessions.count(), 2);

    const wrong = await sendJson(app, first, 'POST', '/api/profile/password', {
      currentPassword: 'not-my-password',
      newPassword: 'NewPass123!',
    });
    assert.equal(wrong.status, 400);

    const weak = await sendJson(app, first, 'POST', '/api/profile/password', {
      currentPassword: PASSWORD,
      newPassword: 'short',
    });
    assert.equal(weak.status, 400);

    const changed = await sendJson<{ ok: boolean }>(app, first, 'POST', '/api/profile/password', {
      currentPassword: PASSWORD,
      newPassword: 'NewPass123!',
    });
    assert.equal(changed.status, 200);
    assert.deepEqual(changed.body, { ok: true });
    assert.equal(store.sessions.count(), 1, 'other sessions are revoked');

    assert.equal(
      (await app.request('/api/auth/me', { headers: { cookie: first } })).status,
      401,
      'the requesting cookie is rotated',
    );
    assert.equal((await app.request('/api/auth/me', { headers: { cookie: second } })).status, 401);

    const rotated = changed.res.headers.get('set-cookie') ?? '';
    const rotatedCookie = `np_session=${/np_session=([^;]+)/.exec(rotated)?.[1]}`;
    assert.match(rotated, /HttpOnly/i);
    assert.equal(
      (await app.request('/api/auth/me', { headers: { cookie: rotatedCookie } })).status,
      200,
    );

    const oldLogin = await sendJson(app, '', 'POST', '/api/auth/login', {
      email: DEMO.admin.email,
      password: PASSWORD,
    });
    assert.equal(oldLogin.status, 401);

    const newLogin = await sendJson(app, '', 'POST', '/api/auth/login', {
      email: DEMO.admin.email,
      password: 'NewPass123!',
    });
    assert.equal(newLogin.status, 200);

    const activities = await getJson<{ activities: { type: string }[] }>(
      app,
      rotatedCookie,
      '/api/activities?limit=10',
    );
    assert.ok(activities.activities.some((activity) => activity.type === 'user.password_changed'));
  } finally {
    store.close();
  }
});

test('users can list and revoke their own sessions', async () => {
  const store = testStore();
  try {
    const { app } = testApp(store);
    const current = await login(app, DEMO.admin.email);
    const other = await login(app, DEMO.admin.email);

    const listed = await getJson<{ sessions: SessionInfo[] }>(app, current, '/api/sessions');
    assert.equal(listed.sessions.length, 2);
    assert.equal(listed.sessions.filter((session) => session.current).length, 1);
    assert.ok(listed.sessions.every((session) => session.id.length === 16));

    const currentSession = listed.sessions.find((session) => session.current);
    const otherSession = listed.sessions.find((session) => !session.current);
    assert.ok(currentSession && otherSession);

    const revokeCurrent = await app.request(`/api/sessions/${currentSession.id}`, {
      method: 'DELETE',
      headers: { cookie: current },
    });
    assert.equal(revokeCurrent.status, 400, 'the current session must use logout');

    const revoked = await app.request(`/api/sessions/${otherSession.id}`, {
      method: 'DELETE',
      headers: { cookie: current },
    });
    assert.equal(revoked.status, 204);
    assert.equal(store.sessions.count(), 1);
    assert.equal((await app.request('/api/auth/me', { headers: { cookie: other } })).status, 401);
    assert.equal(
      (await app.request('/api/auth/me', { headers: { cookie: current } })).status,
      200,
      'the current session survives',
    );

    await login(app, DEMO.admin.email);
    await login(app, DEMO.admin.email);
    assert.equal(store.sessions.count(), 3);
    const others = await sendJson<{ revoked: number }>(
      app,
      current,
      'POST',
      '/api/sessions/revoke-others',
      {},
    );
    assert.equal(others.status, 200);
    assert.equal(others.body.revoked, 2);
    assert.equal(store.sessions.count(), 1);
  } finally {
    store.close();
  }
});

test('stale profile and preference versions return 409 with the latest state', async () => {
  const store = testStore();
  try {
    const { app } = testApp(store);
    const cookie = await login(app, DEMO.pm.email);

    const profile = await getJson<Profile>(app, cookie, '/api/profile');
    const saved = await sendJson<Profile>(app, cookie, 'PATCH', '/api/profile', {
      name: '并发资料',
      timezone: 'UTC',
      version: profile.version,
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.version, profile.version + 1);

    const staleProfile = await sendJson<{ current: Profile }>(
      app,
      cookie,
      'PATCH',
      '/api/profile',
      {
        name: '覆盖者',
        timezone: 'UTC',
        version: profile.version,
      },
    );
    assert.equal(staleProfile.status, 409);
    assert.equal(staleProfile.body.current.name, '并发资料');

    const preferences = await getJson<Preferences>(app, cookie, '/api/preferences');
    const prefSaved = await sendJson<Preferences>(app, cookie, 'PATCH', '/api/preferences', {
      defaultRange: '7d',
      version: preferences.version,
    });
    assert.equal(prefSaved.status, 200);
    assert.equal(prefSaved.body.version, preferences.version + 1);

    const stalePrefs = await sendJson<{ current: Preferences }>(
      app,
      cookie,
      'PATCH',
      '/api/preferences',
      { defaultRange: 'today', version: preferences.version },
    );
    assert.equal(stalePrefs.status, 409);
    assert.equal(stalePrefs.body.current.defaultRange, '7d');
  } finally {
    store.close();
  }
});

test('users can change their sign-in email', async () => {
  const store = testStore();
  try {
    const { app } = testApp(store);
    const email = `email-${crypto.randomUUID()}@clay.test`;
    const id = addAccount(store, email);
    const first = await login(app, email);
    const second = await login(app, email);

    const wrongPassword = await sendJson(app, first, 'POST', '/api/profile/email', {
      email: 'next@clay.test',
      password: 'Wrong1234!',
    });
    assert.equal(wrongPassword.status, 400);

    const duplicate = await sendJson(app, first, 'POST', '/api/profile/email', {
      email: DEMO.pm.email,
      password: PASSWORD,
    });
    assert.equal(duplicate.status, 409);
    assert.equal((duplicate.body as { error: string }).error, 'duplicate_email');

    store.notifications.enqueueMail({ userId: id, subject: '待发送通知', body: '内容' });
    const changed = await sendJson<{ email: string }>(app, first, 'POST', '/api/profile/email', {
      email: 'next@clay.test',
      password: PASSWORD,
    });
    assert.equal(changed.status, 200);
    assert.equal(changed.body.email, 'next@clay.test');
    assert.equal((await getJson<Profile>(app, first, '/api/profile')).email, 'next@clay.test');

    const queued = store.db.raw
      .prepare('SELECT recipient FROM mail_outbox WHERE user_id = ?')
      .get(id) as unknown as { recipient: string };
    assert.equal(queued.recipient, 'next@clay.test', 'pending mail follows the new address');

    const otherSession = await app.request('/api/sessions', { headers: authHeaders(second) });
    assert.equal(otherSession.status, 401, 'changing the email signs out other sessions');

    const oldLogin = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: PASSWORD }),
    });
    assert.equal(oldLogin.status, 401);
    assert.ok(await login(app, 'next@clay.test'));
  } finally {
    store.close();
  }
});

test('users can delete their own account', async () => {
  const store = testStore();
  try {
    const { app } = testApp(store);
    const email = `delete-${crypto.randomUUID()}@clay.test`;
    const id = addAccount(store, email, 'pm');
    const cookie = await login(app, email);

    const wrongPassword = await sendJson(app, cookie, 'POST', '/api/profile/delete', {
      password: 'Wrong1234!',
      confirmEmail: email,
    });
    assert.equal(wrongPassword.status, 400);

    const mismatched = await sendJson(app, cookie, 'POST', '/api/profile/delete', {
      password: PASSWORD,
      confirmEmail: 'other@clay.test',
    });
    assert.equal(mismatched.status, 400);

    const deleted = await sendJson(app, cookie, 'POST', '/api/profile/delete', {
      password: PASSWORD,
      confirmEmail: email,
    });
    assert.equal(deleted.status, 200);

    const row = store.db.raw
      .prepare('SELECT email, name, status FROM users WHERE id = ?')
      .get(id) as unknown as { email: string; name: string; status: string };
    assert.equal(row.email, `deleted-${id}@invalid`);
    assert.equal(row.name, '已删除用户');
    assert.equal(row.status, 'disabled');
    assert.equal(
      (await app.request('/api/auth/me', { headers: authHeaders(cookie) })).status,
      401,
      'the deleted account session is gone',
    );
    const audit = store.db.raw
      .prepare("SELECT COUNT(*) AS total FROM audit_log WHERE action = 'user.account_deleted'")
      .get() as unknown as { total: number };
    assert.equal(Number(audit.total), 1);
  } finally {
    store.close();
  }
});

test('demo accounts and the last administrator cannot delete themselves', async () => {
  const store = testStore();
  try {
    const { app } = testApp(store);
    const cookie = await login(app, DEMO.pm.email);
    const demo = await sendJson<{ error: string }>(app, cookie, 'POST', '/api/profile/delete', {
      password: PASSWORD,
      confirmEmail: DEMO.pm.email,
    });
    assert.equal(demo.status, 403);
    assert.equal(demo.body.error, 'demo_account');
  } finally {
    store.close();
  }

  const plain = new Store(':memory:', {
    demo: false,
    demoAccounts: false,
    bootstrapAdmin: { email: 'owner@clay.test', password: 'Owner1234!' },
  });
  try {
    const { app } = testApp(plain);
    const cookie = await login(app, 'owner@clay.test', 'Owner1234!');
    const result = await sendJson<{ error: string }>(app, cookie, 'POST', '/api/profile/delete', {
      password: 'Owner1234!',
      confirmEmail: 'owner@clay.test',
    });
    assert.equal(result.status, 409);
    assert.equal(result.body.error, 'last_admin');
  } finally {
    plain.close();
  }
});
