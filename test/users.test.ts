import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { User, UserListResult } from '../shared/types.ts';
import { ensureBootstrapAdmin, isDemoEmail } from '../src/seed.ts';
import { Store } from '../src/store.ts';
import { DEMO, getJson, login, sendJson, TEST_NOW, testApp, testStore } from './helpers.ts';

const QA_PASSWORD = 'QaPass123!';

async function setup() {
  const store = testStore({ demo: true });
  const { app } = testApp(store);
  const admin = await login(app, DEMO.admin.email);
  return { store, app, admin };
}

test('admins create accounts that can sign in, managers cannot', async () => {
  const { store, app, admin } = await setup();
  try {
    const created = await sendJson<User>(app, admin, 'POST', '/api/users', {
      email: 'QA@Pulse.Demo',
      name: '测试成员',
      role: 'viewer',
      password: QA_PASSWORD,
      timezone: 'Asia/Tokyo',
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.email, 'qa@pulse.demo', 'emails are normalized to lowercase');
    assert.equal(created.body.role, 'viewer');
    assert.equal(created.body.timezone, 'Asia/Tokyo');
    assert.equal(created.body.status, 'active');
    assert.ok(!('passwordHash' in created.body));

    const qaCookie = await login(app, 'qa@pulse.demo', QA_PASSWORD);
    const me = await getJson<{ user: { id: string; role: string } }>(app, qaCookie, '/api/auth/me');
    assert.equal(me.user.id, created.body.id);
    assert.equal(me.user.role, 'viewer');

    const duplicate = await sendJson(app, admin, 'POST', '/api/users', {
      email: 'qa@pulse.demo',
      name: '重复',
      role: 'viewer',
      password: QA_PASSWORD,
    });
    assert.equal(duplicate.status, 409);
    assert.equal((duplicate.body as { error: string }).error, 'duplicate_email');

    const manager = await login(app, DEMO.manager.email);
    const forbidden = await sendJson(app, manager, 'POST', '/api/users', {
      email: 'manager-made@pulse.demo',
      name: '越权',
      role: 'viewer',
      password: QA_PASSWORD,
    });
    assert.equal(forbidden.status, 403);

    const badTimezone = await sendJson(app, admin, 'POST', '/api/users', {
      email: 'tz@pulse.demo',
      name: '时区错误',
      role: 'viewer',
      password: QA_PASSWORD,
      timezone: 'Mars/Olympus',
    });
    assert.equal(badTimezone.status, 400);

    const weak = await sendJson(app, admin, 'POST', '/api/users', {
      email: 'weak@pulse.demo',
      name: '弱密码',
      role: 'viewer',
      password: 'short',
    });
    assert.equal(weak.status, 400);

    const common = await sendJson(app, admin, 'POST', '/api/users', {
      email: 'common@pulse.demo',
      name: '常见密码',
      role: 'viewer',
      password: 'Password123!',
    });
    assert.equal(common.status, 400);
    assert.match(JSON.stringify(common.body), /过于常见/);
  } finally {
    store.close();
  }
});

test('user lists filter, search and count accounts', async () => {
  const { store, app, admin } = await setup();
  try {
    await sendJson(app, admin, 'POST', '/api/users', {
      email: 'pm2@pulse.demo',
      name: '项目经理二号',
      role: 'pm',
      password: QA_PASSWORD,
    });
    await sendJson(app, admin, 'POST', '/api/users', {
      email: 'viewer2@pulse.demo',
      name: '只读二号',
      role: 'viewer',
      password: QA_PASSWORD,
    });

    const all = await getJson<UserListResult>(app, admin, '/api/users?pageSize=50');
    assert.equal(all.total, 6);
    assert.deepEqual(all.counts, { total: 6, active: 6, disabled: 0, admins: 1 });
    assert.ok(!('timezone' in all.users[0]!), 'directory entries stay minimal');

    const pms = await getJson<UserListResult>(app, admin, '/api/users?role=pm&pageSize=50');
    assert.deepEqual(
      pms.users.map((user) => user.name).sort(),
      [DEMO.pm.name, '项目经理二号'].sort(),
    );

    const searched = await getJson<UserListResult>(app, admin, '/api/users?q=viewer2');
    assert.equal(searched.total, 1);
    assert.equal(searched.users[0]!.email, 'viewer2@pulse.demo');

    const multiWord = await getJson<UserListResult>(
      app,
      admin,
      `/api/users?q=${encodeURIComponent('只读 二号')}`,
    );
    assert.equal(multiWord.total, 1, 'multi-word FTS matches all terms');
    assert.equal(multiWord.users[0]!.name, '只读二号');

    const shortQuery = await getJson<UserListResult>(
      app,
      admin,
      `/api/users?q=${encodeURIComponent('二号')}`,
    );
    assert.equal(shortQuery.total, 2, 'short terms fall back to LIKE');

    const disabled = await sendJson(app, admin, 'PATCH', `/api/users/${searched.users[0]!.id}`, {
      status: 'disabled',
      version: 1,
    });
    assert.equal(disabled.status, 200);
    const onlyDisabled = await getJson<UserListResult>(app, admin, '/api/users?status=disabled');
    assert.equal(onlyDisabled.total, 1);
    assert.equal(onlyDisabled.users[0]!.email, 'viewer2@pulse.demo');
    assert.equal(onlyDisabled.counts.disabled, 1);

    const page = await getJson<UserListResult>(app, admin, '/api/users?pageSize=2&page=2');
    assert.equal(page.users.length, 2);
    assert.equal(page.total, 6);

    const manager = await login(app, DEMO.manager.email);
    assert.equal((await app.request('/api/users', { headers: { cookie: manager } })).status, 200);
    assert.equal(
      (await app.request('/api/users?role=pm', { headers: { cookie: manager } })).status,
      200,
    );
  } finally {
    store.close();
  }
});

test('role changes and disabling revoke existing sessions', async () => {
  const { store, app, admin } = await setup();
  try {
    const pmCookie = await login(app, DEMO.pm.email);
    const demoted = await sendJson<User>(app, admin, 'PATCH', `/api/users/${DEMO.pm.id}`, {
      role: 'viewer',
    });
    assert.equal(demoted.status, 200);
    assert.equal(demoted.body.role, 'viewer');
    assert.equal(
      (await app.request('/api/auth/me', { headers: { cookie: pmCookie } })).status,
      401,
    );

    const relogin = await login(app, DEMO.pm.email);
    const me = await getJson<{ user: { role: string } }>(app, relogin, '/api/auth/me');
    assert.equal(me.user.role, 'viewer', 'new sessions pick up the new role');

    const created = await sendJson<User>(app, admin, 'POST', '/api/users', {
      email: 'toggle@pulse.demo',
      name: '开关用户',
      role: 'viewer',
      password: QA_PASSWORD,
    });
    assert.equal(created.status, 201);
    const toggleCookie = await login(app, 'toggle@pulse.demo', QA_PASSWORD);

    const disabled = await sendJson<User>(app, admin, 'PATCH', `/api/users/${created.body.id}`, {
      status: 'disabled',
    });
    assert.equal(disabled.status, 200);
    assert.equal(disabled.body.status, 'disabled');
    assert.equal(
      (await app.request('/api/auth/me', { headers: { cookie: toggleCookie } })).status,
      401,
    );

    const disabledLogin = await sendJson(app, '', 'POST', '/api/auth/login', {
      email: 'toggle@pulse.demo',
      password: QA_PASSWORD,
    });
    assert.equal(disabledLogin.status, 403);

    const enabled = await sendJson<User>(app, admin, 'PATCH', `/api/users/${created.body.id}`, {
      status: 'active',
    });
    assert.equal(enabled.status, 200);
    await login(app, 'toggle@pulse.demo', QA_PASSWORD);

    const audit = store.audit.list(20);
    const actions = audit.map((entry) => entry.action);
    assert.ok(actions.includes('user.created'));
    assert.ok(actions.includes('user.role_changed'));
    assert.ok(actions.includes('user.disabled'));
    assert.ok(actions.includes('user.enabled'));
    assert.ok(
      audit
        .filter((entry) => !entry.action.startsWith('auth.'))
        .every((entry) => entry.actorName === DEMO.admin.name),
    );
  } finally {
    store.close();
  }
});

test('the last active admin cannot be demoted or disabled', async () => {
  const { store, app, admin } = await setup();
  try {
    const demote = await sendJson(app, admin, 'PATCH', `/api/users/${DEMO.admin.id}`, {
      role: 'manager',
    });
    assert.equal(demote.status, 409);
    assert.equal((demote.body as { error: string }).error, 'last_admin');

    const selfDisable = await sendJson(app, admin, 'PATCH', `/api/users/${DEMO.admin.id}`, {
      status: 'disabled',
    });
    assert.equal(selfDisable.status, 400);

    const otherAdmin = await sendJson<User>(app, admin, 'POST', '/api/users', {
      email: 'admin2@pulse.demo',
      name: '第二管理员',
      role: 'admin',
      password: QA_PASSWORD,
    });
    assert.equal(otherAdmin.status, 201);

    const secondCookie = await login(app, 'admin2@pulse.demo', QA_PASSWORD);
    const accepted = await sendJson<User>(
      app,
      secondCookie,
      'PATCH',
      `/api/users/${DEMO.admin.id}`,
      {
        role: 'manager',
      },
    );
    assert.equal(accepted.status, 200);
    assert.equal(accepted.body.role, 'manager');
    assert.equal(store.users.activeAdmins(DEMO.admin.id), 1);

    assert.equal(
      (await app.request('/api/users', { headers: { cookie: secondCookie } })).status,
      200,
    );
  } finally {
    store.close();
  }
});

test('non-demo admin counts ignore unusable demo accounts', () => {
  const store = new Store(':memory:', {
    demo: false,
    demoAccounts: false,
    now: TEST_NOW,
    bootstrapAdmin: { email: 'owner@clay.test', password: 'Owner1234!' },
  });
  try {
    store.users.create({
      id: DEMO.admin.id,
      email: DEMO.admin.email,
      name: DEMO.admin.name,
      role: 'admin',
      passwordHash: 'not-a-real-hash',
      isDemo: true,
    });
    assert.equal(store.users.activeAdmins(), 2, 'both admin rows are active');
    assert.equal(store.users.activeAdmins(undefined, isDemoEmail), 1);

    ensureBootstrapAdmin(store.users, { email: 'owner2@clay.test', password: 'Owner1234!' });
    assert.equal(store.users.activeAdmins(undefined, isDemoEmail), 2);
  } finally {
    store.close();
  }
});

test('admins can reset a password to a one-time temporary credential', async () => {
  const { store, app, admin } = await setup();
  try {
    const created = await sendJson<User>(app, admin, 'POST', '/api/users', {
      email: 'reset@pulse.demo',
      name: '被重置成员',
      role: 'pm',
      password: QA_PASSWORD,
    });
    assert.equal(created.status, 201);
    const memberCookie = await login(app, 'reset@pulse.demo', QA_PASSWORD);

    const reset = await sendJson<{ temporaryPassword: string }>(
      app,
      admin,
      'POST',
      `/api/users/${created.body.id}/reset-password`,
      {},
    );
    assert.equal(reset.status, 200);
    assert.equal(typeof reset.body.temporaryPassword, 'string');
    assert.ok(reset.body.temporaryPassword.length >= 12);

    assert.equal(
      (await app.request('/api/auth/me', { headers: { cookie: memberCookie } })).status,
      401,
      'existing sessions are revoked',
    );

    const oldLogin = await sendJson(app, '', 'POST', '/api/auth/login', {
      email: 'reset@pulse.demo',
      password: QA_PASSWORD,
    });
    assert.equal(oldLogin.status, 401);

    const newLogin = await sendJson(app, '', 'POST', '/api/auth/login', {
      email: 'reset@pulse.demo',
      password: reset.body.temporaryPassword,
    });
    assert.equal(newLogin.status, 200);

    const entry = store.audit.list(20).find((item) => item.action === 'user.password_reset');
    assert.ok(entry, 'the reset is audited');
  } finally {
    store.close();
  }
});

test('admin edits use optimistic locking and return the latest user on conflict', async () => {
  const { store, app, admin } = await setup();
  try {
    const created = await sendJson<User>(app, admin, 'POST', '/api/users', {
      email: 'versioned@pulse.demo',
      name: '版本成员',
      role: 'viewer',
      password: QA_PASSWORD,
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.version, 1);

    const stale = await sendJson<{ current: User }>(
      app,
      admin,
      'PATCH',
      `/api/users/${created.body.id}`,
      { name: '过期编辑', version: 99 },
    );
    assert.equal(stale.status, 409);
    assert.equal(stale.body.current.name, '版本成员');

    const fresh = await sendJson<User>(app, admin, 'PATCH', `/api/users/${created.body.id}`, {
      name: '最新名字',
      version: created.body.version,
    });
    assert.equal(fresh.status, 200);
    assert.equal(fresh.body.version, created.body.version + 1);
  } finally {
    store.close();
  }
});
