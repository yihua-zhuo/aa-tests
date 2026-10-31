import type {
  DocumentBBox,
  DocumentBlock,
  DocumentIr,
  DocumentPage,
  DocumentTableChain,
} from '../shared/types.ts';
import { annotateBorderlessTables } from './ocr-borderless.ts';

/** Top/bottom fraction of the page treated as running header/footer zones. */
const HEADER_ZONE = 0.12;
const FOOTER_ZONE = 0.12;
/** A block this wide acts as a band separator in multi-column layouts. */
const WIDE_BLOCK_RATIO = 0.65;
/** Horizontal gap that separates two columns, as a fraction of page width. */
const COLUMN_GAP_RATIO = 0.04;
const COLUMN_GAP_MIN = 16;
/** Same-position duplicates need both geometric and textual agreement. */
const OVERLAP_IOU = 0.6;
const OVERLAP_TEXT_SIMILARITY = 0.85;
/** A continuation table must start at the bottom of one page and the top of the next. */
const CONTINUATION_BOTTOM = 0.7;
const CONTINUATION_TOP = 0.3;
const CONTINUATION_HEADER_SIMILARITY = 0.75;
const MAX_OVERLAP_BLOCKS = 400;
const MAX_PAIR_CHECKS = 20_000;

export type DocumentRefinement = {
  version: 1;
  /** Blocks marked as repeated running headers/footers. */
  headers: number;
  footers: number;
  /** Duplicate blocks excluded from reading order but kept in the IR. */
  overlaps: number;
  /** Cross-page table links created. */
  continuations: number;
  /** Borderless table candidates inferred from text alignment. */
  borderless: number;
  /** `graph` when any page used bbox-aware ordering, `source` otherwise. */
  readingOrder: 'graph' | 'source';
};

type SizedPage = {
  width: number;
  height: number;
};

function positive(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function pageSize(page: DocumentPage): SizedPage | null {
  let width = positive(page.width);
  let height = positive(page.height);
  if (!width || !height) {
    let right = 0;
    let bottom = 0;
    for (const block of page.blocks) {
      if (!block.bbox) continue;
      right = Math.max(right, block.bbox.x + block.bbox.width);
      bottom = Math.max(bottom, block.bbox.y + block.bbox.height);
    }
    width = width ?? (right > 0 ? right : null);
    height = height ?? (bottom > 0 ? bottom : null);
  }
  return width && height ? { width, height } : null;
}

function bottomOf(bbox: DocumentBBox): number {
  return bbox.y + bbox.height;
}

function centerY(bbox: DocumentBBox): number {
  return bbox.y + bbox.height / 2;
}

/**
 * Running headers repeat except for page numbers, so digits are collapsed.
 * The comparison is only used to tag zones, never to delete text.
 */
function templateKey(text: string): string {
  return text.toLowerCase().replace(/\s+/g, '').replace(/\d+/g, '#');
}

function markTemplates(document: DocumentIr): { headers: number; footers: number } {
  type Entry = { block: DocumentBlock; page: number; zone: 'header' | 'footer' };
  const groups = new Map<string, Entry[]>();

  for (const page of document.pages) {
    const size = pageSize(page);
    if (!size) continue;
    for (const block of page.blocks) {
      if (!block.bbox || !block.text.trim() || block.type === 'table') continue;
      const top = block.bbox.y;
      const bottom = bottomOf(block.bbox);
      let zone: Entry['zone'] | null = null;
      if (bottom <= size.height * HEADER_ZONE) zone = 'header';
      else if (top >= size.height * (1 - FOOTER_ZONE)) zone = 'footer';
      if (!zone) continue;
      const key = `${zone}|${templateKey(block.text)}`;
      const entries = groups.get(key) ?? [];
      entries.push({ block, page: page.number, zone });
      groups.set(key, entries);
    }
  }

  const pageCount = document.pages.length;
  const minPages = pageCount >= 4 ? Math.max(2, Math.ceil(pageCount * 0.5)) : 2;
  let headers = 0;
  let footers = 0;
  for (const entries of groups.values()) {
    const pages = new Set(entries.map((entry) => entry.page));
    if (pages.size < minPages) continue;
    for (const entry of entries) {
      if (entry.block.type !== 'header' && entry.block.type !== 'footer') {
        entry.block.type = entry.zone;
      }
      entry.block.meta = {
        ...entry.block.meta,
        template: entry.zone,
        templatePages: pages.size,
      };
      if (entry.zone === 'header') headers += 1;
      else footers += 1;
    }
  }
  return { headers, footers };
}

function bboxIoU(left: DocumentBBox, right: DocumentBBox): number {
  const x1 = Math.max(left.x, right.x);
  const y1 = Math.max(left.y, right.y);
  const x2 = Math.min(left.x + left.width, right.x + right.width);
  const y2 = Math.min(left.y + left.height, right.y + right.height);
  if (x2 <= x1 || y2 <= y1) return 0;
  const intersection = (x2 - x1) * (y2 - y1);
  const union = left.width * left.height + right.width * right.height - intersection;
  return union > 0 ? intersection / union : 0;
}

function bigrams(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (let index = 0; index < text.length - 1; index += 1) {
    const gram = text.slice(index, index + 2);
    counts.set(gram, (counts.get(gram) ?? 0) + 1);
  }
  return counts;
}

/** Dice coefficient over normalized character bigrams; cheap and forgiving. */
function textSimilarity(left: string, right: string): number {
  const a = left.toLowerCase().replace(/\s+/g, '');
  const b = right.toLowerCase().replace(/\s+/g, '');
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const first = bigrams(a);
  const second = bigrams(b);
  let intersection = 0;
  for (const [gram, count] of first) {
    const other = second.get(gram);
    if (other) intersection += Math.min(count, other);
  }
  return (2 * intersection) / (a.length + b.length - 2);
}

function sourceRank(block: DocumentBlock): number {
  switch (block.source.stage) {
    case 'native':
      return 4;
    case 'visual':
      return 3;
    case 'vlm':
      return 2;
    default:
      return 1;
  }
}

function keepsOverDuplicate(left: DocumentBlock, right: DocumentBlock): DocumentBlock {
  const rank = (block: DocumentBlock): number =>
    sourceRank(block) * 10 + (block.type === 'table' ? 5 : 0);
  if (rank(left) !== rank(right)) return rank(left) > rank(right) ? left : right;
  const leftConfidence = left.confidence ?? 0;
  const rightConfidence = right.confidence ?? 0;
  if (leftConfidence !== rightConfidence) {
    return leftConfidence > rightConfidence ? left : right;
  }
  if (left.text.length !== right.text.length) {
    return left.text.length > right.text.length ? left : right;
  }
  return left;
}

function isOverlapDuplicate(block: DocumentBlock): boolean {
  return typeof block.meta?.overlapOf === 'string';
}

/**
 * Whole-page OCR, line OCR and table OCR can emit the same region. Both
 * blocks stay in the IR; the lower-priority one is linked to the keeper and
 * excluded from the reading order.
 */
function markOverlaps(document: DocumentIr): number {
  let marked = 0;
  for (const page of document.pages) {
    const candidates = page.blocks
      .filter((block) => block.bbox && block.text.trim() && !isOverlapDuplicate(block))
      .slice(0, MAX_OVERLAP_BLOCKS);
    let checks = 0;
    outer: for (let left = 0; left < candidates.length; left += 1) {
      for (let right = left + 1; right < candidates.length; right += 1) {
        checks += 1;
        if (checks > MAX_PAIR_CHECKS) break outer;
        const first = candidates[left] as DocumentBlock;
        const second = candidates[right] as DocumentBlock;
        const a = first.bbox as DocumentBBox;
        const b = second.bbox as DocumentBBox;
        if (bottomOf(a) <= b.y || bottomOf(b) <= a.y) continue;
        const iou = bboxIoU(a, b);
        if (iou < OVERLAP_IOU) continue;
        const similarity = textSimilarity(first.text, second.text);
        if (similarity < OVERLAP_TEXT_SIMILARITY) continue;
        const keeper = keepsOverDuplicate(first, second);
        const duplicate = keeper === first ? second : first;
        if (isOverlapDuplicate(duplicate)) continue;
        duplicate.meta = {
          ...duplicate.meta,
          overlapOf: keeper.id,
          overlap: {
            iou: Math.round(iou * 1000) / 1000,
            similarity: Math.round(similarity * 1000) / 1000,
          },
        };
        marked += 1;
      }
    }
  }
  return marked;
}

function tableColumns(block: DocumentBlock): number {
  let columns = 0;
  for (const row of block.rows ?? []) columns = Math.max(columns, row.length);
  for (const cell of block.cells ?? []) {
    columns = Math.max(columns, cell.column + (cell.columnSpan ?? 1));
  }
  return columns;
}

/** Relative column widths from cell bboxes; null when geometry is missing. */
function columnWidthProfile(block: DocumentBlock): number[] | null {
  const spans = new Map<number, { left: number; right: number }>();
  for (const cell of block.cells ?? []) {
    if (!cell.bbox) continue;
    const column = Math.floor(cell.column);
    const current = spans.get(column);
    const left = cell.bbox.x;
    const right = cell.bbox.x + cell.bbox.width;
    spans.set(column, {
      left: current ? Math.min(current.left, left) : left,
      right: current ? Math.max(current.right, right) : right,
    });
  }
  if (spans.size < 2) return null;
  const widths = [...spans.keys()]
    .sort((left, right) => left - right)
    .map((column) => {
      const span = spans.get(column) as { left: number; right: number };
      return Math.max(0, span.right - span.left);
    });
  const total = widths.reduce((sum, width) => sum + width, 0);
  return total > 0 ? widths.map((width) => width / total) : null;
}

function widthProfileSimilarity(left: number[], right: number[]): number | null {
  if (left.length !== right.length || left.length === 0) return null;
  const difference =
    left.reduce((sum, value, index) => sum + Math.abs(value - (right[index] ?? 0)), 0) /
    left.length;
  return Math.max(0, 1 - difference);
}

function normalizedRow(row: readonly string[] | undefined): string | null {
  if (!row) return null;
  const value = row.join('|').toLowerCase().replace(/\s+/g, '');
  return value ? value : null;
}

function headerSimilarity(left: DocumentBlock, right: DocumentBlock): number | null {
  const a = normalizedRow(left.rows?.[0]);
  const b = normalizedRow(right.rows?.[0]);
  if (!a || !b) return null;
  return textSimilarity(a, b);
}

/**
 * Links a table at the bottom of one page to a table at the top of the next
 * when their column counts and headers agree. Rows are never merged; only the
 * relationship and repeated-header evidence are recorded.
 */
function linkContinuations(document: DocumentIr): number {
  const pages = [...document.pages].sort((left, right) => left.number - right.number);
  let linked = 0;
  for (let index = 0; index < pages.length - 1; index += 1) {
    const previous = pages[index] as DocumentPage;
    const next = pages[index + 1] as DocumentPage;
    const previousSize = pageSize(previous);
    const nextSize = pageSize(next);
    if (!previousSize || !nextSize) continue;
    const previousTable = previous.blocks
      .filter(
        (block) =>
          block.type === 'table' &&
          block.bbox &&
          bottomOf(block.bbox) >= previousSize.height * CONTINUATION_BOTTOM,
      )
      .sort(
        (left, right) => bottomOf(right.bbox as DocumentBBox) - bottomOf(left.bbox as DocumentBBox),
      )[0];
    const nextTable = next.blocks
      .filter(
        (block) =>
          block.type === 'table' &&
          block.bbox &&
          block.bbox.y <= nextSize.height * CONTINUATION_TOP,
      )
      .sort((left, right) => (left.bbox as DocumentBBox).y - (right.bbox as DocumentBBox).y)[0];
    if (!previousTable || !nextTable) continue;
    if (previousTable.meta?.continuedTo || nextTable.meta?.continuedFrom) continue;
    const previousColumns = tableColumns(previousTable);
    const nextColumns = tableColumns(nextTable);
    if (previousColumns === 0 || nextColumns === 0) continue;
    if (previousColumns !== nextColumns) continue;
    const similarity = headerSimilarity(previousTable, nextTable);
    if (similarity !== null && similarity < CONTINUATION_HEADER_SIMILARITY) continue;
    const previousWidths = columnWidthProfile(previousTable);
    const nextWidths = columnWidthProfile(nextTable);
    const widthSimilarity =
      previousWidths && nextWidths ? widthProfileSimilarity(previousWidths, nextWidths) : null;
    if (widthSimilarity !== null && widthSimilarity < 0.6) continue;
    const evidence = {
      headerSimilarity: similarity === null ? null : Math.round(similarity * 1000) / 1000,
      widthSimilarity: widthSimilarity === null ? null : Math.round(widthSimilarity * 1000) / 1000,
      position: 'bottom-to-top',
    };
    previousTable.meta = {
      ...previousTable.meta,
      continuedTo: { page: next.number, blockId: nextTable.id },
      continuationEvidence: evidence,
    };
    nextTable.meta = {
      ...nextTable.meta,
      continuedFrom: { page: previous.number, blockId: previousTable.id },
      continuationEvidence: evidence,
    };
    if (similarity !== null) nextTable.meta.repeatedHeader = true;
    linked += 1;
  }
  return linked;
}

type OrderedBlock = {
  block: DocumentBlock;
  reason: 'header' | 'footer' | 'spanning' | 'column' | 'flow' | 'source';
};

function orderColumns(blocks: DocumentBlock[], pageWidth: number): DocumentBlock[] {
  if (blocks.length <= 1) return [...blocks];
  const sorted = [...blocks].sort((left, right) => {
    const a = left.bbox as DocumentBBox;
    const b = right.bbox as DocumentBBox;
    return a.x - b.x || a.y - b.y;
  });
  const gap = Math.max(COLUMN_GAP_MIN, pageWidth * COLUMN_GAP_RATIO);
  const columns: DocumentBlock[][] = [];
  let current: DocumentBlock[] = [];
  let rightEdge = Number.NEGATIVE_INFINITY;
  for (const block of sorted) {
    const bbox = block.bbox as DocumentBBox;
    if (current.length > 0 && bbox.x - rightEdge > gap) {
      columns.push(current);
      current = [];
      rightEdge = Number.NEGATIVE_INFINITY;
    }
    current.push(block);
    rightEdge = Math.max(rightEdge, bbox.x + bbox.width);
  }
  if (current.length > 0) columns.push(current);
  if (columns.length <= 1) {
    return sorted.sort((left, right) => {
      const a = left.bbox as DocumentBBox;
      const b = right.bbox as DocumentBBox;
      return a.y - b.y || a.x - b.x;
    });
  }
  const ordered: DocumentBlock[] = [];
  columns.forEach((column, columnIndex) => {
    column.sort((left, right) => {
      const a = left.bbox as DocumentBBox;
      const b = right.bbox as DocumentBBox;
      return a.y - b.y || a.x - b.x;
    });
    for (const block of column) {
      block.meta = { ...block.meta, orderReason: 'column', orderColumn: columnIndex };
      ordered.push(block);
    }
  });
  return ordered;
}

function orderPage(
  page: DocumentPage,
  sized: SizedPage | null,
): { ordered: OrderedBlock[]; graph: boolean } {
  const fallback = [...page.blocks].sort((left, right) => left.order - right.order);
  const visible = fallback.filter((block) => !isOverlapDuplicate(block));
  const withBBox = visible.filter((block) => block.bbox !== null);
  if (!sized || withBBox.length < 2) {
    return {
      ordered: visible.map((block) => ({ block, reason: 'source' as const })),
      graph: false,
    };
  }

  const headers = visible
    .filter((block) => block.type === 'header' && block.bbox)
    .sort((left, right) => {
      const a = left.bbox as DocumentBBox;
      const b = right.bbox as DocumentBBox;
      return a.y - b.y || a.x - b.x;
    });
  const footers = visible
    .filter((block) => block.type === 'footer' && block.bbox)
    .sort((left, right) => {
      const a = left.bbox as DocumentBBox;
      const b = right.bbox as DocumentBBox;
      return a.y - b.y || a.x - b.x;
    });
  const body = visible.filter(
    (block) => block.bbox && block.type !== 'header' && block.type !== 'footer',
  );
  // Only coordinate-less blocks fall back to source order; headers, footers
  // and body blocks are all placed explicitly above.
  const leftovers = visible.filter((block) => !block.bbox);

  const wide = body
    .filter((block) => (block.bbox as DocumentBBox).width >= sized.width * WIDE_BLOCK_RATIO)
    .sort((left, right) => {
      const a = left.bbox as DocumentBBox;
      const b = right.bbox as DocumentBBox;
      return a.y - b.y || a.x - b.x;
    });
  const narrow = body.filter(
    (block) => (block.bbox as DocumentBBox).width < sized.width * WIDE_BLOCK_RATIO,
  );
  const bands: DocumentBlock[][] = Array.from({ length: wide.length + 1 }, () => []);
  for (const block of narrow) {
    const y = centerY(block.bbox as DocumentBBox);
    let band = 0;
    for (const separator of wide) {
      if (centerY(separator.bbox as DocumentBBox) <= y) band += 1;
    }
    (bands[band] as DocumentBlock[]).push(block);
  }

  const ordered: OrderedBlock[] = [];
  for (const block of headers) {
    block.meta = { ...block.meta, orderReason: 'header' };
    ordered.push({ block, reason: 'header' });
  }
  for (let band = 0; band < bands.length; band += 1) {
    for (const block of orderColumns(bands[band] as DocumentBlock[], sized.width)) {
      ordered.push({ block, reason: block.meta?.orderReason === 'column' ? 'column' : 'flow' });
    }
    if (band < wide.length) {
      const separator = wide[band] as DocumentBlock;
      separator.meta = { ...separator.meta, orderReason: 'spanning' };
      ordered.push({ block: separator, reason: 'spanning' });
    }
  }
  for (const block of footers) {
    block.meta = { ...block.meta, orderReason: 'footer' };
    ordered.push({ block, reason: 'footer' });
  }
  for (const block of leftovers) {
    block.meta = { ...block.meta, orderReason: 'source' };
    ordered.push({ block, reason: 'source' });
  }

  const graph = body.length >= 2;
  return { ordered, graph };
}

/**
 * Explicit continuation chains. Each entry keeps the original per-page table
 * blocks; a stitched row count is offered for consumers without merging text.
 */
export function tableChains(document: DocumentIr): DocumentTableChain[] {
  const tables = document.pages.flatMap((page) =>
    page.blocks
      .filter((block) => block.type === 'table')
      .map((block) => ({ page: page.number, block })),
  );
  const byId = new Map(tables.map((entry) => [entry.block.id, entry]));
  const visited = new Set<string>();
  const chains: DocumentTableChain[] = [];

  for (const entry of tables) {
    if (visited.has(entry.block.id)) continue;
    let head = entry;
    const backward = new Set<string>([head.block.id]);
    while (true) {
      const from = head.block.meta?.continuedFrom as { blockId?: unknown } | undefined;
      if (typeof from?.blockId !== 'string') break;
      const previous = byId.get(from.blockId);
      if (!previous || backward.has(previous.block.id)) break;
      backward.add(previous.block.id);
      head = previous;
    }

    const blocks: { page: number; blockId: string }[] = [];
    let rows = 0;
    let current: (typeof tables)[number] | undefined = head;
    const forward = new Set<string>();
    while (current && !forward.has(current.block.id)) {
      forward.add(current.block.id);
      visited.add(current.block.id);
      blocks.push({ page: current.page, blockId: current.block.id });
      rows +=
        (current.block.rows?.length ?? 0) - (current.block.meta?.repeatedHeader === true ? 1 : 0);
      const next = current.block.meta?.continuedTo as { blockId?: unknown } | undefined;
      current = typeof next?.blockId === 'string' ? byId.get(next.blockId) : undefined;
    }
    if (blocks.length > 1) {
      chains.push({ id: `tc-p${head.page}-${head.block.id}`, blocks, rows });
    }
  }
  return chains;
}

/**
 * Deterministic DIR cleanup applied after parsing: tags repeated running
 * headers/footers, links same-position duplicates, records cross-page table
 * continuations and rebuilds a bbox-aware reading order. The original blocks,
 * their text and their coordinates are never discarded.
 */
/**
 * Documents stored before the independent/same-engine split carry a single
 * `confirmed` value. It was produced by the same engine re-reading the same
 * pixels, so it maps to `confirmed_same_engine`: dropping it would erase real
 * provenance, while treating it as independent would overstate the proof.
 */
export function normalizeDocumentIr<T extends DocumentIr | null>(document: T): T {
  if (!document) return document;
  const legacy = (value: unknown) => (value === 'confirmed' ? 'confirmed_same_engine' : value);
  const evidence = document.meta.fieldEvidence;
  if (Array.isArray(evidence)) {
    for (const item of evidence) {
      if (typeof item !== 'object' || item === null) continue;
      const entry = item as { agreement?: unknown };
      entry.agreement = legacy(entry.agreement);
    }
  }
  for (const page of document.pages) {
    for (const block of page.blocks) {
      if (block.meta?.regionAgreement === 'confirmed') {
        block.meta.regionAgreement = 'confirmed_same_engine';
      }
    }
  }
  return document;
}

export function refineDocumentIr(document: DocumentIr): DocumentIr {
  const templates = markTemplates(document);
  const overlaps = markOverlaps(document);
  const continuations = linkContinuations(document);
  const borderless = annotateBorderlessTables(document).length;

  const readingOrder: string[] = [];
  let graph = false;
  for (const page of document.pages) {
    const result = orderPage(page, pageSize(page));
    graph ||= result.graph;
    result.ordered.forEach((entry, index) => {
      entry.block.order = index;
      readingOrder.push(entry.block.id);
    });
  }

  document.readingOrder = readingOrder;
  const refinement: DocumentRefinement = {
    version: 1,
    headers: templates.headers,
    footers: templates.footers,
    overlaps,
    continuations,
    borderless,
    readingOrder: graph ? 'graph' : 'source',
  };
  document.meta = {
    ...document.meta,
    refinement,
    tableContinuations: tableChains(document),
  };
  return document;
}
