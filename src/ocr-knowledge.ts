import type {
  DocumentFieldKind,
  DocumentIr,
  OcrFieldRevision,
  OcrKnowledgeEntity,
  OcrKnowledgeEntityType,
  OcrKnowledgeGraph,
  OcrKnowledgeMetric,
  OcrKnowledgeOccurrence,
  OcrKnowledgeRelation,
} from '../shared/types.ts';
import { isNumericField, numericCandidate } from './ocr-numeric.ts';
import { attachRevisions, deriveFieldProvenance } from './ocr-provenance.ts';

const MAX_OCCURRENCES = 12;
const MAX_ENTITIES = 200;
const MAX_RELATIONS = 400;
const MIN_IDENTIFIER_LENGTH = 3;
const MIN_MENTION_LENGTH = 5;

const ENTITY_TYPES: Partial<Record<DocumentFieldKind, OcrKnowledgeEntityType>> = {
  identifier: 'identifier',
  account: 'account',
  amount: 'amount',
  date: 'date',
};

export type OcrKnowledgeDocument = {
  attachmentId: string;
  projectId: string;
  projectName: string | null;
  name: string;
  createdAt: string;
  text: string;
  document: DocumentIr | null;
  revisions: OcrFieldRevision[];
};

export type OcrKnowledgeOptions = {
  generatedAt?: string;
  maxEntities?: number;
};

type EntityDraft = {
  id: string;
  type: OcrKnowledgeEntityType;
  canonical: string;
  display: string;
  occurrences: OcrKnowledgeOccurrence[];
  attachmentIds: Set<string>;
  revised: boolean;
  confidenceSum: number;
  confidenceCount: number;
};

function currencyOf(text: string): string | null {
  if (/[¥￥]|CNY|RMB/iu.test(text)) return 'CNY';
  if (/\$|USD/iu.test(text)) return 'USD';
  if (/€|EUR/iu.test(text)) return 'EUR';
  if (/£|GBP/iu.test(text)) return 'GBP';
  return null;
}

/** Accept single-digit month/day forms such as `2026年9月1日`. */
function canonicalDateLike(value: string): string | null {
  const match = value.match(/(19|20)\d{2}\D{1,2}(\d{1,2})\D{1,2}(\d{1,2})/u);
  if (!match) return null;
  const year = Number(match[0].slice(0, 4));
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

const LABEL_PREFIX =
  /^(?:发票号|合同号|订单号|编号|单号|税号|证件号|invoice|order|serial|ref|no\.?|account|acct|#)\s*[:：#]?\s*/iu;

/** Strip known label prefixes so identifiers link across different labels. */
function identifierValue(value: string): string {
  let text = value.trim();
  for (let round = 0; round < 3; round += 1) {
    const next = text.replace(LABEL_PREFIX, '').trim();
    if (next === text || next === '') break;
    text = next;
  }
  return text || value.trim();
}

/**
 * Normalize a field value for cross-document linking. The returned key only
 * exists for business identifiers, accounts, amounts and dates; the raw text
 * is never rewritten.
 */
export function knowledgeKey(
  value: string,
  kind: DocumentFieldKind,
): { id: string; type: OcrKnowledgeEntityType; canonical: string } | null {
  const type = ENTITY_TYPES[kind];
  if (!type || !isNumericField(kind)) return null;
  if (type === 'date') {
    const candidate = numericCandidate(value.trim(), kind);
    const canonical = candidate.valid ? candidate.canonical : canonicalDateLike(value);
    if (canonical === null) return null;
    return { id: `date:${canonical}`, type, canonical };
  }
  if (type === 'identifier') {
    const token = identifierValue(value);
    if (!token) return null;
    const candidate = numericCandidate(token, 'identifier');
    if (!candidate.valid || candidate.canonical === null) return null;
    const canonical = candidate.canonical.toUpperCase();
    if (canonical.length < MIN_IDENTIFIER_LENGTH || !/\d/u.test(canonical)) return null;
    return { id: `identifier:${canonical}`, type, canonical };
  }
  if (type === 'account') {
    const candidate = numericCandidate(value, 'account');
    if (!candidate.valid || candidate.canonical === null) return null;
    return { id: `account:${candidate.canonical}`, type, canonical: candidate.canonical };
  }
  const candidate = numericCandidate(value.trim(), 'amount');
  if (!candidate.valid || candidate.canonical === null) return null;
  const currency = currencyOf(value);
  return {
    id: `amount:${currency ?? '?'}:${candidate.canonical}`,
    type,
    canonical: `${currency ?? ''}${candidate.canonical}`,
  };
}

function normalizeText(text: string): string {
  return text.toUpperCase().replace(/\s+/gu, '');
}

function meanConfidence(draft: EntityDraft): number | null {
  if (draft.confidenceCount === 0) return null;
  return Math.round((draft.confidenceSum / draft.confidenceCount) * 1000) / 1000;
}

function toEntity(draft: EntityDraft): OcrKnowledgeEntity {
  return {
    id: draft.id,
    type: draft.type,
    canonical: draft.canonical,
    display: draft.display,
    occurrences: draft.occurrences,
    documents: draft.attachmentIds.size,
    confidence: meanConfidence(draft),
    revised: draft.revised,
  };
}

function endOfMonth(createdAt: string): string | null {
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 7);
}

function monthMetrics(occurrences: readonly OcrKnowledgeOccurrence[]): OcrKnowledgeMetric[] {
  const groups = new Map<
    string,
    { currency: string; month: string; total: number; samples: number }
  >();
  for (const occurrence of occurrences) {
    const month = endOfMonth(occurrence.createdAt);
    if (!month) continue;
    const candidate = numericCandidate(occurrence.value.trim(), 'amount');
    if (!candidate.valid || candidate.canonical === null) continue;
    const amount = Number(candidate.canonical);
    if (!Number.isFinite(amount)) continue;
    const currency = currencyOf(occurrence.value) ?? '?';
    const key = `${currency}:${month}`;
    const group = groups.get(key) ?? { currency, month, total: 0, samples: 0 };
    group.total += amount;
    group.samples += 1;
    groups.set(key, group);
  }
  return [...groups.values()]
    .sort(
      (left, right) =>
        left.month.localeCompare(right.month) || left.currency.localeCompare(right.currency),
    )
    .map((group) => ({
      key: `amount:${group.currency}:${group.month}`,
      label: `${group.currency === '?' ? '未标明币种' : group.currency} · ${group.month} 金额合计`,
      value: Math.round(group.total * 100) / 100,
      unit: 'amount' as const,
      samples: group.samples,
    }));
}

/**
 * Build a read-only knowledge graph across completed OCR documents.
 *
 * Entities come only from normalized key fields (identifier/account/amount/
 * date), using the latest human revision when present. Relations are either
 * `shared` (the same entity appears in several attachments) or `mentions` (an
 * identifier appears verbatim in another attachment's recognized text).
 * Metrics aggregate entity counts and amount totals per month.
 */
export function buildKnowledgeGraph(
  documents: readonly OcrKnowledgeDocument[],
  options: OcrKnowledgeOptions = {},
): OcrKnowledgeGraph {
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const maxEntities = Math.max(1, Math.min(2000, Math.floor(options.maxEntities ?? MAX_ENTITIES)));
  const warnings: string[] = [];
  const drafts = new Map<string, EntityDraft>();
  const normalizedText = new Map<string, string>();
  let skipped = 0;
  let entityTotal = 0;

  for (const document of documents) {
    normalizedText.set(document.attachmentId, normalizeText(document.text));
    if (!document.document) continue;
    const fields = attachRevisions(deriveFieldProvenance(document.document), document.revisions);
    const latest = new Map<string, OcrFieldRevision>();
    for (const revision of document.revisions) latest.set(revision.fieldId, revision);
    for (const field of fields) {
      if (!ENTITY_TYPES[field.kind]) continue;
      const revision = latest.get(field.id);
      const value = (revision?.revisedText ?? field.text).trim();
      const key = knowledgeKey(value, field.kind);
      if (!key) {
        skipped += 1;
        continue;
      }
      let draft = drafts.get(key.id);
      if (!draft) {
        draft = {
          id: key.id,
          type: key.type,
          canonical: key.canonical,
          display: value,
          occurrences: [],
          attachmentIds: new Set(),
          revised: false,
          confidenceSum: 0,
          confidenceCount: 0,
        };
        drafts.set(key.id, draft);
        entityTotal += 1;
      }
      if (revision) draft.revised = true;
      if (typeof field.confidence === 'number' && Number.isFinite(field.confidence)) {
        draft.confidenceSum += field.confidence;
        draft.confidenceCount += 1;
      }
      if (draft.attachmentIds.has(document.attachmentId)) continue;
      draft.attachmentIds.add(document.attachmentId);
      if (draft.occurrences.length >= MAX_OCCURRENCES) continue;
      draft.occurrences.push({
        attachmentId: document.attachmentId,
        projectId: document.projectId,
        projectName: document.projectName,
        name: document.name,
        page: field.page,
        fieldId: field.id,
        fieldKind: field.kind,
        value,
        confidence: field.confidence,
        revised: Boolean(revision),
        createdAt: document.createdAt,
      });
    }
  }

  const all = [...drafts.values()].sort(
    (left, right) =>
      right.attachmentIds.size - left.attachmentIds.size ||
      right.occurrences.length - left.occurrences.length ||
      left.canonical.localeCompare(right.canonical),
  );
  if (all.length > maxEntities) {
    warnings.push(`实体数量 ${all.length} 超过上限，仅返回前 ${maxEntities} 个`);
  }
  const entities = all.slice(0, maxEntities).map(toEntity);

  const relations: OcrKnowledgeRelation[] = [];
  const seenRelations = new Set<string>();
  const addRelation = (relation: OcrKnowledgeRelation): void => {
    if (relations.length >= MAX_RELATIONS) return;
    const key = `${relation.entityId}\u0000${relation.kind}\u0000${relation.from}\u0000${relation.to}`;
    if (seenRelations.has(key)) return;
    seenRelations.add(key);
    relations.push(relation);
  };

  for (const draft of all.slice(0, maxEntities)) {
    const attachments = [...draft.attachmentIds].sort();
    if (attachments.length > 1) {
      const [source] = attachments;
      for (const target of attachments.slice(1)) {
        addRelation({
          entityId: draft.id,
          entityType: draft.type,
          kind: 'shared',
          from: source!,
          to: target,
        });
      }
    }
    if (draft.type !== 'identifier' && draft.type !== 'account') continue;
    const needle = draft.canonical.toUpperCase().replace(/\s+/gu, '');
    if (needle.length < MIN_MENTION_LENGTH) continue;
    const source = attachments[0] ?? draft.occurrences[0]?.attachmentId;
    if (!source) continue;
    for (const [attachmentId, text] of normalizedText) {
      if (draft.attachmentIds.has(attachmentId)) continue;
      if (!text.includes(needle)) continue;
      addRelation({
        entityId: draft.id,
        entityType: draft.type,
        kind: 'mentions',
        from: source,
        to: attachmentId,
      });
    }
  }
  if (relations.length >= MAX_RELATIONS)
    warnings.push(`引用关系超过上限，最多返回 ${MAX_RELATIONS} 条`);

  const byType: Record<OcrKnowledgeEntityType, number> = {
    identifier: 0,
    account: 0,
    amount: 0,
    date: 0,
  };
  for (const draft of all) byType[draft.type] += 1;

  const amountOccurrences = all
    .filter((draft) => draft.type === 'amount')
    .flatMap((draft) => draft.occurrences);
  const metrics: OcrKnowledgeMetric[] = [
    {
      key: 'documents',
      label: '已分析文档',
      value: documents.length,
      unit: 'count',
      samples: documents.length,
    },
    {
      key: 'entities',
      label: '实体总数',
      value: entityTotal,
      unit: 'count',
      samples: entityTotal,
    },
    {
      key: 'entities:cross_document',
      label: '跨文档实体',
      value: all.filter((draft) => draft.attachmentIds.size > 1).length,
      unit: 'count',
      samples: entityTotal,
    },
    ...monthMetrics(amountOccurrences),
  ];

  if (documents.length === 0) warnings.push('没有已完成 OCR 的文档可供构建知识图谱');
  if (skipped > 0) warnings.push(`${skipped} 个字段无法归一化，已跳过`);

  return {
    generatedAt,
    documents: documents.length,
    entities,
    relations,
    metrics,
    byType,
    warnings,
  };
}
