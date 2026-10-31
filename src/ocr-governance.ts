import type {
  DocumentFieldEvidence,
  DocumentQuality,
  OcrDashboardBucket,
  OcrEngine,
  OcrFeedbackPool,
  OcrFieldRevision,
  OcrProductionDashboard,
  OcrStage,
  OcrStageStats,
  OcrStatus,
  OcrVersionChain,
  OcrVersionNode,
} from '../shared/types.ts';
import { businessCategory, clamp01, documentCategory } from './ocr-feedback.ts';

export type OcrDashboardRow = {
  id: string;
  name: string;
  mime: string;
  status: OcrStatus;
  engine: OcrEngine | null;
  model: string | null;
  pages: number;
  seconds: number | null;
  characters: number;
  confidence: number | null;
  truncated: boolean;
  reviewRequired: boolean;
  revisions: number;
  language: string | null;
  /** Customer/organization dimension resolved from attachment → project → workspace. */
  workspaceId?: string | null;
  workspaceName?: string | null;
  quality: DocumentQuality | null;
  hasTable: boolean;
  stages: OcrStage[];
  updatedAt: string | null;
};

type BucketAccumulator = {
  documents: number;
  done: number;
  failed: number;
  review: number;
  truncated: number;
  revisions: number;
  revisionDocs: number;
  confidenceSum: number;
  confidenceCount: number;
  secondsSum: number;
  secondsCount: number;
  pages: number;
  characters: number;
};

function emptyAccumulator(): BucketAccumulator {
  return {
    documents: 0,
    done: 0,
    failed: 0,
    review: 0,
    truncated: 0,
    revisions: 0,
    revisionDocs: 0,
    confidenceSum: 0,
    confidenceCount: 0,
    secondsSum: 0,
    secondsCount: 0,
    pages: 0,
    characters: 0,
  };
}

function addRow(accumulator: BucketAccumulator, row: OcrDashboardRow): void {
  accumulator.documents += 1;
  if (row.status === 'done') accumulator.done += 1;
  if (row.status === 'failed') accumulator.failed += 1;
  if (row.reviewRequired && row.status === 'done') accumulator.review += 1;
  if (row.truncated && row.status === 'done') accumulator.truncated += 1;
  accumulator.revisions += row.revisions;
  if (row.revisions > 0) accumulator.revisionDocs += 1;
  if (typeof row.confidence === 'number' && Number.isFinite(row.confidence)) {
    accumulator.confidenceSum += clamp01(row.confidence);
    accumulator.confidenceCount += 1;
  }
  if (typeof row.seconds === 'number' && Number.isFinite(row.seconds)) {
    accumulator.secondsSum += row.seconds;
    accumulator.secondsCount += 1;
  }
  accumulator.pages += row.pages;
  accumulator.characters += row.characters;
}

function finalizeBucket(key: string, accumulator: BucketAccumulator): OcrDashboardBucket {
  const finished = accumulator.done + accumulator.failed;
  return {
    key,
    documents: accumulator.documents,
    done: accumulator.done,
    failed: accumulator.failed,
    failureRate: finished > 0 ? accumulator.failed / finished : 0,
    reviewRate: accumulator.done > 0 ? accumulator.review / accumulator.done : 0,
    truncationRate: accumulator.done > 0 ? accumulator.truncated / accumulator.done : 0,
    revisionObservedRate: accumulator.done > 0 ? accumulator.revisionDocs / accumulator.done : null,
    confidenceRiskProxy:
      accumulator.confidenceCount > 0
        ? clamp01(1 - accumulator.confidenceSum / accumulator.confidenceCount)
        : null,
    seconds:
      accumulator.secondsCount > 0 ? accumulator.secondsSum / accumulator.secondsCount : null,
    secondsPerPage: accumulator.pages > 0 ? accumulator.secondsSum / accumulator.pages : null,
    pages: accumulator.pages,
    characters: accumulator.characters,
  };
}

function bucketize(
  rows: readonly OcrDashboardRow[],
  keyOf: (row: OcrDashboardRow) => string,
): OcrDashboardBucket[] {
  const buckets = new Map<string, BucketAccumulator>();
  for (const row of rows) {
    const key = keyOf(row);
    let accumulator = buckets.get(key);
    if (!accumulator) {
      accumulator = emptyAccumulator();
      buckets.set(key, accumulator);
    }
    addRow(accumulator, row);
  }
  return [...buckets.entries()]
    .map(([key, accumulator]) => finalizeBucket(key, accumulator))
    .sort((left, right) => right.documents - left.documents || left.key.localeCompare(right.key));
}

function pageBucket(pages: number): string {
  if (pages <= 1) return '1';
  if (pages <= 3) return '2-3';
  if (pages <= 10) return '4-10';
  if (pages <= 20) return '11-20';
  return '21+';
}

function p95(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = values.slice().sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95));
  return sorted[index] ?? null;
}

function stageStats(rows: readonly OcrDashboardRow[]): OcrStageStats[] {
  const stats = new Map<string, OcrStageStats>();
  for (const row of rows) {
    for (const stage of row.stages) {
      let entry = stats.get(stage.kind);
      if (!entry) {
        entry = { stage: stage.kind, runs: 0, failed: 0, skipped: 0, seconds: 0 };
        stats.set(stage.kind, entry);
      }
      entry.runs += 1;
      if (stage.status === 'failed') entry.failed += 1;
      if (stage.status === 'skipped') entry.skipped += 1;
      if (Number.isFinite(stage.seconds)) entry.seconds += stage.seconds;
    }
  }
  return [...stats.values()].sort((left, right) => right.runs - left.runs);
}

/**
 * Aggregate production monitoring from stored OCR metadata. No document text
 * is included; CER and field error are explicitly labelled proxies because
 * production traffic has no ground truth.
 */
export function buildProductionDashboard(
  rows: readonly OcrDashboardRow[],
  input: {
    windowDays: number;
    generatedAt: string;
    feedback: OcrFeedbackPool;
    drift: OcrProductionDashboard['drift'];
  },
): OcrProductionDashboard {
  const overall = emptyAccumulator();
  for (const row of rows) addRow(overall, row);
  const finished = overall.done + overall.failed;
  const seconds = rows
    .filter((row) => row.status === 'done')
    .map((row) => row.seconds)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  const secondsSum = seconds.reduce((sum, value) => sum + value, 0);

  return {
    windowDays: input.windowDays,
    generatedAt: input.generatedAt,
    documents: overall.documents,
    done: overall.done,
    failed: overall.failed,
    pending: rows.filter((row) => row.status === 'pending').length,
    processing: rows.filter((row) => row.status === 'processing').length,
    failureRate: finished > 0 ? overall.failed / finished : 0,
    reviewRate: overall.done > 0 ? overall.review / overall.done : 0,
    truncationRate: overall.done > 0 ? overall.truncated / overall.done : 0,
    revisionObservedRate: overall.done > 0 ? overall.revisionDocs / overall.done : null,
    confidenceRiskProxy:
      overall.confidenceCount > 0
        ? clamp01(1 - overall.confidenceSum / overall.confidenceCount)
        : null,
    revisions: overall.revisions,
    latency: {
      averageSeconds: seconds.length > 0 ? secondsSum / seconds.length : null,
      p95Seconds: p95(seconds),
    },
    throughput: {
      pages: overall.pages,
      characters: overall.characters,
      charactersPerSecond: secondsSum > 0 ? overall.characters / secondsSum : null,
    },
    byModel: bucketize(rows, (row) => `${row.engine ?? 'unknown'}:${row.model ?? 'unknown'}`),
    byLanguage: bucketize(rows, (row) => row.language ?? 'unknown'),
    byFileType: bucketize(rows, (row) => documentCategory(row.name, row.mime)),
    byBusinessType: bucketize(rows, (row) => businessCategory(row.name, row.mime)),
    byWorkspace: bucketize(rows, (row) => row.workspaceName ?? row.workspaceId ?? '未归属'),
    byPageBucket: bucketize(rows, (row) => pageBucket(row.pages)),
    byStage: stageStats(rows),
    feedback: input.feedback,
    drift: input.drift,
  };
}

export type OcrVersionSource = {
  id: string;
  projectId: string;
  status: OcrStatus;
  text: string;
  engine: OcrEngine | null;
  model: string | null;
  engineModel: string | null;
  confidence: number | null;
  truncated: boolean;
  route: string | null;
  mode: string;
  dpi: number;
  updatedAt: string | null;
  quality: DocumentQuality | null;
  stages: OcrStage[];
  document: { meta: Record<string, unknown> } | null;
};

function fieldEvidence(meta: Record<string, unknown> | undefined): DocumentFieldEvidence[] {
  const raw = meta?.fieldEvidence;
  return Array.isArray(raw) ? (raw as DocumentFieldEvidence[]) : [];
}

function evidenceId(evidence: DocumentFieldEvidence): string {
  const cell = evidence.cell ? `:r${evidence.cell.row}:c${evidence.cell.column}` : '';
  return `p${evidence.page}:${evidence.blockId}${cell}`;
}

/**
 * Assemble the immutable lineage: original OCR → cascade stages → candidate
 * selections → human revisions. Every node keeps its parents so any final
 * value can be traced back to the source image, model and operator.
 */
export function buildVersionChain(
  source: OcrVersionSource,
  revisions: readonly OcrFieldRevision[],
): OcrVersionChain {
  const originalId = 'original';
  const nodes: OcrVersionNode[] = [
    {
      id: originalId,
      kind: 'original',
      label: `原始 OCR · ${source.engine ?? 'unknown'}${source.model ? ` / ${source.model}` : ''}`,
      at: source.updatedAt,
      engine: source.engine,
      model: source.engineModel ?? source.model,
      modelSha256: null,
      sha256: null,
      score: source.quality?.score ?? null,
      text: null,
      parents: [],
      detail: {
        characters: source.text.length,
        confidence: source.confidence,
        route: source.route,
        mode: source.mode,
        dpi: source.dpi,
        truncated: source.truncated,
        qualityStatus: source.quality?.status ?? null,
      },
    },
  ];

  let lastStageId = originalId;
  source.stages.forEach((stage, index) => {
    const id = `stage:${index + 1}:${stage.kind}`;
    nodes.push({
      id,
      kind: 'stage',
      label: `${stage.kind} · ${stage.status}${stage.model ? ` · ${stage.model}` : ''}`,
      at: null,
      engine: stage.engine,
      model: stage.model,
      modelSha256: null,
      sha256: stage.outputSha256 ?? stage.inputSha256 ?? null,
      score: stage.score,
      text: null,
      parents: [lastStageId],
      detail: {
        durationSeconds: stage.seconds,
        dpi: stage.dpi,
        trigger: stage.trigger ?? null,
        decision: stage.decision ?? null,
        params: stage.params ?? null,
        quality: stage.quality ?? null,
        inputSha256: stage.inputSha256 ?? null,
        outputSha256: stage.outputSha256 ?? null,
        message: stage.message,
      },
    });
    lastStageId = id;
  });

  const selectionIds = new Map<string, string>();
  for (const evidence of fieldEvidence(source.document?.meta)) {
    if (!evidence.selected) continue;
    const fieldId = evidenceId(evidence);
    const id = `selection:${fieldId}`;
    selectionIds.set(fieldId, id);
    const selectedCandidate =
      evidence.selected === 'candidate'
        ? [...evidence.candidates].sort(
            (left, right) => (right.confidence ?? 0) - (left.confidence ?? 0),
          )[0]
        : null;
    const evidenceEngine =
      evidence.source.engine === 'paddle' || evidence.source.engine === 'docling'
        ? evidence.source.engine
        : null;
    nodes.push({
      id,
      kind: 'selection',
      label: `字段选择 · ${evidence.kind} · ${evidence.selected === 'initial' ? '保留原始' : '采用候选'}`,
      at: null,
      engine: evidenceEngine,
      model: evidence.source.model,
      modelSha256: null,
      sha256: null,
      score: selectedCandidate?.confidence ?? evidence.confidence,
      text: selectedCandidate?.text ?? evidence.text,
      parents: [lastStageId],
      detail: {
        fieldId,
        fieldKind: evidence.kind,
        page: evidence.page,
        blockId: evidence.blockId,
        bbox: evidence.bbox,
        agreement: evidence.agreement,
        selectionReason: evidence.reason ?? null,
        originalText: evidence.text,
        candidateCount: evidence.candidates.length,
        candidateModels: [...new Set(evidence.candidates.map((item) => item.model ?? 'unknown'))],
        passes: evidence.passes,
        failed: evidence.failed,
      },
    });
  }

  const orderedRevisions = revisions
    .slice()
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  for (const revision of orderedRevisions) {
    const parent = selectionIds.get(revision.fieldId) ?? lastStageId;
    nodes.push({
      id: `revision:${revision.id}`,
      kind: 'revision',
      label: `人工修订 · ${revision.fieldKind}`,
      at: revision.createdAt,
      engine: null,
      model: null,
      modelSha256: null,
      sha256: null,
      score: null,
      text: revision.revisedText,
      parents: [parent],
      detail: {
        fieldId: revision.fieldId,
        fieldKind: revision.fieldKind,
        page: revision.page,
        blockId: revision.blockId,
        bbox: revision.bbox,
        originalText: revision.originalText,
        reason: revision.reason,
        revisedBy: revision.revisedBy,
      },
    });
  }

  return {
    attachmentId: source.id,
    projectId: source.projectId,
    status: source.status,
    nodes,
    revisions: orderedRevisions,
  };
}

/** Key-field accuracy gain per unit of added cost; higher ranks first. */
export function optimizationScore(entry: {
  expectedGain: number;
  implementationCost: number;
  inferenceCost: number;
}): number {
  const cost = Math.max(0.1, entry.implementationCost + entry.inferenceCost);
  return Math.round((Math.max(0, entry.expectedGain) / cost) * 1000) / 1000;
}
