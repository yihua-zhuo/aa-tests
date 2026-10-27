import { Hono } from 'hono';
import { z } from 'zod';
import { canManageProject } from '../../shared/permissions.ts';
import {
  GoalCreateSchema,
  GoalImpactSchema,
  GoalLinkCreateSchema,
  GoalQuerySchema,
  GoalUpdateSchema,
  KeyResultCreateSchema,
  KeyResultUpdateSchema,
  PortfolioConfigCreateSchema,
  PortfolioConfigUpdateSchema,
  PortfolioQuerySchema,
  PortfolioScoreSchema,
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

const PortfolioScoreQuerySchema = PortfolioQuerySchema.extend({
  configId: z.string().uuid('评分模板无效'),
});

export function strategyRoutes(store: Store): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get('/api/goals', (c) => {
    const parsed = readQuery(c, GoalQuerySchema);
    if (!parsed.ok) return parsed.response;
    const user = currentUser(c);
    if (parsed.data.projectId && !store.projects.get(parsed.data.projectId, user.role, user.id)) {
      return notFound(c, '项目不存在');
    }
    noStore(c);
    const goals = store.goals.list({
      workspaceId: workspaceOf(user),
      projectId: parsed.data.projectId,
      level: parsed.data.level,
      includeArchived: parsed.data.includeArchived === '1',
      visibleProjectIds: visibleProjectIds(store, user),
    });
    return c.json({
      goals,
      roots: goals.filter((goal) => goal.parentId === null).map((goal) => goal.id),
    });
  });

  app.post('/api/goals', async (c) => {
    const user = currentUser(c);
    if (!canWriteWorkspace(user)) return forbidden(c);
    const parsed = await readBody(c, GoalCreateSchema);
    if (!parsed.ok) return parsed.response;
    const result = store.goals.create(workspaceOf(user), parsed.data, actorOf(user));
    if (result.status === 'invalid') return validationError(c, result.message);
    if (result.status === 'missing') return notFound(c, '工作区不存在');
    if (result.status === 'conflict') {
      return conflict(c, '目标已被其他会话修改，已返回最新版本', result.current);
    }
    noStore(c);
    return c.json(result.goal, 201);
  });

  app.get('/api/goals/:id', (c) => {
    const user = currentUser(c);
    const goal = store.goals.get(
      c.req.param('id'),
      workspaceOf(user),
      visibleProjectIds(store, user),
    );
    if (!goal) return notFound(c, '目标不存在');
    noStore(c);
    return c.json(goal);
  });

  app.patch('/api/goals/:id', async (c) => {
    const user = currentUser(c);
    const id = c.req.param('id');
    const goal = store.goals.get(id, workspaceOf(user), visibleProjectIds(store, user));
    if (!goal) return notFound(c, '目标不存在');
    if (!canWriteWorkspace(user)) return forbidden(c);
    const parsed = await readBody(c, GoalUpdateSchema);
    if (!parsed.ok) return parsed.response;
    const result = store.goals.update(id, workspaceOf(user), parsed.data, actorOf(user));
    if (result.status === 'missing') return notFound(c, '目标不存在');
    if (result.status === 'invalid') return validationError(c, result.message);
    if (result.status === 'conflict') {
      return conflict(c, '目标已被其他会话修改，已返回最新版本', result.current);
    }
    noStore(c);
    return c.json(result.goal);
  });

  app.delete('/api/goals/:id', (c) => {
    const user = currentUser(c);
    const id = c.req.param('id');
    const goal = store.goals.get(id, workspaceOf(user), visibleProjectIds(store, user));
    if (!goal) return notFound(c, '目标不存在');
    if (!canWriteWorkspace(user)) return forbidden(c);
    store.goals.remove(id, workspaceOf(user));
    noStore(c);
    return c.body(null, 204);
  });

  app.post('/api/goals/:id/impact', async (c) => {
    const user = currentUser(c);
    const id = c.req.param('id');
    const parsed = await readBody(c, GoalImpactSchema);
    if (!parsed.ok) return parsed.response;
    const impact = store.goals.impact(
      id,
      workspaceOf(user),
      parsed.data,
      visibleProjectIds(store, user),
    );
    if (!impact) return notFound(c, '目标不存在');
    noStore(c);
    return c.json(impact);
  });

  app.get('/api/goals/:id/changes', (c) => {
    const user = currentUser(c);
    const id = c.req.param('id');
    const goal = store.goals.get(id, workspaceOf(user), visibleProjectIds(store, user));
    if (!goal) return notFound(c, '目标不存在');
    noStore(c);
    return c.json(store.goals.changeLogs(id, workspaceOf(user)));
  });

  app.post('/api/goals/:id/key-results', async (c) => {
    const user = currentUser(c);
    const id = c.req.param('id');
    const goal = store.goals.get(id, workspaceOf(user), visibleProjectIds(store, user));
    if (!goal) return notFound(c, '目标不存在');
    if (!canWriteWorkspace(user)) return forbidden(c);
    const parsed = await readBody(c, KeyResultCreateSchema);
    if (!parsed.ok) return parsed.response;
    const keyResult = store.goals.addKeyResult(id, workspaceOf(user), parsed.data);
    if (!keyResult) return notFound(c, '目标不存在');
    noStore(c);
    return c.json(keyResult, 201);
  });

  app.patch('/api/goals/:id/key-results/:keyResultId', async (c) => {
    const user = currentUser(c);
    const id = c.req.param('id');
    const goal = store.goals.get(id, workspaceOf(user), visibleProjectIds(store, user));
    if (!goal) return notFound(c, '目标不存在');
    if (!canWriteWorkspace(user)) return forbidden(c);
    const parsed = await readBody(c, KeyResultUpdateSchema);
    if (!parsed.ok) return parsed.response;
    const result = store.goals.updateKeyResult(
      c.req.param('keyResultId'),
      id,
      workspaceOf(user),
      parsed.data,
    );
    if (result.status === 'missing') return notFound(c, '关键结果不存在');
    if (result.status === 'conflict') {
      return conflict(c, '关键结果已被其他会话修改，已返回最新版本', result.current);
    }
    noStore(c);
    return c.json(result.keyResult);
  });

  app.delete('/api/goals/:id/key-results/:keyResultId', (c) => {
    const user = currentUser(c);
    const id = c.req.param('id');
    const goal = store.goals.get(id, workspaceOf(user), visibleProjectIds(store, user));
    if (!goal) return notFound(c, '目标不存在');
    if (!canWriteWorkspace(user)) return forbidden(c);
    const removed = store.goals.removeKeyResult(c.req.param('keyResultId'), id, workspaceOf(user));
    if (!removed) return notFound(c, '关键结果不存在');
    noStore(c);
    return c.body(null, 204);
  });

  app.post('/api/goals/:id/links', async (c) => {
    const user = currentUser(c);
    const id = c.req.param('id');
    const goal = store.goals.get(id, workspaceOf(user), visibleProjectIds(store, user));
    if (!goal) return notFound(c, '目标不存在');
    if (!canWriteWorkspace(user)) return forbidden(c);
    const parsed = await readBody(c, GoalLinkCreateSchema);
    if (!parsed.ok) return parsed.response;
    const result = store.goals.addLink(id, workspaceOf(user), parsed.data);
    if (result.status === 'missing') return notFound(c, '目标不存在');
    if (result.status === 'invalid') return validationError(c, result.message);
    noStore(c);
    return c.json(result.link, 201);
  });

  app.delete('/api/goals/:id/links/:linkId', (c) => {
    const user = currentUser(c);
    const id = c.req.param('id');
    const goal = store.goals.get(id, workspaceOf(user), visibleProjectIds(store, user));
    if (!goal) return notFound(c, '目标不存在');
    if (!canWriteWorkspace(user)) return forbidden(c);
    const removed = store.goals.removeLink(c.req.param('linkId'), id, workspaceOf(user));
    if (!removed) return notFound(c, '关联不存在');
    noStore(c);
    return c.body(null, 204);
  });

  app.get('/api/portfolio/configs', (c) => {
    const user = currentUser(c);
    noStore(c);
    return c.json(store.portfolio.listConfigs(workspaceOf(user), true));
  });

  app.post('/api/portfolio/configs', async (c) => {
    const user = currentUser(c);
    if (!canWriteWorkspace(user)) return forbidden(c);
    const parsed = await readBody(c, PortfolioConfigCreateSchema);
    if (!parsed.ok) return parsed.response;
    const result = store.portfolio.createConfig(
      workspaceOf(user),
      {
        ...parsed.data,
        weights: parsed.data.weights.map((factor) => ({
          key: factor.key,
          label: factor.label ?? factor.key,
          weight: factor.weight,
          direction: factor.direction,
        })),
      },
      user.id,
    );
    if (result.status === 'invalid') return validationError(c, result.message);
    if (result.status === 'missing') return notFound(c, '工作区不存在');
    if (result.status === 'conflict') {
      return conflict(c, '评分模板已被其他会话修改，已返回最新版本', result.current);
    }
    noStore(c);
    return c.json(result.config, 201);
  });

  app.patch('/api/portfolio/configs/:id', async (c) => {
    const user = currentUser(c);
    if (!canWriteWorkspace(user)) return forbidden(c);
    const parsed = await readBody(c, PortfolioConfigUpdateSchema);
    if (!parsed.ok) return parsed.response;
    const weights = parsed.data.weights
      ? parsed.data.weights.map((factor) => ({
          key: factor.key,
          label: factor.label ?? factor.key,
          weight: factor.weight,
          direction: factor.direction,
        }))
      : undefined;
    const input: Parameters<typeof store.portfolio.updateConfig>[2] = {
      ...parsed.data,
      weights,
    };
    const result = store.portfolio.updateConfig(c.req.param('id'), workspaceOf(user), input);
    if (result.status === 'missing') return notFound(c, '评分模板不存在');
    if (result.status === 'invalid') return validationError(c, result.message);
    if (result.status === 'conflict') {
      return conflict(c, '评分模板已被其他会话修改，已返回最新版本', result.current);
    }
    noStore(c);
    return c.json(result.config);
  });

  app.delete('/api/portfolio/configs/:id', (c) => {
    const user = currentUser(c);
    if (!canWriteWorkspace(user)) return forbidden(c);
    const removed = store.portfolio.removeConfig(c.req.param('id'), workspaceOf(user));
    if (!removed) return notFound(c, '评分模板不存在');
    noStore(c);
    return c.body(null, 204);
  });

  app.get('/api/portfolio/scores', (c) => {
    const parsed = readQuery(c, PortfolioQuerySchema);
    if (!parsed.ok) return parsed.response;
    const user = currentUser(c);
    const workspaceId = workspaceOf(user);
    const visible = visibleProjectIds(store, user);
    const configs = parsed.data.configId
      ? [store.portfolio.getConfig(parsed.data.configId, workspaceId)]
      : store.portfolio.listConfigs(workspaceId, true);
    const scores = configs.flatMap((config) =>
      config ? store.portfolio.listScores(workspaceId, config.id, visible) : [],
    );
    noStore(c);
    return c.json(scores);
  });

  app.get('/api/portfolio/scores/:projectId', (c) => {
    const parsed = readQuery(c, PortfolioScoreQuerySchema);
    if (!parsed.ok) return parsed.response;
    const user = currentUser(c);
    const workspaceId = workspaceOf(user);
    if (!store.projects.get(c.req.param('projectId'), user.role, user.id)) {
      return notFound(c, '项目不存在');
    }
    const score = store.portfolio.getScore(
      c.req.param('projectId'),
      parsed.data.configId,
      workspaceId,
    );
    if (!score) return notFound(c, '项目评分不存在');
    noStore(c);
    return c.json(score);
  });

  app.post('/api/portfolio/scores', async (c) => {
    const user = currentUser(c);
    const parsed = await readBody(c, PortfolioScoreSchema);
    if (!parsed.ok) return parsed.response;
    const project = store.projects.get(parsed.data.projectId, user.role, user.id);
    if (!project) return notFound(c, '项目不存在');
    if (!canManageProject(user.role, project.ownerId === user.id, user.permissions)) {
      return forbidden(c);
    }
    const result = store.portfolio.score(
      parsed.data.projectId,
      parsed.data.configId,
      workspaceOf(user),
      parsed.data,
      user.id,
    );
    if (result.status === 'missing') return notFound(c, '项目或评分模板不存在');
    if (result.status === 'invalid') return validationError(c, result.message);
    noStore(c);
    return c.json(result.score);
  });

  return app;
}
