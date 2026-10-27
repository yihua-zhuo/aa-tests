import { Hono } from 'hono';
import {
  canCreateProject,
  canImportProjects,
  canManageProject,
  canViewAllProjects,
} from '../../shared/permissions.ts';
import {
  ProjectBatchSchema,
  ProjectCreateSchema,
  ProjectDuplicateSchema,
  ProjectQuerySchema,
  ProjectUpdateSchema,
  SavedViewCreateSchema,
  SavedViewUpdateSchema,
  TemplateApplySchema,
} from '../../shared/schemas.ts';
import { findTemplate, PROJECT_TEMPLATES } from '../../shared/templates.ts';
import type { SessionUser, UserOption } from '../../shared/types.ts';
import type { AppEnv } from '../app-env.ts';
import {
  csvCell,
  MAX_IMPORT_BYTES,
  MAX_IMPORT_ROWS,
  normalizeProjectRows,
  parseCsvRows,
} from '../csv.ts';
import { forbidden, noStore, notFound, readBody, readQuery, validationError } from '../http.ts';
import { exportRowLimit } from '../limits.ts';
import { currentUser } from '../middleware/auth.ts';
import { contextIp } from '../net.ts';
import { publishActivity, publishVisibility } from '../realtime.ts';
import type { EventHub } from '../sse.ts';
import type { Store } from '../store.ts';
import type { ResolvedImportItem } from '../stores/projects.ts';

function actorOf(user: SessionUser): UserOption {
  return { id: user.id, name: user.name };
}

function publishLatest(store: Store, hub: EventHub): void {
  const activity = store.activities.latest();
  if (activity) publishActivity(hub, store, activity);
}

function missingMembers(store: Store, memberIds: string[] | undefined): string | null {
  if (!memberIds) return null;
  for (const id of memberIds) {
    const member = store.users.findById(id);
    if (!member) return '成员不存在';
    if (member.status !== 'active') return '成员已被停用';
  }
  return null;
}

export function projectRoutes(store: Store, hub: EventHub, trustProxy: boolean): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get('/api/projects', (c) => {
    const parsed = readQuery(c, ProjectQuerySchema);
    if (!parsed.ok) return parsed.response;
    const user = currentUser(c);

    noStore(c);
    return c.json(
      store.projects.list(user.role, user.id, {
        q: parsed.data.q,
        status: parsed.data.status,
        owner: parsed.data.owner,
        sort: parsed.data.sort,
        tag: parsed.data.tag,
        due: parsed.data.due === 'all' ? undefined : parsed.data.due,
        favorite: parsed.data.favorite === '1',
        page: parsed.data.page,
        pageSize: parsed.data.pageSize,
      }),
    );
  });

  app.post('/api/projects', async (c) => {
    const user = currentUser(c);
    if (!canCreateProject(user.role, user.permissions)) return forbidden(c, '只读成员不能创建项目');

    const parsed = await readBody(c, ProjectCreateSchema);
    if (!parsed.ok) return parsed.response;
    const body = parsed.data;

    const ownerId = body.ownerId ?? user.id;
    if (!canViewAllProjects(user.role, user.permissions) && ownerId !== user.id) {
      return forbidden(c, '只能将项目分配给自己');
    }
    const owner = store.users.findById(ownerId);
    if (owner?.status !== 'active') return validationError(c, '负责人无效');

    const memberError = missingMembers(store, body.memberIds);
    if (memberError) return validationError(c, memberError);

    const project = store.projects.create(
      {
        name: body.name,
        description: body.description,
        status: body.status,
        progress: body.progress,
        ownerId,
        startDate: body.startDate ?? null,
        dueDate: body.dueDate ?? null,
        tags: body.tags,
        memberIds: body.memberIds,
        visibility: body.visibility,
      },
      actorOf(user),
    );
    store.audit.record({
      actor: actorOf(user),
      action: 'project.created',
      target: project.name,
      ip: contextIp(c, trustProxy),
      detail: {
        projectId: project.id,
        status: project.status,
        ownerId: project.ownerId,
        members: project.members.length,
      },
    });
    publishLatest(store, hub);
    noStore(c);
    return c.json(project, 201);
  });

  app.post('/api/projects/batch', async (c) => {
    const user = currentUser(c);
    if (!canCreateProject(user.role, user.permissions)) {
      return forbidden(c, '只读成员不能批量操作项目');
    }

    const parsed = await readBody(c, ProjectBatchSchema);
    if (!parsed.ok) return parsed.response;
    const body = parsed.data;

    if (body.action === 'owner') {
      const ownerId = body.ownerId as string;
      if (!canViewAllProjects(user.role, user.permissions) && ownerId !== user.id) {
        return forbidden(c, '只能将项目分配给自己');
      }
      const owner = store.users.findById(ownerId);
      if (owner?.status !== 'active') return validationError(c, '负责人无效');
    }

    const allowed: string[] = [];
    const denied: string[] = [];
    for (const id of body.ids) {
      const project = store.projects.get(id, user.role, user.id);
      if (!project) {
        denied.push(id);
        continue;
      }
      if (!canManageProject(user.role, project.ownerId === user.id, user.permissions)) {
        denied.push(id);
        continue;
      }
      allowed.push(id);
    }
    if (allowed.length === 0) return forbidden(c, '没有可操作的项目');

    const result = store.projects.batch(
      allowed,
      body.action,
      { status: body.status, ownerId: body.ownerId },
      actorOf(user),
    );
    const skipped = [...new Set([...denied, ...result.skipped])];

    store.audit.record({
      actor: actorOf(user),
      action: 'project.batch_updated',
      target: null,
      ip: contextIp(c, trustProxy),
      detail: {
        action: body.action,
        status: body.status ?? null,
        ownerId: body.ownerId ?? null,
        requested: body.ids.length,
        updated: result.updated,
        skipped: skipped.length,
      },
    });
    publishLatest(store, hub);
    if (body.action === 'owner') publishVisibility(hub);
    noStore(c);
    return c.json({ updated: result.updated, skipped });
  });

  app.get('/api/saved-views', (c) => {
    const user = currentUser(c);
    noStore(c);
    return c.json({ views: store.projects.savedViews(user.id) });
  });

  app.post('/api/saved-views', async (c) => {
    const user = currentUser(c);
    const parsed = await readBody(c, SavedViewCreateSchema);
    if (!parsed.ok) return parsed.response;

    const result = store.projects.createSavedView(user.id, parsed.data.name, parsed.data.query);
    if (result === 'duplicate') {
      noStore(c);
      return c.json({ error: 'conflict', message: '已存在同名视图' }, 409);
    }
    if (result === 'limit') {
      return validationError(c, '最多保存 20 个视图，请先删除不用的视图');
    }
    noStore(c);
    return c.json(result, 201);
  });

  app.patch('/api/saved-views/:id', async (c) => {
    const user = currentUser(c);
    const parsed = await readBody(c, SavedViewUpdateSchema);
    if (!parsed.ok) return parsed.response;

    const result = store.projects.updateSavedView(user.id, c.req.param('id'), parsed.data);
    if (result === 'missing') return notFound(c, '视图不存在');
    if (result === 'duplicate') {
      noStore(c);
      return c.json({ error: 'conflict', message: '已存在同名视图' }, 409);
    }
    noStore(c);
    return c.json(result);
  });

  app.delete('/api/saved-views/:id', (c) => {
    const user = currentUser(c);
    if (!store.projects.deleteSavedView(user.id, c.req.param('id'))) {
      return notFound(c, '视图不存在');
    }
    noStore(c);
    return c.body(null, 204);
  });

  app.get('/api/project-templates', (c) => {
    noStore(c);
    return c.json({ templates: PROJECT_TEMPLATES });
  });

  app.post('/api/projects/from-template', async (c) => {
    const user = currentUser(c);
    if (!canCreateProject(user.role, user.permissions)) return forbidden(c, '只读成员不能创建项目');

    const parsed = await readBody(c, TemplateApplySchema);
    if (!parsed.ok) return parsed.response;
    const body = parsed.data;

    const template = findTemplate(body.templateId);
    if (!template) return notFound(c, '模板不存在');

    const ownerId = body.ownerId ?? user.id;
    if (!canViewAllProjects(user.role, user.permissions) && ownerId !== user.id) {
      return forbidden(c, '只能将项目分配给自己');
    }
    const owner = store.users.findById(ownerId);
    if (owner?.status !== 'active') return validationError(c, '负责人无效');

    const memberError = missingMembers(store, body.memberIds);
    if (memberError) return validationError(c, memberError);

    const result = store.projects.applyTemplate(
      template,
      {
        name: body.name,
        description: body.description,
        ownerId,
        startDate: body.startDate ?? new Date().toISOString().slice(0, 10),
        memberIds: body.memberIds,
      },
      actorOf(user),
    );
    store.audit.record({
      actor: actorOf(user),
      action: 'project.template_applied',
      target: result.project.name,
      ip: contextIp(c, trustProxy),
      detail: {
        projectId: result.project.id,
        templateId: template.id,
        tasks: result.tasks,
        milestones: result.milestones,
      },
    });
    publishLatest(store, hub);
    publishVisibility(hub);
    noStore(c);
    return c.json(result, 201);
  });

  app.post('/api/projects/:id/duplicate', async (c) => {
    const user = currentUser(c);
    const project = store.projects.get(c.req.param('id'), user.role, user.id);
    if (!project) return notFound(c, '项目不存在');
    if (!canManageProject(user.role, project.ownerId === user.id, user.permissions)) {
      return forbidden(c);
    }

    const parsed = await readBody(c, ProjectDuplicateSchema);
    if (!parsed.ok) return parsed.response;

    const result = store.projects.duplicate(
      project.id,
      {
        name: parsed.data.name,
        dateOffsetDays: parsed.data.dateOffsetDays,
        includeMembers: parsed.data.includeMembers,
        includeTasks: parsed.data.includeTasks,
      },
      actorOf(user),
    );
    if (!result) return notFound(c, '项目不存在');

    store.audit.record({
      actor: actorOf(user),
      action: 'project.duplicated',
      target: result.project.name,
      ip: contextIp(c, trustProxy),
      detail: {
        projectId: result.project.id,
        sourceId: project.id,
        tasks: result.tasks,
        milestones: result.milestones,
        offsetDays: parsed.data.dateOffsetDays,
      },
    });
    publishLatest(store, hub);
    publishVisibility(hub);
    noStore(c);
    return c.json(result, 201);
  });

  app.get('/api/projects/export.csv', (c) => {
    const parsed = readQuery(c, ProjectQuerySchema);
    if (!parsed.ok) return parsed.response;
    const user = currentUser(c);
    const ids = parsed.data.ids
      ?.split(',')
      .map((id) => id.trim())
      .filter(Boolean)
      .slice(0, 200);
    const filters = {
      q: parsed.data.q,
      status: parsed.data.status,
      owner: parsed.data.owner,
      tag: parsed.data.tag,
      due: parsed.data.due === 'all' ? undefined : parsed.data.due,
      favorite: parsed.data.favorite === '1',
      ids: ids && ids.length > 0 ? ids : undefined,
    };
    const limit = exportRowLimit();
    const total = store.projects.count(user.role, user.id, filters);
    if (total > limit) {
      noStore(c);
      return c.json(
        {
          error: 'export_too_large',
          message: `当前筛选结果 ${total} 个，超过单次导出上限 ${limit} 个，请先缩小范围`,
        },
        413,
      );
    }
    const rows = store.projects.exportRows(user.role, user.id, filters);
    store.audit.record({
      actor: actorOf(user),
      action: 'project.exported',
      target: null,
      ip: contextIp(c, trustProxy),
      detail: {
        count: total,
        q: filters.q ?? null,
        status: filters.status,
        owner: filters.owner ?? null,
        ids: filters.ids?.length ?? 0,
      },
    });
    const encoder = new TextEncoder();
    const header =
      '\uFEFFname,description,status,progress,owner,startDate,dueDate,createdAt,updatedAt\n';
    let headerSent = false;
    let finished = false;

    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!headerSent) {
          headerSent = true;
          controller.enqueue(encoder.encode(header));
          return;
        }
        if (finished) {
          controller.close();
          return;
        }
        const lines: string[] = [];
        while (lines.length < 50) {
          const next = rows.next();
          if (next.done) {
            finished = true;
            break;
          }
          const project = next.value;
          lines.push(
            [
              csvCell(project.name),
              csvCell(project.description),
              project.status,
              String(project.progress),
              csvCell(project.ownerName),
              project.startDate ?? '',
              project.dueDate ?? '',
              project.createdAt,
              project.updatedAt,
            ].join(','),
          );
        }
        if (lines.length > 0) controller.enqueue(encoder.encode(`${lines.join('\n')}\n`));
        if (finished && lines.length === 0) controller.close();
      },
    });

    c.header('Cache-Control', 'no-store');
    return c.body(stream, 200, {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': 'attachment; filename="clay-projects.csv"',
    });
  });

  app.post('/api/projects/import', async (c) => {
    const user = currentUser(c);
    if (!canImportProjects(user.role, user.permissions)) {
      return forbidden(c, '只有管理员或业务经理可以导入项目');
    }

    const form = await c.req.formData().catch(() => null);
    const file = form?.get('file');
    if (!(file instanceof File)) {
      return validationError(c, '请上传 CSV 或 JSON 文件');
    }

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
        const parsedJson = JSON.parse(text) as unknown;
        const list = Array.isArray(parsedJson)
          ? parsedJson
          : parsedJson &&
              typeof parsedJson === 'object' &&
              Array.isArray((parsedJson as { projects?: unknown }).projects)
            ? (parsedJson as { projects: unknown[] }).projects
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
    if (rows.length > MAX_IMPORT_ROWS) {
      noStore(c);
      return c.json({ error: 'too_many_rows', message: `单次最多导入 ${MAX_IMPORT_ROWS} 行` }, 413);
    }

    const preview = c.req.query('preview') === '1';
    const normalized = normalizeProjectRows(rows);
    const usersByEmail = store.users.allByEmail();
    const existing = store.projects.names();
    const seen = new Set<string>();
    const issues = [...normalized.errors];
    const resolved: ResolvedImportItem[] = [];
    let duplicates = 0;

    for (const item of normalized.items) {
      const key = item.name.toLowerCase();
      if (existing.has(key) || seen.has(key)) {
        duplicates++;
        issues.push({ row: item.row, message: '同名项目已存在' });
        continue;
      }

      let ownerId: string | undefined;
      if (item.ownerEmail) {
        const owner = usersByEmail.get(item.ownerEmail);
        if (owner?.status !== 'active') {
          issues.push({ row: item.row, message: `负责人 ${item.ownerEmail} 不存在或已停用` });
          continue;
        }
        ownerId = owner.id;
      }

      const memberIds: string[] = [];
      let memberIssue = false;
      for (const email of item.memberEmails) {
        const member = usersByEmail.get(email);
        if (member?.status !== 'active') {
          issues.push({ row: item.row, message: `成员 ${email} 不存在或已停用` });
          memberIssue = true;
          break;
        }
        if (member.id !== ownerId) memberIds.push(member.id);
      }
      if (memberIssue) continue;

      seen.add(key);
      resolved.push({ ...item, ownerId, memberIds });
    }

    const imported = preview ? 0 : store.projects.importMany(resolved, actorOf(user), user.id);
    if (!preview) {
      store.audit.record({
        actor: actorOf(user),
        action: 'project.imported',
        target: file.name,
        ip: contextIp(c, trustProxy),
        detail: {
          file: file.name,
          size: file.size,
          imported,
          skipped: issues.length,
          duplicates,
        },
      });
    }
    if (imported > 0) {
      publishLatest(store, hub);
      publishVisibility(hub);
    }
    issues.sort((left, right) => left.row - right.row);
    noStore(c);
    return c.json({
      preview,
      imported,
      skipped: issues.length,
      duplicates,
      errors: issues.slice(0, 100),
      items: preview
        ? resolved.slice(0, 50).map((item) => ({
            row: item.row,
            name: item.name,
            status: item.status,
            ownerEmail: item.ownerEmail,
            members: item.memberEmails,
          }))
        : [],
    });
  });

  app.get('/api/projects/trash', (c) => {
    const user = currentUser(c);
    noStore(c);
    return c.json({ projects: store.projects.trash(user.role, user.id) });
  });

  app.post('/api/projects/:id/restore', (c) => {
    const user = currentUser(c);
    if (!canViewAllProjects(user.role, user.permissions)) {
      return forbidden(c, '只有管理员或业务经理可以恢复项目');
    }
    const project = store.projects.restore(c.req.param('id'), actorOf(user));
    if (!project) return notFound(c, '回收站中没有该项目');
    store.audit.record({
      actor: actorOf(user),
      action: 'project.restored',
      target: project.name,
      ip: contextIp(c, trustProxy),
      detail: { projectId: project.id },
    });
    publishLatest(store, hub);
    publishVisibility(hub);
    noStore(c);
    return c.json(project);
  });

  app.delete('/api/projects/:id/purge', (c) => {
    const user = currentUser(c);
    if (user.role !== 'admin') return forbidden(c, '只有管理员可以永久删除项目');
    const id = c.req.param('id');
    if (!store.projects.purge(id)) return notFound(c, '回收站中没有该项目');
    store.audit.record({
      actor: actorOf(user),
      action: 'project.purged',
      ip: contextIp(c, trustProxy),
      detail: { projectId: id },
    });
    publishVisibility(hub);
    noStore(c);
    return c.body(null, 204);
  });

  app.get('/api/projects/:id', (c) => {
    const user = currentUser(c);
    const project = store.projects.get(c.req.param('id'), user.role, user.id);
    if (!project) {
      if (store.projects.isDeleted(c.req.param('id'))) {
        noStore(c);
        return c.json({ error: 'deleted', message: '该项目已移入回收站，可由管理员恢复' }, 410);
      }
      return notFound(c, '项目不存在');
    }
    noStore(c);
    return c.json(project);
  });

  app.post('/api/projects/:id/favorite', (c) => {
    const user = currentUser(c);
    const project = store.projects.get(c.req.param('id'), user.role, user.id);
    if (!project) return notFound(c, '项目不存在');
    store.projects.setFavorite(project.id, user.id, true);
    noStore(c);
    return c.json({ favorite: true });
  });

  app.delete('/api/projects/:id/favorite', (c) => {
    const user = currentUser(c);
    const project = store.projects.get(c.req.param('id'), user.role, user.id);
    if (!project) return notFound(c, '项目不存在');
    store.projects.setFavorite(project.id, user.id, false);
    noStore(c);
    return c.json({ favorite: false });
  });

  app.patch('/api/projects/:id', async (c) => {
    const user = currentUser(c);
    const id = c.req.param('id');
    const project = store.projects.get(id, user.role, user.id);
    if (!project) return notFound(c, '项目不存在');
    if (!canManageProject(user.role, project.ownerId === user.id, user.permissions)) {
      return forbidden(c);
    }

    const parsed = await readBody(c, ProjectUpdateSchema);
    if (!parsed.ok) return parsed.response;
    const body = parsed.data;

    if (body.ownerId !== undefined) {
      if (!canViewAllProjects(user.role, user.permissions) && body.ownerId !== user.id) {
        return forbidden(c, '只能将项目分配给自己');
      }
      const owner = store.users.findById(body.ownerId);
      if (owner?.status !== 'active') return validationError(c, '负责人无效');
    }
    const memberError = missingMembers(store, body.memberIds);
    if (memberError) return validationError(c, memberError);

    const result = store.projects.update(
      id,
      {
        name: body.name,
        description: body.description,
        status: body.status,
        progress: body.progress,
        ownerId: body.ownerId,
        startDate: body.startDate,
        dueDate: body.dueDate,
        tags: body.tags,
        memberIds: body.memberIds,
        visibility: body.visibility,
      },
      body.version,
      actorOf(user),
    );

    if (result.status === 'missing') return notFound(c, '项目不存在');
    if (result.status === 'conflict') {
      noStore(c);
      return c.json(
        {
          error: 'conflict',
          message: '项目已被其他会话修改，已返回最新版本',
          current: result.current,
        },
        409,
      );
    }

    store.audit.record({
      actor: actorOf(user),
      action: 'project.updated',
      target: result.project.name,
      ip: contextIp(c, trustProxy),
      detail: {
        projectId: id,
        fields: Object.keys(body).filter((field) => field !== 'version'),
        status: result.project.status,
      },
    });

    publishLatest(store, hub);
    if (body.memberIds !== undefined || body.ownerId !== undefined) {
      publishVisibility(hub);
    }
    noStore(c);
    return c.json(result.project);
  });

  app.delete('/api/projects/:id', (c) => {
    const user = currentUser(c);
    const project = store.projects.get(c.req.param('id'), user.role, user.id);
    if (!project) return notFound(c, '项目不存在');
    if (!canViewAllProjects(user.role, user.permissions)) {
      return forbidden(c, '只有管理员或业务经理可以删除项目');
    }

    store.projects.remove(project.id, actorOf(user));
    store.audit.record({
      actor: actorOf(user),
      action: 'project.deleted',
      target: project.name,
      ip: contextIp(c, trustProxy),
      detail: { projectId: project.id },
    });
    publishLatest(store, hub);
    publishVisibility(hub);
    noStore(c);
    return c.body(null, 204);
  });

  return app;
}
