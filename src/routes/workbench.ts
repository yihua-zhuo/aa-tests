import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { WorkbenchQuerySchema, WorkbenchUpdateSchema } from '../../shared/schemas.ts';
import type { AppEnv } from '../app-env.ts';
import type { ResourceDef } from '../domain/registry.ts';
import { resourceByKey } from '../domain/registry.ts';
import type { ServiceResult } from '../domain/service.ts';
import { forbidden, noStore, notFound, readQuery, validationError } from '../http.ts';
import { currentUser } from '../middleware/auth.ts';
import type { Store } from '../store.ts';
import { conflict } from './enterprise-helpers.ts';

function sendError(
  c: Parameters<typeof validationError>[0],
  result: ServiceResult<unknown>,
): Response {
  if (result.ok) return c.json({}, 500);
  if (result.status === 400) return validationError(c, result.message);
  if (result.status === 403) return forbidden(c, result.message);
  if (result.status === 404) return notFound(c, result.message);
  if (result.status === 409) return conflict(c, result.message, result.current);
  noStore(c);
  return c.json({ error: 'internal_error', message: result.message }, 500);
}

export function workbenchRoutes(store: Store): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  const resolve = (c: Parameters<typeof validationError>[0]): ResourceDef | Response => {
    const resource = resourceByKey(c.req.param('resource') ?? '');
    if (!resource) return notFound(c, '资源类型不存在');
    return resource;
  };

  app.get('/api/workbench/:resource', (c) => {
    const def = resolve(c);
    if (def instanceof Response) return def;
    const parsed = readQuery(c, WorkbenchQuerySchema);
    if (!parsed.ok) return parsed.response;
    const result = store.domain.list(def, currentUser(c), parsed.data);
    if (!result.ok) return sendError(c, result);
    noStore(c);
    return c.json(result.data);
  });

  app.get('/api/workbench/:resource/:id', (c) => {
    const def = resolve(c);
    if (def instanceof Response) return def;
    const result = store.domain.get(def, currentUser(c), c.req.param('id'));
    if (!result.ok) return sendError(c, result);
    if (!result.data) return notFound(c, '资源不存在');
    noStore(c);
    return c.json(result.data);
  });

  app.post('/api/workbench/:resource', async (c) => {
    const def = resolve(c);
    if (def instanceof Response) return def;
    if (!def.allowCreate || !def.create) return validationError(c, '该资源不支持直接创建');
    const query = readQuery(c, WorkbenchQuerySchema);
    if (!query.ok) return query.response;
    const body = await c.req.json().catch(() => undefined);
    const parsed = def.create.safeParse(body);
    if (!parsed.success) {
      return validationError(c, parsed.error.issues[0]?.message ?? '请求体校验失败');
    }
    const input = parsed.data as Record<string, unknown>;
    delete input.resource;
    const result = store.domain.create(def, currentUser(c), query.data, input, c.get('reqId'));
    if (!result.ok) return sendError(c, result);
    noStore(c);
    return c.json(result.data, 201);
  });

  app.patch('/api/workbench/:resource/:id', async (c) => {
    const def = resolve(c);
    if (def instanceof Response) return def;
    if (!def.allowUpdate) return forbidden(c, '该资源不支持直接更新');
    const schema = def.update ?? WorkbenchUpdateSchema;
    const body = await c.req.json().catch(() => undefined);
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      return validationError(c, parsed.error.issues[0]?.message ?? '请求体校验失败');
    }
    const user = currentUser(c);
    const id = c.req.param('id');
    const changes = parsed.data as Record<string, unknown>;
    let formVersion: number | null = null;
    if (def.key === 'task-forms' && changes.fields !== undefined) {
      const current = store.db.stmt('SELECT * FROM task_forms WHERE id = ?').get(id) as unknown as
        | Record<string, unknown>
        | undefined;
      if (current) {
        store.db
          .stmt(
            `INSERT OR IGNORE INTO task_form_versions
               (id, form_id, version, name, fields_json, created_by, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            randomUUID(),
            id,
            Number(current.version),
            String(current.name),
            String(current.fields_json),
            user.id,
            new Date().toISOString(),
          );
        formVersion = Number(current.schema_version) + 1;
      }
    }
    const result = store.domain.update(def, user, id, changes, c.get('reqId'));
    if (!result.ok) return sendError(c, result);
    if (formVersion !== null) {
      store.db.stmt('UPDATE task_forms SET schema_version = ? WHERE id = ?').run(formVersion, id);
      result.data.schemaVersion = formVersion;
    }
    noStore(c);
    return c.json(result.data);
  });

  app.delete('/api/workbench/:resource/:id', (c) => {
    const def = resolve(c);
    if (def instanceof Response) return def;
    if (!def.allowDelete) return forbidden(c, '该资源不支持删除');
    const result = store.domain.remove(def, currentUser(c), c.req.param('id'), c.get('reqId'));
    if (!result.ok) return sendError(c, result);
    noStore(c);
    return c.json({ ok: true });
  });

  return app;
}
