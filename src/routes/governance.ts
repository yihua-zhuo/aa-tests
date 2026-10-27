import { Hono } from 'hono';
import { canManageWorkspace } from '../../shared/permissions.ts';
import {
  JitGrantCreateSchema,
  JitQuerySchema,
  PermissionSimulateSchema,
} from '../../shared/schemas.ts';
import type { AppEnv } from '../app-env.ts';
import { forbidden, noStore, notFound, readBody, readQuery, validationError } from '../http.ts';
import { currentUser } from '../middleware/auth.ts';
import type { Store } from '../store.ts';
import { conflict, workspaceOf } from './enterprise-helpers.ts';

export function governanceRoutes(store: Store): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.post('/api/governance/simulate', async (c) => {
    const user = currentUser(c);
    if (!canManageWorkspace(user.role, user.permissions)) return forbidden(c);
    const parsed = await readBody(c, PermissionSimulateSchema);
    if (!parsed.ok) return parsed.response;
    const result = store.governance.simulate(parsed.data, workspaceOf(user));
    if (!result) return notFound(c, '成员或资源不存在');
    noStore(c);
    return c.json(result);
  });

  app.get('/api/governance/jit', (c) => {
    const parsed = readQuery(c, JitQuerySchema);
    if (!parsed.ok) return parsed.response;
    const user = currentUser(c);
    const manager = canManageWorkspace(user.role, user.permissions);
    noStore(c);
    return c.json(
      store.governance.listGrants(workspaceOf(user), {
        status: parsed.data.status,
        userId: manager ? parsed.data.userId : user.id,
      }),
    );
  });

  app.post('/api/governance/jit', async (c) => {
    const user = currentUser(c);
    const parsed = await readBody(c, JitGrantCreateSchema);
    if (!parsed.ok) return parsed.response;
    const manager = canManageWorkspace(user.role, user.permissions);
    if (!manager && parsed.data.userId && parsed.data.userId !== user.id) {
      return forbidden(c);
    }
    const result = store.governance.createGrant(
      workspaceOf(user),
      {
        ...parsed.data,
        userId: manager ? parsed.data.userId : user.id,
      },
      user,
    );
    if (result.status === 'invalid') return validationError(c, result.message);
    if (result.status === 'missing') return notFound(c, '临时授权不存在');
    if (result.status === 'conflict') {
      return conflict(c, '临时授权已被其他会话修改，已返回最新版本', result.current);
    }
    noStore(c);
    return c.json(result.grant, 201);
  });

  app.post('/api/governance/jit/:id/approve', (c) => {
    const user = currentUser(c);
    if (!canManageWorkspace(user.role, user.permissions)) return forbidden(c);
    const result = store.governance.approveGrant(c.req.param('id'), workspaceOf(user), user);
    if (result.status === 'missing') return notFound(c, '临时授权不存在');
    if (result.status === 'invalid') return validationError(c, result.message);
    if (result.status === 'conflict') {
      return conflict(c, '临时授权已被其他会话修改，已返回最新版本', result.current);
    }
    noStore(c);
    return c.json(result.grant);
  });

  app.post('/api/governance/jit/:id/reject', (c) => {
    const user = currentUser(c);
    if (!canManageWorkspace(user.role, user.permissions)) return forbidden(c);
    const result = store.governance.rejectGrant(c.req.param('id'), workspaceOf(user), user);
    if (result.status === 'missing') return notFound(c, '临时授权不存在');
    if (result.status === 'invalid') return validationError(c, result.message);
    if (result.status === 'conflict') {
      return conflict(c, '临时授权已被其他会话修改，已返回最新版本', result.current);
    }
    noStore(c);
    return c.json(result.grant);
  });

  app.post('/api/governance/jit/:id/revoke', (c) => {
    const user = currentUser(c);
    if (!canManageWorkspace(user.role, user.permissions)) return forbidden(c);
    const result = store.governance.revokeGrant(c.req.param('id'), workspaceOf(user));
    if (result.status === 'missing') return notFound(c, '临时授权不存在');
    if (result.status === 'invalid') return validationError(c, result.message);
    if (result.status === 'conflict') {
      return conflict(c, '临时授权已被其他会话修改，已返回最新版本', result.current);
    }
    noStore(c);
    return c.json(result.grant);
  });

  return app;
}
