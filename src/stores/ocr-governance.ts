import { randomUUID } from 'node:crypto';
import type {
  DocumentIr,
  DocumentQuality,
  OcrDriftAlert,
  OcrDriftAlertRecord,
  OcrDriftDimension,
  OcrFeedbackErrorType,
  OcrFeedbackPool,
  OcrFeedbackSample,
  OcrFeedbackSelection,
  OcrFeedbackSignals,
  OcrFeedbackStatus,
  OcrKnowledgeGraph,
  OcrOptimizationEntry,
  OcrOptimizationRisk,
  OcrOptimizationStatus,
  OcrStage,
  UserOption,
} from '../../shared/types.ts';
import type { Database } from '../db.ts';
import { normalizeDocumentIr } from '../document-ir.ts';
import type { OcrDistribution, OcrDistributionInput } from '../ocr-drift.ts';
import {
  clamp01,
  feedbackDrafts,
  feedbackPriority,
  type OcrFeedbackDraft,
  type OcrFeedbackSource,
  selectFeedbackSamples,
  textLanguage,
} from '../ocr-feedback.ts';
import {
  buildProductionDashboard,
  type OcrDashboardRow,
  optimizationScore,
} from '../ocr-governance.ts';
import { buildKnowledgeGraph, type OcrKnowledgeDocument } from '../ocr-knowledge.ts';
import type { OcrFieldRevisionsStore } from './ocr-revisions.ts';

const MAX_KNOWLEDGE_TEXT_CHARS = 50_000;
const MAX_KNOWLEDGE_DOCUMENT_BYTES = 8_000_000;

type FeedbackRow = {
  id: string;
  attachment_id: string | null;
  project_id: string | null;
  sha256: string | null;
  error_type: OcrFeedbackErrorType;
  category: string;
  lang: string | null;
  page: number | null;
  block_id: string | null;
  field_id: string | null;
  signals_json: string;
  priority: number;
  status: OcrFeedbackStatus;
  note: string | null;
  created_at: string;
  sampled_at: string | null;
  labeled_at: string | null;
};

type FeedbackSourceRow = {
  id: string;
  project_id: string;
  sha256: string | null;
  name: string;
  mime: string;
  ocr_text: string | null;
  ocr_confidence: number | null;
  ocr_quality_json: string | null;
  ocr_document_json: string | null;
};

type KnowledgeRow = {
  id: string;
  project_id: string;
  project_name: string | null;
  name: string;
  created_at: string;
  ocr_text: string | null;
  ocr_document_json: string | null;
  doc_size: number | null;
};

type DistributionRow = {
  name: string;
  mime: string;
  ocr_text: string | null;
  ocr_pages: number;
  ocr_quality_json: string | null;
  ocr_document_json: string | null;
};

type DashboardDbRow = {
  id: string;
  name: string;
  mime: string;
  ocr_status: OcrDashboardRow['status'];
  ocr_engine: OcrDashboardRow['engine'];
  ocr_model: string | null;
  ocr_pages: number;
  ocr_seconds: number | null;
  ocr_confidence: number | null;
  ocr_truncated: number;
  ocr_review_required: number;
  ocr_quality_json: string | null;
  ocr_stages_json: string | null;
  ocr_document_json: string | null;
  ocr_text: string | null;
  ocr_updated_at: string | null;
  workspace_id: string | null;
  workspace_name: string | null;
  characters: number;
  revisions: number;
};

type BaselineRow = {
  sample_size: number;
  distribution_json: string;
  created_at: string;
};

type AlertRow = {
  id: string;
  dimension: OcrDriftDimension;
  severity: OcrDriftAlert['severity'];
  total_variation: number;
  threshold: number;
  message: string;
  buckets_json: string;
  status: 'open' | 'acknowledged';
  detected_at: string;
  acknowledged_at: string | null;
  acknowledged_by: string | null;
  acknowledged_by_name: string | null;
};

type OptimizationRow = {
  id: string;
  title: string;
  target_error: string;
  expected_gain: number;
  implementation_cost: number;
  inference_cost: number;
  risk: OcrOptimizationRisk;
  benchmark_result: string;
  production_result: string;
  status: OcrOptimizationStatus;
  created_by: string | null;
  created_by_name: string | null;
  created_at: string;
  updated_at: string;
};

export type OcrOptimizationInput = {
  title: string;
  targetError: string;
  expectedGain: number;
  implementationCost: number;
  inferenceCost: number;
  risk: OcrOptimizationRisk;
  benchmarkResult?: string;
  productionResult?: string;
  status?: OcrOptimizationStatus;
};

export type OcrOptimizationPatch = Partial<OcrOptimizationInput>;

const SELECT_FEEDBACK = `SELECT id, attachment_id, project_id, sha256, error_type, category,
       lang, page, block_id, field_id, signals_json, priority, status, note,
       created_at, sampled_at, labeled_at
  FROM ocr_feedback_samples`;

function parseJson<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function toFeedback(row: FeedbackRow): OcrFeedbackSample {
  const signals = parseJson<OcrFeedbackSignals>(row.signals_json, {
    confidence: null,
    uncertainty: 0,
    disagreement: 0,
    fieldFailure: 0,
    novelty: 0,
    revision: 0,
  });
  return {
    id: row.id,
    attachmentId: row.attachment_id,
    projectId: row.project_id,
    sha256: row.sha256,
    errorType: row.error_type,
    category: row.category,
    lang: row.lang,
    page: row.page === null ? null : Number(row.page),
    blockId: row.block_id,
    fieldId: row.field_id,
    signals,
    priority: Number(row.priority),
    status: row.status,
    note: row.note,
    createdAt: row.created_at,
    sampledAt: row.sampled_at,
    labeledAt: row.labeled_at,
  };
}

function toOptimization(row: OptimizationRow): OcrOptimizationEntry {
  const entry = {
    expectedGain: Number(row.expected_gain),
    implementationCost: Number(row.implementation_cost),
    inferenceCost: Number(row.inference_cost),
  };
  return {
    id: row.id,
    title: row.title,
    targetError: row.target_error,
    ...entry,
    risk: row.risk,
    benchmarkResult: row.benchmark_result,
    productionResult: row.production_result,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    score: optimizationScore(entry),
    createdBy:
      row.created_by || row.created_by_name
        ? { id: row.created_by ?? '', name: row.created_by_name ?? '' }
        : null,
  };
}

const SELECT_OPTIMIZATION = `SELECT o.id, o.title, o.target_error, o.expected_gain,
       o.implementation_cost, o.inference_cost, o.risk, o.benchmark_result,
       o.production_result, o.status, o.created_by, u.name AS created_by_name,
       o.created_at, o.updated_at
  FROM ocr_optimizations o
  LEFT JOIN users u ON u.id = o.created_by`;

/** Feedback pool, drift baseline and the optimization ledger (items 65-70). */
export class OcrGovernanceStore {
  readonly #db: Database;
  readonly #revisions: OcrFieldRevisionsStore;

  constructor(db: Database, revisions: OcrFieldRevisionsStore) {
    this.#db = db;
    this.#revisions = revisions;
  }

  #categoryCounts(): Map<string, number> {
    const rows = this.#db
      .stmt(`SELECT category, COUNT(*) AS count FROM ocr_feedback_samples GROUP BY category`)
      .all() as unknown as { category: string; count: number }[];
    return new Map(rows.map((row) => [row.category, Number(row.count)]));
  }

  /** Insert deduplicated drafts; returns the number of new samples. */
  ingest(drafts: readonly OcrFeedbackDraft[], now: string): number {
    if (drafts.length === 0) return 0;
    return this.#db.transaction(() => {
      const categories = this.#categoryCounts();
      const insert = this.#db.stmt(
        `INSERT OR IGNORE INTO ocr_feedback_samples
           (id, attachment_id, project_id, sha256, dedupe_key, error_type, category,
            lang, page, block_id, field_id, signals_json, priority, status, note, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pool', ?, ?)`,
      );
      let inserted = 0;
      for (const draft of drafts) {
        const fingerprint = draft.sha256 ?? draft.attachmentId;
        const dedupeKey = draft.dedupeKey ?? `${fingerprint}:${draft.errorType}`;
        const novelty = clamp01(1 - (categories.get(draft.category) ?? 0) / 20);
        const signals: OcrFeedbackSignals = {
          ...draft.signals,
          novelty: Math.round(novelty * 1000) / 1000,
        };
        const result = insert.run(
          randomUUID(),
          draft.attachmentId,
          draft.projectId,
          draft.sha256,
          dedupeKey,
          draft.errorType,
          draft.category,
          draft.lang,
          draft.page,
          draft.blockId,
          draft.fieldId,
          JSON.stringify(signals),
          feedbackPriority(signals),
          draft.note,
          now,
        );
        if (Number(result.changes) > 0) {
          inserted += 1;
          categories.set(draft.category, (categories.get(draft.category) ?? 0) + 1);
        }
      }
      return inserted;
    });
  }

  ingestSource(source: OcrFeedbackSource, now: string): number {
    return this.ingest(feedbackDrafts(source), now);
  }

  /**
   * Automatic sample return after an OCR run: low confidence, model
   * disagreement, failed key fields and revisions enter the pool.
   */
  completeOcrFeedback(input: {
    attachmentId: string;
    projectId: string;
    sha256: string | null;
    name: string;
    mime: string;
    text: string;
    confidence: number | null;
    quality: DocumentQuality | null;
    document: DocumentIr | null;
    now: string;
  }): number {
    return this.ingestSource(
      {
        attachment: {
          id: input.attachmentId,
          projectId: input.projectId,
          sha256: input.sha256,
          name: input.name,
          mime: input.mime,
          ocrText: input.text,
          confidence: input.confidence,
        },
        quality: input.quality,
        document: input.document,
        revisions: this.#revisions.list(input.attachmentId),
      },
      input.now,
    );
  }

  /** Record a user complaint against an attachment; it is never rewritten. */
  reportComplaint(input: {
    attachmentId: string;
    projectId: string;
    /** Reporter, so one user's complaint never absorbs another's. */
    userId: string;
    sha256: string | null;
    name: string;
    mime: string;
    text: string;
    confidence: number | null;
    quality: DocumentQuality | null;
    document: DocumentIr | null;
    note: string;
    now: string;
  }): OcrFeedbackSample | null {
    const drafts = feedbackDrafts({
      attachment: {
        id: input.attachmentId,
        projectId: input.projectId,
        sha256: input.sha256,
        name: input.name,
        mime: input.mime,
        ocrText: input.text,
        confidence: input.confidence,
      },
      quality: input.quality,
      document: input.document,
      revisions: this.#revisions.list(input.attachmentId),
      complaint: input.note,
    });
    const fingerprint = input.sha256 ?? input.attachmentId;
    // Scope dedupe to the project and reporter so the same file in another
    // project or from another user never reuses this feedback row.
    const dedupeKey = `${input.projectId}:${input.userId}:${fingerprint}:user_complaint`;
    for (const draft of drafts) {
      if (draft.errorType === 'user_complaint') draft.dedupeKey = dedupeKey;
    }
    this.ingest(drafts, input.now);
    const row = this.#db
      .stmt(`${SELECT_FEEDBACK} WHERE dedupe_key = ? AND project_id = ?`)
      .get(dedupeKey, input.projectId) as unknown as FeedbackRow | undefined;
    return row ? toFeedback(row) : null;
  }

  #feedbackFilter(options: {
    status?: OcrFeedbackStatus | 'all';
    errorType?: OcrFeedbackErrorType;
  }): { where: string; params: (string | number)[] } {
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (options.status && options.status !== 'all') {
      clauses.push('status = ?');
      params.push(options.status);
    }
    if (options.errorType) {
      clauses.push('error_type = ?');
      params.push(options.errorType);
    }
    return { where: clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '', params };
  }

  countFeedback(
    options: { status?: OcrFeedbackStatus | 'all'; errorType?: OcrFeedbackErrorType } = {},
  ): number {
    const { where, params } = this.#feedbackFilter(options);
    const row = this.#db
      .stmt(`SELECT COUNT(*) AS count FROM ocr_feedback_samples${where}`)
      .get(...params) as unknown as { count: number };
    return Number(row.count);
  }

  listFeedback(
    options: {
      status?: OcrFeedbackStatus | 'all';
      errorType?: OcrFeedbackErrorType;
      limit?: number;
    } = {},
  ): OcrFeedbackSample[] {
    const { where, params } = this.#feedbackFilter(options);
    const limit = Math.max(1, Math.min(1000, Math.floor(options.limit ?? 200)));
    const rows = this.#db
      .stmt(
        `${SELECT_FEEDBACK}${where}
          ORDER BY priority DESC, created_at ASC
          LIMIT ?`,
      )
      .all(...params, limit) as unknown as FeedbackRow[];
    return rows.map(toFeedback);
  }

  feedbackPool(): OcrFeedbackPool {
    // Aggregate over the full table so the dashboard totals never silently
    // reflect only the first page of samples.
    const total = Number(
      (
        this.#db.stmt('SELECT COUNT(*) AS count FROM ocr_feedback_samples').get() as unknown as {
          count: number;
        }
      ).count,
    );
    const byErrorType: OcrFeedbackPool['byErrorType'] = {
      low_confidence: 0,
      model_disagreement: 0,
      field_validation: 0,
      human_revision: 0,
      user_complaint: 0,
    };
    const typeRows = this.#db
      .stmt('SELECT error_type, COUNT(*) AS count FROM ocr_feedback_samples GROUP BY error_type')
      .all() as unknown as { error_type: OcrFeedbackErrorType; count: number }[];
    for (const row of typeRows) {
      if (row.error_type in byErrorType) byErrorType[row.error_type] = Number(row.count);
    }
    const byStatus: OcrFeedbackPool['byStatus'] = {
      pool: 0,
      sampled: 0,
      labeled: 0,
      dismissed: 0,
    };
    const statusRows = this.#db
      .stmt('SELECT status, COUNT(*) AS count FROM ocr_feedback_samples GROUP BY status')
      .all() as unknown as { status: OcrFeedbackStatus; count: number }[];
    for (const row of statusRows) {
      if (row.status in byStatus) byStatus[row.status] = Number(row.count);
    }
    const byCategory = (
      this.#db
        .stmt(
          `SELECT category, COUNT(*) AS count FROM ocr_feedback_samples
            GROUP BY category ORDER BY count DESC, category ASC`,
        )
        .all() as unknown as { category: string; count: number }[]
    ).map((row) => ({ category: row.category, count: Number(row.count) }));
    return {
      total,
      byErrorType,
      byStatus,
      byCategory,
      unlabeled: byStatus.pool + byStatus.sampled,
    };
  }

  /**
   * Cross-document knowledge graph. Built on read from completed OCR documents
   * so it always reflects the latest revisions without a second write path.
   */
  knowledgeGraph(options: { projectId?: string; limit?: number } = {}): OcrKnowledgeGraph {
    const limit = Math.max(1, Math.min(1000, Math.floor(options.limit ?? 200)));
    const params: string[] = [];
    let where = `a.ocr_status = 'done' AND a.ocr_text IS NOT NULL`;
    if (options.projectId) {
      where += ' AND a.project_id = ?';
      params.push(options.projectId);
    }
    // Entity values are matched verbatim across documents, so the graph reads the
    // engine text before display normalization (spacing never splits an ID).
    const rows = this.#db
      .stmt(
        `SELECT a.id, a.project_id, p.name AS project_name, a.name, a.created_at,
                substr(COALESCE(a.ocr_raw_text, a.ocr_text), 1, ?) AS ocr_text,
                CASE WHEN length(a.ocr_document_json) <= ?
                     THEN a.ocr_document_json ELSE NULL END AS ocr_document_json,
                length(a.ocr_document_json) AS doc_size
           FROM attachments a LEFT JOIN projects p ON p.id = a.project_id
          WHERE ${where}
          ORDER BY a.created_at DESC, a.rowid DESC
          LIMIT ?`,
      )
      .all(
        MAX_KNOWLEDGE_TEXT_CHARS,
        MAX_KNOWLEDGE_DOCUMENT_BYTES,
        ...params,
        limit,
      ) as unknown as KnowledgeRow[];
    const revisions = this.#revisions.listFor(rows.map((row) => row.id));
    let oversized = 0;
    const documents: OcrKnowledgeDocument[] = rows.map((row) => {
      const tooLarge =
        row.ocr_document_json === null && (row.doc_size ?? 0) > MAX_KNOWLEDGE_DOCUMENT_BYTES;
      if (tooLarge) oversized += 1;
      return {
        attachmentId: row.id,
        projectId: row.project_id,
        projectName: row.project_name,
        name: row.name,
        createdAt: row.created_at,
        text: row.ocr_text ?? '',
        document: tooLarge
          ? null
          : normalizeDocumentIr(parseJson<DocumentIr | null>(row.ocr_document_json, null)),
        revisions: revisions.get(row.id) ?? [],
      };
    });
    const graph = buildKnowledgeGraph(documents);
    if (oversized > 0) {
      graph.warnings.push(`${oversized} 份文档结构过大，仅使用了识别文本`);
    }
    return graph;
  }

  /**
   * Active-learning selection: highest uncertainty / disagreement / validation
   * failure first, stratified by error type and document category. An optional
   * cost budget keeps expensive strata from consuming the whole round.
   */
  selectFeedback(
    options: { perStratum?: number; total?: number; budget?: number | null } = {},
    now = new Date().toISOString(),
  ): OcrFeedbackSelection {
    const pool = this.listFeedback({ status: 'pool', limit: 1000 });
    const selection = selectFeedbackSamples(pool, options);
    const update = this.#db.stmt(
      `UPDATE ocr_feedback_samples SET status = 'sampled', sampled_at = ?
        WHERE id = ? AND status = 'pool'`,
    );
    this.#db.transaction(() => {
      for (const sample of selection.samples) update.run(now, sample.id);
    });
    return {
      ...selection,
      samples: selection.samples.map((sample) => ({
        ...sample,
        status: 'sampled' as const,
        sampledAt: now,
      })),
    };
  }

  markFeedback(
    id: string,
    status: Exclude<OcrFeedbackStatus, 'sampled'>,
    note: string | null,
    now: string,
  ): OcrFeedbackSample | null {
    this.#db
      .stmt(
        `UPDATE ocr_feedback_samples
            SET status = ?,
                note = COALESCE(?, note),
                labeled_at = CASE WHEN ? = 'labeled' THEN ? ELSE labeled_at END
          WHERE id = ?`,
      )
      .run(status, note, status, now, id);
    const row = this.#db.stmt(`${SELECT_FEEDBACK} WHERE id = ?`).get(id) as unknown as
      | FeedbackRow
      | undefined;
    return row ? toFeedback(row) : null;
  }

  /** Backfill automatic sample return for recent finished OCR attachments. */
  syncRecent(days: number, now: Date, limit = 1000): { scanned: number; inserted: number } {
    const since = new Date(now.getTime() - days * 86_400_000).toISOString();
    const rows = this.#db
      .stmt(
        `SELECT id, project_id, sha256, name, mime, ocr_text, ocr_confidence,
                ocr_quality_json, ocr_document_json
           FROM attachments
          WHERE ocr_status = 'done'
            AND COALESCE(ocr_updated_at, created_at) >= ?
          ORDER BY COALESCE(ocr_updated_at, created_at) DESC
          LIMIT ?`,
      )
      .all(since, limit) as unknown as FeedbackSourceRow[];
    let inserted = 0;
    for (const row of rows) {
      inserted += this.completeOcrFeedback({
        attachmentId: row.id,
        projectId: row.project_id,
        sha256: row.sha256,
        name: row.name,
        mime: row.mime,
        text: row.ocr_text ?? '',
        confidence: row.ocr_confidence === null ? null : Number(row.ocr_confidence),
        quality: parseJson<DocumentQuality | null>(row.ocr_quality_json, null),
        document: normalizeDocumentIr(parseJson<DocumentIr | null>(row.ocr_document_json, null)),
        now: now.toISOString(),
      });
    }
    return { scanned: rows.length, inserted };
  }

  distributionInputs(days: number, now: Date, limit = 2000): OcrDistributionInput[] {
    const since = new Date(now.getTime() - days * 86_400_000).toISOString();
    const rows = this.#db
      .stmt(
        `SELECT name, mime, ocr_text, ocr_pages, ocr_quality_json, ocr_document_json
           FROM attachments
          WHERE ocr_status = 'done'
            AND COALESCE(ocr_updated_at, created_at) >= ?
          ORDER BY COALESCE(ocr_updated_at, created_at) DESC
          LIMIT ?`,
      )
      .all(since, limit) as unknown as DistributionRow[];
    return rows.map((row) => {
      const document = normalizeDocumentIr(
        parseJson<DocumentIr | null>(row.ocr_document_json, null),
      );
      const pages = document?.pages ?? [];
      return {
        name: row.name,
        mime: row.mime,
        text: row.ocr_text ?? '',
        pageCount: Number(row.ocr_pages),
        pageSizes: pages.map((page) => ({ width: page.width, height: page.height })),
        blocksPerPage: pages.map((page) => page.blocks.length),
        hasTable: pages.some((page) => page.blocks.some((block) => block.type === 'table')),
        quality: parseJson<DocumentQuality | null>(row.ocr_quality_json, null),
      } satisfies OcrDistributionInput;
    });
  }

  getBaseline(): { distribution: OcrDistribution; sampleSize: number; createdAt: string } | null {
    const row = this.#db
      .stmt(
        'SELECT sample_size, distribution_json, created_at FROM ocr_drift_baseline WHERE id = 1',
      )
      .get() as unknown as BaselineRow | undefined;
    if (!row) return null;
    const distribution = parseJson<OcrDistribution | null>(row.distribution_json, null);
    if (!distribution) return null;
    return {
      distribution,
      sampleSize: Number(row.sample_size),
      createdAt: row.created_at,
    };
  }

  saveBaseline(distribution: OcrDistribution, createdAt: string, createdBy: string | null): void {
    this.#db
      .stmt(
        `INSERT INTO ocr_drift_baseline (id, sample_size, distribution_json, created_by, created_at)
         VALUES (1, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           sample_size = excluded.sample_size,
           distribution_json = excluded.distribution_json,
           created_by = excluded.created_by,
           created_at = excluded.created_at`,
      )
      .run(distribution.samples, JSON.stringify(distribution), createdBy, createdAt);
  }

  recordAlerts(alerts: readonly OcrDriftAlert[], detectedAt: string): number {
    if (alerts.length === 0) return 0;
    const day = detectedAt.slice(0, 10);
    const insert = this.#db.stmt(
      `INSERT OR IGNORE INTO ocr_drift_alerts
         (id, dedupe_key, dimension, severity, total_variation, threshold, message,
          buckets_json, status, detected_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)`,
    );
    let inserted = 0;
    for (const alert of alerts) {
      const result = insert.run(
        randomUUID(),
        `${alert.dimension}:${day}`,
        alert.dimension,
        alert.severity,
        alert.totalVariation,
        alert.threshold,
        alert.message,
        JSON.stringify(alert.buckets),
        detectedAt,
      );
      if (Number(result.changes) > 0) inserted += 1;
    }
    return inserted;
  }

  listAlerts(limit = 20): OcrDriftAlertRecord[] {
    const rows = this.#db
      .stmt(
        `SELECT a.id, a.dimension, a.severity, a.total_variation, a.threshold, a.message,
                a.buckets_json, a.status, a.detected_at, a.acknowledged_at,
                a.acknowledged_by, u.name AS acknowledged_by_name
           FROM ocr_drift_alerts a
           LEFT JOIN users u ON u.id = a.acknowledged_by
          ORDER BY a.detected_at DESC, a.rowid DESC
          LIMIT ?`,
      )
      .all(limit) as unknown as AlertRow[];
    return rows.map((row) => ({
      id: row.id,
      dimension: row.dimension,
      severity: row.severity,
      totalVariation: Number(row.total_variation),
      threshold: Number(row.threshold),
      message: row.message,
      buckets: parseJson(row.buckets_json, []),
      status: row.status,
      detectedAt: row.detected_at,
      acknowledgedAt: row.acknowledged_at,
      acknowledgedBy:
        row.acknowledged_by || row.acknowledged_by_name
          ? { id: row.acknowledged_by ?? '', name: row.acknowledged_by_name ?? '' }
          : null,
    }));
  }

  dashboardRows(days: number, now: Date, limit = 5000): OcrDashboardRow[] {
    const since = new Date(now.getTime() - days * 86_400_000).toISOString();
    const rows = this.#db
      .stmt(
        `SELECT a.id, a.name, a.mime, a.ocr_status, a.ocr_engine, a.ocr_model,
                a.ocr_pages, a.ocr_seconds, a.ocr_confidence, a.ocr_truncated,
                a.ocr_review_required, a.ocr_quality_json, a.ocr_stages_json,
                a.ocr_document_json, a.ocr_text, a.ocr_updated_at,
                p.workspace_id AS workspace_id, w.name AS workspace_name,
                COALESCE(length(a.ocr_text), 0) AS characters,
                (SELECT COUNT(*) FROM ocr_field_revisions r WHERE r.attachment_id = a.id) AS revisions
           FROM attachments a
           LEFT JOIN projects p ON p.id = a.project_id
           LEFT JOIN workspaces w ON w.id = p.workspace_id
          WHERE a.ocr_status IN ('pending', 'processing', 'done', 'failed')
            AND COALESCE(a.ocr_updated_at, a.created_at) >= ?
          ORDER BY COALESCE(a.ocr_updated_at, a.created_at) DESC
          LIMIT ?`,
      )
      .all(since, limit) as unknown as DashboardDbRow[];
    return rows.map((row) => {
      const document = normalizeDocumentIr(
        parseJson<DocumentIr | null>(row.ocr_document_json, null),
      );
      return {
        id: row.id,
        name: row.name,
        mime: row.mime,
        status: row.ocr_status,
        engine: row.ocr_engine,
        model: row.ocr_model,
        pages: Number(row.ocr_pages),
        seconds: row.ocr_seconds === null ? null : Number(row.ocr_seconds),
        characters: Number(row.characters),
        confidence: row.ocr_confidence === null ? null : Number(row.ocr_confidence),
        truncated: Number(row.ocr_truncated) === 1,
        reviewRequired: Number(row.ocr_review_required) === 1,
        revisions: Number(row.revisions),
        language: textLanguage(row.ocr_text ?? ''),
        workspaceId: row.workspace_id,
        workspaceName: row.workspace_name,
        quality: parseJson<DocumentQuality | null>(row.ocr_quality_json, null),
        hasTable: Boolean(
          document?.pages.some((page) => page.blocks.some((block) => block.type === 'table')),
        ),
        stages: parseJson<OcrStage[]>(row.ocr_stages_json, []),
        updatedAt: row.ocr_updated_at,
      } satisfies OcrDashboardRow;
    });
  }

  dashboard(
    days: number,
    now: Date,
    drift: Parameters<typeof buildProductionDashboard>[1]['drift'],
  ) {
    const rows = this.dashboardRows(days, now);
    return buildProductionDashboard(rows, {
      windowDays: days,
      generatedAt: now.toISOString(),
      feedback: this.feedbackPool(),
      drift,
    });
  }

  listOptimizations(): OcrOptimizationEntry[] {
    const rows = this.#db.stmt(SELECT_OPTIMIZATION).all() as unknown as OptimizationRow[];
    return rows
      .map(toOptimization)
      .sort(
        (left, right) => right.score - left.score || right.updatedAt.localeCompare(left.updatedAt),
      );
  }

  #findOptimization(id: string): OcrOptimizationEntry | null {
    const row = this.#db.stmt(`${SELECT_OPTIMIZATION} WHERE o.id = ?`).get(id) as unknown as
      | OptimizationRow
      | undefined;
    return row ? toOptimization(row) : null;
  }

  createOptimization(
    input: OcrOptimizationInput & { createdBy: UserOption | null; createdAt: string },
  ): OcrOptimizationEntry {
    const id = randomUUID();
    this.#db
      .stmt(
        `INSERT INTO ocr_optimizations
           (id, title, target_error, expected_gain, implementation_cost, inference_cost,
            risk, benchmark_result, production_result, status, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.title,
        input.targetError,
        input.expectedGain,
        input.implementationCost,
        input.inferenceCost,
        input.risk,
        input.benchmarkResult ?? '',
        input.productionResult ?? '',
        input.status ?? 'proposed',
        input.createdBy?.id ?? null,
        input.createdAt,
        input.createdAt,
      );
    const entry = this.#findOptimization(id);
    if (!entry) throw new Error('optimization creation failed');
    return entry;
  }

  updateOptimization(
    id: string,
    patch: OcrOptimizationPatch,
    updatedAt: string,
  ): OcrOptimizationEntry | null {
    const existing = this.#findOptimization(id);
    if (!existing) return null;
    const merged = {
      title: patch.title ?? existing.title,
      targetError: patch.targetError ?? existing.targetError,
      expectedGain: patch.expectedGain ?? existing.expectedGain,
      implementationCost: patch.implementationCost ?? existing.implementationCost,
      inferenceCost: patch.inferenceCost ?? existing.inferenceCost,
      risk: patch.risk ?? existing.risk,
      benchmarkResult: patch.benchmarkResult ?? existing.benchmarkResult,
      productionResult: patch.productionResult ?? existing.productionResult,
      status: patch.status ?? existing.status,
    };
    this.#db
      .stmt(
        `UPDATE ocr_optimizations
            SET title = ?, target_error = ?, expected_gain = ?, implementation_cost = ?,
                inference_cost = ?, risk = ?, benchmark_result = ?, production_result = ?,
                status = ?, updated_at = ?
          WHERE id = ?`,
      )
      .run(
        merged.title,
        merged.targetError,
        merged.expectedGain,
        merged.implementationCost,
        merged.inferenceCost,
        merged.risk,
        merged.benchmarkResult,
        merged.productionResult,
        merged.status,
        updatedAt,
        id,
      );
    return this.#findOptimization(id);
  }
}
