import { Hono } from 'hono';
import { canManageWorkspace } from '../../shared/permissions.ts';
import type {
  OcrDriftReport,
  OcrFeedbackErrorType,
  OcrFeedbackStatus,
  OcrOptimizationRisk,
  OcrOptimizationStatus,
} from '../../shared/types.ts';
import type { AppEnv } from '../app-env.ts';
import { forbidden, noStore, notFound, validationError } from '../http.ts';
import { currentUser } from '../middleware/auth.ts';
import { contextIp } from '../net.ts';
import { recoveryYieldMinSamples } from '../ocr-cascade.ts';
import {
  compareDistributions,
  distributionOf,
  emptyDistribution,
  MIN_BASELINE_SAMPLES,
} from '../ocr-drift.ts';
import type { Store } from '../store.ts';
import { OcrPassAuditStore } from '../stores/ocr-audits.ts';
import type { OcrOptimizationInput, OcrOptimizationPatch } from '../stores/ocr-governance.ts';

const FEEDBACK_STATUSES = new Set<OcrFeedbackStatus>(['pool', 'sampled', 'labeled', 'dismissed']);
const MARKABLE_STATUSES = new Set<Exclude<OcrFeedbackStatus, 'sampled'>>([
  'pool',
  'labeled',
  'dismissed',
]);
const FEEDBACK_TYPES = new Set<OcrFeedbackErrorType>([
  'low_confidence',
  'model_disagreement',
  'field_validation',
  'human_revision',
  'user_complaint',
]);
const OPTIMIZATION_RISKS = new Set<OcrOptimizationRisk>(['low', 'medium', 'high']);
const OPTIMIZATION_STATUSES = new Set<OcrOptimizationStatus>([
  'proposed',
  'implemented',
  'measured',
  'rolled_back',
]);

function readDays(value: string | undefined, fallback = 30): number | null {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 365) return null;
  return parsed;
}

function driftFor(store: Store, days: number, now: Date): OcrDriftReport {
  const current = distributionOf(store.ocrGovernance.distributionInputs(days, now));
  const baseline = store.ocrGovernance.getBaseline();
  return compareDistributions(baseline?.distribution ?? emptyDistribution(), current, {
    baselineAt: baseline?.createdAt ?? null,
    generatedAt: now.toISOString(),
  });
}

type OptimizationRead = { ok: true; value: OcrOptimizationPatch } | { ok: false; message: string };

function readOptimization(body: Record<string, unknown>): OptimizationRead {
  const patch: OcrOptimizationPatch = {};
  if (body.title !== undefined) {
    if (typeof body.title !== 'string' || body.title.trim() === '' || body.title.length > 200) {
      return { ok: false, message: 'title 必须是 1-200 字符的字符串' };
    }
    patch.title = body.title.trim();
  }
  if (body.targetError !== undefined) {
    if (
      typeof body.targetError !== 'string' ||
      body.targetError.trim() === '' ||
      body.targetError.length > 200
    ) {
      return { ok: false, message: 'targetError 必须是 1-200 字符的字符串' };
    }
    patch.targetError = body.targetError.trim();
  }
  if (body.expectedGain !== undefined) {
    if (
      typeof body.expectedGain !== 'number' ||
      !Number.isFinite(body.expectedGain) ||
      body.expectedGain < 0 ||
      body.expectedGain > 1
    ) {
      return { ok: false, message: 'expectedGain 必须是 0-1 之间的数字' };
    }
    patch.expectedGain = body.expectedGain;
  }
  if (body.implementationCost !== undefined) {
    if (
      typeof body.implementationCost !== 'number' ||
      !Number.isFinite(body.implementationCost) ||
      body.implementationCost < 0 ||
      body.implementationCost > 1000
    ) {
      return { ok: false, message: 'implementationCost 必须是 0-1000 之间的数字' };
    }
    patch.implementationCost = body.implementationCost;
  }
  if (body.inferenceCost !== undefined) {
    if (
      typeof body.inferenceCost !== 'number' ||
      !Number.isFinite(body.inferenceCost) ||
      body.inferenceCost < 0 ||
      body.inferenceCost > 10
    ) {
      return { ok: false, message: 'inferenceCost 必须是 0-10 之间的数字' };
    }
    patch.inferenceCost = body.inferenceCost;
  }
  if (body.risk !== undefined) {
    if (
      typeof body.risk !== 'string' ||
      !OPTIMIZATION_RISKS.has(body.risk as OcrOptimizationRisk)
    ) {
      return { ok: false, message: 'risk 只能是 low、medium 或 high' };
    }
    patch.risk = body.risk as OcrOptimizationRisk;
  }
  if (body.status !== undefined) {
    if (
      typeof body.status !== 'string' ||
      !OPTIMIZATION_STATUSES.has(body.status as OcrOptimizationStatus)
    ) {
      return {
        ok: false,
        message: 'status 只能是 proposed、implemented、measured 或 rolled_back',
      };
    }
    patch.status = body.status as OcrOptimizationStatus;
  }
  for (const key of ['benchmarkResult', 'productionResult'] as const) {
    const value = body[key];
    if (value === undefined) continue;
    if (typeof value !== 'string' || value.length > 2000) {
      return { ok: false, message: `${key} 必须是不超过 2000 字符的字符串` };
    }
    patch[key] = value.trim();
  }
  return { ok: true, value: patch };
}

export function ocrGovernanceRoutes(store: Store, trustProxy: boolean): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  const requireAdmin = (c: Parameters<typeof currentUser>[0]) => {
    const user = currentUser(c);
    return canManageWorkspace(user.role, user.permissions) ? user : null;
  };

  app.get('/api/ocr/recovery-yields', (c) => {
    const user = requireAdmin(c);
    if (!user) return forbidden(c, '只有工作区管理员可以查看恢复收益统计');
    noStore(c);
    return c.json({
      yields: store.ocrYields.list(),
      minSamples: recoveryYieldMinSamples(),
    });
  });

  app.get('/api/ocr/feedback', (c) => {
    const user = requireAdmin(c);
    if (!user) return forbidden(c, '只有工作区管理员可以查看 OCR 错误样本池');
    const statusParam = c.req.query('status');
    if (statusParam && !FEEDBACK_STATUSES.has(statusParam as OcrFeedbackStatus)) {
      return validationError(c, 'status 不是有效的样本状态');
    }
    const typeParam = c.req.query('errorType');
    if (typeParam && !FEEDBACK_TYPES.has(typeParam as OcrFeedbackErrorType)) {
      return validationError(c, 'errorType 不是有效的错误类型');
    }
    const limit = Number(c.req.query('limit') ?? 200);
    const filter = {
      status: (statusParam as OcrFeedbackStatus | undefined) ?? 'all',
      errorType: typeParam as OcrFeedbackErrorType | undefined,
    } as const;
    const samples = store.ocrGovernance.listFeedback({
      ...filter,
      limit: Number.isFinite(limit) ? limit : 200,
    });
    noStore(c);
    return c.json({
      pool: store.ocrGovernance.feedbackPool(),
      samples,
      matched: store.ocrGovernance.countFeedback(filter),
    });
  });

  app.post('/api/ocr/feedback/sync', async (c) => {
    const user = requireAdmin(c);
    if (!user) return forbidden(c, '只有工作区管理员可以回流 OCR 错误样本');
    const body = (await c.req.json().catch(() => ({}))) as { days?: unknown };
    const days = readDays(body.days === undefined ? undefined : String(body.days));
    if (days === null) return validationError(c, 'days 必须是 1-365 之间的整数');
    const now = new Date();
    const result = store.ocrGovernance.syncRecent(days, now);
    store.audit.record({
      actor: { id: user.id, name: user.name },
      action: 'ocr.feedback_synced',
      target: 'ocr-feedback',
      ip: contextIp(c, trustProxy),
      detail: { days, ...result },
    });
    noStore(c);
    return c.json({ ...result, pool: store.ocrGovernance.feedbackPool() });
  });

  app.post('/api/ocr/feedback/sample', async (c) => {
    const user = requireAdmin(c);
    if (!user) return forbidden(c, '只有工作区管理员可以抽取标注样本');
    const body = (await c.req.json().catch(() => ({}))) as {
      perStratum?: unknown;
      total?: unknown;
      budget?: unknown;
    };
    for (const [key, value, max] of [
      ['perStratum', body.perStratum, 50],
      ['total', body.total, 500],
      ['budget', body.budget, 10_000],
    ] as const) {
      if (
        value !== undefined &&
        (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > max)
      ) {
        return validationError(c, `${key} 必须是 1-${max} 之间的整数`);
      }
    }
    const selection = store.ocrGovernance.selectFeedback({
      perStratum: body.perStratum as number | undefined,
      total: body.total as number | undefined,
      budget: body.budget as number | undefined,
    });
    store.audit.record({
      actor: { id: user.id, name: user.name },
      action: 'ocr.feedback_sampled',
      target: 'ocr-feedback',
      ip: contextIp(c, trustProxy),
      detail: { selected: selection.samples.length, strata: selection.strata.length },
    });
    noStore(c);
    return c.json(selection);
  });

  app.post('/api/ocr/feedback/:sampleId/status', async (c) => {
    const user = requireAdmin(c);
    if (!user) return forbidden(c, '只有工作区管理员可以更新样本状态');
    const body = (await c.req.json().catch(() => ({}))) as {
      status?: unknown;
      note?: unknown;
    };
    if (
      typeof body.status !== 'string' ||
      !MARKABLE_STATUSES.has(body.status as Exclude<OcrFeedbackStatus, 'sampled'>)
    ) {
      return validationError(c, 'status 只能是 pool、labeled 或 dismissed');
    }
    let note: string | null = null;
    if (body.note !== undefined) {
      if (typeof body.note !== 'string' || body.note.length > 500) {
        return validationError(c, 'note 必须是不超过 500 字符的字符串');
      }
      note = body.note.trim() || null;
    }
    const sample = store.ocrGovernance.markFeedback(
      c.req.param('sampleId'),
      body.status as Exclude<OcrFeedbackStatus, 'sampled'>,
      note,
      new Date().toISOString(),
    );
    if (!sample) return notFound(c, '样本不存在');
    noStore(c);
    return c.json({ sample });
  });

  app.get('/api/ocr/knowledge', (c) => {
    const user = requireAdmin(c);
    if (!user) return forbidden(c, '只有工作区管理员可以查看文档知识图谱');
    const projectId = c.req.query('projectId')?.trim() || undefined;
    const limit = Number(c.req.query('limit') ?? 200);
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
      return validationError(c, 'limit 必须是 1-1000 之间的整数');
    }
    noStore(c);
    return c.json({ graph: store.ocrGovernance.knowledgeGraph({ projectId, limit }) });
  });

  app.get('/api/ocr/quality/dashboard', (c) => {
    const user = requireAdmin(c);
    if (!user) return forbidden(c, '只有工作区管理员可以查看 OCR 生产看板');
    const days = readDays(c.req.query('days'));
    if (days === null) return validationError(c, 'days 必须是 1-365 之间的整数');
    const now = new Date();
    const drift = driftFor(store, days, now);
    const dashboard = {
      ...store.ocrGovernance.dashboard(days, now, drift),
      workspaceThresholds: store.ocrCalibration
        .list()
        .filter((profile) => profile.dimension === 'workspace'),
    };
    noStore(c);
    return c.json({ dashboard, alerts: store.ocrGovernance.listAlerts(10) });
  });

  app.get('/api/ocr/drift', (c) => {
    const user = requireAdmin(c);
    if (!user) return forbidden(c, '只有工作区管理员可以查看 OCR 数据漂移');
    const days = readDays(c.req.query('days'));
    if (days === null) return validationError(c, 'days 必须是 1-365 之间的整数');
    const now = new Date();
    const drift = driftFor(store, days, now);
    noStore(c);
    return c.json({ drift, alerts: store.ocrGovernance.listAlerts(20) });
  });

  app.post('/api/ocr/drift/baseline', async (c) => {
    const user = requireAdmin(c);
    if (!user) return forbidden(c, '只有工作区管理员可以设置漂移基准');
    const body = (await c.req.json().catch(() => ({}))) as { days?: unknown };
    const days = readDays(body.days === undefined ? undefined : String(body.days));
    if (days === null) return validationError(c, 'days 必须是 1-365 之间的整数');
    const now = new Date();
    const distribution = distributionOf(store.ocrGovernance.distributionInputs(days, now));
    if (distribution.samples < MIN_BASELINE_SAMPLES) {
      return c.json(
        {
          error: 'unprocessable',
          message: `样本不足：${distribution.samples} 个，至少需要 ${MIN_BASELINE_SAMPLES} 个已完成 OCR 文档`,
        },
        422,
      );
    }
    store.ocrGovernance.saveBaseline(distribution, now.toISOString(), user.id);
    store.audit.record({
      actor: { id: user.id, name: user.name },
      action: 'ocr.drift_baseline_saved',
      target: 'ocr-drift',
      ip: contextIp(c, trustProxy),
      detail: { days, samples: distribution.samples },
    });
    noStore(c);
    return c.json({
      baseline: { samples: distribution.samples, createdAt: now.toISOString() },
    });
  });

  app.post('/api/ocr/drift/check', async (c) => {
    const user = requireAdmin(c);
    if (!user) return forbidden(c, '只有工作区管理员可以检查 OCR 数据漂移');
    const body = (await c.req.json().catch(() => ({}))) as { days?: unknown };
    const days = readDays(body.days === undefined ? undefined : String(body.days));
    if (days === null) return validationError(c, 'days 必须是 1-365 之间的整数');
    const now = new Date();
    const drift = driftFor(store, days, now);
    const inserted = store.ocrGovernance.recordAlerts(drift.alerts, now.toISOString());
    if (inserted > 0) {
      store.audit.record({
        actor: { id: user.id, name: user.name },
        action: 'ocr.drift_detected',
        target: 'ocr-drift',
        ip: contextIp(c, trustProxy),
        detail: {
          days,
          inserted,
          dimensions: drift.alerts.map((alert) => alert.dimension),
        },
      });
    }
    noStore(c);
    return c.json({ drift, inserted, alerts: store.ocrGovernance.listAlerts(20) });
  });

  app.get('/api/ocr/optimizations', (c) => {
    const user = requireAdmin(c);
    if (!user) return forbidden(c, '只有工作区管理员可以查看 OCR 优化台账');
    noStore(c);
    return c.json({ entries: store.ocrGovernance.listOptimizations() });
  });

  app.post('/api/ocr/optimizations', async (c) => {
    const user = requireAdmin(c);
    if (!user) return forbidden(c, '只有工作区管理员可以维护 OCR 优化台账');
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const read = readOptimization(body);
    if (!read.ok) return validationError(c, read.message);
    const patch = read.value;
    if (!patch.title || !patch.targetError || patch.expectedGain === undefined) {
      return validationError(c, 'title、targetError 和 expectedGain 为必填项');
    }
    const input: OcrOptimizationInput & {
      createdBy: { id: string; name: string };
      createdAt: string;
    } = {
      title: patch.title,
      targetError: patch.targetError,
      expectedGain: patch.expectedGain,
      implementationCost: patch.implementationCost ?? 0,
      inferenceCost: patch.inferenceCost ?? 0,
      risk: patch.risk ?? 'medium',
      benchmarkResult: patch.benchmarkResult,
      productionResult: patch.productionResult,
      status: patch.status,
      createdBy: { id: user.id, name: user.name },
      createdAt: new Date().toISOString(),
    };
    const entry = store.ocrGovernance.createOptimization(input);
    store.audit.record({
      actor: { id: user.id, name: user.name },
      action: 'ocr.optimization_created',
      target: 'ocr-optimization',
      ip: contextIp(c, trustProxy),
      detail: { id: entry.id, title: entry.title, targetError: entry.targetError },
    });
    noStore(c);
    return c.json({ entry }, 201);
  });

  app.patch('/api/ocr/optimizations/:id', async (c) => {
    const user = requireAdmin(c);
    if (!user) return forbidden(c, '只有工作区管理员可以维护 OCR 优化台账');
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const read = readOptimization(body);
    if (!read.ok) return validationError(c, read.message);
    const entry = store.ocrGovernance.updateOptimization(
      c.req.param('id'),
      read.value,
      new Date().toISOString(),
    );
    if (!entry) return notFound(c, '优化记录不存在');
    store.audit.record({
      actor: { id: user.id, name: user.name },
      action: 'ocr.optimization_updated',
      target: 'ocr-optimization',
      ip: contextIp(c, trustProxy),
      detail: { id: entry.id, status: entry.status },
    });
    noStore(c);
    return c.json({ entry });
  });

  app.get('/api/ocr/pass-audits', (c) => {
    const user = requireAdmin(c);
    if (!user) return forbidden(c, '只有工作区管理员可以查看通过文档审计');
    const status = c.req.query('status');
    if (status && !['all', 'pending', 'audited'].includes(status)) {
      return validationError(c, 'status 只能是 all、pending 或 audited');
    }
    const projectId = c.req.query('projectId')?.trim() || undefined;
    const period = c.req.query('period')?.trim() || undefined;
    noStore(c);
    return c.json({
      audits: store.ocrPassAudits.list({
        status: status ?? 'all',
        projectId,
        period,
        limit: 200,
      }),
      stats: store.ocrPassAudits.stats({ projectId, period }),
      period: OcrPassAuditStore.periodOf(new Date()),
    });
  });

  app.post('/api/ocr/pass-audits/sample', async (c) => {
    const user = requireAdmin(c);
    if (!user) return forbidden(c, '只有工作区管理员可以抽取通过文档审计样本');
    const body = (await c.req.json().catch(() => ({}))) as {
      fraction?: unknown;
      perType?: unknown;
      period?: unknown;
      projectId?: unknown;
    };
    if (
      body.fraction !== undefined &&
      (typeof body.fraction !== 'number' ||
        !Number.isFinite(body.fraction) ||
        body.fraction < 0.001 ||
        body.fraction > 0.2)
    ) {
      return validationError(c, 'fraction 必须是 0.001-0.2 之间的比例');
    }
    if (
      body.perType !== undefined &&
      (typeof body.perType !== 'number' ||
        !Number.isInteger(body.perType) ||
        body.perType < 1 ||
        body.perType > 50)
    ) {
      return validationError(c, 'perType 必须是 1-50 之间的整数');
    }
    const period =
      body.period === undefined || body.period === null
        ? undefined
        : typeof body.period === 'string'
          ? body.period.trim()
          : null;
    if (period === null || (period && !/^\d{4}-W\d{2}$/.test(period))) {
      return validationError(c, 'period 必须形如 2026-W44');
    }
    const projectId =
      body.projectId === undefined ? undefined : String(body.projectId).trim() || undefined;
    const result = store.ocrPassAudits.sample({
      fraction: body.fraction as number | undefined,
      perType: body.perType as number | undefined,
      period,
      projectId,
      now: new Date().toISOString(),
    });
    store.audit.record({
      actor: { id: user.id, name: user.name },
      action: 'ocr.pass_audit_sampled',
      target: 'ocr-pass-audits',
      ip: contextIp(c, trustProxy),
      detail: {
        period: result.period,
        created: result.created.length,
        strata: result.strata.length,
      },
    });
    noStore(c);
    return c.json({ ...result, stats: store.ocrPassAudits.stats({ projectId }) });
  });

  app.post('/api/ocr/pass-audits/:id/verdict', async (c) => {
    const user = requireAdmin(c);
    if (!user) return forbidden(c, '只有工作区管理员可以标注通过文档审计');
    const body = (await c.req.json().catch(() => ({}))) as {
      verdict?: unknown;
      note?: unknown;
    };
    if (body.verdict !== 'clean' && body.verdict !== 'error') {
      return validationError(c, 'verdict 只能是 clean 或 error');
    }
    let note: string | null = null;
    if (body.note !== undefined) {
      if (typeof body.note !== 'string' || body.note.length > 500) {
        return validationError(c, 'note 必须是不超过 500 字符的字符串');
      }
      note = body.note.trim() || null;
    }
    const result = store.ocrPassAudits.verdict(
      c.req.param('id'),
      body.verdict,
      { id: user.id, name: user.name },
      new Date().toISOString(),
      note,
    );
    if (result === 'conflict') {
      return validationError(c, '该样本已有两名复核人，需要第三人重新抽样');
    }
    if (!result) return notFound(c, '审计记录不存在');
    store.audit.record({
      actor: { id: user.id, name: user.name },
      action: 'ocr.pass_audited',
      target: 'ocr-pass-audit',
      ip: contextIp(c, trustProxy),
      detail: { id: result.id, status: result.status },
    });
    noStore(c);
    return c.json({ audit: result, stats: store.ocrPassAudits.stats() });
  });

  app.get('/api/ocr/revision-qc', (c) => {
    const user = requireAdmin(c);
    if (!user) return forbidden(c, '只有工作区管理员可以查看修订质检队列');
    const projectId = c.req.query('projectId')?.trim() || undefined;
    const limit = Number(c.req.query('limit') ?? 25);
    noStore(c);
    return c.json({
      items: store.ocrRevisionReviews.queue({
        projectId,
        limit: Number.isFinite(limit) ? limit : 25,
      }),
      stats: store.ocrRevisionReviews.stats({ projectId }),
    });
  });

  app.post('/api/ocr/revision-qc/:id/review', async (c) => {
    const user = requireAdmin(c);
    if (!user) return forbidden(c, '只有工作区管理员可以复核人工修订');
    const body = (await c.req.json().catch(() => ({}))) as {
      verdict?: unknown;
      value?: unknown;
      note?: unknown;
    };
    if (body.verdict !== 'confirm' && body.verdict !== 'revise' && body.verdict !== 'arbitrate') {
      return validationError(c, 'verdict 只能是 confirm、revise 或 arbitrate');
    }
    const options: { value?: string; note?: string } = {};
    for (const key of ['value', 'note'] as const) {
      const raw = body[key];
      if (raw === undefined || raw === null) continue;
      if (typeof raw !== 'string' || raw.length > 2000) {
        return validationError(c, `${key} 必须是不超过 2000 字符的字符串`);
      }
      options[key] = raw;
    }
    const result = store.ocrRevisionReviews.record(
      c.req.param('id'),
      body.verdict,
      { id: user.id, name: user.name },
      new Date().toISOString(),
      options,
    );
    if (result === 'self') return validationError(c, '修订人不能为自己的修订出具复核意见');
    if (result === 'duplicate') return validationError(c, '你已经复核过这条修订');
    if (result === 'needs_value') return validationError(c, '改判或仲裁必须给出字段值');
    if (result === 'missing') return notFound(c, '修订记录不存在');
    if (!result) return notFound(c, '修订记录不存在');
    store.audit.record({
      actor: { id: user.id, name: user.name },
      action: 'ocr.revision_reviewed',
      target: 'ocr-field-revision',
      ip: contextIp(c, trustProxy),
      detail: { id: result.revision.id, verdict: body.verdict, reliability: result.reliability },
    });
    noStore(c);
    return c.json({ item: result, stats: store.ocrRevisionReviews.stats() });
  });

  return app;
}
