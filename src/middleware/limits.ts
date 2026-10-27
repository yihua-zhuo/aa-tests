import type { Context, MiddlewareHandler } from 'hono';
import { requestIp } from '../net.ts';

type RateLimitOptions = {
  max?: number;
  windowMs?: number;
  skip?: (path: string) => boolean;
  trustProxy?: boolean;
};

type Bucket = { count: number; reset: number };

const MAX_BUCKETS = 5_000;

export function rateLimit(options: RateLimitOptions = {}): MiddlewareHandler {
  const max = options.max ?? 120;
  const windowMs = options.windowMs ?? 60_000;
  const trustProxy = options.trustProxy ?? false;
  const buckets = new Map<string, Bucket>();

  return async (c, next) => {
    if (max <= 0 || options.skip?.(c.req.path)) {
      await next();
      return;
    }

    const ip = requestIp(c.env, c.req.raw.headers, trustProxy);
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

    let bucket = buckets.get(ip);
    if (!bucket || bucket.reset <= now) {
      bucket = { count: 0, reset: now + windowMs };
      buckets.delete(ip);
      buckets.set(ip, bucket);
    }
    bucket.count++;

    const retryAfter = Math.max(1, Math.ceil((bucket.reset - now) / 1000));
    c.header('X-RateLimit-Limit', String(max));
    c.header('X-RateLimit-Remaining', String(Math.max(0, max - bucket.count)));
    c.header('X-RateLimit-Reset', String(retryAfter));

    if (bucket.count > max) {
      c.header('Retry-After', String(retryAfter));
      c.header('Cache-Control', 'no-store');
      return c.json({ error: 'rate_limited', message: '请求过于频繁，请稍后再试' }, 429);
    }

    await next();
  };
}

type BodyLimitOptions = {
  defaultBytes: number;
  overrides?: Record<string, number>;
  patternOverrides?: { pattern: RegExp; bytes: number }[];
};

function reject(c: Context, limit: number): Response {
  c.header('Cache-Control', 'no-store');
  return c.json(
    { error: 'payload_too_large', message: `请求体不能超过 ${Math.round(limit / 1024)}KB` },
    413,
  );
}

export function bodyLimit(options: BodyLimitOptions): MiddlewareHandler {
  return async (c, next) => {
    const raw = c.req.raw;
    if (!raw.body) {
      await next();
      return;
    }

    const limit =
      options.overrides?.[c.req.path] ??
      options.patternOverrides?.find((item) => item.pattern.test(c.req.path))?.bytes ??
      options.defaultBytes;
    const declared = c.req.header('content-length');
    const chunked = c.req.header('transfer-encoding') !== undefined;

    if (declared !== undefined && !chunked) {
      const size = Number(declared);
      if (!Number.isFinite(size) || size < 0) {
        return c.json({ error: 'invalid_body', message: 'Content-Length 无效' }, 400);
      }
      if (size > limit) return reject(c, limit);
      await next();
      return;
    }

    // Chunked uploads have no declared size: buffer up to the limit so the
    // middleware can enforce it without trusting the client.
    const reader = raw.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > limit) {
          await reader.cancel().catch(() => {});
          return reject(c, limit);
        }
        chunks.push(value);
      }
    } catch {
      return c.json({ error: 'invalid_body', message: '无法读取请求体' }, 400);
    }

    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    });
    c.req.raw = new Request(raw, { body, duplex: 'half' });
    await next();
  };
}
