import type {
  DocumentBBox,
  DocumentBlock,
  DocumentFieldCandidate,
  DocumentFieldEvidence,
  DocumentFieldKind,
  DocumentIr,
  OcrFieldProvenance,
  OcrFieldRevision,
} from '../shared/types.ts';
import { isNumericField, numericCandidate } from './ocr-numeric.ts';
import { keyFieldKindOf } from './ocr-quality.ts';
import {
  cellBBox,
  isTypedCellColumn,
  type TableColumnKind,
  tableRows,
  tableSchemaOf,
} from './ocr-tables.ts';

const VALIDATION_RULES: Record<DocumentFieldKind, string> = {
  amount: '金额格式与币种一致性',
  date: '有效日期',
  identifier: '编号字符集',
  account: '8-32 位账号数字',
  quantity: '数值与单位',
  percentage: '0-100 百分比',
  number: '数值格式',
  text: '非空文本',
};

function cellKind(kind: TableColumnKind): DocumentFieldKind | null {
  switch (kind) {
    case 'amount':
    case 'date':
    case 'quantity':
    case 'percentage':
    case 'number':
    case 'identifier':
      return kind;
    default:
      return null;
  }
}

function fieldEvidenceOf(document: DocumentIr): DocumentFieldEvidence[] {
  const raw = document.meta.fieldEvidence;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (item): item is DocumentFieldEvidence =>
      typeof item === 'object' &&
      item !== null &&
      typeof (item as DocumentFieldEvidence).blockId === 'string' &&
      Array.isArray((item as DocumentFieldEvidence).candidates),
  );
}

function evidenceFor(
  evidence: DocumentFieldEvidence[],
  page: number,
  blockId: string,
  cell: { row: number; column: number } | null,
): OcrFieldProvenance['evidence'] {
  const match = evidence.find(
    (item) =>
      item.page === page &&
      item.blockId === blockId &&
      (cell ? item.cell?.row === cell.row && item.cell?.column === cell.column : !item.cell),
  );
  if (!match) return null;
  return {
    agreement: match.agreement,
    selected: match.selected,
    passes: match.passes,
    failed: match.failed,
    candidates: match.candidates as DocumentFieldCandidate[],
  };
}

function validationOf(
  kind: DocumentFieldKind,
  text: string,
  block: DocumentBlock,
): OcrFieldProvenance['validation'] {
  const rules = [VALIDATION_RULES[kind]];
  const issues: string[] = [];
  let numeric: { canonical: string | null; valid: boolean } | null = null;
  if (isNumericField(kind)) {
    const candidate = numericCandidate(text, kind);
    numeric = { canonical: candidate?.canonical ?? null, valid: candidate?.valid ?? false };
    if (!numeric.valid) issues.push(`无法按${VALIDATION_RULES[kind]}解析`);
  }
  let status: OcrFieldProvenance['validation']['status'] = issues.length > 0 ? 'flagged' : 'passed';
  if (block.validation) {
    issues.push(...block.validation.issues);
    if (block.validation.status === 'failed') status = 'failed';
    else if (block.validation.status === 'flagged' && status === 'passed') status = 'flagged';
  }
  return { status, rules, issues, numeric };
}

function blockField(
  page: number,
  block: DocumentBlock,
  kind: DocumentFieldKind,
  evidence: DocumentFieldEvidence[],
): OcrFieldProvenance {
  return {
    id: `p${page}:${block.id}`,
    kind,
    page,
    blockId: block.id,
    bbox: block.bbox,
    text: block.text,
    confidence: block.confidence,
    source: block.source,
    crop: { page, bbox: block.bbox },
    validation: validationOf(kind, block.text, block),
    evidence: evidenceFor(evidence, page, block.id, null),
    revisions: [],
  };
}

function tableFields(
  page: number,
  block: DocumentBlock,
  evidence: DocumentFieldEvidence[],
): OcrFieldProvenance[] {
  const schema = tableSchemaOf(block);
  if (!schema) return [];
  const rows = tableRows(block);
  const fields: OcrFieldProvenance[] = [];
  for (let row = schema.headerRows; row < rows.length; row += 1) {
    for (const column of schema.columns) {
      if (!isTypedCellColumn(column)) continue;
      const kind = cellKind(column.kind);
      if (!kind) continue;
      const text = (rows[row]?.[column.index] ?? '').trim();
      if (!text) continue;
      const box = cellBBox(block, rows, row, column.index);
      const bbox: DocumentBBox | null = box?.bbox ?? null;
      fields.push({
        id: `p${page}:${block.id}:r${row}:c${column.index}`,
        kind,
        page,
        blockId: block.id,
        bbox,
        text,
        confidence: block.confidence,
        source: block.source,
        crop: { page, bbox },
        cell: {
          row,
          column: column.index,
          header: column.label || `第 ${column.index + 1} 列`,
        },
        validation: validationOf(kind, text, block),
        evidence: evidenceFor(evidence, page, block.id, { row, column: column.index }),
        revisions: [],
      });
    }
  }
  return fields;
}

/**
 * Derives locatable business fields from the document IR. The IR text is kept
 * verbatim; constrained numeric interpretation lives beside it.
 */
export function deriveFieldProvenance(document: DocumentIr | null): OcrFieldProvenance[] {
  if (!document) return [];
  const evidence = fieldEvidenceOf(document);
  const fields: OcrFieldProvenance[] = [];
  for (const page of document.pages) {
    for (const block of page.blocks) {
      const kind = keyFieldKindOf(block);
      if (kind) fields.push(blockField(page.number, block, kind, evidence));
      if (block.type === 'table') fields.push(...tableFields(page.number, block, evidence));
    }
  }
  return fields;
}

/** Attaches stored human revisions without altering the original field text. */
export function attachRevisions(
  fields: OcrFieldProvenance[],
  revisions: OcrFieldRevision[],
): OcrFieldProvenance[] {
  if (revisions.length === 0) return fields;
  const byField = new Map<string, OcrFieldRevision[]>();
  for (const revision of revisions) {
    const list = byField.get(revision.fieldId) ?? [];
    list.push(revision);
    byField.set(revision.fieldId, list);
  }
  return fields.map((field) => ({ ...field, revisions: byField.get(field.id) ?? [] }));
}
