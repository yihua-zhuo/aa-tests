import type { MiddlewareHandler } from 'hono';
import { hostAllowed, originAllowed } from '../net.ts';

type OriginOptions = {
  allowedOrigins?: readonly string[];
};

type HostOptions = {
  allowedHosts?: readonly string[];
};

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function requireTrustedHost(options: HostOptions = {}): MiddlewareHandler {
  const allowed = options.allowedHosts ?? [];
  return async (c, next) => {
    if (!hostAllowed(c.req.header('host'), allowed)) {
      c.header('Cache-Control', 'no-store');
      return c.json({ error: 'untrusted_host', message: '请求 Host 不在允许列表' }, 403);
    }
    await next();
  };
}

export function requireSameOrigin(options: OriginOptions = {}): MiddlewareHandler {
  const allowed = options.allowedOrigins ?? [];
  return async (c, next) => {
    if (SAFE_METHODS.has(c.req.method)) {
      await next();
      return;
    }
    const origin = c.req.header('origin');
    if (origin !== undefined && !originAllowed(origin, c.req.header('host'), allowed)) {
      c.header('Cache-Control', 'no-store');
      return c.json({ error: 'forbidden_origin', message: '跨站请求被拒绝' }, 403);
    }
    // Modern browsers omit Origin on some same-origin requests but always send
    // Fetch Metadata. Reject cross-site attempts even without an Origin header.
    const site = c.req.header('sec-fetch-site');
    if (site !== undefined && site !== 'same-origin' && site !== 'none') {
      c.header('Cache-Control', 'no-store');
      return c.json({ error: 'forbidden_origin', message: '跨站请求被拒绝' }, 403);
    }
    await next();
  };
}
