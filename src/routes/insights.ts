import { Hono } from 'hono';
import { canManageProject } from '../../shared/permissions.ts';
import {
  BudgetEntryCreateSchema,
  BudgetUpsertSchema,
  MetricCreateSchema,
  MetricEvaluateSchema,
  MetricQuerySchema,
  MetricUpdateSchema,
} from '../../shared/schemas.ts';
import type { AppEnv } from '../app-env.ts';
import { forbidden, noStore, notFound, readBody, readQuery, validationError } from '../http.ts';
import { currentUser } from '../middleware/auth.ts';
import type { Store } from '../store.ts';
import {
  actorOf,
  canWriteWorkspace,
  conflict,
  visibleProjectIds,
  workspaceOf,
} from './enterprise-helpers.ts';

export function insightsRoutes(store: Store): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get('/api/metrics', (c) => {
    const parsed = readQuery(c, MetricQuerySchema);
    if (!parsed.ok) return parsed.response;
    const user = currentUser(c);
    noStore(c);
    return c.json(store.insights.listMetrics(workspaceOf(user), parsed.data.status));
  });

  app.post('/api/metrics', async (c) => {
    const user = currentUser(c);
    if (!canWriteWorkspace(user)) return forbidden(c);
    const parsed = await readBody(c, MetricCreateSchema);
    if (!parsed.ok) return parsed.response;
    const result = store.insights.createMetric(workspaceOf(user), parsed.data, actorOf(user));
    if (result.status === 'invalid') return validationError(c, result.message);
    if (result.status === 'missing') return notFound(c, '工作区不存在');
    if (result.status === 'conflict') {
      return conflict(c, '指标已被其他会话修改，已返回最新版本', result.current);
    }
    noStore(c);
    return c.json(result.metric, 201);
  });

  app.get('/api/metrics/:id', (c) => {
    const user = currentUser(c);
    const metric = store.insights.getMetric(c.req.param('id'), workspaceOf(user));
    if (!metric) return notFound(c, '指标不存在');
    noStore(c);
    return c.json(metric);
  });

  app.patch('/api/metrics/:id', async (c) => {
    const user = currentUser(c);
    if (!canWriteWorkspace(user)) return forbidden(c);
    const parsed = await readBody(c, MetricUpdateSchema);
    if (!parsed.ok) return parsed.response;
    const result = store.insights.updateMetric(
      c.req.param('id'),
      workspaceOf(user),
      parsed.data,
      actorOf(user),
    );
    if (result.status === 'missing') return notFound(c, '指标不存在');
    if (result.status === 'invalid') return validationError(c, result.message);
    if (result.status === 'conflict') {
      return conflict(c, '指标已被其他会话修改，已返回最新版本', result.current);
    }
    noStore(c);
    return c.json({
      ...result.metric,
      recalculationRequired: result.recalculationRequired ?? false,
    });
  });

  app.get('/api/metrics/:id/versions', (c) => {
    const user = currentUser(c);
    const versions = store.insights.listMetricVersions(c.req.param('id'), workspaceOf(user));
    if (!versions) return notFound(c, '指标不存在');
    noStore(c);
    return c.json(versions);
  });

  app.post('/api/metrics/:id/evaluate', async (c) => {
    const user = currentUser(c);
    const parsed = await readBody(c, MetricEvaluateSchema);
    if (!parsed.ok) return parsed.response;
    const evaluation = store.insights.evaluateMetric(
      c.req.param('id'),
      workspaceOf(user),
      parsed.data,
    );
    if (!evaluation) return notFound(c, '指标不存在');
    noStore(c);
    return c.json(evaluation);
  });

  app.get('/api/budgets', (c) => {
    const user = currentUser(c);
    noStore(c);
    return c.json(store.insights.listBudgets(workspaceOf(user), visibleProjectIds(store, user)));
  });

  app.get('/api/projects/:id/budget', (c) => {
    const user = currentUser(c);
    if (!store.projects.get(c.req.param('id'), user.role, user.id)) {
      return notFound(c, '项目不存在');
    }
    const summary = store.insights.budgetSummary(c.req.param('id'), workspaceOf(user));
    if (!summary) return notFound(c, '预算不存在');
    noStore(c);
    return c.json(summary);
  });

  app.put('/api/projects/:id/budget', async (c) => {
    const user = currentUser(c);
    const project = store.projects.get(c.req.param('id'), user.role, user.id);
    if (!project) return notFound(c, '项目不存在');
    if (!canManageProject(user.role, project.ownerId === user.id, user.permissions)) {
      return forbidden(c);
    }
    const parsed = await readBody(c, BudgetUpsertSchema);
    if (!parsed.ok) return parsed.response;
    const result = store.insights.upsertBudget(
      project.id,
      workspaceOf(user),
      parsed.data,
      actorOf(user),
    );
    if (result.status === 'missing') return notFound(c, '项目不存在');
    if (result.status === 'invalid') return validationError(c, result.message);
    if (result.status === 'conflict') {
      return conflict(c, '预算已被其他会话修改，已返回最新版本', result.current);
    }
    noStore(c);
    return c.json(result.summary);
  });

  app.post('/api/projects/:id/budget/entries', async (c) => {
    const user = currentUser(c);
    const project = store.projects.get(c.req.param('id'), user.role, user.id);
    if (!project) return notFound(c, '项目不存在');
    if (!canManageProject(user.role, project.ownerId === user.id, user.permissions)) {
      return forbidden(c);
    }
    const parsed = await readBody(c, BudgetEntryCreateSchema);
    if (!parsed.ok) return parsed.response;
    const result = store.insights.addBudgetEntry(
      project.id,
      workspaceOf(user),
      parsed.data,
      actorOf(user),
    );
    if (result.status === 'missing') return notFound(c, '预算不存在');
    if (result.status === 'invalid') return validationError(c, result.message);
    noStore(c);
    return c.json({ ...result.summary, replayed: result.replayed }, 201);
  });

  return app;
}
