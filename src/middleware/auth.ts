import type { Context, MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import type { Role, SessionUser, TokenScope } from '../../shared/types.ts';
import type { AppEnv } from '../app-env.ts';
import { hashToken, SESSION_COOKIE, SESSION_COOKIE_HOST, SESSION_IDLE_MS } from '../auth.ts';
import { isDemoEmail } from '../seed.ts';
import type { Store } from '../store.ts';

const TOUCH_INTERVAL_MS = 5 * 60 * 1000;

const SESSION_ONLY_PREFIXES = [
  '/api/profile/tokens',
  '/api/profile/webhooks',
  '/api/profile/email',
  '/api/profile/delete',
  '/api/profile/password',
  '/api/profile/mfa',
  '/api/sessions',
  '/api/ops',
  '/api/ocr',
];

export function sessionToken(c: Context): string | undefined {
  return getCookie(c, SESSION_COOKIE) ?? getCookie(c, SESSION_COOKIE_HOST);
}

export function bearerToken(c: Context): string | undefined {
  const header = c.req.header('authorization');
  if (!header) return undefined;
  const [scheme, value] = header.split(' ', 2);
  if (scheme?.toLowerCase() !== 'bearer' || !value) return undefined;
  return value.trim() || undefined;
}

export function hasTokenScope(scopes: readonly TokenScope[], needed: TokenScope): boolean {
  if (needed === 'read') return scopes.includes('read') || scopes.includes('write');
  return scopes.includes('write');
}

export function loadUser(store: Store): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const bearer = bearerToken(c);
    if (bearer) {
      const auth = store.tokens.authenticate(hashToken(bearer));
      const allowed = auth !== null && (store.demoAccounts || !isDemoEmail(auth.user.email));
      if (auth && allowed) {
        c.set('user', auth.user);
        c.set('authKind', 'token');
        c.set('tokenId', auth.tokenId);
        c.set('tokenScopes', auth.scopes);
        if (auth.user.jitPermissions?.length) {
          store.governance.markActiveUsed(auth.user.id, auth.user.workspaceId ?? 'ws_default');
        }
      }
      await next();
      return;
    }

    const token = sessionToken(c);
    if (token) {
      const tokenHash = hashToken(token);
      const lookup = store.sessions.find(tokenHash, new Date().toISOString(), SESSION_IDLE_MS);
      const allowed =
        lookup !== null &&
        lookup.status === 'active' &&
        (store.demoAccounts || !isDemoEmail(lookup.user.email));
      if (lookup && allowed) {
        c.set('user', lookup.user);
        c.set('sessionHash', tokenHash);
        c.set('authKind', 'session');
        if (lookup.user.jitPermissions?.length) {
          store.governance.markActiveUsed(lookup.user.id, lookup.user.workspaceId ?? 'ws_default');
        }
        if (Date.now() - Date.parse(lookup.lastSeenAt) > TOUCH_INTERVAL_MS) {
          store.sessions.touch(tokenHash);
        }
      } else {
        store.sessions.revoke(tokenHash);
      }
    }
    await next();
  };
}

/** Rejects personal access tokens for credential and integration management. */
export const requireSession: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!c.get('user')) {
    c.header('Cache-Control', 'no-store');
    return c.json({ error: 'unauthorized', message: '请先登录' }, 401);
  }
  if (c.get('authKind') === 'token' || !c.get('sessionHash')) {
    c.header('Cache-Control', 'no-store');
    return c.json({ error: 'session_required', message: '该操作需要使用浏览器会话完成' }, 403);
  }
  await next();
};

/** Applies PAT scopes and blocks token access to sensitive management endpoints. */
export const enforceTokenPolicy: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.get('authKind') !== 'token') {
    await next();
    return;
  }
  const path = c.req.path;
  if (SESSION_ONLY_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))) {
    c.header('Cache-Control', 'no-store');
    return c.json({ error: 'session_required', message: '该操作需要使用浏览器会话完成' }, 403);
  }
  const method = c.req.method.toUpperCase();
  if (
    method !== 'GET' &&
    method !== 'HEAD' &&
    method !== 'OPTIONS' &&
    !hasTokenScope(c.get('tokenScopes') ?? [], 'write')
  ) {
    c.header('Cache-Control', 'no-store');
    return c.json({ error: 'insufficient_scope', message: '访问令牌缺少写入权限' }, 403);
  }
  await next();
};

export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!c.get('user')) {
    c.header('Cache-Control', 'no-store');
    return c.json({ error: 'unauthorized', message: '请先登录' }, 401);
  }
  await next();
};

export function requireRoles(...roles: Role[]): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const user = c.get('user');
    if (!user) {
      c.header('Cache-Control', 'no-store');
      return c.json({ error: 'unauthorized', message: '请先登录' }, 401);
    }
    if (!roles.includes(user.role)) {
      c.header('Cache-Control', 'no-store');
      return c.json({ error: 'forbidden', message: '没有访问该资源的权限' }, 403);
    }
    await next();
  };
}

export function currentUser(c: Context<AppEnv>): SessionUser {
  const user = c.get('user');
  if (!user) throw new Error('authentication middleware is missing');
  return user;
}

export function isSecureRequest(c: Context, trustProxy = false): boolean {
  const override = process.env.COOKIE_SECURE;
  if (override === '1') return true;
  if (override === '0') return false;
  if (new URL(c.req.url).protocol === 'https:') return true;
  if (process.env.NODE_ENV === 'production') return true;
  if (!trustProxy) return false;
  const forwarded = c.req.header('x-forwarded-proto')?.split(',')[0]?.trim().toLowerCase();
  return forwarded === 'https';
}
