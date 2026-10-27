import { Hono } from 'hono';
import {
  AutomationDryRunSchema,
  AutomationPruneSchema,
  AutomationQuerySchema,
  AutomationRuleCreateSchema,
  AutomationRuleUpdateSchema,
  AutomationRunsQuerySchema,
} from '../../shared/schemas.ts';
import type { AppEnv } from '../app-env.ts';
import { forbidden, noStore, notFound, readBody, readQuery, validationError } from '../http.ts';
import { currentUser } from '../middleware/auth.ts';
import type { Store } from '../store.ts';
import { canWriteWorkspace, conflict, workspaceOf } from './enterprise-helpers.ts';

export function automationRoutes(store: Store): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get('/api/automation/rules', (c) => {
    const parsed = readQuery(c, AutomationQuerySchema);
    if (!parsed.ok) return parsed.response;
    const user = currentUser(c);
    if (parsed.data.projectId && !store.projects.get(parsed.data.projectId, user.role, user.id)) {
      return notFound(c, '项目不存在');
    }
    noStore(c);
    return c.json(
      store.automation.listRules(workspaceOf(user), {
        trigger: parsed.data.trigger,
        projectId: parsed.data.projectId,
      }),
    );
  });

  app.post('/api/automation/rules', async (c) => {
    const user = currentUser(c);
    if (!canWriteWorkspace(user)) return forbidden(c);
    const parsed = await readBody(c, AutomationRuleCreateSchema);
    if (!parsed.ok) return parsed.response;
    const result = store.automation.createRule(workspaceOf(user), parsed.data, user.id);
    if (result.status === 'invalid') return validationError(c, result.message);
    if (result.status === 'missing') return notFound(c, '工作区不存在');
    if (result.status === 'conflict') {
      return conflict(c, '自动化规则已被其他会话修改，已返回最新版本', result.current);
    }
    noStore(c);
    return c.json(result.rule, 201);
  });

  app.patch('/api/automation/rules/:id', async (c) => {
    const user = currentUser(c);
    if (!canWriteWorkspace(user)) return forbidden(c);
    const parsed = await readBody(c, AutomationRuleUpdateSchema);
    if (!parsed.ok) return parsed.response;
    const result = store.automation.updateRule(c.req.param('id'), workspaceOf(user), parsed.data);
    if (result.status === 'missing') return notFound(c, '自动化规则不存在');
    if (result.status === 'invalid') return validationError(c, result.message);
    if (result.status === 'conflict') {
      return conflict(c, '自动化规则已被其他会话修改，已返回最新版本', result.current);
    }
    noStore(c);
    return c.json(result.rule);
  });

  app.delete('/api/automation/rules/:id', (c) => {
    const user = currentUser(c);
    if (!canWriteWorkspace(user)) return forbidden(c);
    const removed = store.automation.removeRule(c.req.param('id'), workspaceOf(user));
    if (!removed) return notFound(c, '自动化规则不存在');
    noStore(c);
    return c.body(null, 204);
  });

  app.post('/api/automation/rules/:id/dry-run', async (c) => {
    const user = currentUser(c);
    if (!canWriteWorkspace(user)) return forbidden(c);
    const parsed = await readBody(c, AutomationDryRunSchema);
    if (!parsed.ok) return parsed.response;
    const preview = store.automation.dryRun(
      c.req.param('id'),
      workspaceOf(user),
      parsed.data,
      user.id,
    );
    if (!preview) return notFound(c, '自动化规则不存在或已停用');
    noStore(c);
    return c.json(preview);
  });

  app.get('/api/automation/runs', (c) => {
    const parsed = readQuery(c, AutomationRunsQuerySchema);
    if (!parsed.ok) return parsed.response;
    const user = currentUser(c);
    noStore(c);
    return c.json(
      store.automation.listRuns(workspaceOf(user), {
        ruleId: parsed.data.ruleId,
        limit: parsed.data.limit,
      }),
    );
  });

  app.get('/api/automation/runs/dead-letter', (c) => {
    const user = currentUser(c);
    noStore(c);
    return c.json(store.automation.deadLetters(workspaceOf(user)));
  });

  app.post('/api/automation/runs/:id/replay', (c) => {
    const user = currentUser(c);
    if (!canWriteWorkspace(user)) return forbidden(c);
    const run = store.automation.replayRun(c.req.param('id'), workspaceOf(user), {
      id: user.id,
      name: user.name,
    });
    if (!run) return notFound(c, '自动化运行记录不存在或无法重放');
    noStore(c);
    return c.json(run, 201);
  });

  app.post('/api/automation/runs/:id/actions/:index/retry', (c) => {
    const user = currentUser(c);
    if (!canWriteWorkspace(user)) return forbidden(c);
    const index = Number(c.req.param('index'));
    const result = store.automation.retryRunAction(c.req.param('id'), workspaceOf(user), index, {
      id: user.id,
      name: user.name,
    });
    if (result.status === 'missing') return notFound(c, '自动化运行记录不存在');
    if (result.status === 'invalid') return validationError(c, result.message ?? '动作重试失败');
    noStore(c);
    return c.json(result.run, 201);
  });

  app.post('/api/automation/runs/prune', async (c) => {
    const user = currentUser(c);
    if (!canWriteWorkspace(user)) return forbidden(c);
    const parsed = await readBody(c, AutomationPruneSchema);
    if (!parsed.ok) return parsed.response;
    const removed = store.automation.pruneRuns(workspaceOf(user), parsed.data.olderThanDays);
    noStore(c);
    return c.json({ removed });
  });

  return app;
}
