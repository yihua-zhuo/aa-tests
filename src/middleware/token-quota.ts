import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../app-env.ts';

type Bucket = { count: number; reset: number };

const MAX_BUCKETS = 10_000;

/** Fixed-window request quota keyed by personal access token. */
export function tokenQuota(options: { max: number; windowMs?: number }): MiddlewareHandler<AppEnv> {
  const windowMs = options.windowMs ?? 60_000;
  const buckets = new Map<string, Bucket>();

  return async (c, next) => {
    if (options.max <= 0 || c.get('authKind') !== 'token') {
      await next();
      return;
    }
    const tokenId = c.get('tokenId');
    if (!tokenId) {
      await next();
      return;
    }
    const now = Date.now();
    if (buckets.size >= MAX_BUCKETS) {
      for (const [key, bucket] of buckets) {
        if (bucket.reset <= now) buckets.delete(key);
      }
      while (buckets.size >= MAX_BUCKETS) {
        const oldest = buckets.keys().next().value;
        if (oldest === undefined) break;
        buckets.delete(oldest);
      }
    }

    let bucket = buckets.get(tokenId);
    if (!bucket || bucket.reset <= now) {
      bucket = { count: 0, reset: now + windowMs };
      buckets.delete(tokenId);
      buckets.set(tokenId, bucket);
    }
    bucket.count++;

    const retryAfter = Math.max(1, Math.ceil((bucket.reset - now) / 1000));
    c.header('X-RateLimit-Limit', String(options.max));
    c.header('X-RateLimit-Remaining', String(Math.max(0, options.max - bucket.count)));
    c.header('X-RateLimit-Reset', String(retryAfter));

    if (bucket.count > options.max) {
      c.header('Retry-After', String(retryAfter));
      c.header('Cache-Control', 'no-store');
      return c.json(
        { error: 'quota_exceeded', message: '访问令牌的请求额度已用完，请稍后重试' },
        429,
      );
    }
    await next();
  };
}
