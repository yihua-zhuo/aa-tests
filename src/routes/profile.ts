import { Hono } from 'hono';
import { deleteCookie, setCookie } from 'hono/cookie';
import {
  AccountDeleteSchema,
  EmailChangeSchema,
  MfaDisableSchema,
  MfaEnableSchema,
  PasswordChangeSchema,
  PreferencesUpdateSchema,
  ProfileUpdateSchema,
} from '../../shared/schemas.ts';
import type { AppEnv } from '../app-env.ts';
import {
  cookieOptions,
  createSessionToken,
  hashPassword,
  hashToken,
  SESSION_COOKIE,
  SESSION_COOKIE_HOST,
  SESSION_TTL_MS,
  sessionCookieName,
  verifyPassword,
} from '../auth.ts';
import { noStore, readBody, validationError } from '../http.ts';
import { currentUser, isSecureRequest } from '../middleware/auth.ts';
import { contextIp } from '../net.ts';
import { publishActivity } from '../realtime.ts';
import { isDemoEmail } from '../seed.ts';
import type { EventHub } from '../sse.ts';
import type { Store } from '../store.ts';
import { generateRecoveryCodes, generateTotpSecret, otpauthUrl, verifyTotp } from '../totp.ts';
import { inspectUpload, MAX_AVATAR_BYTES, safeFileName } from '../uploads.ts';
import type { WsHub } from '../ws.ts';

export function profileRoutes(
  store: Store,
  hub: EventHub,
  wsHub: WsHub | undefined,
  trustProxy: boolean,
): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get('/api/profile', (c) => {
    const session = currentUser(c);
    const user = store.users.findById(session.id);
    if (!user) {
      noStore(c);
      return c.json({ error: 'unauthorized' }, 401);
    }
    noStore(c);
    return c.json({
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      timezone: user.timezone,
      avatarUrl: user.avatarUrl ?? null,
      createdAt: user.createdAt,
      lastLoginAt: user.lastLoginAt,
      version: user.version,
    });
  });

  app.patch('/api/profile', async (c) => {
    const session = currentUser(c);
    const parsed = await readBody(c, ProfileUpdateSchema);
    if (!parsed.ok) return parsed.response;

    const result = store.users.update(
      session.id,
      {
        name: parsed.data.name,
        timezone: parsed.data.timezone,
      },
      parsed.data.version,
    );
    if (result.status === 'missing') {
      noStore(c);
      return c.json({ error: 'unauthorized' }, 401);
    }
    if (result.status === 'conflict') {
      noStore(c);
      return c.json(
        {
          error: 'conflict',
          message: '个人资料已被其他会话修改，请刷新后重试',
          current: result.current,
        },
        409,
      );
    }
    const updated = result.user;
    c.set('user', {
      id: updated.id,
      email: updated.email,
      name: updated.name,
      role: updated.role,
      timezone: updated.timezone,
      avatarUrl: updated.avatarUrl ?? null,
    });

    noStore(c);
    return c.json({
      id: updated.id,
      email: updated.email,
      name: updated.name,
      role: updated.role,
      timezone: updated.timezone,
      avatarUrl: updated.avatarUrl ?? null,
      createdAt: updated.createdAt,
      lastLoginAt: updated.lastLoginAt,
      version: updated.version,
    });
  });

  app.post('/api/profile/avatar', async (c) => {
    const session = currentUser(c);
    const form = await c.req.formData().catch(() => null);
    const file = form?.get('file');
    if (!(file instanceof File)) return validationError(c, '请选择头像图片');
    if (file.size > MAX_AVATAR_BYTES) return validationError(c, '头像不能超过 2MB');

    const data = new Uint8Array(await file.arrayBuffer());
    const base = safeFileName(file.name || 'avatar');
    const extension =
      file.type === 'image/png'
        ? '.png'
        : file.type === 'image/webp'
          ? '.webp'
          : file.type === 'image/gif'
            ? '.gif'
            : '.jpg';
    const name = /\.[a-z0-9]+$/i.test(base) ? base : `${base}${extension}`;
    const inspected = inspectUpload(name, file.type, data, 'avatar');
    if (!inspected.ok) return validationError(c, inspected.reason);

    await store.uploads.writeAvatar(session.id, data);
    const avatarUrl = `/api/users/${encodeURIComponent(session.id)}/avatar?v=${Date.now()}`;
    store.users.setAvatar(session.id, avatarUrl);
    store.audit.record({
      actor: { id: session.id, name: session.name },
      action: 'user.avatar_updated',
      target: session.email,
      ip: contextIp(c, trustProxy),
      detail: { mime: inspected.mime, size: data.byteLength, scan: 'clean' },
    });

    noStore(c);
    return c.json({ avatarUrl });
  });

  app.delete('/api/profile/avatar', async (c) => {
    const session = currentUser(c);
    await store.uploads.removeAvatar(session.id);
    store.users.setAvatar(session.id, null);
    store.audit.record({
      actor: { id: session.id, name: session.name },
      action: 'user.avatar_removed',
      target: session.email,
      ip: contextIp(c, trustProxy),
    });
    noStore(c);
    return c.body(null, 204);
  });

  app.post('/api/profile/email', async (c) => {
    const session = currentUser(c);
    const parsed = await readBody(c, EmailChangeSchema);
    if (!parsed.ok) return parsed.response;

    const account = store.users.authByEmail(session.email);
    if (!account) {
      noStore(c);
      return c.json({ error: 'unauthorized' }, 401);
    }
    if (store.demoAccounts && isDemoEmail(account.email)) {
      noStore(c);
      return c.json({ error: 'demo_account', message: '演示账号的登录邮箱不可修改' }, 403);
    }
    if (!(await verifyPassword(parsed.data.password, account.passwordHash))) {
      return validationError(c, '当前密码不正确');
    }
    if (parsed.data.email === account.email) {
      return validationError(c, '新邮箱与当前邮箱相同');
    }
    if (store.users.setEmail(account.id, parsed.data.email) === 'duplicate') {
      noStore(c);
      return c.json({ error: 'duplicate_email', message: '该邮箱已被其他账号使用' }, 409);
    }
    store.notifications.redirectPendingMail(account.id, parsed.data.email);

    const current = c.get('sessionHash');
    if (current) {
      const removed = store.sessions.revokeOthers(account.id, current);
      for (const hash of removed) {
        hub.closeSession(hash);
        wsHub?.closeSession(hash);
      }
    }

    store.audit.record({
      actor: { id: account.id, name: account.name },
      action: 'user.email_changed',
      target: parsed.data.email,
      ip: contextIp(c, trustProxy),
      detail: { previousEmail: account.email },
    });
    noStore(c);
    return c.json({ ok: true, email: parsed.data.email });
  });

  app.post('/api/profile/delete', async (c) => {
    const session = currentUser(c);
    const parsed = await readBody(c, AccountDeleteSchema);
    if (!parsed.ok) return parsed.response;

    const account = store.users.authByEmail(session.email);
    if (!account) {
      noStore(c);
      return c.json({ error: 'unauthorized' }, 401);
    }
    if (store.demoAccounts && isDemoEmail(account.email)) {
      noStore(c);
      return c.json({ error: 'demo_account', message: '演示账号不能注销' }, 403);
    }
    if (!(await verifyPassword(parsed.data.password, account.passwordHash))) {
      return validationError(c, '当前密码不正确');
    }
    if (parsed.data.confirmEmail !== account.email) {
      return validationError(c, '确认邮箱与当前账号不一致');
    }
    if (
      account.role === 'admin' &&
      store.users.activeAdmins(account.id, store.demoAccounts ? undefined : isDemoEmail) === 0
    ) {
      noStore(c);
      return c.json(
        { error: 'last_admin', message: '请先将管理员权限转交给其他成员再注销账号' },
        409,
      );
    }
    const fallback = store.users.fallbackAdmin(account.id, account.workspaceId);
    if (!fallback) {
      noStore(c);
      return c.json(
        { error: 'no_admin', message: '当前工作区没有其他可用管理员，无法转交项目' },
        409,
      );
    }

    const result = store.ops.eraseUser(account.id, fallback.id);
    if (result !== 'ok') {
      noStore(c);
      return c.json({ error: 'delete_failed', message: '注销失败，请稍后重试' }, 409);
    }
    hub.closeUser(account.id);
    wsHub?.closeUser(account.id);
    for (const name of [SESSION_COOKIE, SESSION_COOKIE_HOST]) {
      deleteCookie(c, name, { path: '/', secure: name === SESSION_COOKIE_HOST });
    }
    store.audit.record({
      actor: { id: account.id, name: account.name },
      action: 'user.account_deleted',
      target: account.email,
      ip: contextIp(c, trustProxy),
      detail: { transferredTo: fallback.id },
    });
    noStore(c);
    return c.json({ ok: true });
  });

  app.post('/api/profile/password', async (c) => {
    const session = currentUser(c);
    const parsed = await readBody(c, PasswordChangeSchema);
    if (!parsed.ok) return parsed.response;

    const account = store.users.authByEmail(session.email);
    if (!account || !(await verifyPassword(parsed.data.currentPassword, account.passwordHash))) {
      return validationError(c, '当前密码不正确');
    }

    store.users.setPassword(account.id, await hashPassword(parsed.data.newPassword));
    store.sessions.revokeUser(account.id);
    hub.closeUser(account.id);
    wsHub?.closeUser(account.id);

    const now = Date.now();
    const { token, tokenHash } = createSessionToken();
    store.sessions.create({
      tokenHash,
      userId: account.id,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + SESSION_TTL_MS).toISOString(),
      ip: contextIp(c, trustProxy),
      userAgent: c.req.header('user-agent')?.slice(0, 250) ?? null,
    });
    const secure = isSecureRequest(c, trustProxy);
    setCookie(c, sessionCookieName(secure), token, cookieOptions(secure));

    const activity = store.activities.record({
      type: 'user.password_changed',
      actor: { id: account.id, name: account.name },
      project: null,
      message: `更新了「${account.name}」的登录密码`,
    });
    publishActivity(hub, store, activity);
    store.audit.record({
      actor: { id: account.id, name: account.name },
      action: 'user.password_changed',
      target: account.email,
      ip: contextIp(c, trustProxy),
    });

    noStore(c);
    return c.json({ ok: true });
  });

  app.get('/api/profile/mfa', (c) => {
    const session = currentUser(c);
    noStore(c);
    return c.json({ enabled: store.users.mfaEnabled(session.id) });
  });

  app.post('/api/profile/mfa/setup', (c) => {
    const session = currentUser(c);
    const account = store.users.authByEmail(session.email);
    if (!account) {
      noStore(c);
      return c.json({ error: 'unauthorized' }, 401);
    }
    if (account.mfaEnabled) {
      noStore(c);
      return c.json({ error: 'already_enabled', message: '已启用双因素认证' }, 409);
    }
    const secret = generateTotpSecret();
    const recoveryCodes = generateRecoveryCodes();
    store.users.setMfaSecret(
      account.id,
      secret,
      recoveryCodes.map((code) => hashToken(code)),
    );
    store.audit.record({
      actor: { id: account.id, name: account.name },
      action: 'user.mfa_setup',
      target: account.email,
      ip: contextIp(c, trustProxy),
    });
    noStore(c);
    return c.json({
      secret,
      otpauth: otpauthUrl(account.email, secret),
      recoveryCodes,
    });
  });

  app.post('/api/profile/mfa/enable', async (c) => {
    const session = currentUser(c);
    const parsed = await readBody(c, MfaEnableSchema);
    if (!parsed.ok) return parsed.response;
    const account = store.users.authByEmail(session.email);
    if (!account?.mfaSecret) {
      return validationError(c, '请先生成双因素密钥');
    }
    if (!verifyTotp(account.mfaSecret, parsed.data.code)) {
      return validationError(c, '验证码不正确，请核对设备时间');
    }
    store.users.enableMfa(account.id);
    store.audit.record({
      actor: { id: account.id, name: account.name },
      action: 'user.mfa_enabled',
      target: account.email,
      ip: contextIp(c, trustProxy),
    });
    noStore(c);
    return c.json({ ok: true });
  });

  app.post('/api/profile/mfa/disable', async (c) => {
    const session = currentUser(c);
    const parsed = await readBody(c, MfaDisableSchema);
    if (!parsed.ok) return parsed.response;
    const account = store.users.authByEmail(session.email);
    if (!account || !(await verifyPassword(parsed.data.password, account.passwordHash))) {
      return validationError(c, '密码不正确');
    }
    store.users.disableMfa(account.id);
    store.audit.record({
      actor: { id: account.id, name: account.name },
      action: 'user.mfa_disabled',
      target: account.email,
      ip: contextIp(c, trustProxy),
    });
    noStore(c);
    return c.json({ ok: true });
  });

  app.get('/api/sessions', (c) => {
    const session = currentUser(c);
    noStore(c);
    return c.json({
      sessions: store.sessions.listForUser(session.id, c.get('sessionHash')),
    });
  });

  app.delete('/api/sessions/:id', (c) => {
    const session = currentUser(c);
    const id = c.req.param('id');
    if (!/^[a-f0-9]{16}$/.test(id)) return validationError(c, '会话标识无效');
    const current = c.get('sessionHash')?.slice(0, 16);
    if (id === current) {
      noStore(c);
      return c.json({ error: 'current_session', message: '请使用退出登录结束当前会话' }, 400);
    }
    const removed = store.sessions.revokeById(session.id, id);
    if (removed.length === 0) {
      noStore(c);
      return c.json({ error: 'not_found', message: '会话不存在或已失效' }, 404);
    }
    for (const hash of removed) {
      hub.closeSession(hash);
      wsHub?.closeSession(hash);
    }
    store.audit.record({
      actor: { id: session.id, name: session.name },
      action: 'user.session_revoked',
      target: session.email,
      ip: contextIp(c, trustProxy),
      detail: { sessionId: id },
    });
    noStore(c);
    return c.body(null, 204);
  });

  app.post('/api/sessions/revoke-others', (c) => {
    const session = currentUser(c);
    const current = c.get('sessionHash');
    if (!current) {
      noStore(c);
      return c.json({ error: 'unauthorized' }, 401);
    }
    const removed = store.sessions.revokeOthers(session.id, current);
    for (const hash of removed) {
      hub.closeSession(hash);
      wsHub?.closeSession(hash);
    }
    if (removed.length > 0) {
      store.audit.record({
        actor: { id: session.id, name: session.name },
        action: 'user.sessions_revoked',
        target: session.email,
        ip: contextIp(c, trustProxy),
        detail: { count: removed.length },
      });
    }
    noStore(c);
    return c.json({ revoked: removed.length });
  });

  app.get('/api/preferences', (c) => {
    const session = currentUser(c);
    noStore(c);
    return c.json(store.preferences.get(session.id));
  });

  app.patch('/api/preferences', async (c) => {
    const session = currentUser(c);
    const parsed = await readBody(c, PreferencesUpdateSchema);
    if (!parsed.ok) return parsed.response;
    const { version, ...patch } = parsed.data;
    const next = store.preferences.update(session.id, patch, version);
    noStore(c);
    if (!next) {
      return c.json(
        {
          error: 'conflict',
          message: '偏好已被其他会话修改，已返回最新设置',
          current: store.preferences.get(session.id),
        },
        409,
      );
    }
    if (Object.keys(patch).length > 0) {
      store.audit.record({
        actor: { id: session.id, name: session.name },
        action: 'preferences.updated',
        target: session.email,
        ip: contextIp(c, trustProxy),
        detail: {
          fields: Object.keys(patch),
          defaultRange: next.defaultRange,
          emailNotifications: next.emailNotifications,
          weeklyDigest: next.weeklyDigest,
          sidebarCollapsed: next.sidebarCollapsed,
        },
      });
    }
    return c.json(next);
  });

  return app;
}
