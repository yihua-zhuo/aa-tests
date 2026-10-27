import { Hono } from 'hono';
import { canManageProject } from '../../shared/permissions.ts';
import { CommentCreateSchema, CommentQuerySchema } from '../../shared/schemas.ts';
import type { SessionUser, UserOption } from '../../shared/types.ts';
import type { AppEnv } from '../app-env.ts';
import { forbidden, noStore, notFound, readBody, readQuery, validationError } from '../http.ts';
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

export function commentRoutes(store: Store, hub: EventHub): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get('/api/projects/:id/comments', (c) => {
    const user = currentUser(c);
    const projectId = c.req.param('id');
    if (!store.projects.get(projectId, user.role, user.id)) return notFound(c, '项目不存在');

    const parsed = readQuery(c, CommentQuerySchema);
    if (!parsed.ok) return parsed.response;
    if (parsed.data.taskId) {
      const task = store.tasks.get(parsed.data.taskId);
      if (!task || task.projectId !== projectId) return notFound(c, '任务不存在');
    }

    noStore(c);
    return c.json(store.comments.list(projectId, parsed.data.taskId));
  });

  app.post('/api/projects/:id/comments', async (c) => {
    const user = currentUser(c);
    const projectId = c.req.param('id');
    const project = store.projects.get(projectId, user.role, user.id);
    if (!project) return notFound(c, '项目不存在');
    if (user.role === 'viewer') return forbidden(c, '只读成员不能发表评论');

    const parsed = await readBody(c, CommentCreateSchema);
    if (!parsed.ok) return parsed.response;

    let task: { id: string; title: string; assigneeId: string | null } | null = null;
    if (parsed.data.taskId) {
      const found = store.tasks.get(parsed.data.taskId);
      if (!found || found.projectId !== projectId) return validationError(c, '任务不存在');
      task = { id: found.id, title: found.title, assigneeId: found.assigneeId };
    }

    const allowed = new Set([project.ownerId, ...project.members.map((member) => member.id)]);
    const mentions = parsed.data.mentions ?? [];
    if (mentions.some((userId) => !allowed.has(userId))) {
      return validationError(c, '只能提及项目负责人或成员');
    }

    const comment = store.comments.create(
      { project: { id: project.id, name: project.name }, task },
      { body: parsed.data.body, taskId: task?.id ?? null, mentions },
      actorOf(user),
    );

    publishLatest(store, hub);
    noStore(c);
    return c.json(comment, 201);
  });

  app.delete('/api/comments/:id', (c) => {
    const user = currentUser(c);
    const comment = store.comments.find(c.req.param('id'));
    if (!comment) return notFound(c, '评论不存在');
    const project = store.projects.get(comment.projectId, user.role, user.id);
    if (!project) return notFound(c, '项目不存在');

    const canManage = canManageProject(user.role, project.ownerId === user.id, user.permissions);
    if (comment.authorId !== user.id && !canManage) return forbidden(c);

    const task = comment.taskId ? store.tasks.get(comment.taskId) : null;
    store.comments.remove(
      comment.id,
      {
        project: { id: project.id, name: project.name },
        task: task ? { id: task.id, title: task.title, assigneeId: task.assigneeId } : null,
      },
      actorOf(user),
    );

    publishLatest(store, hub);
    noStore(c);
    return c.body(null, 204);
  });

  return app;
}
