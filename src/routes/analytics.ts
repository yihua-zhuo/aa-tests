import { Hono } from 'hono';
import { hasPermission } from '../../shared/permissions.ts';
import { resolveRange } from '../../shared/ranges.ts';
import {
  MetricsImportSchema,
  MetricsQuerySchema,
  RangeQuerySchema,
  ReportExportQuerySchema,
  SavedReportCreateSchema,
  SavedReportUpdateSchema,
  WorkspaceUpdateSchema,
} from '../../shared/schemas.ts';
import type { MetricRecord } from '../../shared/types.ts';
import type { AppEnv } from '../app-env.ts';
import { MAX_IMPORT_BYTES, parseCsvRows } from '../csv.ts';
import { forbidden, noStore, notFound, readBody, readQuery, validationError } from '../http.ts';
import { currentUser } from '../middleware/auth.ts';
import { contextIp } from '../net.ts';
import type { Store } from '../store.ts';
import { workspaceTimeZone } from '../timezone.ts';

function rangeFrom(query: { range: string; from?: string; to?: string }, now: Date) {
  return resolveRange(
    { range: query.range, from: query.from, to: query.to },
    now,
    workspaceTimeZone(),
  );
}

function actorOf(user: { id: string; name: string }) {
  return { id: user.id, name: user.name };
}

type ParsedMetrics = {
  records: MetricRecord[];
  errors: { row: number; message: string }[];
};

function parseMetricRows(
  rows: Record<string, unknown>[],
  defaultCurrency: MetricRecord['currency'],
): ParsedMetrics {
  const records: MetricRecord[] = [];
  const errors: { row: number; message: string }[] = [];
  rows.forEach((row, index) => {
    const lineNumber = index + 2;
    const raw = ['revenue', 'customers', 'conversions', 'visitors'].map((key) =>
      row[key] === undefined || row[key] === null ? '' : String(row[key]).trim(),
    );
    if (!row.date || raw.some((value) => value === '')) {
      errors.push({ row: lineNumber, message: '缺少日期或指标字段' });
      return;
    }
    const parsed = MetricsImportSchema.shape.records.element.safeParse({
      date: String(row.date).trim(),
      revenue: Number(raw[0]),
      customers: Number(raw[1]),
      conversions: Number(raw[2]),
      visitors: Number(raw[3]),
      currency:
        row.currency === undefined || row.currency === ''
          ? defaultCurrency
          : String(row.currency).trim().toUpperCase(),
    });
    if (!parsed.success) {
      errors.push({
        row: lineNumber,
        message: parsed.error.issues[0]?.message ?? '指标格式无效',
      });
      return;
    }
    records.push({ ...parsed.data, currency: parsed.data.currency ?? defaultCurrency });
  });
  return { records, errors };
}

export function analyticsRoutes(store: Store, trustProxy = false): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get('/api/workspace', (c) => {
    noStore(c);
    return c.json({ workspace: store.workspace.get() });
  });

  app.patch('/api/workspace', async (c) => {
    const user = currentUser(c);
    if (!hasPermission(user.role, user.permissions, 'workspace.manage')) {
      return forbidden(c, '只有管理员可以修改工作区币种');
    }

    const parsed = await readBody(c, WorkspaceUpdateSchema);
    if (!parsed.ok) return parsed.response;
    const workspace = store.workspace.update(parsed.data);
    store.audit.record({
      actor: actorOf(user),
      action: 'workspace.updated',
      target: workspace.currency,
      ip: contextIp(c, trustProxy),
      detail: {
        currency: workspace.currency,
        rate: workspace.rates[workspace.currency],
        timeLogVisibility: workspace.timeLogVisibility,
      },
    });
    noStore(c);
    return c.json({ workspace });
  });

  app.get('/api/analytics/revenue', (c) => {
    const parsed = readQuery(c, RangeQuerySchema);
    if (!parsed.ok) return parsed.response;
    const resolved = rangeFrom(parsed.data, store.now());
    if (!resolved.ok) return validationError(c, resolved.message);

    const granularity = parsed.data.granularity ?? resolved.range.granularity;
    const comparison = c.req.query('compare') !== '0';
    noStore(c);
    return c.json(store.analytics.revenueReport(resolved.range, granularity, comparison));
  });

  app.get('/api/analytics/channels', (c) => {
    const parsed = readQuery(c, RangeQuerySchema);
    if (!parsed.ok) return parsed.response;
    const resolved = rangeFrom(parsed.data, store.now());
    if (!resolved.ok) return validationError(c, resolved.message);

    noStore(c);
    return c.json(store.analytics.channelReport(resolved.range));
  });

  app.get('/api/analytics/audience', (c) => {
    const parsed = readQuery(c, RangeQuerySchema);
    if (!parsed.ok) return parsed.response;
    const resolved = rangeFrom(parsed.data, store.now());
    if (!resolved.ok) return validationError(c, resolved.message);

    noStore(c);
    return c.json(store.analytics.audienceReport(resolved.range));
  });

  app.get('/api/analytics/projects', (c) => {
    const user = currentUser(c);
    noStore(c);
    return c.json({
      overview: store.projects.overview(user.role, user.id),
      counts: store.projects.statusCounts(user.role, user.id),
    });
  });

  app.get('/api/analytics/sources', (c) => {
    noStore(c);
    return c.json({
      sources: store.analytics.sources(),
      currency: store.workspace.get().currency,
      demo: store.demo,
    });
  });

  app.get('/api/analytics/metrics', (c) => {
    const user = currentUser(c);
    if (user.role !== 'admin') return forbidden(c, '只有管理员可以查看原始指标');
    const parsed = readQuery(c, MetricsQuerySchema);
    if (!parsed.ok) return parsed.response;
    if (parsed.data.from > parsed.data.to) return validationError(c, '开始日期不能晚于结束日期');
    noStore(c);
    return c.json({
      records: store.analytics.metricDays(parsed.data.from, parsed.data.to),
      currency: store.workspace.get().currency,
    });
  });

  app.post('/api/analytics/metrics', async (c) => {
    const user = currentUser(c);
    if (user.role !== 'admin') return forbidden(c, '只有管理员可以导入指标');

    const parsed = await readBody(c, MetricsImportSchema);
    if (!parsed.ok) return parsed.response;
    const currency = store.workspace.get().currency;
    const records = parsed.data.records.map((record) => ({
      ...record,
      currency: record.currency ?? currency,
    }));
    const result = store.analytics.importMetrics(records, 'api');
    store.audit.record({
      actor: actorOf(user),
      action: 'analytics.metrics_imported',
      target: 'api',
      ip: contextIp(c, trustProxy),
      detail: { source: 'api', imported: result.imported },
    });
    noStore(c);
    return c.json(result);
  });

  app.post('/api/analytics/import', async (c) => {
    const user = currentUser(c);
    if (user.role !== 'admin') return forbidden(c, '只有管理员可以导入指标');

    const form = await c.req.formData().catch(() => null);
    const file = form?.get('file');
    if (!(file instanceof File)) return validationError(c, '请上传 CSV 或 JSON 文件');
    if (file.size > MAX_IMPORT_BYTES) {
      noStore(c);
      return c.json({ error: 'file_too_large', message: '文件不能超过 2MB' }, 413);
    }

    const text = await file.text();
    let rows: Record<string, unknown>[];
    try {
      const trimmed = text.trimStart();
      if (
        file.name.toLowerCase().endsWith('.json') ||
        trimmed.startsWith('[') ||
        trimmed.startsWith('{')
      ) {
        const parsed = JSON.parse(text) as unknown;
        const list = Array.isArray(parsed)
          ? parsed
          : parsed &&
              typeof parsed === 'object' &&
              Array.isArray((parsed as { records?: unknown }).records)
            ? (parsed as { records: unknown[] }).records
            : null;
        if (!list) throw new Error('invalid json shape');
        rows = list.filter(
          (row): row is Record<string, unknown> =>
            !!row && typeof row === 'object' && !Array.isArray(row),
        );
      } else {
        rows = parseCsvRows(text);
      }
    } catch {
      return validationError(c, '无法解析文件内容');
    }

    if (rows.length === 0) return validationError(c, '文件中没有可导入的行');
    if (rows.length > 366) return validationError(c, '单次最多导入 366 行');

    const parsedRows = parseMetricRows(rows, store.workspace.get().currency);
    const result = store.analytics.importMetrics(parsedRows.records, 'csv');
    const skipped = parsedRows.errors.length;
    store.audit.record({
      actor: actorOf(user),
      action: 'analytics.metrics_imported',
      target: file.name,
      ip: contextIp(c, trustProxy),
      detail: {
        source: 'csv',
        file: file.name,
        size: file.size,
        imported: result.imported,
        skipped,
      },
    });
    noStore(c);
    return c.json({
      imported: result.imported,
      skipped,
      errors: parsedRows.errors.slice(0, 100),
    });
  });

  app.get('/api/analytics/export.csv', (c) => {
    const parsed = readQuery(c, ReportExportQuerySchema);
    if (!parsed.ok) return parsed.response;
    const resolved = rangeFrom(parsed.data, store.now());
    if (!resolved.ok) return validationError(c, resolved.message);
    const csv = store.analytics.exportCsv({
      kind: parsed.data.kind,
      range: resolved.range,
      granularity: parsed.data.granularity,
      comparison: parsed.data.compare !== '0',
    });
    noStore(c);
    return c.body(csv.content, 200, {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${csv.filename}"`,
    });
  });

  app.get('/api/analytics/reports', (c) => {
    const user = currentUser(c);
    noStore(c);
    return c.json({ reports: store.reports.list(user.id) });
  });

  app.post('/api/analytics/reports', async (c) => {
    const user = currentUser(c);
    const parsed = await readBody(c, SavedReportCreateSchema);
    if (!parsed.ok) return parsed.response;
    const check = rangeFrom(parsed.data.query, store.now());
    if (!check.ok) return validationError(c, check.message);

    const report = store.reports.create(user.id, {
      name: parsed.data.name,
      query: parsed.data.query,
      frequency: parsed.data.frequency,
    });
    store.audit.record({
      actor: actorOf(user),
      action: 'report.created',
      target: report.id,
      ip: contextIp(c, trustProxy),
      detail: { name: report.name, frequency: report.frequency },
    });
    noStore(c);
    return c.json({ report }, 201);
  });

  app.patch('/api/analytics/reports/:id', async (c) => {
    const user = currentUser(c);
    const parsed = await readBody(c, SavedReportUpdateSchema);
    if (!parsed.ok) return parsed.response;
    if (parsed.data.query) {
      const check = rangeFrom(parsed.data.query, store.now());
      if (!check.ok) return validationError(c, check.message);
    }

    const report = store.reports.update(user.id, c.req.param('id'), parsed.data);
    if (!report) return notFound(c, '报表不存在');
    store.audit.record({
      actor: actorOf(user),
      action: 'report.updated',
      target: report.id,
      ip: contextIp(c, trustProxy),
      detail: { name: report.name, frequency: report.frequency },
    });
    noStore(c);
    return c.json({ report });
  });

  app.delete('/api/analytics/reports/:id', (c) => {
    const user = currentUser(c);
    const id = c.req.param('id');
    if (!store.reports.delete(user.id, id)) return notFound(c, '报表不存在');
    store.audit.record({
      actor: actorOf(user),
      action: 'report.deleted',
      target: id,
      ip: contextIp(c, trustProxy),
    });
    noStore(c);
    return c.body(null, 204);
  });

  app.get('/api/analytics/reports/:id/export.csv', (c) => {
    const user = currentUser(c);
    const exported = store.reports.export(user.id, c.req.param('id'), store.now());
    if (!exported) return notFound(c, '报表不存在或范围无效');
    noStore(c);
    return c.body(exported.content, 200, {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${exported.filename}"`,
    });
  });

  return app;
}
