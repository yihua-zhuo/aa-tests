import { randomBytes } from 'node:crypto';
import { type Context, Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import {
  LoginSchema,
  MfaLoginSchema,
  PasswordResetConfirmSchema,
  PasswordResetRequestSchema,
} from '../../shared/schemas.ts';
import type { AppEnv } from '../app-env.ts';
import {
  cookieOptions,
  createSessionToken,
  dummyHash,
  hashPassword,
  hashToken,
  SESSION_COOKIE,
  SESSION_COOKIE_HOST,
  SESSION_TTL_MS,
  sessionCookieName,
  verifyPassword,
} from '../auth.ts';
import { noStore, readBody, validationError } from '../http.ts';
import { log } from '../logger.ts';
import { currentUser, isSecureRequest } from '../middleware/auth.ts';
import { contextIp } from '../net.ts';
import { publishActivity } from '../realtime.ts';
import { DEMO_PASSWORD, DEMO_USERS, isDemoEmail } from '../seed.ts';
import type { EventHub } from '../sse.ts';
import type { Store } from '../store.ts';
import { verifyTotp } from '../totp.ts';
import type { WsHub } from '../ws.ts';

const MAX_ACCOUNT_ATTEMPTS = 10;
const MAX_IP_ATTEMPTS = 30;
const MFA_TTL_MS = 5 * 60 * 1000;
const MAX_MFA_ATTEMPTS = 5;
const RESET_TTL_MS = 30 * 60 * 1000;
const RESET_REQUEST_LIMIT = 5;
const RESET_IP_LIMIT = 20;

export function authRoutes(
  store: Store,
  hub: EventHub,
  wsHub: WsHub | undefined,
  trustProxy: boolean,
): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  const completeLogin = (
    c: Context<AppEnv>,
    account: { id: string; email: string; name: string; role: string; timezone: string },
  ) => {
    const now = Date.now();
    const createdAt = new Date(now).toISOString();
    const { token, tokenHash } = createSessionToken();
    store.sessions.create({
      tokenHash,
      userId: account.id,
      createdAt,
      expiresAt: new Date(now + SESSION_TTL_MS).toISOString(),
      ip: contextIp(c, trustProxy),
      userAgent: c.req.header('user-agent')?.slice(0, 250) ?? null,
    });
    store.users.touchLogin(account.id, createdAt);
    const secure = isSecureRequest(c, trustProxy);
    setCookie(c, sessionCookieName(secure), token, cookieOptions(secure));
    noStore(c);
    const sessionUser = store.users.findSessionUser(account.id);
    return {
      user: sessionUser ?? {
        id: account.id,
        email: account.email,
        name: account.name,
        role: account.role,
        timezone: account.timezone,
      },
      preferences: store.preferences.get(account.id),
      workspace: store.workspace.get(),
      demo: store.demo,
      features: store.ops.featureMap(),
    };
  };

  app.post('/api/auth/login', async (c) => {
    const parsed = await readBody(c, LoginSchema);
    if (!parsed.ok) return parsed.response;

    const { email, password } = parsed.data;
    const ip = contextIp(c, trustProxy);
    const now = Date.now();
    const accountKey = `account:${email}`;
    const ipKey = `ip:${ip}`;
    const rules = [
      { key: accountKey, limit: MAX_ACCOUNT_ATTEMPTS },
      { key: ipKey, limit: MAX_IP_ATTEMPTS },
    ];

    const limit = store.loginAttempts.check(rules, now);
    if (limit.blocked) {
      c.header('Retry-After', String(Math.max(1, Math.ceil(limit.retryAfterMs / 1000))));
      noStore(c);
      return c.json({ error: 'rate_limited', message: '登录尝试过于频繁，请稍后再试' }, 429);
    }

    const recordFailure = (reason: string): void => {
      store.loginAttempts.record(rules, now);
      store.audit.record({
        actor: null,
        action: 'auth.login_failed',
        target: email,
        ip,
        detail: { reason },
      });
    };

    const account = store.users.authByEmail(email);
    if (!account) {
      await verifyPassword(password, dummyHash());
      recordFailure('unknown_email');
      noStore(c);
      return c.json({ error: 'invalid_credentials', message: '邮箱或密码不正确' }, 401);
    }
    if (!(await verifyPassword(password, account.passwordHash))) {
      recordFailure('bad_password');
      noStore(c);
      return c.json({ error: 'invalid_credentials', message: '邮箱或密码不正确' }, 401);
    }
    if (!store.demoAccounts && isDemoEmail(account.email)) {
      recordFailure('demo_disabled');
      noStore(c);
      return c.json({ error: 'invalid_credentials', message: '邮箱或密码不正确' }, 401);
    }
    if (account.status !== 'active') {
      store.audit.record({
        actor: null,
        action: 'auth.login_failed',
        target: email,
        ip,
        detail: { reason: 'account_disabled' },
      });
      noStore(c);
      return c.json({ error: 'account_disabled', message: '该账号已被停用' }, 403);
    }

    if (account.mfaEnabled) {
      const { token, tokenHash } = createSessionToken();
      store.mfaChallenges.create({
        tokenHash,
        userId: account.id,
        expiresAt: new Date(now + MFA_TTL_MS).toISOString(),
        createdAt: new Date(now).toISOString(),
      });
      store.audit.record({
        actor: null,
        action: 'auth.mfa_challenge',
        target: email,
        ip,
      });
      noStore(c);
      return c.json({ mfaRequired: true, ticket: token, expiresIn: MFA_TTL_MS / 1000 });
    }

    store.loginAttempts.clear([accountKey]);
    return c.json(completeLogin(c, account));
  });

  app.post('/api/auth/mfa', async (c) => {
    const parsed = await readBody(c, MfaLoginSchema);
    if (!parsed.ok) return parsed.response;
    const ip = contextIp(c, trustProxy);
    const ticketHash = hashToken(parsed.data.ticket);
    const challenge = store.mfaChallenges.find(ticketHash);
    if (!challenge) {
      noStore(c);
      return c.json({ error: 'invalid_ticket', message: '验证已过期，请重新登录' }, 401);
    }
    const account = store.users.findById(challenge.userId);
    if (account?.status !== 'active') {
      store.mfaChallenges.remove(ticketHash);
      noStore(c);
      return c.json({ error: 'invalid_ticket', message: '验证已过期，请重新登录' }, 401);
    }

    const credential = parsed.data.code.trim().toUpperCase();
    const auth = store.users.authByEmail(account.email);
    let accepted = false;
    if (auth?.mfaSecret && /^\d{6}$/u.test(credential)) {
      accepted = verifyTotp(auth.mfaSecret, credential);
    }
    if (!accepted && auth) {
      accepted = store.users.consumeRecoveryCode(auth.id, hashToken(credential));
    }

    if (!accepted) {
      const attempts = store.mfaChallenges.fail(ticketHash);
      if (attempts >= MAX_MFA_ATTEMPTS) store.mfaChallenges.remove(ticketHash);
      store.audit.record({
        actor: null,
        action: 'auth.mfa_failed',
        target: account.email,
        ip,
        detail: { attempts },
      });
      noStore(c);
      return c.json({ error: 'invalid_code', message: '验证码不正确或已过期' }, 401);
    }

    store.mfaChallenges.remove(ticketHash);
    store.loginAttempts.clear([`account:${account.email}`]);
    store.audit.record({
      actor: { id: account.id, name: account.name },
      action: 'auth.mfa_success',
      target: account.email,
      ip,
    });
    return c.json(completeLogin(c, account));
  });

  app.post('/api/auth/password-reset/request', async (c) => {
    const parsed = await readBody(c, PasswordResetRequestSchema);
    if (!parsed.ok) return parsed.response;
    const { email } = parsed.data;
    const ip = contextIp(c, trustProxy);
    const now = Date.now();
    const rules = [
      { key: `pwreset:account:${email}`, limit: RESET_REQUEST_LIMIT },
      { key: `pwreset:ip:${ip}`, limit: RESET_IP_LIMIT },
    ];
    const limit = store.loginAttempts.check(rules, now);
    if (limit.blocked) {
      c.header('Retry-After', String(Math.max(1, Math.ceil(limit.retryAfterMs / 1000))));
      noStore(c);
      return c.json({ error: 'rate_limited', message: '请求过于频繁，请稍后再试' }, 429);
    }
    store.loginAttempts.record(rules, now);

    const account = store.users.authByEmail(email);
    const usable =
      account !== null &&
      account.status === 'active' &&
      (store.demoAccounts || !isDemoEmail(account.email));
    let resetToken: string | undefined;
    if (usable && account) {
      resetToken = randomBytes(32).toString('base64url');
      store.passwordResets.create({
        tokenHash: hashToken(resetToken),
        userId: account.id,
        expiresAt: new Date(now + RESET_TTL_MS).toISOString(),
        ip,
      });
    }
    const exposeToken = process.env.NODE_ENV !== 'production';
    if (usable && !exposeToken) {
      log('warn', 'password reset requested but no mail transport is configured', { email });
    }
    store.audit.record({
      actor: null,
      action: 'auth.password_reset_requested',
      target: email,
      ip,
      detail: { matched: usable, delivered: exposeToken },
    });
    noStore(c);
    return c.json({
      ok: true,
      expiresIn: RESET_TTL_MS / 1000,
      ...(exposeToken && resetToken ? { resetToken } : {}),
    });
  });

  app.post('/api/auth/password-reset/confirm', async (c) => {
    const parsed = await readBody(c, PasswordResetConfirmSchema);
    if (!parsed.ok) return parsed.response;
    const userId = store.passwordResets.consume(hashToken(parsed.data.token));
    if (!userId) {
      noStore(c);
      return c.json({ error: 'invalid_token', message: '链接无效或已过期，请重新申请' }, 400);
    }
    const account = store.users.findById(userId);
    if (account?.status !== 'active') {
      noStore(c);
      return c.json({ error: 'invalid_token', message: '账号不可用，请联系管理员' }, 400);
    }

    store.users.setPassword(account.id, await hashPassword(parsed.data.password));
    store.sessions.revokeUser(account.id);
    hub.closeUser(account.id);
    wsHub?.closeUser(account.id);
    store.loginAttempts.clear([`account:${account.email}`, `pwreset:account:${account.email}`]);

    const activity = store.activities.record({
      type: 'user.password_changed',
      actor: { id: account.id, name: account.name },
      project: null,
      message: `通过重置链接更新了「${account.name}」的登录密码`,
    });
    publishActivity(hub, store, activity);
    store.audit.record({
      actor: { id: account.id, name: account.name },
      action: 'auth.password_reset_completed',
      target: account.email,
      ip: contextIp(c, trustProxy),
    });
    noStore(c);
    return c.json({ ok: true });
  });

  app.post('/api/auth/logout', (c) => {
    for (const name of [SESSION_COOKIE, SESSION_COOKIE_HOST]) {
      const token = getCookie(c, name);
      if (token) {
        const tokenHash = hashToken(token);
        store.sessions.revoke(tokenHash);
        hub.closeSession(tokenHash);
        wsHub?.closeSession(tokenHash);
      }
      deleteCookie(c, name, {
        path: '/',
        secure: name === SESSION_COOKIE_HOST,
      });
    }
    noStore(c);
    return c.body(null, 204);
  });

  app.get('/api/auth/me', (c) => {
    const session = currentUser(c);
    const user = store.users.findById(session.id);
    if (!user) {
      noStore(c);
      return c.json({ error: 'unauthorized' }, 401);
    }
    noStore(c);
    return c.json({
      user: store.users.findSessionUser(user.id) ?? session,
      workspaceInfo: store.workspaces.forUser(user.id),
      preferences: store.preferences.get(user.id),
      workspace: store.workspace.get(),
      demo: store.demo,
      features: store.ops.featureMap(),
    });
  });

  app.get('/api/auth/demo-users', (c) => {
    if (!store.demo) {
      noStore(c);
      return c.json({ error: 'not_found' }, 404);
    }
    noStore(c);
    return c.json({
      password: DEMO_PASSWORD,
      users: DEMO_USERS.map((user) => ({
        email: user.email,
        name: user.name,
        role: user.role,
      })),
    });
  });

  return app;
}

export { validationError };
