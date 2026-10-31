import type {
  DocumentIr,
  DocumentQuality,
  OcrFeedbackErrorType,
  OcrFeedbackPool,
  OcrFeedbackSample,
  OcrFeedbackSelection,
  OcrFeedbackSignals,
  OcrFieldRevision,
  OcrScriptProfile,
} from '../shared/types.ts';
import { profileScript } from './ocr-models.ts';
import { deriveFieldProvenance } from './ocr-provenance.ts';

const CONFIDENCE_HIGH = 0.92;
const CONFIDENCE_LOW = 0.5;
const LOW_CONFIDENCE_DRAFT = 0.5;
const DISAGREEMENT_DRAFT = 0.5;
const MAX_NOTE = 500;

export type OcrFeedbackSource = {
  attachment: {
    id: string;
    projectId: string;
    sha256: string | null;
    name: string;
    mime: string;
    ocrText: string;
    confidence: number | null;
  };
  quality: DocumentQuality | null;
  document: DocumentIr | null;
  revisions: OcrFieldRevision[];
  complaint?: string | null;
};

export type OcrFeedbackDraft = {
  attachmentId: string;
  projectId: string;
  sha256: string | null;
  errorType: OcrFeedbackErrorType;
  category: string;
  lang: string | null;
  page: number | null;
  blockId: string | null;
  fieldId: string | null;
  signals: OcrFeedbackSignals;
  note: string | null;
  /** Explicit per-row key for events that must not be deduplicated, such as complaints. */
  dedupeKey?: string;
};

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

/** Mime/extension category; extracted document text is never used here. */
export function documentCategory(name: string, mime: string): string {
  const extension = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '';
  if (mime === 'application/pdf' || extension === 'pdf') return 'pdf';
  if (mime.startsWith('image/')) return `image:${extension || mime.slice(6) || 'unknown'}`;
  return extension || mime || 'other';
}

const BUSINESS_CATEGORIES: { category: string; pattern: RegExp }[] = [
  { category: 'invoice', pattern: /发票|账单|税单|\b(?:invoice|bill)\b/i },
  { category: 'receipt', pattern: /收据|小票|\breceipt\b/i },
  { category: 'contract', pattern: /合同|协议|契约|\b(?:contract|agreement)\b/i },
  { category: 'report', pattern: /报告|报表|结算|对账|\b(?:report|statement)\b/i },
  { category: 'identity', pattern: /身份证|证件|执照|护照|\b(?:passport|license|licence)\b/i },
  { category: 'table', pattern: /表格|明细|清单|台账|\b(?:table|sheet|ledger)\b/i },
];

/**
 * Business type inferred from the file name only; document text is never read.
 * Filenames that match no known term fall back to the file format bucket.
 */
export function businessCategory(name: string, mime: string): string {
  const stem = name.replace(/\.[^.]+$/, '');
  for (const entry of BUSINESS_CATEGORIES) {
    if (entry.pattern.test(stem)) return entry.category;
  }
  const extension = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '';
  if (extension === 'xlsx' || extension === 'xls' || extension === 'csv') return 'table';
  if (mime === 'application/pdf' || extension === 'pdf') return 'pdf';
  if (mime.startsWith('image/')) return 'image';
  return 'other';
}

/** Dominant OCR language hint, or null when there is no measurable text. */
export function textLanguage(text: string): string | null {
  if (!text.trim()) return null;
  const profile: OcrScriptProfile = profileScript(text);
  return profile.letters + profile.digits > 0 ? profile.language : null;
}

function meanBlockConfidence(document: DocumentIr | null): number | null {
  if (!document) return null;
  let sum = 0;
  let count = 0;
  for (const page of document.pages) {
    for (const block of page.blocks) {
      const confidence = block.confidence;
      if (typeof confidence === 'number' && Number.isFinite(confidence)) {
        sum += confidence;
        count += 1;
      }
    }
  }
  return count > 0 ? sum / count : null;
}

function riskPresent(quality: DocumentQuality | null, code: string): boolean {
  return Boolean(quality?.hardRisks.some((risk) => risk.code === code));
}

function issuePresent(quality: DocumentQuality | null, code: string): boolean {
  return Boolean(quality?.issues.some((issue) => issue.code === code));
}

function signalNumber(quality: DocumentQuality | null, key: string): number | null {
  const value = quality?.signals[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Derive annotation signals without comparing against ground truth: model
 * confidence, cross-pass disagreement, key-field validation and revisions.
 */
export function feedbackSignals(
  source: Pick<OcrFeedbackSource, 'quality' | 'document' | 'revisions'> & {
    confidence: number | null;
  },
): OcrFeedbackSignals {
  const confidence = source.confidence ?? meanBlockConfidence(source.document);
  const uncertainty =
    confidence === null
      ? source.quality
        ? source.quality.status === 'pass'
          ? 0.35
          : 0.65
        : 0.5
      : clamp01((CONFIDENCE_HIGH - confidence) / (CONFIDENCE_HIGH - CONFIDENCE_LOW));

  const fields = deriveFieldProvenance(source.document).filter((field) => field.kind !== 'text');
  let conflicts = 0;
  let unverified = 0;
  let divergent = 0;
  let failed = 0;
  let flagged = 0;
  for (const field of fields) {
    if (field.evidence?.agreement === 'conflict') conflicts += 1;
    else if (field.evidence?.agreement === 'unverified') unverified += 1;
    const candidates = field.evidence?.candidates ?? [];
    const models = new Set(candidates.map((candidate) => candidate.model ?? 'unknown'));
    const texts = new Set(candidates.map((candidate) => candidate.text.trim()));
    if (models.size > 1 && texts.size > 1) divergent += 1;
    if (field.validation.status === 'failed') failed += 1;
    else if (field.validation.status === 'flagged') flagged += 1;
  }

  let disagreement =
    fields.length > 0
      ? clamp01((conflicts + 0.5 * unverified + 0.5 * divergent) / fields.length)
      : 0;
  if (riskPresent(source.quality, 'field_validation_failed')) {
    disagreement = Math.max(disagreement, 0.5);
  }

  const imageSignal = signalNumber(source.quality, 'fieldAccuracy');
  let fieldFailure = fields.length > 0 ? clamp01((failed + 0.5 * flagged) / fields.length) : 0;
  if (imageSignal !== null) fieldFailure = Math.max(fieldFailure, clamp01(1 - imageSignal));
  if (riskPresent(source.quality, 'field_validation_failed')) {
    fieldFailure = Math.max(fieldFailure, 0.6);
  }

  return {
    confidence,
    uncertainty: Math.round(uncertainty * 1000) / 1000,
    disagreement: Math.round(disagreement * 1000) / 1000,
    fieldFailure: Math.round(fieldFailure * 1000) / 1000,
    novelty: 0.5,
    revision: source.revisions.length > 0 ? 1 : 0,
  };
}

/**
 * Weighted priority used by active learning. Novelty is filled in by the
 * store from the pool's category counts, so new document types rank higher
 * without ever completely outranking hard validation failures.
 */
export function feedbackPriority(signals: OcrFeedbackSignals): number {
  const value =
    0.3 * signals.uncertainty +
    0.3 * signals.disagreement +
    0.25 * signals.fieldFailure +
    0.1 * signals.novelty +
    0.05 * signals.revision;
  return Math.round(clamp01(value) * 1000) / 1000;
}

function weakestBlock(document: DocumentIr | null): { page: number; blockId: string } | null {
  let weakest: { page: number; blockId: string; confidence: number } | null = null;
  if (!document) return null;
  for (const page of document.pages) {
    for (const block of page.blocks) {
      if (typeof block.confidence !== 'number' || !Number.isFinite(block.confidence)) continue;
      if (!weakest || block.confidence < weakest.confidence) {
        weakest = { page: page.number, blockId: block.id, confidence: block.confidence };
      }
    }
  }
  return weakest ? { page: weakest.page, blockId: weakest.blockId } : null;
}

/**
 * Turn one OCR result into deduplicated feedback drafts. Each error type is
 * emitted at most once per document; the store dedupes again by SHA-256.
 */
export function feedbackDrafts(source: OcrFeedbackSource): OcrFeedbackDraft[] {
  const signals = feedbackSignals({
    quality: source.quality,
    document: source.document,
    revisions: source.revisions,
    confidence: source.attachment.confidence,
  });
  const fields = deriveFieldProvenance(source.document).filter((field) => field.kind !== 'text');
  const conflict = fields.find((field) => field.evidence?.agreement === 'conflict');
  const invalid = fields.find((field) => field.validation.status !== 'passed');
  const weakest = weakestBlock(source.document);
  const category = documentCategory(source.attachment.name, source.attachment.mime);
  const lang = textLanguage(source.attachment.ocrText);
  const base = {
    attachmentId: source.attachment.id,
    projectId: source.attachment.projectId,
    sha256: source.attachment.sha256,
    category,
    lang,
    signals,
  };
  const drafts: OcrFeedbackDraft[] = [];

  if (
    signals.uncertainty >= LOW_CONFIDENCE_DRAFT ||
    issuePresent(source.quality, 'low_confidence') ||
    issuePresent(source.quality, 'key_field_low_confidence')
  ) {
    drafts.push({
      ...base,
      errorType: 'low_confidence',
      page: weakest?.page ?? null,
      blockId: weakest?.blockId ?? null,
      fieldId: null,
      note:
        signals.confidence === null
          ? '文本置信度缺失'
          : `置信度 ${signals.confidence.toFixed(2)} 低于标注门槛`,
    });
  }

  if (signals.disagreement >= DISAGREEMENT_DRAFT || conflict) {
    drafts.push({
      ...base,
      errorType: 'model_disagreement',
      page: conflict?.page ?? null,
      blockId: conflict?.blockId ?? null,
      fieldId: conflict?.id ?? null,
      note: conflict
        ? `${conflict.kind} 字段在不同重识别结果间存在分歧`
        : '多个恢复候选的文本或模型不一致',
    });
  }

  if (
    signals.fieldFailure > 0 ||
    invalid ||
    riskPresent(source.quality, 'field_validation_failed')
  ) {
    const issues = invalid?.validation.issues ?? [];
    drafts.push({
      ...base,
      errorType: 'field_validation',
      page: invalid?.page ?? null,
      blockId: invalid?.blockId ?? null,
      fieldId: invalid?.id ?? null,
      note:
        issues.length > 0
          ? issues[0]!.slice(0, MAX_NOTE)
          : `${fields.filter((field) => field.validation.status !== 'passed').length} 个关键字段未通过校验`,
    });
  }

  if (source.revisions.length > 0) {
    const first = source.revisions[0]!;
    drafts.push({
      ...base,
      errorType: 'human_revision',
      page: first.page,
      blockId: first.blockId,
      fieldId: first.fieldId,
      note: `${source.revisions.length} 处人工修订；最近原因：${first.reason}`.slice(0, MAX_NOTE),
    });
  }

  const complaint = source.complaint?.trim();
  if (complaint) {
    drafts.push({
      ...base,
      errorType: 'user_complaint',
      page: null,
      blockId: null,
      fieldId: null,
      note: complaint.slice(0, MAX_NOTE),
    });
  }

  return drafts;
}

const ANNOTATION_COST: Record<OcrFeedbackErrorType, number> = {
  low_confidence: 1,
  field_validation: 1.2,
  human_revision: 1.1,
  model_disagreement: 1.4,
  user_complaint: 1.5,
};

/**
 * Relative annotation cost. Comparing model disagreement or a complaint takes
 * longer than confirming a low-confidence line; locating a page/field adds a
 * small surcharge. Costs are abstract units, not minutes.
 */
export function annotationCost(
  sample: Pick<OcrFeedbackSample, 'errorType' | 'fieldId' | 'page'>,
): number {
  const base = ANNOTATION_COST[sample.errorType] ?? 1;
  const focus = (sample.fieldId ? 0.2 : 0) + (sample.page !== null ? 0.1 : 0);
  return Math.round((base + focus) * 100) / 100;
}

/** Priority per unit of annotation cost; used to maximize value under a budget. */
export function annotationDensity(sample: OcrFeedbackSample): number {
  return Math.round((sample.priority / Math.max(0.1, annotationCost(sample))) * 1000) / 1000;
}

function comparePriority(left: OcrFeedbackSample, right: OcrFeedbackSample): number {
  if (right.priority !== left.priority) return right.priority - left.priority;
  return left.createdAt.localeCompare(right.createdAt);
}

function compareDensity(left: OcrFeedbackSample, right: OcrFeedbackSample): number {
  const difference = annotationDensity(right) - annotationDensity(left);
  if (difference !== 0) return difference;
  return comparePriority(left, right);
}

/**
 * Stratified active-learning selection. Each (error type, category) stratum
 * contributes its highest-priority samples round-robin, so one dominant error
 * type cannot consume the whole labeling budget.
 */
export function selectFeedbackSamples(
  samples: readonly OcrFeedbackSample[],
  options: { perStratum?: number; total?: number; budget?: number | null } = {},
): OcrFeedbackSelection {
  const perStratum = Math.max(1, Math.min(50, Math.floor(options.perStratum ?? 3)));
  const total = Math.max(1, Math.min(500, Math.floor(options.total ?? 50)));
  const budget =
    options.budget === undefined || options.budget === null
      ? null
      : Math.max(1, Math.min(10_000, options.budget));
  const pool = samples
    .filter((sample) => sample.status === 'pool')
    .slice()
    .sort(comparePriority);

  const groups = new Map<
    string,
    { errorType: OcrFeedbackErrorType; category: string; items: OcrFeedbackSample[] }
  >();
  for (const sample of pool) {
    const key = `${sample.errorType}\u0000${sample.category}`;
    const group = groups.get(key);
    if (group) group.items.push(sample);
    else {
      groups.set(key, {
        errorType: sample.errorType,
        category: sample.category,
        items: [sample],
      });
    }
  }
  const ordered = [...groups.values()].sort((left, right) =>
    comparePriority(left.items[0]!, right.items[0]!),
  );
  // Within a stratum, take the highest priority-per-cost sample first so a
  // limited budget never goes to expensive, low-value reviews.
  for (const group of ordered) group.items.sort(compareDensity);

  const selected: OcrFeedbackSample[] = [];
  let used = 0;
  outer: for (let round = 0; round < perStratum; round += 1) {
    let candidates = 0;
    for (const group of ordered) {
      const item = group.items[round];
      if (!item) continue;
      candidates += 1;
      const cost = annotationCost(item);
      if (budget !== null && used + cost > budget) continue;
      selected.push(item);
      used += cost;
      if (selected.length >= total) break outer;
    }
    if (candidates === 0) break;
  }

  const chosen = new Set(selected.map((sample) => sample.id));
  const poolCategories = new Set(pool.map((sample) => sample.category));
  const poolErrorTypes = new Set(pool.map((sample) => sample.errorType));
  return {
    samples: selected.sort(comparePriority),
    strata: ordered.map((group) => ({
      errorType: group.errorType,
      category: group.category,
      available: group.items.length,
      selected: group.items.filter((item) => chosen.has(item.id)).length,
    })),
    budget: {
      limit: budget,
      used: Math.round(used * 100) / 100,
      remaining: budget === null ? null : Math.max(0, Math.round((budget - used) * 100) / 100),
    },
    coverage: {
      categories: new Set(selected.map((sample) => sample.category)).size,
      errorTypes: new Set(selected.map((sample) => sample.errorType)).size,
      poolCategories: poolCategories.size,
      poolErrorTypes: poolErrorTypes.size,
    },
    skipped: pool.length - selected.length,
  };
}

export function feedbackPoolSummary(samples: readonly OcrFeedbackSample[]): OcrFeedbackPool {
  const byErrorType: Record<OcrFeedbackErrorType, number> = {
    low_confidence: 0,
    model_disagreement: 0,
    field_validation: 0,
    human_revision: 0,
    user_complaint: 0,
  };
  const byStatus = { pool: 0, sampled: 0, labeled: 0, dismissed: 0 };
  const categories = new Map<string, number>();
  for (const sample of samples) {
    byErrorType[sample.errorType] += 1;
    byStatus[sample.status] += 1;
    categories.set(sample.category, (categories.get(sample.category) ?? 0) + 1);
  }
  return {
    total: samples.length,
    byErrorType,
    byStatus,
    byCategory: [...categories.entries()]
      .map(([category, count]) => ({ category, count }))
      .sort(
        (left, right) => right.count - left.count || left.category.localeCompare(right.category),
      ),
    unlabeled: byStatus.pool + byStatus.sampled,
  };
}
