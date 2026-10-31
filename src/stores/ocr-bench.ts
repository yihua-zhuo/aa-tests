import type {
  DocumentQuality,
  OcrBenchBusinessLoss,
  OcrBenchDifficulty,
  OcrBenchFieldOutcome,
  OcrBenchFileResult,
  OcrBenchProvenance,
  OcrBenchRun,
  OcrBenchRunSummary,
  OcrBenchTableMetrics,
  OcrConfusionReport,
  OcrEngine,
  OcrErrorBreakdown,
  OcrErrorDiagnosis,
  OcrModelRuntime,
  OcrRoute,
  OcrRouteDecision,
  OcrStage,
} from '../../shared/types.ts';
import { isOcrBenchSplit } from '../../shared/types.ts';
import type { Database } from '../db.ts';

type RunRow = {
  id: string;
  status: 'running' | 'done' | 'failed';
  started_at: string;
  finished_at: string | null;
  include_pdf: number;
  total: number;
  completed: number;
  current: string | null;
  error: string | null;
};

type FileRow = {
  name: string;
  engine: OcrEngine;
  kind: string;
  lang: string | null;
  difficulty: OcrBenchDifficulty | null;
  degradations_json: string | null;
  split: string | null;
  status: 'done' | 'failed';
  model: string | null;
  seconds: number;
  characters: number;
  confidence: number | null;
  pages: number;
  truncated: number;
  cer: number | null;
  raw_cer: number | null;
  keyword_hit: number | null;
  keyword_total: number | null;
  route: OcrRoute | null;
  quality_score: number | null;
  quality_status: DocumentQuality['status'] | null;
  review_required: number;
  stages_json: string | null;
  numeric_cer: number | null;
  symbol_cer: number | null;
  wer: number | null;
  field_hit: number | null;
  field_total: number | null;
  field_strong_hit: number | null;
  field_strong_total: number | null;
  field_strong_unverifiable: number | null;
  field_exact_hit: number | null;
  field_exact_total: number | null;
  fully_correct: number | null;
  errors_json: string | null;
  provenance_json: string | null;
  uncertain_json: string | null;
  sha256: string | null;
  hash_verified: number | null;
  business_json: string | null;
  table_json: string | null;
  field_outcomes_json: string | null;
  confusions_json: string | null;
  diagnosis_json: string | null;
  routing_json: string | null;
  model_sha256: string | null;
  runtime_json: string | null;
  error: string | null;
};

function parseJson<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function parseStages(value: string | null): OcrStage[] {
  return parseJson<OcrStage[]>(value, []);
}

function parseErrors(value: string | null): OcrErrorBreakdown | null {
  const parsed = parseJson<OcrErrorBreakdown | null>(value, null);
  if (!parsed) return null;
  return { ...parsed, top: Array.isArray(parsed.top) ? parsed.top : [] };
}

type HistoryRow = {
  id: string;
  status: 'running' | 'done' | 'failed';
  started_at: string;
  finished_at: string | null;
  include_pdf: number;
  total: number;
  completed: number;
  failed: number;
  error: string | null;
};

function toResult(row: FileRow): OcrBenchFileResult {
  return {
    name: row.name,
    engine: row.engine,
    kind: row.kind,
    lang: row.lang,
    difficulty: row.difficulty,
    degradations: parseJson<string[]>(row.degradations_json, []),
    split: isOcrBenchSplit(row.split) ? row.split : null,
    status: row.status,
    model: row.model,
    route: row.route,
    qualityScore: row.quality_score === null ? null : Number(row.quality_score),
    qualityStatus: row.quality_status,
    reviewRequired: Number(row.review_required) === 1,
    stages: parseStages(row.stages_json),
    seconds: Number(row.seconds),
    characters: Number(row.characters),
    confidence: row.confidence === null ? null : Number(row.confidence),
    pages: Number(row.pages),
    truncated: Number(row.truncated) === 1,
    cer: row.cer === null ? null : Number(row.cer),
    rawCer: row.raw_cer === null ? null : Number(row.raw_cer),
    numericCer: row.numeric_cer === null ? null : Number(row.numeric_cer),
    symbolCer: row.symbol_cer === null ? null : Number(row.symbol_cer),
    wer: row.wer === null ? null : Number(row.wer),
    keywordRecall:
      row.keyword_hit === null || row.keyword_total === null
        ? null
        : { hit: Number(row.keyword_hit), total: Number(row.keyword_total) },
    fieldAccuracy:
      row.field_hit === null || row.field_total === null
        ? null
        : {
            hit: Number(row.field_hit),
            total: Number(row.field_total),
            rate: Number(row.field_total) > 0 ? Number(row.field_hit) / Number(row.field_total) : 0,
          },
    fieldStrong:
      row.field_strong_hit === null || row.field_strong_total === null
        ? null
        : {
            hit: Number(row.field_strong_hit),
            total: Number(row.field_strong_total),
            rate:
              Number(row.field_strong_total) > 0
                ? Number(row.field_strong_hit) / Number(row.field_strong_total)
                : 0,
            // Runs stored before the tally existed simply do not know; 0 would
            // claim every field could be localized.
            unverifiable:
              row.field_strong_unverifiable === null ? null : Number(row.field_strong_unverifiable),
          },
    fieldExact:
      row.field_exact_hit === null || row.field_exact_total === null
        ? null
        : {
            hit: Number(row.field_exact_hit),
            total: Number(row.field_exact_total),
            rate:
              Number(row.field_exact_total) > 0
                ? Number(row.field_exact_hit) / Number(row.field_exact_total)
                : 0,
          },
    fullyCorrect: row.fully_correct === null ? null : Number(row.fully_correct) === 1,
    errors: parseErrors(row.errors_json),
    provenance: parseJson<OcrBenchProvenance | null>(row.provenance_json, null),
    uncertain: parseJson<string[]>(row.uncertain_json, []),
    sha256: row.sha256,
    hashVerified: row.hash_verified === null ? null : Number(row.hash_verified) === 1,
    businessLoss: parseJson<OcrBenchBusinessLoss | null>(row.business_json, null),
    tableMetrics: parseJson<OcrBenchTableMetrics | null>(row.table_json, null),
    fieldOutcomes: parseJson<OcrBenchFieldOutcome[]>(row.field_outcomes_json, []),
    confusions: parseJson<OcrConfusionReport | null>(row.confusions_json, null),
    diagnosis: parseJson<OcrErrorDiagnosis | null>(row.diagnosis_json, null),
    routing: parseJson<OcrRouteDecision | null>(row.routing_json, null),
    modelSha256: row.model_sha256,
    runtime: parseJson<OcrModelRuntime | null>(row.runtime_json, null),
    error: row.error,
  };
}

function toRun(row: RunRow, results: OcrBenchFileResult[]): OcrBenchRun {
  return {
    id: row.id,
    status: row.status,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    includePdf: Number(row.include_pdf) === 1,
    total: Number(row.total),
    completed: Number(row.completed),
    current: row.current,
    results,
    error: row.error,
  };
}

export class OcrBenchStore {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  start(input: { id: string; startedAt: string; includePdf: boolean; total: number }): void {
    this.#db
      .stmt(
        `INSERT INTO ocr_bench_runs
           (id, status, started_at, include_pdf, total, completed, current, error)
         VALUES (?, 'running', ?, ?, ?, 0, NULL, NULL)`,
      )
      .run(input.id, input.startedAt, input.includePdf ? 1 : 0, input.total);
  }

  progress(id: string, current: string | null, completed: number): void {
    this.#db
      .stmt('UPDATE ocr_bench_runs SET current = ?, completed = ? WHERE id = ?')
      .run(current, completed, id);
  }

  addResult(runId: string, result: OcrBenchFileResult): void {
    this.#db.transaction(() => {
      const row = this.#db
        .stmt('SELECT COALESCE(MAX(ordinal), 0) + 1 AS next FROM ocr_bench_files WHERE run_id = ?')
        .get(runId) as unknown as { next: number };
      this.#db
        .stmt(
          `INSERT INTO ocr_bench_files
             (run_id, ordinal, name, engine, kind, lang, difficulty, degradations_json, split,
              status, model, seconds, characters,
              confidence, pages, truncated, cer, raw_cer, keyword_hit, keyword_total, error,
              route, quality_score, quality_status, review_required, stages_json,
              numeric_cer, symbol_cer, wer, field_hit, field_total, field_strong_hit, field_strong_total,
              field_strong_unverifiable, field_exact_hit, field_exact_total,
              fully_correct, errors_json, provenance_json, uncertain_json, sha256,
              hash_verified, business_json, table_json, field_outcomes_json,
              confusions_json, diagnosis_json, routing_json, model_sha256, runtime_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          runId,
          Number(row.next),
          result.name,
          result.engine,
          result.kind,
          result.lang,
          result.difficulty,
          result.degradations.length > 0 ? JSON.stringify(result.degradations) : null,
          result.split ?? null,
          result.status,
          result.model,
          result.seconds,
          result.characters,
          result.confidence,
          result.pages,
          result.truncated ? 1 : 0,
          result.cer,
          result.rawCer,
          result.keywordRecall?.hit ?? null,
          result.keywordRecall?.total ?? null,
          result.error,
          result.route,
          result.qualityScore,
          result.qualityStatus,
          result.reviewRequired ? 1 : 0,
          result.stages.length > 0 ? JSON.stringify(result.stages) : null,
          result.numericCer,
          result.symbolCer,
          result.wer,
          result.fieldAccuracy?.hit ?? null,
          result.fieldAccuracy?.total ?? null,
          result.fieldStrong?.hit ?? null,
          result.fieldStrong?.total ?? null,
          result.fieldStrong?.unverifiable ?? null,
          result.fieldExact?.hit ?? null,
          result.fieldExact?.total ?? null,
          result.fullyCorrect === null ? null : result.fullyCorrect ? 1 : 0,
          result.errors ? JSON.stringify(result.errors) : null,
          result.provenance ? JSON.stringify(result.provenance) : null,
          result.uncertain.length > 0 ? JSON.stringify(result.uncertain) : null,
          result.sha256,
          result.hashVerified === null ? null : result.hashVerified ? 1 : 0,
          result.businessLoss ? JSON.stringify(result.businessLoss) : null,
          result.tableMetrics ? JSON.stringify(result.tableMetrics) : null,
          result.fieldOutcomes.length > 0 ? JSON.stringify(result.fieldOutcomes) : null,
          result.confusions ? JSON.stringify(result.confusions) : null,
          result.diagnosis ? JSON.stringify(result.diagnosis) : null,
          result.routing ? JSON.stringify(result.routing) : null,
          result.modelSha256,
          result.runtime ? JSON.stringify(result.runtime) : null,
        );
      this.#db.stmt('UPDATE ocr_bench_runs SET completed = completed + 1 WHERE id = ?').run(runId);
    });
  }

  finish(id: string, status: 'done' | 'failed', finishedAt: string, error: string | null): void {
    this.#db
      .stmt(
        `UPDATE ocr_bench_runs
            SET status = ?, finished_at = ?, current = NULL, error = ?
          WHERE id = ?`,
      )
      .run(status, finishedAt, error, id);
  }

  interruptRunning(message: string, finishedAt: string): number {
    const result = this.#db
      .stmt(
        `UPDATE ocr_bench_runs
            SET status = 'failed', finished_at = ?, current = NULL, error = ?
          WHERE status = 'running'`,
      )
      .run(finishedAt, message);
    return Number(result.changes);
  }

  latest(): OcrBenchRun | null {
    const run = this.#db
      .stmt('SELECT * FROM ocr_bench_runs ORDER BY started_at DESC, rowid DESC LIMIT 1')
      .get() as unknown as RunRow | undefined;
    if (!run) return null;
    const files = this.#db
      .stmt('SELECT * FROM ocr_bench_files WHERE run_id = ? ORDER BY ordinal')
      .all(run.id) as unknown as FileRow[];
    return toRun(run, files.map(toResult));
  }

  history(limit = 10): OcrBenchRunSummary[] {
    const rows = this.#db
      .stmt(
        `SELECT r.id, r.status, r.started_at, r.finished_at, r.include_pdf, r.total,
                r.completed, r.error,
                COALESCE(SUM(CASE WHEN f.status = 'failed' THEN 1 ELSE 0 END), 0) AS failed
           FROM ocr_bench_runs r
           LEFT JOIN ocr_bench_files f ON f.run_id = r.id
          GROUP BY r.id
          ORDER BY r.started_at DESC, r.rowid DESC
          LIMIT ?`,
      )
      .all(limit) as unknown as HistoryRow[];
    return rows.map((row) => ({
      id: row.id,
      status: row.status,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      includePdf: Number(row.include_pdf) === 1,
      total: Number(row.total),
      completed: Number(row.completed),
      failed: Number(row.failed),
      error: row.error,
    }));
  }
}
