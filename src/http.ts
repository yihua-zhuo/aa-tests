import type { Context } from 'hono';
import type { ZodType } from 'zod';
import type { AppEnv } from './app-env.ts';

export function noStore(c: Context<AppEnv>): void {
  c.header('Cache-Control', 'no-store');
}

export function validationError(c: Context<AppEnv>, message: string): Response {
  noStore(c);
  return c.json({ error: 'invalid_request', message }, 400);
}

export function notFound(c: Context<AppEnv>, message = '资源不存在'): Response {
  noStore(c);
  return c.json({ error: 'not_found', message }, 404);
}

export function forbidden(c: Context<AppEnv>, message = '没有执行该操作的权限'): Response {
  noStore(c);
  return c.json({ error: 'forbidden', message }, 403);
}

export type Parsed<T> = { ok: true; data: T } | { ok: false; response: Response };

export async function readBody<T>(c: Context<AppEnv>, schema: ZodType<T>): Promise<Parsed<T>> {
  const raw = await c.req.json().catch(() => undefined);
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      response: validationError(c, parsed.error.issues[0]?.message ?? '请求体校验失败'),
    };
  }
  return { ok: true, data: parsed.data };
}

export function readQuery<T>(c: Context<AppEnv>, schema: ZodType<T>): Parsed<T> {
  const parsed = schema.safeParse(c.req.query());
  if (!parsed.success) {
    return {
      ok: false,
      response: validationError(c, parsed.error.issues[0]?.message ?? '查询参数校验失败'),
    };
  }
  return { ok: true, data: parsed.data };
}
