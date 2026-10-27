import type { Attachment, UserOption } from '../../shared/types.ts';
import type { Database } from '../db.ts';

type AttachmentRow = {
  id: string;
  project_id: string;
  uploader_id: string | null;
  uploader_name: string | null;
  name: string;
  mime: string;
  size: number;
  stored_name: string;
  created_at: string;
};

export type AttachmentRecord = {
  id: string;
  projectId: string;
  uploaderId: string | null;
  name: string;
  mime: string;
  size: number;
  storedName: string;
  createdAt: string;
  uploader: UserOption | null;
};

function toRecord(row: AttachmentRow): AttachmentRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    uploaderId: row.uploader_id,
    name: row.name,
    mime: row.mime,
    size: Number(row.size),
    storedName: row.stored_name,
    createdAt: row.created_at,
    uploader: row.uploader_id
      ? { id: row.uploader_id, name: row.uploader_name ?? '已删除成员' }
      : null,
  };
}

const SELECT = `
  SELECT a.id, a.project_id, a.uploader_id, u.name AS uploader_name,
         a.name, a.mime, a.size, a.stored_name, a.created_at
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
  }): AttachmentRecord {
    this.#db
      .stmt(
        `INSERT INTO attachments
           (id, project_id, uploader_id, name, mime, size, stored_name, sha256, scan, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'clean', ?)`,
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
        input.createdAt,
      );
    const record = this.find(input.id);
    if (!record) throw new Error('attachment creation failed');
    return record;
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
  };
}
