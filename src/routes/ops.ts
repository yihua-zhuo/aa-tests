import { Hono } from 'hono';
import { canManageWorkspace } from '../../shared/permissions.ts';
import {
  OpsDemoDataSchema,
  OpsFeatureUpdateSchema,
  OpsRestoreSchema,
  OpsSettingsUpdateSchema,
} from '../../shared/schemas.ts';
import type { SessionUser, UserOption } from '../../shared/types.ts';
import type { AppEnv } from '../app-env.ts';
import { forbidden, noStore, notFound, readBody } from '../http.ts';
import { currentUser } from '../middleware/auth.ts';
import { contextIp } from '../net.ts';
import { seedDemoProjects } from '../seed.ts';
import type { EventHub } from '../sse.ts';
import type { Store } from '../store.ts';
import type { WsHub } from '../ws.ts';

function actorOf(user: SessionUser): UserOption {
  return { id: user.id, name: user.name };
}

function canOperate(user: SessionUser): boolean {
  return canManageWorkspace(user.role, user.permissions);
}

export function opsRoutes(
  store: Store,
  hub: EventHub,
  wsHub: WsHub | undefined,
  trustProxy: boolean,
  backupDir: string,
): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get('/api/ops', (c) => {
    const user = currentUser(c);
    if (!canOperate(user)) return forbidden(c, '只有管理员可以访问运维面板');
    noStore(c);
    return c.json({ status: store.ops.status(backupDir, store.db.path) });
  });

  app.get('/api/ops/integrity', (c) => {
    const user = currentUser(c);
    if (!canOperate(user)) return forbidden(c, '只有管理员可以检查数据库完整性');
    noStore(c);
    return c.json({ integrity: store.ops.integrity() });
  });

  app.post('/api/ops/backups', (c) => {
    const actor = currentUser(c);
    if (!canOperate(actor)) return forbidden(c, '只有管理员可以创建备份');
    const backup = store.ops.createBackup(backupDir);
    if (!backup) {
      noStore(c);
      return c.json(
        { error: 'backup_unavailable', message: '当前数据库不支持在线备份（内存数据库）' },
        409,
      );
    }
    store.audit.record({
      actor: actorOf(actor),
      action: 'ops.backup.created',
      target: backup.name,
      ip: contextIp(c, trustProxy),
      detail: { sizeBytes: backup.sizeBytes },
    });
    noStore(c);
    return c.json({ backup }, 201);
  });

  app.post('/api/ops/restore', async (c) => {
    const actor = currentUser(c);
    if (!canOperate(actor)) return forbidden(c, '只有管理员可以恢复备份');
    const parsed = await readBody(c, OpsRestoreSchema);
    if (!parsed.ok) return parsed.response;

    const staged = store.ops.stageRestore(backupDir, parsed.data.file, store.db.path);
    if (!staged.ok) {
      if (staged.reason === 'missing') return notFound(c, '备份文件不存在');
      noStore(c);
      return c.json(
        {
          error: staged.reason === 'memory' ? 'restore_unavailable' : 'invalid_backup',
          message:
            staged.reason === 'memory' ? '内存数据库无法恢复备份' : '备份文件校验失败，已拒绝恢复',
        },
        staged.reason === 'memory' ? 409 : 422,
      );
    }

    store.audit.record({
      actor: actorOf(actor),
      action: 'ops.restore.staged',
      target: parsed.data.file,
      ip: contextIp(c, trustProxy),
    });
    noStore(c);
    return c.json({
      ok: true,
      restartRequired: true,
      file: parsed.data.file,
      message: '恢复已排队，重启服务后生效',
    });
  });

  app.patch('/api/ops/settings', async (c) => {
    const actor = currentUser(c);
    if (!canOperate(actor)) return forbidden(c, '只有管理员可以修改运维设置');
    const parsed = await readBody(c, OpsSettingsUpdateSchema);
    if (!parsed.ok) return parsed.response;
    const settings = store.ops.updateSettings(parsed.data);
    store.audit.record({
      actor: actorOf(actor),
      action: 'ops.settings.updated',
      ip: contextIp(c, trustProxy),
      detail: parsed.data,
    });
    noStore(c);
    return c.json({ settings });
  });

  app.patch('/api/ops/features/:key', async (c) => {
    const actor = currentUser(c);
    if (!canOperate(actor)) return forbidden(c, '只有管理员可以修改功能开关');
    const parsed = await readBody(c, OpsFeatureUpdateSchema);
    if (!parsed.ok) return parsed.response;
    const flag = store.ops.setFeature(c.req.param('key'), parsed.data.enabled, actor.id);
    if (!flag) return notFound(c, '功能开关不存在');
    store.audit.record({
      actor: actorOf(actor),
      action: 'ops.feature.updated',
      target: flag.key,
      ip: contextIp(c, trustProxy),
      detail: { enabled: flag.enabled },
    });
    noStore(c);
    return c.json({ flag });
  });

  app.post('/api/ops/demo-data', async (c) => {
    const actor = currentUser(c);
    if (!canOperate(actor)) return forbidden(c, '只有管理员可以切换演示数据');
    const parsed = await readBody(c, OpsDemoDataSchema);
    if (!parsed.ok) return parsed.response;

    if (parsed.data.enabled && !store.demoAccounts) {
      noStore(c);
      return c.json(
        { error: 'demo_unavailable', message: '当前部署未启用演示账号，无法生成演示数据' },
        409,
      );
    }

    const before = store.ops.demoCounts();
    let removed = 0;
    if (parsed.data.enabled) {
      seedDemoProjects(store.projects, store.users, new Date());
    } else {
      removed = store.ops.purgeDemoProjects();
    }
    store.ops.updateSettings({ demoDataEnabled: parsed.data.enabled });
    const after = store.ops.demoCounts();
    store.audit.record({
      actor: actorOf(actor),
      action: 'ops.demo.toggled',
      ip: contextIp(c, trustProxy),
      detail: { enabled: parsed.data.enabled, removed, before, after },
    });
    noStore(c);
    return c.json({ enabled: parsed.data.enabled, removed, demo: after });
  });

  app.get('/api/ops/users/:id/export', (c) => {
    const actor = currentUser(c);
    if (!canOperate(actor)) return forbidden(c, '只有管理员可以导出成员数据');
    const target = store.users.findById(c.req.param('id'));
    if (!target) return notFound(c, '成员不存在');
    if (target.workspaceId !== actor.workspaceId) return forbidden(c, '不能导出其他工作区的成员');

    const data = store.ops.exportUser(target.id);
    if (!data) return notFound(c, '成员不存在');
    store.audit.record({
      actor: actorOf(actor),
      action: 'ops.user.exported',
      target: target.id,
      ip: contextIp(c, trustProxy),
    });
    noStore(c);
    return c.body(`${JSON.stringify(data, null, 2)}\n`, 200, {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="user-${target.id}.json"`,
    });
  });

  app.post('/api/ops/users/:id/erase', (c) => {
    const actor = currentUser(c);
    if (!canOperate(actor)) return forbidden(c, '只有管理员可以删除成员数据');
    const target = store.users.findById(c.req.param('id'));
    if (!target) return notFound(c, '成员不存在');
    if (target.workspaceId !== actor.workspaceId) return forbidden(c, '不能删除其他工作区的成员');
    if (target.id === actor.id) {
      noStore(c);
      return c.json({ error: 'cannot_erase_self', message: '不能删除当前登录的账号' }, 400);
    }

    const result = store.ops.eraseUser(target.id, actor.id);
    if (result === 'not_found') return notFound(c, '成员不存在');
    if (result === 'last_admin') {
      noStore(c);
      return c.json({ error: 'last_admin', message: '至少需要保留一名启用状态的管理员' }, 409);
    }

    hub.closeUser(target.id);
    wsHub?.closeUser(target.id);
    store.audit.record({
      actor: actorOf(actor),
      action: 'ops.user.erased',
      target: target.id,
      ip: contextIp(c, trustProxy),
    });
    noStore(c);
    return c.json({ ok: true, id: target.id });
  });

  return app;
}
