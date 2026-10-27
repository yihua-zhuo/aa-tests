import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { canManageProject } from '../../shared/permissions.ts';
import type { AttachmentList, SessionUser, UserOption } from '../../shared/types.ts';
import type { AppEnv } from '../app-env.ts';
import { forbidden, noStore, notFound, validationError } from '../http.ts';
import { currentUser } from '../middleware/auth.ts';
import { contextIp } from '../net.ts';
import type { Store } from '../store.ts';
import { type AttachmentRecord, toAttachment } from '../stores/attachments.ts';
import {
  inspectUpload,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS_PER_PROJECT,
  MAX_PROJECT_ATTACHMENT_BYTES,
  safeFileName,
} from '../uploads.ts';

function actorOf(user: SessionUser): UserOption {
  return { id: user.id, name: user.name };
}

const LIMITS = {
  maxBytes: MAX_ATTACHMENT_BYTES,
  maxCount: MAX_ATTACHMENTS_PER_PROJECT,
  maxTotalBytes: MAX_PROJECT_ATTACHMENT_BYTES,
};

function attachmentList(store: Store, projectId: string): AttachmentList {
  const records = store.attachments.list(projectId);
  return {
    attachments: records.map((record) =>
      toAttachment(record, store.uploads.signAttachment(record.id)),
    ),
    limits: LIMITS,
    usage: store.attachments.usage(projectId),
  };
}

export function attachmentRoutes(store: Store, trustProxy: boolean): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get('/api/projects/:id/attachments', (c) => {
    const user = currentUser(c);
    const projectId = c.req.param('id');
    if (!store.projects.get(projectId, user.role, user.id)) return notFound(c, '项目不存在');
    noStore(c);
    return c.json(attachmentList(store, projectId));
  });

  app.post('/api/projects/:id/attachments', async (c) => {
    const user = currentUser(c);
    const projectId = c.req.param('id');
    const project = store.projects.get(projectId, user.role, user.id);
    if (!project) return notFound(c, '项目不存在');
    if (user.role === 'viewer') return forbidden(c, '只读成员不能上传附件');

    const form = await c.req.formData().catch(() => null);
    const file = form?.get('file');
    if (!(file instanceof File)) return validationError(c, '请选择要上传的文件');
    if (file.size === 0) return validationError(c, '文件内容为空');
    if (file.size > MAX_ATTACHMENT_BYTES) {
      return validationError(c, `单个附件不能超过 ${MAX_ATTACHMENT_BYTES / 1_000_000}MB`);
    }

    const usage = store.attachments.usage(projectId);
    if (usage.count >= MAX_ATTACHMENTS_PER_PROJECT) {
      return validationError(c, `每个项目最多上传 ${MAX_ATTACHMENTS_PER_PROJECT} 个附件`);
    }
    if (usage.totalBytes + file.size > MAX_PROJECT_ATTACHMENT_BYTES) {
      return validationError(c, '项目附件总大小已达上限');
    }

    const data = new Uint8Array(await file.arrayBuffer());
    const name = safeFileName(file.name);
    const inspected = inspectUpload(name, file.type, data, 'attachment');
    if (!inspected.ok) return validationError(c, inspected.reason);

    const storedName = `attachments/${randomUUID()}`;
    await store.uploads.write(storedName, data);
    let record: AttachmentRecord;
    try {
      record = store.attachments.create({
        id: randomUUID(),
        projectId,
        uploaderId: user.id,
        name,
        mime: inspected.mime,
        size: data.byteLength,
        storedName,
        sha256: inspected.sha256,
        createdAt: new Date().toISOString(),
      });
    } catch (error) {
      await store.uploads.remove(storedName);
      throw error;
    }

    store.audit.record({
      actor: actorOf(user),
      action: 'project.attachment_added',
      target: project.name,
      ip: contextIp(c, trustProxy),
      detail: {
        projectId,
        attachmentId: record.id,
        name: record.name,
        size: record.size,
        mime: record.mime,
        sha256: inspected.sha256,
        scan: 'clean',
      },
    });

    noStore(c);
    return c.json(
      { attachment: toAttachment(record, store.uploads.signAttachment(record.id)) },
      201,
    );
  });

  app.delete('/api/projects/:id/attachments/:attachmentId', async (c) => {
    const user = currentUser(c);
    const projectId = c.req.param('id');
    const project = store.projects.get(projectId, user.role, user.id);
    if (!project) return notFound(c, '项目不存在');

    const record = store.attachments.find(c.req.param('attachmentId'));
    if (!record || record.projectId !== projectId) return notFound(c, '附件不存在');

    const canManage = canManageProject(user.role, project.ownerId === user.id, user.permissions);
    if (record.uploaderId !== user.id && !canManage) {
      return forbidden(c, '只能删除自己上传的附件');
    }

    store.attachments.remove(record.id);
    await store.uploads.remove(record.storedName);

    store.audit.record({
      actor: actorOf(user),
      action: 'project.attachment_removed',
      target: project.name,
      ip: contextIp(c, trustProxy),
      detail: { projectId, attachmentId: record.id, name: record.name },
    });

    noStore(c);
    return c.body(null, 204);
  });

  app.get('/files/attachments/:id', async (c) => {
    const id = c.req.param('id');
    if (!store.uploads.verifyAttachment(id, c.req.query('expires'), c.req.query('sig'))) {
      c.header('Cache-Control', 'no-store');
      return c.json({ error: 'invalid_signature', message: '下载链接无效或已过期' }, 403);
    }
    const record = store.attachments.find(id);
    if (!record) {
      c.header('Cache-Control', 'no-store');
      return c.json({ error: 'not_found', message: '附件不存在' }, 404);
    }
    const data = await store.uploads.read(record.storedName);
    if (!data) {
      c.header('Cache-Control', 'no-store');
      return c.json({ error: 'not_found', message: '附件文件不存在' }, 404);
    }

    c.header('Content-Type', record.mime);
    c.header('Content-Length', String(data.byteLength));
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Cache-Control', 'private, max-age=300');
    const fallback = record.name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_') || 'download';
    c.header(
      'Content-Disposition',
      `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(record.name)}`,
    );
    const body = Uint8Array.from(data).buffer;
    return c.body(body);
  });

  return app;
}
