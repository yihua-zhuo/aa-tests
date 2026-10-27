import { Hono } from 'hono';
import { canViewAudit } from '../../shared/permissions.ts';
import { AuditCleanupSchema, AuditQuerySchema } from '../../shared/schemas.ts';
import type { SessionUser, UserOption } from '../../shared/types.ts';
import type { AppEnv } from '../app-env.ts';
import { csvCell } from '../csv.ts';
import { forbidden, noStore, readBody, readQuery } from '../http.ts';
import { exportRowLimit } from '../limits.ts';
import { currentUser } from '../middleware/auth.ts';
import { contextIp } from '../net.ts';
import type { Store } from '../store.ts';
import type { AuditFilters } from '../stores/settings.ts';

function actorOf(user: SessionUser): UserOption {
  return { id: user.id, name: user.name };
}

function rangeFilters(from?: string, to?: string): Pick<AuditFilters, 'from' | 'to'> {
  return {
    ...(from ? { from: `${from}T00:00:00.000Z` } : {}),
    ...(to ? { to: `${to}T23:59:59.999Z` } : {}),
  };
}

export function auditRoutes(store: Store, trustProxy: boolean): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get('/api/audit', (c) => {
    const user = currentUser(c);
    if (!canViewAudit(user.role, user.permissions))
      return forbidden(c, '只有管理员可以查看审计日志');

    const parsed = readQuery(c, AuditQuerySchema);
    if (!parsed.ok) return parsed.response;

    const result = store.audit.page({
      q: parsed.data.q,
      action: parsed.data.action,
      actor: parsed.data.actor,
      ...rangeFilters(parsed.data.from, parsed.data.to),
      page: parsed.data.page,
      pageSize: parsed.data.pageSize,
    });
    noStore(c);
    return c.json({ ...result, retention: store.audit.retention });
  });

  app.get('/api/audit/export.csv', (c) => {
    const user = currentUser(c);
    if (!canViewAudit(user.role, user.permissions))
      return forbidden(c, '只有管理员可以导出审计日志');

    const parsed = readQuery(c, AuditQuerySchema);
    if (!parsed.ok) return parsed.response;

    const filters: AuditFilters = {
      q: parsed.data.q,
      action: parsed.data.action,
      actor: parsed.data.actor,
      ...rangeFilters(parsed.data.from, parsed.data.to),
    };
    const limit = exportRowLimit();
    const total = store.audit.count(filters);
    if (total > limit) {
      noStore(c);
      return c.json(
        {
          error: 'export_too_large',
          message: `当前筛选结果 ${total} 条，超过单次导出上限 ${limit} 条，请先缩小范围`,
        },
        413,
      );
    }

    const rows = store.audit.exportRows(filters, limit);
    const lines = [
      'seq,createdAt,actor,action,target,ip,detail',
      ...rows.map((entry) =>
        [
          String(entry.seq),
          entry.createdAt,
          csvCell(entry.actorName ?? ''),
          entry.action,
          csvCell(entry.target ?? ''),
          entry.ip ?? '',
          csvCell(JSON.stringify(entry.detail)),
        ].join(','),
      ),
    ];

    c.header('Cache-Control', 'no-store');
    return c.body(`\uFEFF${lines.join('\n')}\n`, 200, {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': 'attachment; filename="clay-audit.csv"',
    });
  });

  app.post('/api/audit/cleanup', async (c) => {
    const actor = currentUser(c);
    if (!canViewAudit(actor.role, actor.permissions))
      return forbidden(c, '只有管理员可以清理审计日志');

    const parsed = await readBody(c, AuditCleanupSchema);
    if (!parsed.ok) return parsed.response;

    const days = parsed.data.days ?? store.audit.retention.days;
    const removed = store.audit.cleanup(days);
    store.audit.record({
      actor: actorOf(actor),
      action: 'audit.cleanup',
      ip: contextIp(c, trustProxy),
      detail: { days, removed },
    });
    noStore(c);
    return c.json({ removed, days });
  });

  return app;
}
