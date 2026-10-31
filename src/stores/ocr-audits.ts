import { createHash, randomUUID } from 'node:crypto';
import type {
  OcrCalibrationSample,
  OcrPassAudit,
  OcrPassAuditStats,
  OcrPassAuditVerdict,
} from '../../shared/types.ts';
import type { Database } from '../db.ts';
import { rateOf, wilsonInterval } from '../stats.ts';

type AuditRow = {
  id: string;
  attachment_id: string;
  attachment_name: string;
  project_id: string;
  project_name: string | null;
  workspace_id: string | null;
  doc_type: string;
  engine: string | null;
  model: string | null;
  quality_score: number | null;
  confidence: number | null;
  period: string;
  sampled_at: string;
  first_verdict: string | null;
  first_by: string | null;
  first_at: string | null;
  second_verdict: string | null;
  second_by: string | null;
  second_at: string | null;
  note: string | null;
};

type CandidateRow = {
  id: string;
  project_id: string;
  project_name: string | null;
  workspace_id: string | null;
  name: string;
  engine: string | null;
  model: string | null;
  quality_score: number | null;
  confidence: number | null;
};

/** Automatically passed documents: never reviewed, never reused as evidence. */
const PASS_CONDITIONS = `
  a.ocr_status = 'done'
  AND a.ocr_text IS NOT NULL
  AND a.ocr_truncated = 0
  AND COALESCE(a.ocr_quality_status, 'pass') = 'pass'
  AND COALESCE(a.ocr_review_required, 0) = 0`;

const SELECT_AUDIT = `SELECT g.*, a.name AS attachment_name, p.name AS project_name
           FROM ocr_pass_audits g
           JOIN attachments a ON a.id = g.attachment_id
           LEFT JOIN projects p ON p.id = g.project_id`;

function docTypeOf(name: string): string {
  const match = /\.([A-Za-z0-9]{1,10})$/.exec(name);
  return match ? match[1].toLowerCase() : 'other';
}

/** Consensus over two independent verdicts; one verdict alone is not an audit. */
function statusOf(row: {
  first_verdict: string | null;
  second_verdict: string | null;
}): OcrPassAudit['status'] {
  if (!row.first_verdict || !row.second_verdict) return 'pending';
  if (row.first_verdict === row.second_verdict) return row.first_verdict as OcrPassAuditVerdict;
  return 'disputed';
}

function toAudit(row: AuditRow): OcrPassAudit {
  return {
    id: row.id,
    attachmentId: row.attachment_id,
    attachmentName: row.attachment_name,
    projectId: row.project_id,
    projectName: row.project_name,
    workspaceId: row.workspace_id,
    docType: row.doc_type,
    engine: row.engine,
    model: row.model,
    qualityScore: row.quality_score === null ? null : Number(row.quality_score),
    confidence: row.confidence === null ? null : Number(row.confidence),
    period: row.period,
    sampledAt: row.sampled_at,
    status: statusOf(row),
    firstVerdict: (row.first_verdict as OcrPassAuditVerdict | null) ?? null,
    firstBy: row.first_by,
    firstAt: row.first_at,
    secondVerdict: (row.second_verdict as OcrPassAuditVerdict | null) ?? null,
    secondBy: row.second_by,
    secondAt: row.second_at,
    note: row.note,
  };
}

/**
 * Documents that passed automatically never reach the review queue, so any error
 * in them is silent and every threshold fitted on flagged samples is biased.
 * This store keeps a reproducible random sample of passed documents for double
 * annotation; the resulting rate is the only unbiased miss-rate estimate.
 */
export class OcrPassAuditStore {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  /** ISO week key, for example `2026-W44`. */
  static periodOf(date: Date): string {
    const anchor = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
    const day = anchor.getUTCDay() || 7;
    anchor.setUTCDate(anchor.getUTCDate() + 4 - day);
    const yearStart = new Date(Date.UTC(anchor.getUTCFullYear(), 0, 1));
    const week = Math.ceil(((anchor.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
    return `${anchor.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
  }

  /** Deterministic per (period, attachment) so a rerun picks the same documents. */
  static orderKey(period: string, attachmentId: string, salt: string): string {
    return createHash('sha256').update(`${period}|${salt}|${attachmentId}`).digest('hex');
  }

  #conditions(projectId?: string, unauditedOnly = true): { where: string; params: string[] } {
    const parts = [PASS_CONDITIONS];
    const params: string[] = [];
    if (unauditedOnly) {
      parts.push('NOT EXISTS (SELECT 1 FROM ocr_pass_audits g WHERE g.attachment_id = a.id)');
    }
    if (projectId) {
      parts.push('a.project_id = ?');
      params.push(projectId);
    }
    return { where: parts.join(' AND '), params };
  }

  /** Passed documents in the audited period, including already sampled ones. */
  passPopulation(projectId?: string): number {
    const { where, params } = this.#conditions(projectId, false);
    const row = this.#db
      .stmt(`SELECT COUNT(*) AS total FROM attachments a WHERE ${where}`)
      .get(...params) as unknown as { total: number };
    return Number(row.total);
  }

  #candidates(projectId?: string): CandidateRow[] {
    const { where, params } = this.#conditions(projectId);
    return this.#db
      .stmt(
        `SELECT a.id, a.project_id, p.name AS project_name, p.workspace_id, a.name,
                a.ocr_engine AS engine, a.ocr_model AS model,
                a.ocr_quality_score AS quality_score, a.ocr_confidence AS confidence
           FROM attachments a
           LEFT JOIN projects p ON p.id = a.project_id
          WHERE ${where}`,
      )
      .all(...params) as unknown as CandidateRow[];
  }

  sample(input: {
    fraction?: number;
    perType?: number;
    period?: string;
    projectId?: string;
    now: string;
  }): {
    period: string;
    created: OcrPassAudit[];
    strata: { docType: string; population: number; picked: number }[];
  } {
    const fraction = Math.min(Math.max(input.fraction ?? 0.02, 0.001), 0.2);
    const perType = Math.min(Math.max(input.perType ?? 5, 1), 50);
    const period = input.period?.trim() || OcrPassAuditStore.periodOf(new Date(input.now));
    const groups = new Map<string, CandidateRow[]>();
    for (const row of this.#candidates(input.projectId)) {
      const docType = docTypeOf(row.name);
      const bucket = groups.get(docType) ?? [];
      bucket.push(row);
      groups.set(docType, bucket);
    }
    const salt = process.env.OCR_AUDIT_SALT?.trim() || 'v1';
    const created: OcrPassAudit[] = [];
    const strata: { docType: string; population: number; picked: number }[] = [];
    const insert = this.#db.stmt(
      `INSERT INTO ocr_pass_audits
         (id, attachment_id, project_id, workspace_id, doc_type, engine, model,
          quality_score, confidence, period, sampled_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.#db.transaction(() => {
      for (const [docType, bucket] of [...groups.entries()].sort(([left], [right]) =>
        left.localeCompare(right),
      )) {
        const ordered = bucket
          .map((row) => ({ row, key: OcrPassAuditStore.orderKey(period, row.id, salt) }))
          .sort((left, right) => left.key.localeCompare(right.key));
        const wanted = Math.min(
          ordered.length,
          perType,
          Math.max(1, Math.ceil(ordered.length * fraction)),
        );
        for (const { row } of ordered.slice(0, wanted)) {
          const id = randomUUID();
          insert.run(
            id,
            row.id,
            row.project_id,
            row.workspace_id,
            docType,
            row.engine,
            row.model,
            row.quality_score,
            row.confidence,
            period,
            input.now,
          );
          created.push(
            toAudit({
              ...row,
              id,
              attachment_id: row.id,
              attachment_name: row.name,
              doc_type: docType,
              quality_score: row.quality_score,
              period,
              sampled_at: input.now,
              first_verdict: null,
              first_by: null,
              first_at: null,
              second_verdict: null,
              second_by: null,
              second_at: null,
              note: null,
            }),
          );
        }
        strata.push({ docType, population: ordered.length, picked: wanted });
      }
    });
    return { period, created, strata };
  }

  list(input: { status?: string; projectId?: string; period?: string; limit?: number } = {}) {
    const conditions: string[] = [];
    const params: (string | number)[] = [];
    if (input.projectId) {
      conditions.push('g.project_id = ?');
      params.push(input.projectId);
    }
    if (input.period) {
      conditions.push('g.period = ?');
      params.push(input.period);
    }
    if (input.status === 'pending') conditions.push('g.second_verdict IS NULL');
    else if (input.status === 'audited') conditions.push('g.second_verdict IS NOT NULL');
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    params.push(Math.min(Math.max(input.limit ?? 100, 1), 500));
    const rows = this.#db
      .stmt(`${SELECT_AUDIT} ${where} ORDER BY g.sampled_at DESC, g.rowid DESC LIMIT ?`)
      .all(...params) as unknown as AuditRow[];
    return rows.map(toAudit);
  }

  find(id: string): OcrPassAudit | null {
    const row = this.#db.stmt(`${SELECT_AUDIT} WHERE g.id = ?`).get(id) as unknown as
      | AuditRow
      | undefined;
    return row ? toAudit(row) : null;
  }

  /**
   * Record one reviewer's verdict. A second slot is refused when the same person
   * already filled both, because two verdicts from one reviewer are not an
   * independent double annotation.
   */
  verdict(
    id: string,
    verdict: OcrPassAuditVerdict,
    actor: { id: string; name: string },
    now: string,
    note?: string | null,
  ): OcrPassAudit | 'conflict' | null {
    const current = this.#db.stmt(`${SELECT_AUDIT} WHERE g.id = ?`).get(id) as unknown as
      | AuditRow
      | undefined;
    if (!current) return null;
    const slot = !current.first_by
      ? 'first'
      : current.first_by === actor.id
        ? 'first'
        : !current.second_by
          ? 'second'
          : current.second_by === actor.id
            ? 'second'
            : 'conflict';
    if (slot === 'conflict') return 'conflict';
    this.#db
      .stmt(
        `UPDATE ocr_pass_audits
            SET ${slot}_verdict = ?, ${slot}_by = ?, ${slot}_at = ?, note = COALESCE(?, note)
          WHERE id = ?`,
      )
      .run(verdict, actor.id, now, note ?? null, id);
    return this.find(id);
  }

  stats(input: { projectId?: string; period?: string } = {}): OcrPassAuditStats {
    const conditions: string[] = [];
    const params: string[] = [];
    if (input.projectId) {
      conditions.push('project_id = ?');
      params.push(input.projectId);
    }
    if (input.period) {
      conditions.push('period = ?');
      params.push(input.period);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows = this.#db
      .stmt(
        `SELECT id, attachment_id, project_id, workspace_id, doc_type, engine, model,
                quality_score, confidence, period, sampled_at, first_verdict, first_by,
                first_at, second_verdict, second_by, second_at, note
           FROM ocr_pass_audits ${where}`,
      )
      .all(...params) as unknown as AuditRow[];
    let pending = 0;
    let clean = 0;
    let error = 0;
    let disputed = 0;
    const byType = new Map<
      string,
      { sampled: number; clean: number; error: number; disputed: number }
    >();
    for (const row of rows) {
      const bucket = byType.get(row.doc_type) ?? {
        sampled: 0,
        clean: 0,
        error: 0,
        disputed: 0,
      };
      bucket.sampled += 1;
      const status = statusOf(row);
      if (status === 'pending') pending += 1;
      else {
        if (status === 'clean') clean += 1;
        else if (status === 'error') error += 1;
        else disputed += 1;
        bucket[status] += 1;
      }
      byType.set(row.doc_type, bucket);
    }
    const audited = clean + error + disputed;
    // Disputed documents count as errors: one reviewer found a problem, so the
    // estimate stays conservative instead of dropping the ambiguous case.
    const errors = error + disputed;
    const population = this.passPopulation(input.projectId);
    const doubleAudited = rows.filter((row) => row.second_verdict !== null).length;
    return {
      sampled: rows.length,
      pending,
      audited,
      clean,
      error,
      disputed,
      silentErrorRate: rateOf(errors, audited),
      interval: wilsonInterval(errors, audited),
      disagreementRate: rateOf(disputed, doubleAudited),
      passDocuments: population,
      coverage: rateOf(rows.length, population),
      byDocType: [...byType.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([docType, bucket]) => {
          const bucketAudited = bucket.clean + bucket.error + bucket.disputed;
          const bucketErrors = bucket.error + bucket.disputed;
          return {
            docType,
            sampled: bucket.sampled,
            audited: bucketAudited,
            clean: bucket.clean,
            error: bucket.error,
            disputed: bucket.disputed,
            silentErrorRate: rateOf(bucketErrors, bucketAudited),
            interval: wilsonInterval(bucketErrors, bucketAudited),
          };
        }),
    };
  }

  /** Consensus verdicts, used as the selection-bias-free calibration input. */
  calibrationSamples(): OcrCalibrationSample[] {
    const rows = this.#db
      .stmt(
        `SELECT doc_type, workspace_id, confidence, first_verdict, second_verdict
           FROM ocr_pass_audits
          WHERE first_verdict IS NOT NULL AND second_verdict IS NOT NULL`,
      )
      .all() as unknown as {
      doc_type: string;
      workspace_id: string | null;
      confidence: number | null;
      first_verdict: string;
      second_verdict: string;
    }[];
    return rows.flatMap((row) => {
      if (row.confidence === null) return [];
      const correct = row.first_verdict === row.second_verdict && row.first_verdict === 'clean';
      return [
        {
          confidence: Number(row.confidence),
          correct,
          severe: !correct,
          kind: row.doc_type,
          difficulty: null,
          language: null,
          fileType: row.doc_type,
          workspaceId: row.workspace_id,
        },
      ];
    });
  }
}
