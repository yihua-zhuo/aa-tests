import { randomBytes } from 'node:crypto';
import { Hono } from 'hono';
import { canManageUsers, canViewUserDirectory } from '../../shared/permissions.ts';
import {
  CustomRoleCreateSchema,
  CustomRoleUpdateSchema,
  UserCreateSchema,
  UserQuerySchema,
  UserUpdateSchema,
  WorkspaceCreateSchema,
  WorkspaceRenameSchema,
} from '../../shared/schemas.ts';
import type { ActivityType, SessionUser, UserOption } from '../../shared/types.ts';
import type { AppEnv } from '../app-env.ts';
import { hashPassword } from '../auth.ts';
import { forbidden, noStore, notFound, readBody, readQuery, validationError } from '../http.ts';
import { currentUser } from '../middleware/auth.ts';
import { contextIp } from '../net.ts';
import { publishActivity, publishVisibility } from '../realtime.ts';
import { isDemoEmail } from '../seed.ts';
import type { EventHub } from '../sse.ts';
import type { Store } from '../store.ts';
import { sniffImageMime } from '../uploads.ts';
import type { WsHub } from '../ws.ts';

function actorOf(user: SessionUser): UserOption {
  return { id: user.id, name: user.name };
}

export function userRoutes(
  store: Store,
  hub: EventHub,
  wsHub: WsHub | undefined,
  trustProxy: boolean,
): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get('/api/users/options', (c) => {
    const user = currentUser(c);
    noStore(c);
    return c.json({ users: store.users.options(user.workspaceId) });
  });

  app.get('/api/workspaces', (c) => {
    const user = currentUser(c);
    if (!canManageUsers(user.role, user.permissions)) return forbidden(c);
    noStore(c);
    return c.json({ workspaces: store.workspaces.list() });
  });

  app.post('/api/workspaces', async (c) => {
    const actor = currentUser(c);
    if (!canManageUsers(actor.role, actor.permissions)) return forbidden(c);
    const parsed = await readBody(c, WorkspaceCreateSchema);
    if (!parsed.ok) return parsed.response;
    const workspace = store.workspaces.create(parsed.data.name);
    store.audit.record({
      actor: actorOf(actor),
      action: 'workspace.created',
      target: workspace.id,
      ip: contextIp(c, trustProxy),
      detail: { name: workspace.name },
    });
    noStore(c);
    return c.json({ workspace }, 201);
  });

  app.patch('/api/workspaces/:id', async (c) => {
    const actor = currentUser(c);
    if (!canManageUsers(actor.role, actor.permissions)) return forbidden(c);
    const parsed = await readBody(c, WorkspaceRenameSchema);
    if (!parsed.ok) return parsed.response;
    const workspace = store.workspaces.rename(c.req.param('id'), parsed.data.name);
    if (!workspace) return notFound(c, '工作区不存在');
    store.audit.record({
      actor: actorOf(actor),
      action: 'workspace.updated',
      target: workspace.id,
      ip: contextIp(c, trustProxy),
      detail: { name: workspace.name },
    });
    noStore(c);
    return c.json({ workspace });
  });

  app.get('/api/custom-roles', (c) => {
    const user = currentUser(c);
    if (!canViewUserDirectory(user.role, user.permissions)) return forbidden(c);
    noStore(c);
    return c.json({ roles: store.workspaces.customRoles(user.workspaceId) });
  });

  app.post('/api/custom-roles', async (c) => {
    const actor = currentUser(c);
    if (!canManageUsers(actor.role, actor.permissions)) return forbidden(c);
    const parsed = await readBody(c, CustomRoleCreateSchema);
    if (!parsed.ok) return parsed.response;
    const result = store.workspaces.createCustomRole(
      actor.workspaceId ?? 'ws_default',
      parsed.data,
    );
    if (result.status === 'duplicate') {
      noStore(c);
      return c.json({ error: 'duplicate_name', message: '角色名称已存在' }, 409);
    }
    if (result.status === 'missing') return notFound(c, '工作区不存在');
    store.audit.record({
      actor: actorOf(actor),
      action: 'role.created',
      target: result.role.id,
      ip: contextIp(c, trustProxy),
      detail: {
        name: result.role.name,
        baseRole: result.role.baseRole,
        permissions: result.role.permissions,
      },
    });
    noStore(c);
    return c.json({ role: result.role }, 201);
  });

  app.patch('/api/custom-roles/:id', async (c) => {
    const actor = currentUser(c);
    if (!canManageUsers(actor.role, actor.permissions)) return forbidden(c);
    const current = store.workspaces.customRole(c.req.param('id'));
    if (!current || current.workspaceId !== actor.workspaceId) return notFound(c, '角色不存在');
    const parsed = await readBody(c, CustomRoleUpdateSchema);
    if (!parsed.ok) return parsed.response;
    const result = store.workspaces.updateCustomRole(current.id, parsed.data);
    if (result.status === 'duplicate') {
      noStore(c);
      return c.json({ error: 'duplicate_name', message: '角色名称已存在' }, 409);
    }
    if (result.status === 'missing') return notFound(c, '角色不存在');
    store.audit.record({
      actor: actorOf(actor),
      action: 'role.updated',
      target: result.role.id,
      ip: contextIp(c, trustProxy),
      detail: {
        name: result.role.name,
        baseRole: result.role.baseRole,
        permissions: result.role.permissions,
      },
    });
    noStore(c);
    return c.json({ role: result.role });
  });

  app.delete('/api/custom-roles/:id', (c) => {
    const actor = currentUser(c);
    if (!canManageUsers(actor.role, actor.permissions)) return forbidden(c);
    const current = store.workspaces.customRole(c.req.param('id'));
    if (!current || current.workspaceId !== actor.workspaceId) return notFound(c, '角色不存在');
    store.workspaces.deleteCustomRole(current.id);
    store.audit.record({
      actor: actorOf(actor),
      action: 'role.deleted',
      target: current.id,
      ip: contextIp(c, trustProxy),
      detail: { name: current.name },
    });
    noStore(c);
    return c.body(null, 204);
  });

  app.get('/api/users/:id/avatar', async (c) => {
    const id = c.req.param('id');
    if (!store.users.findById(id)) return notFound(c, '用户不存在');
    const data = await store.uploads.readAvatar(id);
    const mime = data ? sniffImageMime(data) : null;
    if (!data || !mime) return notFound(c, '头像不存在');

    c.header('Content-Type', mime);
    c.header('Content-Length', String(data.byteLength));
    c.header('Cache-Control', 'private, max-age=300');
    c.header('X-Content-Type-Options', 'nosniff');
    const body = Uint8Array.from(data).buffer;
    return c.body(body);
  });

  app.get('/api/users', (c) => {
    const user = currentUser(c);
    if (!canViewUserDirectory(user.role, user.permissions)) return forbidden(c);

    const parsed = readQuery(c, UserQuerySchema);
    if (!parsed.ok) return parsed.response;

    noStore(c);
    return c.json(
      store.users.list({
        q: parsed.data.q,
        role: parsed.data.role,
        status: parsed.data.status,
        workspaceId: user.workspaceId,
        page: parsed.data.page,
        pageSize: parsed.data.pageSize,
      }),
    );
  });

  app.post('/api/users', async (c) => {
    const actor = currentUser(c);
    if (!canManageUsers(actor.role, actor.permissions)) return forbidden(c);

    const parsed = await readBody(c, UserCreateSchema);
    if (!parsed.ok) return parsed.response;
    const body = parsed.data;
    const workspaceId = body.workspaceId ?? actor.workspaceId ?? 'ws_default';
    if (!store.workspaces.get(workspaceId)) {
      return validationError(c, '工作区不存在');
    }
    const customRole = body.customRoleId ? store.workspaces.customRole(body.customRoleId) : null;
    if (body.customRoleId && (!customRole || customRole.workspaceId !== workspaceId)) {
      return validationError(c, '自定义角色无效');
    }

    if (store.users.authByEmail(body.email)) {
      noStore(c);
      return c.json({ error: 'duplicate_email', message: '该邮箱已存在' }, 409);
    }

    const result = store.users.create({
      email: body.email,
      name: body.name,
      role: customRole?.baseRole ?? body.role,
      passwordHash: await hashPassword(body.password),
      timezone: body.timezone,
      workspaceId,
      customRoleId: customRole?.id ?? null,
    });
    if (!result.ok) {
      noStore(c);
      return c.json({ error: 'duplicate_email', message: '该邮箱已存在' }, 409);
    }

    store.audit.record({
      actor: actorOf(actor),
      action: 'user.created',
      target: result.user.email,
      ip: contextIp(c, trustProxy),
      detail: { role: result.user.role },
    });
    const activity = store.activities.record({
      type: 'user.created',
      actor: actorOf(actor),
      project: null,
      message: `创建了成员「${result.user.name}」`,
      meta: { role: result.user.role },
    });
    publishActivity(hub, store, activity);
    publishVisibility(hub);

    noStore(c);
    return c.json(result.user, 201);
  });

  app.patch('/api/users/:id', async (c) => {
    const actor = currentUser(c);
    if (!canManageUsers(actor.role, actor.permissions)) return forbidden(c);

    const id = c.req.param('id');
    const target = store.users.findById(id);
    if (!target) return notFound(c, '用户不存在');

    const parsed = await readBody(c, UserUpdateSchema);
    if (!parsed.ok) return parsed.response;
    const patch = parsed.data;

    if (patch.customRoleId !== undefined && patch.customRoleId !== null) {
      const customRole = store.workspaces.customRole(patch.customRoleId);
      if (!customRole || customRole.workspaceId !== (target.workspaceId ?? actor.workspaceId)) {
        return validationError(c, '自定义角色无效');
      }
      patch.role = customRole.baseRole;
    }
    if (patch.customRoleId === null) patch.role = undefined;

    if (id === actor.id && patch.status === 'disabled') {
      return validationError(c, '不能停用自己的账号');
    }
    const losesAdmin =
      target.role === 'admin' &&
      ((patch.role !== undefined && patch.role !== 'admin') || patch.status === 'disabled');
    if (
      losesAdmin &&
      store.users.activeAdmins(target.id, store.demoAccounts ? undefined : isDemoEmail) === 0
    ) {
      noStore(c);
      return c.json({ error: 'last_admin', message: '至少需要保留一名启用中的管理员' }, 409);
    }

    const result = store.users.update(id, patch, patch.version);
    if (result.status === 'missing') return notFound(c, '用户不存在');
    if (result.status === 'conflict') {
      noStore(c);
      return c.json(
        {
          error: 'conflict',
          message: '该成员已被其他会话修改，已返回最新资料',
          current: result.current,
        },
        409,
      );
    }
    const updated = result.user;

    const roleChanged = patch.role !== undefined && patch.role !== target.role;
    const statusChanged = patch.status !== undefined && patch.status !== target.status;
    if (statusChanged || roleChanged) {
      store.sessions.revokeUser(id);
      hub.closeUser(id);
      wsHub?.closeUser(id);
    }

    store.audit.record({
      actor: actorOf(actor),
      action: roleChanged
        ? 'user.role_changed'
        : statusChanged
          ? updated.status === 'disabled'
            ? 'user.disabled'
            : 'user.enabled'
          : 'user.updated',
      target: target.email,
      ip: contextIp(c, trustProxy),
      detail: {
        ...(roleChanged ? { from: target.role, to: updated.role } : {}),
        ...(statusChanged ? { status: updated.status } : {}),
      },
    });

    let activityType: ActivityType | null = null;
    let message = '';
    if (roleChanged) {
      activityType = 'user.role_changed';
      message = `调整了「${target.name}」的角色`;
    } else if (patch.status === 'disabled') {
      activityType = 'user.disabled';
      message = `停用了成员「${target.name}」`;
    } else if (patch.status === 'active' && target.status === 'disabled') {
      activityType = 'user.enabled';
      message = `恢复了成员「${target.name}」`;
    }
    if (activityType) {
      const activity = store.activities.record({
        type: activityType,
        actor: actorOf(actor),
        project: null,
        message,
        meta: { role: updated.role, status: updated.status },
      });
      publishActivity(hub, store, activity);
    }
    if (roleChanged || statusChanged) publishVisibility(hub);

    noStore(c);
    return c.json(updated);
  });

  app.post('/api/users/:id/reset-password', async (c) => {
    const actor = currentUser(c);
    if (!canManageUsers(actor.role, actor.permissions)) return forbidden(c);

    const id = c.req.param('id');
    const target = store.users.findById(id);
    if (!target) return notFound(c, '用户不存在');
    if (target.id === actor.id) {
      return validationError(c, '请使用设置页修改自己的密码');
    }

    const temporaryPassword = `Aa1!${randomBytes(9).toString('base64url')}`;
    store.users.setPassword(target.id, await hashPassword(temporaryPassword));
    store.users.disableMfa(target.id);
    store.sessions.revokeUser(target.id);
    hub.closeUser(target.id);
    wsHub?.closeUser(target.id);

    store.audit.record({
      actor: actorOf(actor),
      action: 'user.password_reset',
      target: target.email,
      ip: contextIp(c, trustProxy),
    });
    const activity = store.activities.record({
      type: 'user.password_changed',
      actor: actorOf(actor),
      project: null,
      message: `重置了「${target.name}」的登录密码`,
    });
    publishActivity(hub, store, activity);

    noStore(c);
    return c.json({
      temporaryPassword,
      user: store.users.findById(target.id),
    });
  });

  return app;
}
