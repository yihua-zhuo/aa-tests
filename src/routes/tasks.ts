import { Hono } from 'hono';
import { canManageProject } from '../../shared/permissions.ts';
import { MilestoneCreateSchema, TaskCreateSchema, TaskUpdateSchema } from '../../shared/schemas.ts';
import type { SessionUser, UserOption } from '../../shared/types.ts';
import type { AppEnv } from '../app-env.ts';
import { forbidden, noStore, notFound, readBody, validationError } from '../http.ts';
import { currentUser } from '../middleware/auth.ts';
import { publishActivity } from '../realtime.ts';
import type { EventHub } from '../sse.ts';
import type { Store } from '../store.ts';

function actorOf(user: SessionUser): UserOption {
  return { id: user.id, name: user.name };
}

function publishLatest(store: Store, hub: EventHub): void {
  const activity = store.activities.latest();
  if (activity) publishActivity(hub, store, activity);
}

export function taskRoutes(store: Store, hub: EventHub): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get('/api/projects/:id/tasks', (c) => {
    const user = currentUser(c);
    const id = c.req.param('id');
    if (!store.projects.get(id, user.role, user.id)) return notFound(c, '项目不存在');
    noStore(c);
    return c.json(store.tasks.list(id));
  });

  app.post('/api/projects/:id/tasks', async (c) => {
    const user = currentUser(c);
    const id = c.req.param('id');
    const project = store.projects.get(id, user.role, user.id);
    if (!project) return notFound(c, '项目不存在');
    if (!canManageProject(user.role, project.ownerId === user.id, user.permissions))
      return forbidden(c);

    const parsed = await readBody(c, TaskCreateSchema);
    if (!parsed.ok) return parsed.response;
    const result = store.tasks.create(id, parsed.data, actorOf(user));
    if (result.status === 'invalid') return validationError(c, result.message);

    store.automation.runEvent({
      trigger: 'task.created',
      eventKey: `task.created:${result.task.id}`,
      workspaceId: project.workspaceId,
      projectId: project.id,
      projectName: project.name,
      taskId: result.task.id,
      taskTitle: result.task.title,
      status: result.task.status,
      priority: result.task.priority,
      assigneeId: result.task.assigneeId,
      actor: actorOf(user),
    });
    publishLatest(store, hub);
    noStore(c);
    return c.json(result.task, 201);
  });

  app.patch('/api/tasks/:id', async (c) => {
    const user = currentUser(c);
    const task = store.tasks.get(c.req.param('id'));
    if (!task) return notFound(c, '任务不存在');
    const project = store.projects.get(task.projectId, user.role, user.id);
    if (!project) return notFound(c, '项目不存在');
    if (!canManageProject(user.role, project.ownerId === user.id, user.permissions))
      return forbidden(c);

    const parsed = await readBody(c, TaskUpdateSchema);
    if (!parsed.ok) return parsed.response;
    if (parsed.data.status === 'done' && task.status !== 'done') {
      const pending = store.db
        .stmt(
          `SELECT COUNT(*) AS total FROM task_checklist_items
           WHERE task_id = ? AND required = 1 AND done = 0`,
        )
        .get(task.id) as unknown as { total: number };
      if (Number(pending.total) > 0) {
        return validationError(c, `仍有 ${pending.total} 项必填检查未完成`);
      }
    }
    const result = store.tasks.update(task.id, parsed.data, parsed.data.version, actorOf(user));
    if (result.status === 'missing') return notFound(c, '任务不存在');
    if (result.status === 'invalid') return validationError(c, result.message);
    if (result.status === 'conflict') {
      noStore(c);
      return c.json(
        {
          error: 'conflict',
          message: '任务已被其他会话修改，已返回最新版本',
          current: result.current,
        },
        409,
      );
    }

    const event = {
      eventKey: `task.updated:${result.task.id}:${result.task.version}`,
      workspaceId: project.workspaceId,
      projectId: project.id,
      projectName: project.name,
      taskId: result.task.id,
      taskTitle: result.task.title,
      status: result.task.status,
      priority: result.task.priority,
      assigneeId: result.task.assigneeId,
      actor: actorOf(user),
    } as const;
    store.automation.runEvent({ ...event, trigger: 'task.updated' });
    if (result.task.status === 'done' && task.status !== 'done') {
      store.automation.runEvent({ ...event, trigger: 'task.completed' });
    }
    publishLatest(store, hub);
    noStore(c);
    return c.json(result.task);
  });

  app.delete('/api/tasks/:id', (c) => {
    const user = currentUser(c);
    const task = store.tasks.get(c.req.param('id'));
    if (!task) return notFound(c, '任务不存在');
    const project = store.projects.get(task.projectId, user.role, user.id);
    if (!project) return notFound(c, '项目不存在');
    if (!canManageProject(user.role, project.ownerId === user.id, user.permissions))
      return forbidden(c);

    store.tasks.remove(task.id, actorOf(user));
    publishLatest(store, hub);
    noStore(c);
    return c.body(null, 204);
  });

  app.post('/api/projects/:id/milestones', async (c) => {
    const user = currentUser(c);
    const id = c.req.param('id');
    const project = store.projects.get(id, user.role, user.id);
    if (!project) return notFound(c, '项目不存在');
    if (!canManageProject(user.role, project.ownerId === user.id, user.permissions))
      return forbidden(c);

    const parsed = await readBody(c, MilestoneCreateSchema);
    if (!parsed.ok) return parsed.response;
    const milestone = store.tasks.createMilestone(id, parsed.data, actorOf(user));

    publishLatest(store, hub);
    noStore(c);
    return c.json(milestone, 201);
  });

  app.delete('/api/milestones/:id', (c) => {
    const user = currentUser(c);
    const milestone = store.tasks.getMilestone(c.req.param('id'));
    if (!milestone) return notFound(c, '里程碑不存在');
    const project = store.projects.get(milestone.projectId, user.role, user.id);
    if (!project) return notFound(c, '项目不存在');
    if (!canManageProject(user.role, project.ownerId === user.id, user.permissions))
      return forbidden(c);

    store.tasks.removeMilestone(milestone.id, actorOf(user));
    publishLatest(store, hub);
    noStore(c);
    return c.body(null, 204);
  });

  return app;
}
