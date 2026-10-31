import { randomUUID } from 'node:crypto';
import type {
  DocumentBBox,
  DocumentFieldKind,
  OcrFieldRevision,
  UserOption,
} from '../../shared/types.ts';
import type { Database } from '../db.ts';

type RevisionRow = {
  id: string;
  attachment_id: string;
  project_id: string;
  field_id: string;
  field_kind: DocumentFieldKind;
  page: number;
  block_id: string | null;
  bbox_json: string | null;
  original_text: string;
  revised_text: string;
  reason: string;
  revised_by: string | null;
  revised_by_name: string | null;
  created_at: string;
};

export type OcrFieldRevisionInput = {
  attachmentId: string;
  projectId: string;
  fieldId: string;
  fieldKind: DocumentFieldKind;
  page: number;
  blockId: string | null;
  bbox: DocumentBBox | null;
  originalText: string;
  revisedText: string;
  reason: string;
  revisedBy: UserOption | null;
  createdAt: string;
};

function parseBBox(value: string | null): DocumentBBox | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as DocumentBBox;
    return typeof parsed?.x === 'number' && typeof parsed?.y === 'number' ? parsed : null;
  } catch {
    return null;
  }
}

function toRevision(row: RevisionRow): OcrFieldRevision {
  return {
    id: row.id,
    attachmentId: row.attachment_id,
    projectId: row.project_id,
    fieldId: row.field_id,
    fieldKind: row.field_kind,
    page: Number(row.page),
    blockId: row.block_id,
    bbox: parseBBox(row.bbox_json),
    originalText: row.original_text,
    revisedText: row.revised_text,
    reason: row.reason,
    revisedBy:
      row.revised_by || row.revised_by_name
        ? { id: row.revised_by ?? '', name: row.revised_by_name ?? '' }
        : null,
    createdAt: row.created_at,
  };
}

export class OcrFieldRevisionsStore {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  list(attachmentId: string): OcrFieldRevision[] {
    const rows = this.#db
      .stmt(
        `SELECT id, attachment_id, project_id, field_id, field_kind, page, block_id,
                bbox_json, original_text, revised_text, reason, revised_by,
                revised_by_name, created_at
           FROM ocr_field_revisions
          WHERE attachment_id = ?
          ORDER BY created_at ASC, rowid ASC`,
      )
      .all(attachmentId) as unknown as RevisionRow[];
    return rows.map(toRevision);
  }

  /** Batch variant that avoids one query per attachment on aggregate reads. */
  listFor(attachmentIds: readonly string[]): Map<string, OcrFieldRevision[]> {
    const result = new Map<string, OcrFieldRevision[]>();
    const unique = [...new Set(attachmentIds)];
    // Stay below SQLite's bound-parameter ceiling for large windows.
    for (let start = 0; start < unique.length; start += 500) {
      const chunk = unique.slice(start, start + 500);
      const rows = this.#db
        .stmt(
          `SELECT id, attachment_id, project_id, field_id, field_kind, page, block_id,
                  bbox_json, original_text, revised_text, reason, revised_by,
                  revised_by_name, created_at
             FROM ocr_field_revisions
            WHERE attachment_id IN (${chunk.map(() => '?').join(', ')})
            ORDER BY created_at ASC, rowid ASC`,
        )
        .all(...chunk) as unknown as RevisionRow[];
      for (const row of rows) {
        const list = result.get(row.attachment_id);
        if (list) list.push(toRevision(row));
        else result.set(row.attachment_id, [toRevision(row)]);
      }
    }
    return result;
  }

  create(input: OcrFieldRevisionInput): OcrFieldRevision {
    const id = randomUUID();
    this.#db
      .stmt(
        `INSERT INTO ocr_field_revisions
           (id, attachment_id, project_id, field_id, field_kind, page, block_id,
            bbox_json, original_text, revised_text, reason, revised_by,
            revised_by_name, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.attachmentId,
        input.projectId,
        input.fieldId,
        input.fieldKind,
        input.page,
        input.blockId,
        input.bbox ? JSON.stringify(input.bbox) : null,
        input.originalText,
        input.revisedText,
        input.reason,
        input.revisedBy?.id ?? null,
        input.revisedBy?.name ?? null,
        input.createdAt,
      );
    const row = this.#db
      .stmt(
        `SELECT id, attachment_id, project_id, field_id, field_kind, page, block_id,
                bbox_json, original_text, revised_text, reason, revised_by,
                revised_by_name, created_at
           FROM ocr_field_revisions
          WHERE id = ?`,
      )
      .get(id) as unknown as RevisionRow;
    return toRevision(row);
  }

  count(attachmentId: string): number {
    const row = this.#db
      .stmt('SELECT COUNT(*) AS count FROM ocr_field_revisions WHERE attachment_id = ?')
      .get(attachmentId) as unknown as { count: number };
    return Number(row?.count ?? 0);
  }
}
