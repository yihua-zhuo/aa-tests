import { Hono } from 'hono';
import { canManageProject, hasPermission } from '../../shared/permissions.ts';
import {
  BlockerCreateSchema,
  BlockerQuerySchema,
  BlockerResolveSchema,
  DependencyCreateSchema,
  RecurrenceCreateSchema,
  RecurrenceRunSchema,
  RecurrenceSkipSchema,
  RecurrenceUpdateSchema,
  TimeLogCreateSchema,
  TimeLogQuerySchema,
  TimeLogUpdateSchema,
} from '../../shared/schemas.ts';
import type { AppEnv } from '../app-env.ts';
import { forbidden, noStore, notFound, readBody, readQuery, validationError } from '../http.ts';
import { currentUser } from '../middleware/auth.ts';
import type { EventHub } from '../sse.ts';
import type { Store } from '../store.ts';
import {
  actorOf,
  conflict,
  publishLatest,
  visibleProjectIds,
  workspaceOf,
} from './enterprise-helpers.ts';

const BlockerStatusQuerySchema = BlockerQuerySchema.omit({ projectId: true });

export function planningRoutes(store: Store, hub: EventHub): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  const canSeeAllTimeLogs = (
    user: ReturnType<typeof currentUser>,
    project: { ownerId: string } | null,
  ): boolean => {
    const visibility = store.workspace.get().timeLogVisibility;
    if (visibility === 'all') return true;
    if (visibility === 'self') return false;
    if (project) {
      return canManageProject(user.role, project.ownerId === user.id, user.permissions);
    }
    return (
      hasPermission(user.role, user.permissions, 'projects.manage_all') ||
      hasPermission(user.role, user.permissions, 'workspace.manage')
    );
  };

  app.get('/api/projects/:id/dependencies', (c) => {
    const user = currentUser(c);
    const project = store.projects.get(c.req.param('id'), user.role, user.id);
    if (!project) return notFound(c, '项目不存在');
    noStore(c);
    return c.json(store.planning.listDependencies(project.id, workspaceOf(user)));
  });

  app.post('/api/projects/:id/dependencies', async (c) => {
    const user = currentUser(c);
    const project = store.projects.get(c.req.param('id'), user.role, user.id);
    if (!project) return notFound(c, '项目不存在');
    if (!canManageProject(user.role, project.ownerId === user.id, user.permissions)) {
      return forbidden(c);
    }
    const parsed = await readBody(c, DependencyCreateSchema);
    if (!parsed.ok) return parsed.response;
    const predecessorTask = store.tasks.get(parsed.data.predecessorId);
    const successorTask = store.tasks.get(parsed.data.successorId);
    if (!predecessorTask || !successorTask) return validationError(c, '任务不存在');
    const predecessorProject = store.projects.get(predecessorTask.projectId, user.role, user.id);
    const successorProject = store.projects.get(successorTask.projectId, user.role, user.id);
    if (!predecessorProject || !successorProject) return notFound(c, '任务不存在');
    if (
      !canManageProject(user.role, predecessorProject.ownerId === user.id, user.permissions) ||
      !canManageProject(user.role, successorProject.ownerId === user.id, user.permissions)
    ) {
      return forbidden(c);
    }
    const result = store.planning.addDependency(project.id, workspaceOf(user), parsed.data);
    if (result.status === 'missing') return notFound(c, '项目不存在');
    if (result.status === 'invalid') return validationError(c, result.message);
    const successor = store.tasks.get(result.dependency.successorId);
    store.automation.runEvent({
      trigger: 'dependency.created',
      eventKey: `dependency.created:${result.dependency.id}`,
      workspaceId: project.workspaceId,
      projectId: successorProject.id,
      projectName: successorProject.name,
      taskId: successor?.id,
      taskTitle: successor?.title,
      status: successor?.status,
      priority: successor?.priority,
      assigneeId: successor?.assigneeId,
      actor: actorOf(user),
    });
    publishLatest(store, hub);
    noStore(c);
    return c.json(result.dependency, 201);
  });

  app.delete('/api/projects/:id/dependencies/:dependencyId', (c) => {
    const user = currentUser(c);
    const project = store.projects.get(c.req.param('id'), user.role, user.id);
    if (!project) return notFound(c, '项目不存在');
    if (!canManageProject(user.role, project.ownerId === user.id, user.permissions)) {
      return forbidden(c);
    }
    const dependencyId = c.req.param('dependencyId');
    const dependency = store.planning
      .listDependencies(project.id, workspaceOf(user))
      ?.find((item) => item.id === dependencyId);
    if (!dependency) return notFound(c, '依赖关系不存在');
    for (const projectId of new Set([
      dependency.predecessorProjectId,
      dependency.successorProjectId,
    ])) {
      const related = store.projects.get(projectId, user.role, user.id);
      if (!related || !canManageProject(user.role, related.ownerId === user.id, user.permissions)) {
        return forbidden(c);
      }
    }
    const removed = store.planning.removeDependency(dependencyId, project.id, workspaceOf(user));
    if (!removed) return notFound(c, '依赖关系不存在');
    noStore(c);
    return c.body(null, 204);
  });

  app.get('/api/projects/:id/critical-path', (c) => {
    const user = currentUser(c);
    const project = store.projects.get(c.req.param('id'), user.role, user.id);
    if (!project) return notFound(c, '项目不存在');
    const path = store.planning.criticalPath(project.id, workspaceOf(user));
    if (!path) return notFound(c, '项目不存在');
    noStore(c);
    return c.json(path);
  });

  app.get('/api/time-logs', (c) => {
    const parsed = readQuery(c, TimeLogQuerySchema);
    if (!parsed.ok) return parsed.response;
    const user = currentUser(c);
    const workspaceId = workspaceOf(user);
    if (parsed.data.projectId) {
      if (!store.projects.get(parsed.data.projectId, user.role, user.id)) {
        return notFound(c, '项目不存在');
      }
    }
    if (parsed.data.taskId) {
      const task = store.tasks.get(parsed.data.taskId);
      if (!task || !store.projects.get(task.projectId, user.role, user.id)) {
        return notFound(c, '任务不存在');
      }
    }
    const logs = store.planning.listTimeLogs({
      taskId: parsed.data.taskId,
      projectId: parsed.data.projectId,
      workspaceId,
    });
    const project = parsed.data.projectId
      ? store.projects.get(parsed.data.projectId, user.role, user.id)
      : null;
    const task = parsed.data.taskId ? store.tasks.get(parsed.data.taskId) : null;
    const taskProject = task ? store.projects.get(task.projectId, user.role, user.id) : null;
    const viewAll = canSeeAllTimeLogs(user, project ?? taskProject);
    const visibleLogs = viewAll ? logs : logs.filter((log) => log.userId === user.id);
    if (!parsed.data.projectId && !parsed.data.taskId) {
      const visible = visibleProjectIds(store, user);
      if (visible) {
        noStore(c);
        return c.json(
          visibleLogs.filter((log) => {
            const row = store.tasks.get(log.taskId);
            return row !== null && visible.has(row.projectId);
          }),
        );
      }
    }
    noStore(c);
    return c.json(visibleLogs);
  });

  app.post('/api/tasks/:id/time-logs', async (c) => {
    const user = currentUser(c);
    const task = store.tasks.get(c.req.param('id'));
    if (!task) return notFound(c, '任务不存在');
    if (!store.projects.get(task.projectId, user.role, user.id)) {
      return notFound(c, '任务不存在');
    }
    const parsed = await readBody(c, TimeLogCreateSchema);
    if (!parsed.ok) return parsed.response;
    const result = store.planning.addTimeLog(
      task.id,
      workspaceOf(user),
      parsed.data,
      actorOf(user),
    );
    if (result.status === 'missing') return notFound(c, '任务不存在');
    if (result.status === 'invalid') return validationError(c, result.message);
    if (result.status === 'conflict') {
      return conflict(c, '工时记录已被其他会话修改，已返回最新版本', result.current);
    }
    store.audit.record({
      actor: actorOf(user),
      action: 'time_log.create',
      target: result.log.id,
      detail: { taskId: task.id, minutes: result.log.minutes, userId: result.log.userId },
    });
    noStore(c);
    return c.json(result.log, 201);
  });

  app.patch('/api/tasks/:id/time-logs/:logId', async (c) => {
    const user = currentUser(c);
    const task = store.tasks.get(c.req.param('id'));
    if (!task) return notFound(c, '任务不存在');
    const project = store.projects.get(task.projectId, user.role, user.id);
    if (!project) return notFound(c, '任务不存在');
    const log = store.planning.getTimeLog(c.req.param('logId'), workspaceOf(user));
    if (!log || log.taskId !== task.id) return notFound(c, '工时记录不存在');
    const manager = canManageProject(user.role, project.ownerId === user.id, user.permissions);
    if (log.userId !== user.id && !manager) return forbidden(c);
    const parsed = await readBody(c, TimeLogUpdateSchema);
    if (!parsed.ok) return parsed.response;
    const result = store.planning.updateTimeLog(log.id, task.id, workspaceOf(user), parsed.data);
    if (result.status === 'missing') return notFound(c, '工时记录不存在');
    if (result.status === 'invalid') return validationError(c, result.message);
    if (result.status === 'conflict') {
      return conflict(c, '工时记录已被其他会话修改，已返回最新版本', result.current);
    }
    store.audit.record({
      actor: actorOf(user),
      action: 'time_log.update',
      target: result.log.id,
      detail: { taskId: task.id, before: log, after: result.log },
    });
    noStore(c);
    return c.json(result.log);
  });

  app.delete('/api/tasks/:id/time-logs/:logId', (c) => {
    const user = currentUser(c);
    const task = store.tasks.get(c.req.param('id'));
    if (!task) return notFound(c, '任务不存在');
    const project = store.projects.get(task.projectId, user.role, user.id);
    if (!project) return notFound(c, '任务不存在');
    const log = store.planning.getTimeLog(c.req.param('logId'), workspaceOf(user));
    if (!log || log.taskId !== task.id) return notFound(c, '工时记录不存在');
    const manager = canManageProject(user.role, project.ownerId === user.id, user.permissions);
    if (log.userId !== user.id && !manager) return forbidden(c);
    store.planning.removeTimeLog(log.id, task.id, workspaceOf(user));
    store.audit.record({
      actor: actorOf(user),
      action: 'time_log.delete',
      target: log.id,
      detail: { taskId: task.id, userId: log.userId, minutes: log.minutes, workDate: log.workDate },
    });
    noStore(c);
    return c.body(null, 204);
  });

  app.get('/api/tasks/:id/time-logs/summary', (c) => {
    const user = currentUser(c);
    const task = store.tasks.get(c.req.param('id'));
    if (!task) return notFound(c, '任务不存在');
    const project = store.projects.get(task.projectId, user.role, user.id);
    if (!project) return notFound(c, '任务不存在');
    const summary = store.planning.timeSummary(task.id, workspaceOf(user));
    if (!summary) return notFound(c, '任务不存在');
    if (!canSeeAllTimeLogs(user, project)) {
      const logs = summary.logs.filter((log) => log.userId === user.id);
      const actualMinutes = logs.reduce((total, log) => total + log.minutes, 0);
      const actualHours = Number((actualMinutes / 60).toFixed(2));
      noStore(c);
      return c.json({
        ...summary,
        actualMinutes,
        actualHours,
        varianceHours:
          summary.estimateHours === null
            ? null
            : Number((actualHours - summary.estimateHours).toFixed(2)),
        logs,
      });
    }
    noStore(c);
    return c.json(summary);
  });

  app.get('/api/projects/:id/blockers', (c) => {
    const user = currentUser(c);
    const project = store.projects.get(c.req.param('id'), user.role, user.id);
    if (!project) return notFound(c, '项目不存在');
    const parsed = readQuery(c, BlockerStatusQuerySchema);
    if (!parsed.ok) return parsed.response;
    const blockers = store.planning.listBlockers(project.id, workspaceOf(user), parsed.data.status);
    if (!blockers) return notFound(c, '项目不存在');
    noStore(c);
    return c.json(blockers);
  });

  app.get('/api/projects/:id/blockers/report', (c) => {
    const user = currentUser(c);
    const project = store.projects.get(c.req.param('id'), user.role, user.id);
    if (!project) return notFound(c, '项目不存在');
    const report = store.planning.blockerReport(project.id, workspaceOf(user));
    if (!report) return notFound(c, '项目不存在');
    noStore(c);
    return c.json(report);
  });

  app.post('/api/tasks/:id/blockers', async (c) => {
    const user = currentUser(c);
    const task = store.tasks.get(c.req.param('id'));
    if (!task) return notFound(c, '任务不存在');
    const project = store.projects.get(task.projectId, user.role, user.id);
    if (!project) return notFound(c, '任务不存在');
    const parsed = await readBody(c, BlockerCreateSchema);
    if (!parsed.ok) return parsed.response;
    const result = store.planning.addBlocker(
      task.id,
      workspaceOf(user),
      parsed.data,
      actorOf(user),
    );
    if (result.status === 'missing') return notFound(c, '任务不存在');
    if (result.status === 'invalid') return validationError(c, result.message);
    if (result.status === 'conflict') {
      return conflict(c, '阻塞记录已被其他会话修改，已返回最新版本', result.current);
    }
    store.automation.runEvent({
      trigger: 'blocker.created',
      eventKey: `blocker.created:${result.blocker.id}`,
      workspaceId: project.workspaceId,
      projectId: project.id,
      projectName: project.name,
      taskId: task.id,
      taskTitle: task.title,
      status: task.status,
      priority: task.priority,
      assigneeId: task.assigneeId,
      actor: actorOf(user),
    });
    publishLatest(store, hub);
    noStore(c);
    return c.json(result.blocker, 201);
  });

  app.post('/api/projects/:id/blockers/:blockerId/resolve', async (c) => {
    const user = currentUser(c);
    const project = store.projects.get(c.req.param('id'), user.role, user.id);
    if (!project) return notFound(c, '项目不存在');
    if (!canManageProject(user.role, project.ownerId === user.id, user.permissions)) {
      return forbidden(c);
    }
    const parsed = await readBody(c, BlockerResolveSchema);
    if (!parsed.ok) return parsed.response;
    const result = store.planning.resolveBlocker(
      c.req.param('blockerId'),
      workspaceOf(user),
      parsed.data,
      actorOf(user),
    );
    if (result.status === 'missing') return notFound(c, '阻塞记录不存在');
    if (result.status === 'invalid') return validationError(c, result.message);
    if (result.status === 'conflict') {
      return conflict(c, '阻塞记录已被其他会话修改，已返回最新版本', result.current);
    }
    noStore(c);
    return c.json(result.blocker);
  });

  app.get('/api/projects/:id/recurrences', (c) => {
    const user = currentUser(c);
    const project = store.projects.get(c.req.param('id'), user.role, user.id);
    if (!project) return notFound(c, '项目不存在');
    const rules = store.planning.listRecurrences(project.id, workspaceOf(user));
    if (!rules) return notFound(c, '项目不存在');
    noStore(c);
    return c.json(rules);
  });

  app.post('/api/projects/:id/recurrences', async (c) => {
    const user = currentUser(c);
    const project = store.projects.get(c.req.param('id'), user.role, user.id);
    if (!project) return notFound(c, '项目不存在');
    if (!canManageProject(user.role, project.ownerId === user.id, user.permissions)) {
      return forbidden(c);
    }
    const parsed = await readBody(c, RecurrenceCreateSchema);
    if (!parsed.ok) return parsed.response;
    const result = store.planning.createRecurrence(
      project.id,
      workspaceOf(user),
      parsed.data,
      actorOf(user),
    );
    if (result.status === 'missing') return notFound(c, '项目不存在');
    if (result.status === 'invalid') return validationError(c, result.message);
    if (result.status === 'conflict') {
      return conflict(c, '重复规则已被其他会话修改，已返回最新版本', result.current);
    }
    noStore(c);
    return c.json(result.rule, 201);
  });

  app.patch('/api/recurrences/:id', async (c) => {
    const user = currentUser(c);
    const id = c.req.param('id');
    const rule = store.planning.getRecurrence(id, workspaceOf(user));
    if (!rule) return notFound(c, '重复规则不存在');
    const project = store.projects.get(rule.projectId, user.role, user.id);
    if (!project) return notFound(c, '重复规则不存在');
    if (!canManageProject(user.role, project.ownerId === user.id, user.permissions)) {
      return forbidden(c);
    }
    const parsed = await readBody(c, RecurrenceUpdateSchema);
    if (!parsed.ok) return parsed.response;
    const result = store.planning.updateRecurrence(id, workspaceOf(user), parsed.data);
    if (result.status === 'missing') return notFound(c, '重复规则不存在');
    if (result.status === 'invalid') return validationError(c, result.message);
    if (result.status === 'conflict') {
      return conflict(c, '重复规则已被其他会话修改，已返回最新版本', result.current);
    }
    noStore(c);
    return c.json(result.rule);
  });

  app.delete('/api/recurrences/:id', (c) => {
    const user = currentUser(c);
    const id = c.req.param('id');
    const rule = store.planning.getRecurrence(id, workspaceOf(user));
    if (!rule) return notFound(c, '重复规则不存在');
    const project = store.projects.get(rule.projectId, user.role, user.id);
    if (!project) return notFound(c, '重复规则不存在');
    if (!canManageProject(user.role, project.ownerId === user.id, user.permissions)) {
      return forbidden(c);
    }
    store.planning.removeRecurrence(id, workspaceOf(user));
    noStore(c);
    return c.body(null, 204);
  });

  app.post('/api/recurrences/:id/skip', async (c) => {
    const user = currentUser(c);
    const id = c.req.param('id');
    const rule = store.planning.getRecurrence(id, workspaceOf(user));
    if (!rule) return notFound(c, '重复规则不存在');
    const project = store.projects.get(rule.projectId, user.role, user.id);
    if (!project) return notFound(c, '重复规则不存在');
    if (!canManageProject(user.role, project.ownerId === user.id, user.permissions)) {
      return forbidden(c);
    }
    const parsed = await readBody(c, RecurrenceSkipSchema);
    if (!parsed.ok) return parsed.response;
    const result = store.planning.skipOccurrence(id, workspaceOf(user), parsed.data);
    if (result.status === 'missing') return notFound(c, '重复规则不存在');
    if (result.status === 'invalid') return validationError(c, result.message);
    if (result.status === 'conflict') {
      return conflict(c, '重复规则已被其他会话修改，已返回最新版本', result.current);
    }
    noStore(c);
    return c.json(result.rule);
  });

  app.post('/api/recurrences/:id/run', async (c) => {
    const user = currentUser(c);
    const id = c.req.param('id');
    const rule = store.planning.getRecurrence(id, workspaceOf(user));
    if (!rule) return notFound(c, '重复规则不存在');
    const project = store.projects.get(rule.projectId, user.role, user.id);
    if (!project) return notFound(c, '重复规则不存在');
    if (!canManageProject(user.role, project.ownerId === user.id, user.permissions)) {
      return forbidden(c);
    }
    const parsed = await readBody(c, RecurrenceRunSchema);
    if (!parsed.ok) return parsed.response;
    const result = store.planning.runRecurrence(
      id,
      workspaceOf(user),
      parsed.data.through,
      actorOf(user),
    );
    if (result.status === 'missing') return notFound(c, '重复规则不存在');
    if (result.status === 'invalid') return validationError(c, result.message);
    for (const occurrence of result.generated) {
      const created = store.tasks.get(occurrence.taskId);
      if (!created) continue;
      store.automation.runEvent({
        trigger: 'task.created',
        eventKey: `task.created:${created.id}`,
        workspaceId: project.workspaceId,
        projectId: project.id,
        projectName: project.name,
        taskId: created.id,
        taskTitle: created.title,
        status: created.status,
        priority: created.priority,
        assigneeId: created.assigneeId,
        actor: actorOf(user),
      });
    }
    publishLatest(store, hub);
    noStore(c);
    return c.json({
      generated: result.generated,
      skipped: result.skipped,
      nextOccurrence: result.nextOccurrence,
    });
  });

  return app;
}
