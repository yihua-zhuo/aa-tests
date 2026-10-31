import { randomUUID } from 'node:crypto';
import { extname } from 'node:path';
import { Hono } from 'hono';
import { canManageProject } from '../../shared/permissions.ts';
import type {
  AttachmentList,
  OcrEngine,
  OcrExport,
  OcrFieldList,
  OcrMode,
  OcrVersionChain,
  SessionUser,
  UserOption,
} from '../../shared/types.ts';
import type { AppEnv } from '../app-env.ts';
import { forbidden, noStore, notFound, validationError } from '../http.ts';
import { currentUser } from '../middleware/auth.ts';
import { contextIp } from '../net.ts';
import { ocrConfigFingerprint, ocrEngineFor } from '../ocr.ts';
import { type ResolvedQualityThresholds, thresholdsFromProfile } from '../ocr-calibration.ts';
import { buildVersionChain } from '../ocr-governance.ts';
import { routeOcr } from '../ocr-models.ts';
import { attachRevisions, deriveFieldProvenance } from '../ocr-provenance.ts';
import { assessQuality } from '../ocr-quality.ts';
import { redactOcrText } from '../ocr-redaction.ts';
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

const VISUAL_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.bmp',
  '.tif',
  '.tiff',
  '.pdf',
]);
const OCR_MODES: readonly OcrMode[] = ['auto', 'table', 'structure', 'enhanced'];

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

/** Reuse must be scored with the same fitted cut-offs/map the worker uses. */
function qualityThresholds(store: Store, record: AttachmentRecord): ResolvedQualityThresholds {
  try {
    const routing = routeOcr({
      name: record.name,
      engine: record.ocrEngine ?? 'paddle',
      mode: record.ocrMode,
    });
    return thresholdsFromProfile(
      store.ocrCalibration.pick({
        fileType: extname(record.name),
        language: routing.language,
        workspaceId: store.ocrCalibration.workspaceForProject(record.projectId),
      }),
    );
  } catch {
    return {};
  }
}

export type AttachmentRouteOptions = {
  /** Nudge the OCR worker so fresh uploads do not wait for the next poll. */
  ocrWake?: () => void;
  /** Cached base model per engine; uploads never wait on a sidecar health probe. */
  ocrModelPeek?: (engine: OcrEngine) => string | null;
};

export function attachmentRoutes(
  store: Store,
  trustProxy: boolean,
  options: AttachmentRouteOptions = {},
): Hono<AppEnv> {
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
    const ocrTarget = ocrEngineFor(name);
    const engineModel = ocrTarget && options.ocrModelPeek ? options.ocrModelPeek(ocrTarget) : null;
    const configHash = ocrConfigFingerprint();
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
        ocrTarget,
      });
    } catch (error) {
      await store.uploads.remove(storedName);
      throw error;
    }

    const reused =
      ocrTarget && engineModel
        ? store.attachments.findReusableOcr(
            inspected.sha256,
            ocrTarget,
            engineModel,
            configHash,
            'auto',
            200,
            projectId,
          )
        : null;
    if (reused && ocrTarget && engineModel) {
      const quality = assessQuality(
        {
          text: reused.text,
          rawText: reused.rawText,
          engine: reused.model ?? ocrTarget,
          model: engineModel,
          confidence: reused.confidence,
          pages: reused.pages,
          truncated: false,
          route: reused.route,
          document: reused.document,
        },
        qualityThresholds(store, record),
      );
      store.attachments.completeOcr(
        record.id,
        {
          text: reused.text,
          rawText: reused.rawText,
          confidence: reused.confidence,
          model: reused.model,
          engineModel,
          configHash,
          seconds: reused.seconds,
          pages: reused.pages,
          truncated: false,
          route: reused.route,
          quality,
          stages: reused.stages,
          document: reused.document,
        },
        new Date().toISOString(),
      );
      record = store.attachments.find(record.id) ?? record;
      store.ocrGovernance.completeOcrFeedback({
        attachmentId: record.id,
        projectId,
        sha256: record.sha256,
        name: record.name,
        mime: record.mime,
        text: reused.text,
        confidence: reused.confidence,
        quality,
        document: reused.document,
        now: new Date().toISOString(),
      });
    } else if (ocrTarget) {
      options.ocrWake?.();
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
        ocr: record.ocrStatus,
        ...(reused ? { ocrReusedFrom: reused.id } : {}),
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

  app.get('/api/projects/:id/attachments/:attachmentId/ocr', (c) => {
    const user = currentUser(c);
    const projectId = c.req.param('id');
    if (!store.projects.get(projectId, user.role, user.id)) return notFound(c, '项目不存在');

    const record = store.attachments.find(c.req.param('attachmentId'));
    if (!record || record.projectId !== projectId) return notFound(c, '附件不存在');
    const ocr = store.attachments.findOcr(record.id);
    if (!ocr) return notFound(c, '附件不存在');

    noStore(c);
    return c.json({ ocr });
  });

  app.get('/api/projects/:id/attachments/:attachmentId/ocr/export', (c) => {
    const user = currentUser(c);
    const projectId = c.req.param('id');
    const project = store.projects.get(projectId, user.role, user.id);
    if (!project) return notFound(c, '项目不存在');

    const record = store.attachments.find(c.req.param('attachmentId'));
    if (!record || record.projectId !== projectId) return notFound(c, '附件不存在');
    const ocr = store.attachments.findOcr(record.id);
    if (!ocr) return notFound(c, '附件不存在');
    if (ocr.purgedAt) {
      noStore(c);
      return c.json(
        { error: 'ocr_purged', message: '识别文本已按保留策略清除，请重新识别后再导出' },
        410,
      );
    }
    if (ocr.status !== 'done') return validationError(c, '识别尚未完成，暂无可导出的文本');

    const { text, redactions } = redactOcrText(ocr.text);
    const base = record.name.replace(/\.[^.]+$/, '') || 'attachment';
    const payload: OcrExport = {
      filename: `${base}-ocr-redacted.txt`,
      text,
      redactions,
    };
    store.audit.record({
      actor: actorOf(user),
      action: 'project.attachment_ocr_exported',
      target: project.name,
      ip: contextIp(c, trustProxy),
      detail: {
        projectId,
        attachmentId: record.id,
        characters: text.length,
        redactions,
      },
    });
    noStore(c);
    return c.json(payload);
  });

  app.post('/api/projects/:id/attachments/:attachmentId/ocr', async (c) => {
    const user = currentUser(c);
    const projectId = c.req.param('id');
    const project = store.projects.get(projectId, user.role, user.id);
    if (!project) return notFound(c, '项目不存在');

    const record = store.attachments.find(c.req.param('attachmentId'));
    if (!record || record.projectId !== projectId) return notFound(c, '附件不存在');

    const canManage = canManageProject(user.role, project.ownerId === user.id, user.permissions);
    if (record.uploaderId !== user.id && !canManage) {
      return forbidden(c, '只能重新识别自己上传的附件');
    }
    if (!record.ocrEngine) return validationError(c, '该附件不需要 OCR');

    const body = (await c.req.json().catch(() => ({}))) as {
      mode?: unknown;
      dpi?: unknown;
    };
    let mode: OcrMode | undefined;
    if (body.mode !== undefined) {
      if (!OCR_MODES.includes(body.mode as OcrMode)) {
        return validationError(c, 'mode 只能是 auto、table、structure 或 enhanced');
      }
      mode = body.mode as OcrMode;
    }
    let dpi: number | undefined;
    if (body.dpi !== undefined) {
      if (
        typeof body.dpi !== 'number' ||
        !Number.isInteger(body.dpi) ||
        body.dpi < 100 ||
        body.dpi > 400
      ) {
        return validationError(c, 'dpi 必须是 100-400 之间的整数');
      }
      dpi = body.dpi;
    }
    if (mode && mode !== 'auto') {
      const extension = extname(record.name).toLowerCase();
      if (record.ocrEngine !== 'paddle' || !VISUAL_EXTENSIONS.has(extension)) {
        return validationError(c, `${mode} 模式仅支持 PaddleOCR 的图片或 PDF 附件`);
      }
    }

    if (!store.attachments.requeueOcr(record.id, new Date().toISOString(), { mode, dpi })) {
      noStore(c);
      return c.json({ error: 'conflict', message: '附件正在识别中，请稍后再试' }, 409);
    }

    options.ocrWake?.();

    store.audit.record({
      actor: actorOf(user),
      action: 'project.attachment_ocr_requeued',
      target: project.name,
      ip: contextIp(c, trustProxy),
      detail: { projectId, attachmentId: record.id, name: record.name, mode, dpi },
    });

    noStore(c);
    return c.json({ ocr: store.attachments.findOcr(record.id) });
  });

  app.get('/api/projects/:id/attachments/:attachmentId/ocr/fields', (c) => {
    const user = currentUser(c);
    const projectId = c.req.param('id');
    if (!store.projects.get(projectId, user.role, user.id)) return notFound(c, '项目不存在');

    const record = store.attachments.find(c.req.param('attachmentId'));
    if (!record || record.projectId !== projectId) return notFound(c, '附件不存在');
    const ocr = store.attachments.findOcr(record.id);
    if (!ocr) return notFound(c, '附件不存在');

    const fields = attachRevisions(
      deriveFieldProvenance(ocr.document),
      store.ocrFieldRevisions.list(record.id),
    );
    noStore(c);
    return c.json({ fields } satisfies OcrFieldList);
  });

  app.get('/api/projects/:id/attachments/:attachmentId/ocr/versions', (c) => {
    const user = currentUser(c);
    const projectId = c.req.param('id');
    if (!store.projects.get(projectId, user.role, user.id)) return notFound(c, '项目不存在');

    const record = store.attachments.find(c.req.param('attachmentId'));
    if (!record || record.projectId !== projectId) return notFound(c, '附件不存在');
    const ocr = store.attachments.findOcr(record.id);
    if (!ocr) return notFound(c, '附件不存在');

    const chain = buildVersionChain(
      {
        id: record.id,
        projectId,
        status: ocr.status,
        text: ocr.text,
        engine: record.ocrEngine,
        model: record.ocrModel,
        engineModel: record.ocrEngineModel,
        confidence: ocr.confidence,
        truncated: ocr.truncated,
        route: ocr.route,
        mode: ocr.mode,
        dpi: ocr.dpi,
        updatedAt: ocr.updatedAt,
        quality: ocr.quality,
        stages: ocr.stages,
        document: ocr.document,
      },
      store.ocrFieldRevisions.list(record.id),
    );
    noStore(c);
    return c.json({ chain } satisfies { chain: OcrVersionChain });
  });

  app.post('/api/projects/:id/attachments/:attachmentId/ocr/complaints', async (c) => {
    const user = currentUser(c);
    const projectId = c.req.param('id');
    if (!store.projects.get(projectId, user.role, user.id)) return notFound(c, '项目不存在');

    const record = store.attachments.find(c.req.param('attachmentId'));
    if (!record || record.projectId !== projectId) return notFound(c, '附件不存在');

    const body = (await c.req.json().catch(() => ({}))) as { note?: unknown };
    const note = typeof body.note === 'string' ? body.note.trim() : '';
    if (note.length < 3) return validationError(c, '请描述识别问题（至少 3 个字符）');
    if (note.length > 500) return validationError(c, '问题描述不能超过 500 个字符');

    const ocr = store.attachments.findOcr(record.id);
    const now = new Date().toISOString();
    const sample = store.ocrGovernance.reportComplaint({
      attachmentId: record.id,
      projectId,
      userId: user.id,
      sha256: record.sha256,
      name: record.name,
      mime: record.mime,
      text: ocr?.text ?? '',
      confidence: ocr?.confidence ?? null,
      quality: ocr?.quality ?? null,
      document: ocr?.document ?? null,
      note,
      now,
    });

    store.audit.record({
      actor: actorOf(user),
      action: 'project.attachment_ocr_complained',
      target: projectId,
      ip: contextIp(c, trustProxy),
      detail: { projectId, attachmentId: record.id, sampleId: sample?.id ?? null },
    });

    noStore(c);
    return c.json({ sample }, 201);
  });

  app.post(
    '/api/projects/:id/attachments/:attachmentId/ocr/fields/:fieldId/revisions',
    async (c) => {
      const user = currentUser(c);
      const projectId = c.req.param('id');
      const project = store.projects.get(projectId, user.role, user.id);
      if (!project) return notFound(c, '项目不存在');

      const record = store.attachments.find(c.req.param('attachmentId'));
      if (!record || record.projectId !== projectId) return notFound(c, '附件不存在');

      const canManage = canManageProject(user.role, project.ownerId === user.id, user.permissions);
      if (record.uploaderId !== user.id && !canManage) {
        return forbidden(c, '只能复核自己上传的附件');
      }

      const fieldId = c.req.param('fieldId');
      const ocr = store.attachments.findOcr(record.id);
      const field = deriveFieldProvenance(ocr?.document ?? null).find(
        (item) => item.id === fieldId,
      );
      if (!field) return notFound(c, '字段不存在');

      const body = (await c.req.json().catch(() => ({}))) as {
        revisedText?: unknown;
        reason?: unknown;
      };
      if (typeof body.revisedText !== 'string' || !body.revisedText.trim()) {
        return validationError(c, 'revisedText 不能为空');
      }
      if (body.revisedText.length > 4000) {
        return validationError(c, 'revisedText 不能超过 4000 个字符');
      }
      const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
      if (!reason) return validationError(c, '请填写修订原因');
      if (reason.length > 500) return validationError(c, '修订原因不能超过 500 个字符');

      const revision = store.ocrFieldRevisions.create({
        attachmentId: record.id,
        projectId,
        fieldId: field.id,
        fieldKind: field.kind,
        page: field.page,
        blockId: field.blockId,
        bbox: field.bbox,
        originalText: field.text,
        revisedText: body.revisedText,
        reason,
        revisedBy: actorOf(user),
        createdAt: new Date().toISOString(),
      });

      store.audit.record({
        actor: actorOf(user),
        action: 'project.attachment_ocr_field_revised',
        target: project.name,
        ip: contextIp(c, trustProxy),
        detail: {
          projectId,
          attachmentId: record.id,
          fieldId: field.id,
          fieldKind: field.kind,
          page: field.page,
          reason,
        },
      });

      if (ocr) {
        store.ocrGovernance.completeOcrFeedback({
          attachmentId: record.id,
          projectId,
          sha256: record.sha256,
          name: record.name,
          mime: record.mime,
          text: ocr.text,
          confidence: ocr.confidence,
          quality: ocr.quality,
          document: ocr.document,
          now: new Date().toISOString(),
        });
      }

      noStore(c);
      return c.json({ revision }, 201);
    },
  );

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
