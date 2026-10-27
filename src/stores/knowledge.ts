import type {
  DecisionOption,
  DecisionRecord,
  DecisionStatus,
  DecisionVersion,
  DocumentConfidentiality,
  DocumentStatus,
  DocumentVersion,
  ProjectDocument,
  UserOption,
} from '../../shared/types.ts';
import { type Database, escapeLike } from '../db.ts';

type DocumentRow = {
  id: string;
  project_id: string;
  workspace_id: string | null;
  title: string;
  content: string;
  format: string;
  status: string;
  owner_id: string | null;
  owner_name: string | null;
  confidentiality: string;
  review_due_at: string | null;
  review_cycle_days: number | null;
  version: number;
  created_at: string;
  updated_at: string;
};

type DocumentVersionRow = {
  id: string;
  document_id: string;
  version: number;
  title: string;
  content: string;
  change_summary: string;
  created_by_name: string | null;
  created_at: string;
};

type DecisionRow = {
  id: string;
  workspace_id: string;
  project_id: string | null;
  project_name: string | null;
  title: string;
  status: string;
  context: string;
  options_json: string;
  decision: string;
  consequences: string;
  decided_by_name: string | null;
  review_at: string | null;
  version: number;
  created_at: string;
  updated_at: string;
};

type DecisionVersionRow = {
  id: string;
  decision_id: string;
  version: number;
  snapshot_json: string;
  change_summary: string;
  changed_by_name: string | null;
  created_at: string;
};

export type DocumentInput = {
  title: string;
  content?: string;
  format?: 'markdown' | 'text';
  status?: DocumentStatus;
  ownerId?: string | null;
  confidentiality?: DocumentConfidentiality;
  reviewDueAt?: string | null;
  reviewCycleDays?: number | null;
};

export type DocumentUpdateInput = Partial<DocumentInput> & {
  version: number;
  changeSummary?: string;
};

export type DecisionInput = {
  projectId?: string | null;
  title: string;
  status?: DecisionStatus;
  context?: string;
  options?: DecisionOption[];
  decision?: string;
  consequences?: string;
  reviewAt?: string | null;
};

export type DecisionUpdateInput = Partial<Omit<DecisionInput, 'projectId'>> & {
  version: number;
  changeSummary?: string;
};

type DocumentResult =
  | { status: 'ok'; document: ProjectDocument }
  | { status: 'missing' }
  | { status: 'invalid'; message: string }
  | { status: 'conflict'; current: ProjectDocument };

type DecisionResult =
  | { status: 'ok'; decision: DecisionRecord }
  | { status: 'missing' }
  | { status: 'invalid'; message: string }
  | { status: 'conflict'; current: DecisionRecord };

function parseOptions(raw: string): DecisionOption[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
      .map((item) => ({
        title: String(item.title ?? ''),
        ...(item.pros ? { pros: String(item.pros) } : {}),
        ...(item.cons ? { cons: String(item.cons) } : {}),
      }))
      .filter((item) => item.title.length > 0);
  } catch {
    return [];
  }
}

function addDays(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00.000Z`) + days * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

function toDocument(row: DocumentRow): ProjectDocument {
  return {
    id: row.id,
    projectId: row.project_id,
    workspaceId: row.workspace_id,
    title: row.title,
    content: row.content,
    format: row.format === 'text' ? 'text' : 'markdown',
    status: row.status as DocumentStatus,
    ownerId: row.owner_id,
    ownerName: row.owner_name,
    confidentiality: row.confidentiality as DocumentConfidentiality,
    reviewDueAt: row.review_due_at,
    reviewCycleDays:
      row.review_cycle_days === null || row.review_cycle_days === undefined
        ? null
        : Number(row.review_cycle_days),
    version: Number(row.version),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toDocumentVersion(row: DocumentVersionRow): DocumentVersion {
  return {
    id: row.id,
    documentId: row.document_id,
    version: Number(row.version),
    title: row.title,
    content: row.content,
    changeSummary: row.change_summary,
    createdByName: row.created_by_name,
    createdAt: row.created_at,
  };
}

function toDecision(row: DecisionRow): DecisionRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    projectId: row.project_id,
    projectName: row.project_name,
    title: row.title,
    status: row.status as DecisionStatus,
    context: row.context,
    options: parseOptions(row.options_json),
    decision: row.decision,
    consequences: row.consequences,
    decidedByName: row.decided_by_name,
    reviewAt: row.review_at,
    version: Number(row.version),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toDecisionVersion(row: DecisionVersionRow): DecisionVersion {
  let snapshot: Record<string, unknown> = {};
  try {
    snapshot = JSON.parse(row.snapshot_json) as Record<string, unknown>;
  } catch {
    snapshot = {};
  }
  return {
    id: row.id,
    decisionId: row.decision_id,
    version: Number(row.version),
    snapshot,
    changeSummary: row.change_summary,
    changedByName: row.changed_by_name,
    createdAt: row.created_at,
  };
}

export class KnowledgeStore {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  #project(projectId: string, workspaceId: string): { id: string } | null {
    const row = this.#db
      .stmt('SELECT id FROM projects WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL')
      .get(projectId, workspaceId) as unknown as { id: string } | undefined;
    return row ?? null;
  }

  #documentRow(id: string, workspaceId: string): DocumentRow | null {
    const row = this.#db
      .stmt(
        `SELECT d.id, d.project_id, d.workspace_id, d.title, d.content, d.format, d.status,
                d.owner_id, u.name AS owner_name, d.confidentiality, d.review_due_at,
                d.review_cycle_days, d.version, d.created_at, d.updated_at
         FROM project_documents d
         JOIN projects p ON p.id = d.project_id
         LEFT JOIN users u ON u.id = d.owner_id
         WHERE d.id = ? AND p.workspace_id = ? AND p.deleted_at IS NULL`,
      )
      .get(id, workspaceId) as unknown as DocumentRow | undefined;
    return row ?? null;
  }

  listDocuments(
    projectId: string,
    workspaceId: string,
    input: { status?: string; q?: string } = {},
  ): ProjectDocument[] | null {
    if (!this.#project(projectId, workspaceId)) return null;
    const where = ['d.project_id = ?'];
    const params: string[] = [projectId];
    if (input.status && input.status !== 'all') {
      where.push('d.status = ?');
      params.push(input.status);
    }
    if (input.q) {
      where.push("(d.title LIKE ? ESCAPE '\\' OR d.content LIKE ? ESCAPE '\\')");
      const pattern = `%${escapeLike(input.q)}%`;
      params.push(pattern, pattern);
    }
    const rows = this.#db
      .stmt(
        `SELECT d.id, d.project_id, d.workspace_id, d.title, d.content, d.format, d.status,
                d.owner_id, u.name AS owner_name, d.confidentiality, d.review_due_at,
                d.review_cycle_days, d.version, d.created_at, d.updated_at
         FROM project_documents d
         LEFT JOIN users u ON u.id = d.owner_id
         WHERE ${where.join(' AND ')}
         ORDER BY d.updated_at DESC LIMIT 200`,
      )
      .all(...params) as unknown as DocumentRow[];
    return rows.map(toDocument);
  }

  getDocument(id: string, workspaceId: string): ProjectDocument | null {
    const row = this.#documentRow(id, workspaceId);
    return row ? toDocument(row) : null;
  }

  #insertDocumentVersion(document: ProjectDocument, actorId: string | null, summary: string): void {
    this.#db
      .stmt(
        `INSERT INTO document_versions
           (id, document_id, version, title, content, change_summary, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        crypto.randomUUID(),
        document.id,
        document.version,
        document.title,
        document.content,
        summary,
        actorId,
        new Date().toISOString(),
      );
  }

  createDocument(
    projectId: string,
    workspaceId: string,
    input: DocumentInput,
    actor: UserOption,
  ): DocumentResult {
    if (!this.#project(projectId, workspaceId)) return { status: 'missing' };
    if (input.ownerId) {
      const owner = this.#db
        .stmt("SELECT 1 AS present FROM users WHERE id = ? AND status = 'active'")
        .get(input.ownerId) as unknown as { present: number } | undefined;
      if (!owner) return { status: 'invalid', message: '负责人不存在或已停用' };
    }
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const reviewDueAt =
      input.reviewDueAt ??
      (input.reviewCycleDays ? addDays(now.slice(0, 10), input.reviewCycleDays) : null);
    this.#db
      .stmt(
        `INSERT INTO project_documents
           (id, project_id, workspace_id, title, content, format, status, owner_id,
            confidentiality, review_due_at, review_cycle_days, version, created_by,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
      )
      .run(
        id,
        projectId,
        workspaceId,
        input.title.trim(),
        input.content ?? '',
        input.format ?? 'markdown',
        input.status ?? 'draft',
        input.ownerId ?? actor.id,
        input.confidentiality ?? 'internal',
        reviewDueAt,
        input.reviewCycleDays ?? null,
        actor.id,
        now,
        now,
      );
    const document = this.getDocument(id, workspaceId);
    if (!document) throw new Error('document creation failed');
    this.#insertDocumentVersion(document, actor.id, '创建文档');
    return { status: 'ok', document };
  }

  updateDocument(
    id: string,
    workspaceId: string,
    input: DocumentUpdateInput,
    actor: UserOption,
  ): DocumentResult {
    const current = this.#documentRow(id, workspaceId);
    if (!current) return { status: 'missing' };
    if (input.ownerId) {
      const owner = this.#db
        .stmt("SELECT 1 AS present FROM users WHERE id = ? AND status = 'active'")
        .get(input.ownerId) as unknown as { present: number } | undefined;
      if (!owner) return { status: 'invalid', message: '负责人不存在或已停用' };
    }
    const sets = ['updated_at = ?', 'version = version + 1'];
    const nowIso = new Date().toISOString();
    const params: (string | number | null)[] = [nowIso];
    const fields: [keyof DocumentInput, string, (value: unknown) => unknown][] = [
      ['title', 'title', (value) => String(value).trim()],
      ['content', 'content', (value) => String(value)],
      ['format', 'format', (value) => value],
      ['status', 'status', (value) => value],
      ['ownerId', 'owner_id', (value) => value ?? null],
      ['confidentiality', 'confidentiality', (value) => value],
      ['reviewDueAt', 'review_due_at', (value) => value ?? null],
      ['reviewCycleDays', 'review_cycle_days', (value) => value ?? null],
    ];
    for (const [key, column, cast] of fields) {
      if (input[key] !== undefined) {
        sets.push(`${column} = ?`);
        params.push(cast(input[key]) as string | number | null);
      }
    }
    const nextStatus = input.status ?? current.status;
    const nextCycle =
      input.reviewCycleDays !== undefined ? input.reviewCycleDays : current.review_cycle_days;
    if (input.reviewDueAt === undefined && input.reviewCycleDays !== undefined && nextCycle) {
      sets.push('review_due_at = ?');
      params.push(addDays(nowIso.slice(0, 10), Number(nextCycle)));
    }
    if (
      input.reviewDueAt !== undefined ||
      input.reviewCycleDays !== undefined ||
      (input.status !== undefined && (nextStatus === 'published' || nextStatus === 'review'))
    ) {
      sets.push('reminder_sent_at = NULL');
    }
    params.push(id, input.version);
    const updated = this.#db
      .stmt(
        `UPDATE project_documents SET ${sets.join(', ')}
         WHERE id = ? AND version = ? RETURNING id`,
      )
      .get(...params) as unknown as { id: string } | undefined;
    if (!updated) {
      const latest = this.getDocument(id, workspaceId);
      return latest ? { status: 'conflict', current: latest } : { status: 'missing' };
    }
    const document = this.getDocument(id, workspaceId);
    if (!document) throw new Error('document update failed');
    this.#insertDocumentVersion(document, actor.id, input.changeSummary?.trim() || '更新文档');
    return { status: 'ok', document };
  }

  listDocumentVersions(id: string, workspaceId: string): DocumentVersion[] | null {
    if (!this.#documentRow(id, workspaceId)) return null;
    const rows = this.#db
      .stmt(
        `SELECT v.id, v.document_id, v.version, v.title, v.content, v.change_summary,
                u.name AS created_by_name, v.created_at
         FROM document_versions v LEFT JOIN users u ON u.id = v.created_by
         WHERE v.document_id = ? ORDER BY v.version DESC LIMIT 100`,
      )
      .all(id) as unknown as DocumentVersionRow[];
    return rows.map(toDocumentVersion);
  }

  restoreDocument(
    id: string,
    workspaceId: string,
    targetVersion: number,
    changeSummary: string | undefined,
    actor: UserOption,
  ): DocumentResult {
    const current = this.#documentRow(id, workspaceId);
    if (!current) return { status: 'missing' };
    const target = this.#db
      .stmt('SELECT title, content FROM document_versions WHERE document_id = ? AND version = ?')
      .get(id, targetVersion) as unknown as { title: string; content: string } | undefined;
    if (!target) return { status: 'invalid', message: '文档版本不存在' };
    const now = new Date().toISOString();
    this.#db
      .stmt(
        `UPDATE project_documents
         SET title = ?, content = ?, updated_at = ?, version = version + 1
         WHERE id = ? AND version = ?`,
      )
      .run(target.title, target.content, now, id, current.version);
    const document = this.getDocument(id, workspaceId);
    if (!document) throw new Error('document restore failed');
    this.#insertDocumentVersion(
      document,
      actor.id,
      changeSummary?.trim() || `恢复到版本 v${targetVersion}`,
    );
    return { status: 'ok', document };
  }

  #decisionRow(id: string, workspaceId: string): DecisionRow | null {
    const row = this.#db
      .stmt(
        `SELECT d.id, d.workspace_id, d.project_id, p.name AS project_name, d.title, d.status,
                d.context, d.options_json, d.decision, d.consequences, u.name AS decided_by_name,
                d.review_at, d.version, d.created_at, d.updated_at
         FROM decisions d
         LEFT JOIN projects p ON p.id = d.project_id
         LEFT JOIN users u ON u.id = d.decided_by
         WHERE d.id = ? AND d.workspace_id = ?`,
      )
      .get(id, workspaceId) as unknown as DecisionRow | undefined;
    return row ?? null;
  }

  #decisionVisible(row: DecisionRow, visible: Set<string> | null): boolean {
    if (!row.project_id) return true;
    return visible === null || visible.has(row.project_id);
  }

  listDecisions(
    workspaceId: string,
    input: {
      projectId?: string;
      status?: string;
      q?: string;
      visible?: Set<string> | null;
    } = {},
  ): DecisionRecord[] {
    const where = ['d.workspace_id = ?'];
    const params: string[] = [workspaceId];
    if (input.projectId) {
      where.push('d.project_id = ?');
      params.push(input.projectId);
    }
    if (input.status && input.status !== 'all') {
      where.push('d.status = ?');
      params.push(input.status);
    }
    if (input.q) {
      where.push("(d.title LIKE ? ESCAPE '\\' OR d.context LIKE ? ESCAPE '\\')");
      const pattern = `%${escapeLike(input.q)}%`;
      params.push(pattern, pattern);
    }
    const rows = this.#db
      .stmt(
        `SELECT d.id, d.workspace_id, d.project_id, p.name AS project_name, d.title, d.status,
                d.context, d.options_json, d.decision, d.consequences, u.name AS decided_by_name,
                d.review_at, d.version, d.created_at, d.updated_at
         FROM decisions d
         LEFT JOIN projects p ON p.id = d.project_id
         LEFT JOIN users u ON u.id = d.decided_by
         WHERE ${where.join(' AND ')}
         ORDER BY d.updated_at DESC LIMIT 200`,
      )
      .all(...params) as unknown as DecisionRow[];
    const visible = input.visible ?? null;
    return rows.filter((row) => this.#decisionVisible(row, visible)).map(toDecision);
  }

  getDecision(
    id: string,
    workspaceId: string,
    visible: Set<string> | null = null,
  ): DecisionRecord | null {
    const row = this.#decisionRow(id, workspaceId);
    if (!row || !this.#decisionVisible(row, visible)) return null;
    return toDecision(row);
  }

  #insertDecisionVersion(decision: DecisionRecord, actorId: string | null, summary: string): void {
    this.#db
      .stmt(
        `INSERT INTO decision_versions
           (id, decision_id, version, snapshot_json, change_summary, changed_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        crypto.randomUUID(),
        decision.id,
        decision.version,
        JSON.stringify({
          title: decision.title,
          status: decision.status,
          context: decision.context,
          options: decision.options,
          decision: decision.decision,
          consequences: decision.consequences,
          reviewAt: decision.reviewAt,
        }),
        summary,
        actorId,
        new Date().toISOString(),
      );
  }

  createDecision(workspaceId: string, input: DecisionInput, actor: UserOption): DecisionResult {
    const workspace = this.#db
      .stmt('SELECT 1 AS present FROM workspaces WHERE id = ?')
      .get(workspaceId) as unknown as { present: number } | undefined;
    if (!workspace) return { status: 'invalid', message: '工作区不存在' };
    if (input.projectId && !this.#project(input.projectId, workspaceId)) {
      return { status: 'invalid', message: '项目不存在' };
    }
    const status = input.status ?? 'proposed';
    if ((status === 'approved' || status === 'rejected') && !input.decision?.trim()) {
      return { status: 'invalid', message: '已决决策必须填写决策结论' };
    }
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    this.#db
      .stmt(
        `INSERT INTO decisions
           (id, workspace_id, project_id, title, status, context, options_json, decision,
            consequences, decided_by, review_at, version, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
      )
      .run(
        id,
        workspaceId,
        input.projectId ?? null,
        input.title.trim(),
        status,
        input.context?.trim() ?? '',
        JSON.stringify(input.options ?? []),
        input.decision?.trim() ?? '',
        input.consequences?.trim() ?? '',
        status === 'approved' || status === 'rejected' ? actor.id : null,
        input.reviewAt ?? null,
        actor.id,
        now,
        now,
      );
    const decision = this.getDecision(id, workspaceId);
    if (!decision) throw new Error('decision creation failed');
    this.#insertDecisionVersion(decision, actor.id, '创建决策');
    return { status: 'ok', decision };
  }

  updateDecision(
    id: string,
    workspaceId: string,
    input: DecisionUpdateInput,
    actor: UserOption,
  ): DecisionResult {
    const row = this.#decisionRow(id, workspaceId);
    if (!row) return { status: 'missing' };
    const nextStatus = input.status ?? (row.status as DecisionStatus);
    const nextDecision = input.decision ?? row.decision;
    if ((nextStatus === 'approved' || nextStatus === 'rejected') && !nextDecision.trim()) {
      return { status: 'invalid', message: '已决决策必须填写决策结论' };
    }
    if (
      row.status !== 'proposed' &&
      (input.status === 'approved' || input.status === 'rejected') &&
      input.status !== row.status
    ) {
      return { status: 'invalid', message: '只有提议中的决策可以批准或驳回' };
    }
    const sets = ['updated_at = ?', 'version = version + 1'];
    const params: (string | number | null)[] = [new Date().toISOString()];
    const fields: [keyof DecisionUpdateInput, string, (value: unknown) => unknown][] = [
      ['title', 'title', (value) => String(value).trim()],
      ['status', 'status', (value) => value],
      ['context', 'context', (value) => String(value).trim()],
      ['options', 'options_json', (value) => JSON.stringify(value ?? [])],
      ['decision', 'decision', (value) => String(value).trim()],
      ['consequences', 'consequences', (value) => String(value).trim()],
      ['reviewAt', 'review_at', (value) => value ?? null],
    ];
    for (const [key, column, cast] of fields) {
      if (input[key] !== undefined) {
        sets.push(`${column} = ?`);
        params.push(cast(input[key]) as string | number | null);
      }
    }
    if (input.status === 'approved' || input.status === 'rejected') {
      sets.push('decided_by = ?');
      params.push(actor.id);
    }
    params.push(id, input.version);
    const updated = this.#db
      .stmt(
        `UPDATE decisions SET ${sets.join(', ')}
         WHERE id = ? AND version = ? RETURNING id`,
      )
      .get(...params) as unknown as { id: string } | undefined;
    if (!updated) {
      const latest = this.getDecision(id, workspaceId);
      return latest ? { status: 'conflict', current: latest } : { status: 'missing' };
    }
    const decision = this.getDecision(id, workspaceId);
    if (!decision) throw new Error('decision update failed');
    this.#insertDecisionVersion(decision, actor.id, input.changeSummary?.trim() || '更新决策');
    return { status: 'ok', decision };
  }

  listDecisionVersions(id: string, workspaceId: string): DecisionVersion[] | null {
    if (!this.#decisionRow(id, workspaceId)) return null;
    const rows = this.#db
      .stmt(
        `SELECT v.id, v.decision_id, v.version, v.snapshot_json, v.change_summary,
                u.name AS changed_by_name, v.created_at
         FROM decision_versions v LEFT JOIN users u ON u.id = v.changed_by
         WHERE v.decision_id = ? ORDER BY v.version DESC LIMIT 100`,
      )
      .all(id) as unknown as DecisionVersionRow[];
    return rows.map(toDecisionVersion);
  }
}
