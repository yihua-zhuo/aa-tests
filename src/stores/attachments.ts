import type {
  Attachment,
  AttachmentOcr,
  DocumentIr,
  DocumentQuality,
  OcrEngine,
  OcrMode,
  OcrRoute,
  OcrStage,
  OcrStatus,
  UserOption,
} from '../../shared/types.ts';
import type { Database } from '../db.ts';
import { normalizeDocumentIr } from '../document-ir.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

type AttachmentRow = {
  id: string;
  project_id: string;
  uploader_id: string | null;
  uploader_name: string | null;
  name: string;
  mime: string;
  size: number;
  stored_name: string;
  sha256: string | null;
  created_at: string;
  ocr_status: OcrStatus;
  ocr_engine: OcrEngine | null;
  ocr_model: string | null;
  ocr_engine_model: string | null;
  ocr_confidence: number | null;
  ocr_error: string | null;
  ocr_characters: number;
  ocr_pages: number;
  ocr_seconds: number | null;
  ocr_truncated: number;
  ocr_force: number;
  ocr_mode: OcrMode;
  ocr_dpi: number;
  ocr_route: OcrRoute | null;
  ocr_quality_json: string | null;
  ocr_stages_json: string | null;
  ocr_review_required: number;
  ocr_attempts: number;
  ocr_updated_at: string | null;
  ocr_purged_at: string | null;
};

type OcrRow = {
  ocr_status: OcrStatus;
  ocr_engine: OcrEngine | null;
  ocr_text: string | null;
  ocr_raw_text: string | null;
  ocr_model: string | null;
  ocr_confidence: number | null;
  ocr_error: string | null;
  ocr_pages: number;
  ocr_seconds: number | null;
  ocr_truncated: number;
  ocr_mode: OcrMode;
  ocr_dpi: number;
  ocr_route: OcrRoute | null;
  ocr_document_json: string | null;
  ocr_quality_json: string | null;
  ocr_stages_json: string | null;
  ocr_review_required: number;
  ocr_updated_at: string | null;
  ocr_purged_at: string | null;
};

export type ReusableOcr = {
  id: string;
  text: string;
  rawText: string;
  model: string | null;
  confidence: number | null;
  pages: number;
  seconds: number | null;
  route: OcrRoute | null;
  quality: DocumentQuality | null;
  stages: OcrStage[];
  document: DocumentIr | null;
};

export type AttachmentRecord = {
  id: string;
  projectId: string;
  uploaderId: string | null;
  name: string;
  mime: string;
  size: number;
  storedName: string;
  sha256: string | null;
  createdAt: string;
  uploader: UserOption | null;
  ocrStatus: OcrStatus;
  ocrEngine: OcrEngine | null;
  ocrModel: string | null;
  ocrEngineModel: string | null;
  ocrConfidence: number | null;
  ocrError: string | null;
  ocrCharacters: number;
  ocrPages: number;
  ocrSeconds: number | null;
  ocrTruncated: boolean;
  ocrForce: boolean;
  ocrMode: OcrMode;
  ocrDpi: number;
  ocrRoute: OcrRoute | null;
  ocrQuality: DocumentQuality | null;
  ocrStages: OcrStage[];
  ocrReviewRequired: boolean;
  ocrUpdatedAt: string | null;
  ocrAttempts: number;
  ocrPurgedAt: string | null;
};

function parseJson<T>(value: string | null): T | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function toRecord(row: AttachmentRow): AttachmentRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    uploaderId: row.uploader_id,
    name: row.name,
    mime: row.mime,
    size: Number(row.size),
    storedName: row.stored_name,
    sha256: row.sha256,
    createdAt: row.created_at,
    uploader: row.uploader_id
      ? { id: row.uploader_id, name: row.uploader_name ?? '已删除成员' }
      : null,
    ocrStatus: row.ocr_status,
    ocrEngine: row.ocr_engine,
    ocrModel: row.ocr_model,
    ocrEngineModel: row.ocr_engine_model,
    ocrConfidence: row.ocr_confidence === null ? null : Number(row.ocr_confidence),
    ocrError: row.ocr_error,
    ocrCharacters: Number(row.ocr_characters),
    ocrPages: Number(row.ocr_pages),
    ocrSeconds: row.ocr_seconds === null ? null : Number(row.ocr_seconds),
    ocrTruncated: Number(row.ocr_truncated) === 1,
    ocrForce: Number(row.ocr_force) === 1,
    ocrMode: row.ocr_mode,
    ocrDpi: Number(row.ocr_dpi),
    ocrRoute: row.ocr_route,
    ocrQuality: parseJson<DocumentQuality>(row.ocr_quality_json),
    ocrStages: parseJson<OcrStage[]>(row.ocr_stages_json) ?? [],
    ocrReviewRequired: Number(row.ocr_review_required) === 1,
    ocrUpdatedAt: row.ocr_updated_at,
    ocrAttempts: Number(row.ocr_attempts),
    ocrPurgedAt: row.ocr_purged_at,
  };
}

const SELECT = `
  SELECT a.id, a.project_id, a.uploader_id, u.name AS uploader_name,
         a.name, a.mime, a.size, a.stored_name, a.sha256, a.created_at,
         a.ocr_status, a.ocr_engine, a.ocr_model, a.ocr_engine_model, a.ocr_confidence,
         a.ocr_error, COALESCE(length(a.ocr_text), 0) AS ocr_characters, a.ocr_pages,
         a.ocr_seconds, a.ocr_truncated, a.ocr_force, a.ocr_mode, a.ocr_dpi,
         a.ocr_route, a.ocr_quality_json, a.ocr_stages_json, a.ocr_review_required,
         a.ocr_attempts, a.ocr_updated_at, a.ocr_purged_at
  FROM attachments a LEFT JOIN users u ON u.id = a.uploader_id
`;

export class AttachmentsStore {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  list(projectId: string): AttachmentRecord[] {
    const rows = this.#db
      .stmt(`${SELECT} WHERE a.project_id = ? ORDER BY a.created_at DESC`)
      .all(projectId) as unknown as AttachmentRow[];
    return rows.map(toRecord);
  }

  find(id: string): AttachmentRecord | null {
    const row = this.#db.stmt(`${SELECT} WHERE a.id = ?`).get(id) as unknown as
      | AttachmentRow
      | undefined;
    return row ? toRecord(row) : null;
  }

  usage(projectId: string): { count: number; totalBytes: number } {
    const row = this.#db
      .stmt(
        'SELECT COUNT(*) AS count, COALESCE(SUM(size), 0) AS total FROM attachments WHERE project_id = ?',
      )
      .get(projectId) as unknown as { count: number; total: number };
    return { count: Number(row.count), totalBytes: Number(row.total) };
  }

  create(input: {
    id: string;
    projectId: string;
    uploaderId: string;
    name: string;
    mime: string;
    size: number;
    storedName: string;
    sha256: string;
    createdAt: string;
    ocrTarget: OcrEngine | null;
  }): AttachmentRecord {
    this.#db
      .stmt(
        `INSERT INTO attachments
           (id, project_id, uploader_id, name, mime, size, stored_name, sha256, scan,
            ocr_status, ocr_engine, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'clean', ?, ?, ?)`,
      )
      .run(
        input.id,
        input.projectId,
        input.uploaderId,
        input.name,
        input.mime,
        input.size,
        input.storedName,
        input.sha256,
        input.ocrTarget ? 'pending' : 'skipped',
        input.ocrTarget,
        input.createdAt,
      );
    const record = this.find(input.id);
    if (!record) throw new Error('attachment creation failed');
    return record;
  }

  /**
   * Atomically move the oldest due job to `processing`. The conditional
   * update doubles as the claim so multiple workers cannot pick the same row.
   */
  claimNext(
    now: string,
    engines: readonly OcrEngine[],
    leaseUntil: string,
  ): AttachmentRecord | null {
    if (engines.length === 0) return null;
    const placeholders = engines.map(() => '?').join(', ');
    const row = this.#db
      .stmt(
        `UPDATE attachments
            SET ocr_status = 'processing',
                ocr_attempts = ocr_attempts + 1,
                ocr_error = NULL,
                ocr_lease_until = ?,
                ocr_updated_at = ?
          WHERE id = (
            SELECT id FROM attachments
             WHERE ocr_status = 'pending'
               AND ocr_engine IN (${placeholders})
               AND (ocr_next_attempt_at IS NULL OR ocr_next_attempt_at <= ?)
             ORDER BY created_at ASC
             LIMIT 1
          )
          RETURNING id, ocr_attempts`,
      )
      .get(leaseUntil, now, ...engines, now) as unknown as
      | { id: string; ocr_attempts: number }
      | undefined;
    if (!row) return null;
    const record = this.find(row.id);
    return record ? { ...record, ocrAttempts: Number(row.ocr_attempts) } : null;
  }

  /** Extend a live claim; only lease expiry lets another worker take the job. */
  renewOcrLease(id: string, leaseUntil: string): void {
    this.#db
      .stmt(
        `UPDATE attachments SET ocr_lease_until = ?
          WHERE id = ? AND ocr_status = 'processing'`,
      )
      .run(leaseUntil, id);
  }

  completeOcr(
    id: string,
    input: {
      text: string;
      /** Engine output before display normalization; kept for exact matching. */
      rawText?: string | null;
      confidence: number | null;
      model: string | null;
      engineModel: string | null;
      /** Hash of every OCR setting that can change output; null for legacy rows. */
      configHash: string | null;
      seconds: number | null;
      pages: number;
      truncated: boolean;
      route?: OcrRoute | null;
      quality?: DocumentQuality | null;
      stages?: OcrStage[];
      document?: DocumentIr | null;
    },
    updatedAt: string,
  ): void {
    const quality = input.quality ?? null;
    this.#db
      .stmt(
        `UPDATE attachments
            SET ocr_status = 'done', ocr_text = ?, ocr_raw_text = ?, ocr_confidence = ?, ocr_model = ?,
                ocr_engine_model = ?, ocr_config_hash = ?, ocr_seconds = ?, ocr_pages = ?, ocr_truncated = ?,
                ocr_route = ?, ocr_document_json = ?, ocr_quality_score = ?,
                ocr_quality_status = ?, ocr_quality_json = ?, ocr_stages_json = ?,
                ocr_review_required = ?,
                ocr_error = NULL, ocr_next_attempt_at = NULL, ocr_force = 0,
                ocr_lease_until = NULL, ocr_updated_at = ?, ocr_purged_at = NULL
          WHERE id = ?`,
      )
      .run(
        input.text,
        input.rawText ?? null,
        input.confidence,
        input.model,
        input.engineModel,
        input.configHash,
        input.seconds,
        input.pages,
        input.truncated ? 1 : 0,
        input.route ?? null,
        input.document ? JSON.stringify(input.document) : null,
        quality ? quality.score : null,
        quality ? quality.status : null,
        quality ? JSON.stringify(quality) : null,
        input.stages && input.stages.length > 0 ? JSON.stringify(input.stages) : null,
        quality && quality.status !== 'pass' ? 1 : 0,
        updatedAt,
        id,
      );
  }

  retryOcr(id: string, error: string, nextAttemptAt: string, updatedAt: string): void {
    this.#db
      .stmt(
        `UPDATE attachments
            SET ocr_status = 'pending', ocr_error = ?, ocr_next_attempt_at = ?,
                ocr_lease_until = NULL, ocr_updated_at = ?
          WHERE id = ?`,
      )
      .run(error, nextAttemptAt, updatedAt, id);
  }

  /** Requeue a claim that was abandoned during shutdown without consuming an attempt. */
  deferOcr(id: string, error: string, updatedAt: string): void {
    this.#db
      .stmt(
        `UPDATE attachments
            SET ocr_status = 'pending', ocr_error = ?, ocr_next_attempt_at = NULL,
                ocr_attempts = MAX(0, ocr_attempts - 1), ocr_lease_until = NULL,
                ocr_updated_at = ?
          WHERE id = ? AND ocr_status = 'processing'`,
      )
      .run(error, updatedAt, id);
  }

  failOcr(id: string, error: string, updatedAt: string): void {
    this.#db
      .stmt(
        `UPDATE attachments
            SET ocr_status = 'failed', ocr_error = ?, ocr_next_attempt_at = NULL,
                ocr_lease_until = NULL, ocr_updated_at = ?
          WHERE id = ?`,
      )
      .run(error, updatedAt, id);
  }

  /** Requeue a finished or failed job; returns false while it is still active. */
  requeueOcr(
    id: string,
    updatedAt: string,
    options: { mode?: OcrMode; dpi?: number } = {},
  ): boolean {
    const row = this.#db
      .stmt(
        `UPDATE attachments
            SET ocr_status = 'pending', ocr_attempts = 0, ocr_error = NULL,
                ocr_next_attempt_at = NULL, ocr_force = 1, ocr_review_required = 0,
                ocr_lease_until = NULL,
                ocr_route = NULL, ocr_document_json = NULL, ocr_quality_score = NULL,
                ocr_quality_status = NULL, ocr_quality_json = NULL, ocr_stages_json = NULL,
                ocr_purged_at = NULL,
                ocr_mode = COALESCE(?, ocr_mode), ocr_dpi = COALESCE(?, ocr_dpi),
                ocr_updated_at = ?
          WHERE id = ? AND ocr_status IN ('done', 'failed')
          RETURNING id`,
      )
      .get(options.mode ?? null, options.dpi ?? null, updatedAt, id) as unknown as
      | { id: string }
      | undefined;
    return Boolean(row);
  }

  findOcr(id: string): AttachmentOcr | null {
    const row = this.#db
      .stmt(
        `SELECT ocr_status, ocr_engine, ocr_text, ocr_raw_text, ocr_model, ocr_confidence, ocr_error,
                ocr_pages, ocr_seconds, ocr_truncated, ocr_mode, ocr_dpi, ocr_route,
                ocr_document_json, ocr_quality_json, ocr_stages_json, ocr_review_required,
                ocr_updated_at, ocr_purged_at
           FROM attachments WHERE id = ?`,
      )
      .get(id) as unknown as OcrRow | undefined;
    if (!row) return null;
    const text = row.ocr_text ?? '';
    return {
      status: row.ocr_status,
      engine: row.ocr_engine,
      model: row.ocr_model,
      confidence: row.ocr_confidence === null ? null : Number(row.ocr_confidence),
      characters: text.length,
      pages: Number(row.ocr_pages),
      seconds: row.ocr_seconds === null ? null : Number(row.ocr_seconds),
      truncated: Number(row.ocr_truncated) === 1,
      mode: row.ocr_mode,
      dpi: Number(row.ocr_dpi),
      route: row.ocr_route,
      quality: parseJson<DocumentQuality>(row.ocr_quality_json),
      reviewRequired: Number(row.ocr_review_required) === 1,
      error: row.ocr_error,
      updatedAt: row.ocr_updated_at,
      text,
      rawText: row.ocr_raw_text ?? text,
      stages: parseJson<OcrStage[]>(row.ocr_stages_json) ?? [],
      document: normalizeDocumentIr(parseJson<DocumentIr>(row.ocr_document_json)),
      purgedAt: row.ocr_purged_at,
    };
  }

  /**
   * Latest successful extraction of identical bytes by the same engine and
   * model. Partial (page-capped or time-capped) results never qualify.
   *
   * Reuse is confined to the workspace owning `projectId`: an identical hash in
   * another workspace would confirm that file exists there and could hand over
   * its content.
   */
  findReusableOcr(
    sha256: string,
    engine: OcrEngine,
    engineModel: string,
    configHash: string,
    mode: OcrMode,
    dpi: number,
    projectId: string,
  ): ReusableOcr | null {
    if (!engineModel) return null;
    const row = this.#db
      .stmt(
        `SELECT a.id, a.ocr_text, a.ocr_raw_text, a.ocr_model, a.ocr_confidence, a.ocr_pages, a.ocr_seconds,
                a.ocr_route, a.ocr_document_json, a.ocr_quality_json, a.ocr_stages_json
           FROM attachments a
           JOIN projects target ON target.id = ?
      LEFT JOIN projects owner ON owner.id = a.project_id
          WHERE a.sha256 = ? AND a.ocr_engine = ? AND a.ocr_engine_model = ?
            AND a.ocr_config_hash = ?
            AND a.ocr_mode = ? AND a.ocr_dpi = ?
            AND a.ocr_status = 'done' AND a.ocr_truncated = 0 AND a.ocr_text IS NOT NULL
            AND COALESCE(a.ocr_quality_status, 'pass') <> 'fail'
            AND COALESCE(target.workspace_id, '') = COALESCE(owner.workspace_id, '')
          ORDER BY a.ocr_updated_at DESC
          LIMIT 1`,
      )
      .get(projectId, sha256, engine, engineModel, configHash, mode, dpi) as unknown as
      | {
          id: string;
          ocr_text: string;
          ocr_raw_text: string | null;
          ocr_model: string | null;
          ocr_confidence: number | null;
          ocr_pages: number;
          ocr_seconds: number | null;
          ocr_route: OcrRoute | null;
          ocr_document_json: string | null;
          ocr_quality_json: string | null;
          ocr_stages_json: string | null;
        }
      | undefined;
    if (!row) return null;
    return {
      id: row.id,
      text: row.ocr_text,
      rawText: row.ocr_raw_text ?? row.ocr_text,
      model: row.ocr_model,
      confidence: row.ocr_confidence === null ? null : Number(row.ocr_confidence),
      pages: Number(row.ocr_pages),
      seconds: row.ocr_seconds === null ? null : Number(row.ocr_seconds),
      route: row.ocr_route,
      quality: parseJson<DocumentQuality>(row.ocr_quality_json),
      stages: parseJson<OcrStage[]>(row.ocr_stages_json) ?? [],
      document: normalizeDocumentIr(parseJson<DocumentIr>(row.ocr_document_json)),
    };
  }

  /**
   * Requeue jobs left in `processing` by a crashed process. Rows touched after
   * the cutoff may belong to a live worker and are left alone.
   */
  recoverProcessing(cutoff: string, message: string, updatedAt: string): number {
    const result = this.#db
      .stmt(
        `UPDATE attachments
            SET ocr_status = 'pending', ocr_error = ?, ocr_next_attempt_at = NULL,
                ocr_lease_until = NULL, ocr_updated_at = ?
          WHERE ocr_status = 'processing'
            AND (
              (ocr_lease_until IS NOT NULL AND ocr_lease_until <= ?)
              OR (ocr_lease_until IS NULL AND (ocr_updated_at IS NULL OR ocr_updated_at <= ?))
            )`,
      )
      .run(message, updatedAt, updatedAt, cutoff);
    return Number(result.changes);
  }

  ocrStats(): { pending: number; processing: number; failed: number; done: number } {
    const rows = this.#db
      .stmt('SELECT ocr_status AS status, COUNT(*) AS count FROM attachments GROUP BY ocr_status')
      .all() as unknown as { status: OcrStatus; count: number }[];
    const stats = { pending: 0, processing: 0, failed: 0, done: 0 };
    for (const row of rows) {
      if (row.status in stats) stats[row.status as keyof typeof stats] = Number(row.count);
    }
    return stats;
  }

  /**
   * Clear transcripts, structured documents and derived review payloads past
   * the retention window. Counts and quality scores stay for ops metrics; the
   * row is stamped so the purge is auditable and re-running is a no-op.
   */
  purgeOcrText(
    retentionDays: number,
    now = Date.now(),
  ): { attachments: number; revisions: number } {
    if (!Number.isFinite(retentionDays) || retentionDays <= 0) {
      return { attachments: 0, revisions: 0 };
    }
    const cutoff = new Date(now - retentionDays * DAY_MS).toISOString();
    const purgedAt = new Date(now).toISOString();
    return this.#db.transaction(() => {
      const purged = this.#db
        .stmt(
          `UPDATE attachments
              SET ocr_text = NULL, ocr_raw_text = NULL, ocr_document_json = NULL,
                  ocr_quality_json = NULL, ocr_stages_json = NULL,
                  ocr_review_required = 0, ocr_purged_at = ?
            WHERE ocr_purged_at IS NULL
              AND COALESCE(ocr_updated_at, created_at) <= ?
              AND (ocr_text IS NOT NULL OR ocr_raw_text IS NOT NULL
                   OR ocr_document_json IS NOT NULL OR ocr_quality_json IS NOT NULL
                   OR ocr_stages_json IS NOT NULL)`,
        )
        .run(purgedAt, cutoff);
      const revisions = this.#db
        .stmt('DELETE FROM ocr_field_revisions WHERE created_at <= ?')
        .run(cutoff);
      return {
        attachments: Number(purged.changes),
        revisions: Number(revisions.changes),
      };
    });
  }

  remove(id: string): void {
    this.#db.stmt('DELETE FROM attachments WHERE id = ?').run(id);
  }
}

export function toAttachment(
  record: AttachmentRecord,
  link: { url: string; expiresAt: string },
): Attachment {
  return {
    id: record.id,
    projectId: record.projectId,
    name: record.name,
    mime: record.mime,
    size: record.size,
    uploader: record.uploader,
    createdAt: record.createdAt,
    downloadUrl: link.url,
    downloadExpiresAt: link.expiresAt,
    ocr: {
      status: record.ocrStatus,
      engine: record.ocrEngine,
      model: record.ocrModel,
      confidence: record.ocrConfidence,
      characters: record.ocrCharacters,
      pages: record.ocrPages,
      seconds: record.ocrSeconds,
      truncated: record.ocrTruncated,
      mode: record.ocrMode,
      dpi: record.ocrDpi,
      route: record.ocrRoute,
      quality: record.ocrQuality,
      reviewRequired: record.ocrReviewRequired,
      error: record.ocrError,
      updatedAt: record.ocrUpdatedAt,
      purgedAt: record.ocrPurgedAt,
    },
  };
}
