import type {
  DocumentBBox,
  DocumentBlock,
  DocumentPage,
  OcrBorderlessTable,
} from '../shared/types.ts';

const MIN_ROWS = 3;
const MIN_COLUMNS = 2;
const MAX_COLUMNS = 12;
const MIN_CELLS = 6;
const MAX_MEDIAN_LENGTH = 48;
/** Short cells avoid treating ordinary multi-column prose as a table. */
const MAX_ALIGNMENT_GAP_RATIO = 0.35;

type LineCell = {
  block: DocumentBlock;
  bbox: DocumentBBox;
};

type RowGroup = {
  cells: LineCell[];
  top: number;
  bottom: number;
  centerX: number;
};

const NUMERIC_CELL = /^[¥￥$€£]?\s*[-+(]?\d[\d,.\s)%]*$/u;
const DATE_CELL = /\d{4}[-/.年]\d{1,2}[-/.月]\d{1,2}|\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}/u;

function clamp(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : (sorted[middle] ?? 0);
}

function overlapY(left: DocumentBBox, right: DocumentBBox): number {
  const top = Math.max(left.y, right.y);
  const bottom = Math.min(left.y + left.height, right.y + right.height);
  const smaller = Math.min(left.height, right.height);
  return smaller > 0 && bottom > top ? (bottom - top) / smaller : 0;
}

function unionBox(boxes: DocumentBBox[]): DocumentBBox {
  const left = Math.min(...boxes.map((box) => box.x));
  const top = Math.min(...boxes.map((box) => box.y));
  const right = Math.max(...boxes.map((box) => box.x + box.width));
  const bottom = Math.max(...boxes.map((box) => box.y + box.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function iou(left: DocumentBBox, right: DocumentBBox): number {
  const x1 = Math.max(left.x, right.x);
  const y1 = Math.max(left.y, right.y);
  const x2 = Math.min(left.x + left.width, right.x + right.width);
  const y2 = Math.min(left.y + left.height, right.y + right.height);
  if (x2 <= x1 || y2 <= y1) return 0;
  const intersection = (x2 - x1) * (y2 - y1);
  const union = left.width * left.height + right.width * right.height - intersection;
  return union > 0 ? intersection / union : 0;
}

function rowGroups(blocks: DocumentBlock[]): RowGroup[] {
  const sorted = [...blocks].sort(
    (left, right) =>
      (left.bbox as DocumentBBox).y - (right.bbox as DocumentBBox).y ||
      (left.bbox as DocumentBBox).x - (right.bbox as DocumentBBox).x,
  );
  const groups: RowGroup[] = [];
  for (const block of sorted) {
    const bbox = block.bbox as DocumentBBox;
    let group = groups.find(
      (item) => overlapY({ ...bbox, y: item.top, height: item.bottom - item.top }, bbox) >= 0.5,
    );
    if (!group) {
      group = { cells: [], top: bbox.y, bottom: bbox.y + bbox.height, centerX: 0 };
      groups.push(group);
    }
    group.cells.push({ block, bbox });
    group.top = Math.min(group.top, bbox.y);
    group.bottom = Math.max(group.bottom, bbox.y + bbox.height);
  }
  for (const group of groups) {
    group.cells.sort((left, right) => left.bbox.x - right.bbox.x);
    const centers = group.cells.map((cell) => cell.bbox.x + cell.bbox.width / 2);
    group.centerX = centers.reduce((sum, value) => sum + value, 0) / Math.max(1, centers.length);
  }
  return groups.sort((left, right) => left.top - right.top);
}

type ColumnCluster = { index: number; center: number; left: number; right: number };

function clusterColumns(cells: LineCell[], tolerance: number): ColumnCluster[] {
  const centers = cells
    .map((cell) => cell.bbox.x + cell.bbox.width / 2)
    .sort((left, right) => left - right);
  const clusters: { center: number; values: number[] }[] = [];
  for (const center of centers) {
    const current = clusters[clusters.length - 1];
    if (current && center - current.center <= tolerance) {
      current.values.push(center);
      current.center =
        current.values.reduce((sum, value) => sum + value, 0) / current.values.length;
    } else {
      clusters.push({ center, values: [center] });
    }
  }
  return clusters.map((cluster, index) => ({
    index,
    center: cluster.center,
    left: Math.min(...cluster.values),
    right: Math.max(...cluster.values),
  }));
}

function candidateFor(
  page: number,
  id: string,
  rows: RowGroup[],
  realTables: DocumentBlock[],
): OcrBorderlessTable | null {
  const cells = rows.flatMap((row) => row.cells);
  if (cells.length < MIN_CELLS) return null;

  const widths = cells.map((cell) => cell.bbox.width);
  const tolerance = Math.max(12, median(widths) * MAX_ALIGNMENT_GAP_RATIO);
  const columns = clusterColumns(cells, tolerance);
  if (columns.length < MIN_COLUMNS || columns.length > MAX_COLUMNS) return null;

  const columnOf = (cell: LineCell): ColumnCluster =>
    columns.reduce((best, column) =>
      Math.abs(cell.bbox.x + cell.bbox.width / 2 - column.center) <
      Math.abs(cell.bbox.x + cell.bbox.width / 2 - best.center)
        ? column
        : best,
    );

  const mapped = new Set<number>();
  for (const row of rows) {
    const seen = new Set<number>();
    for (const cell of row.cells) {
      const column = columnOf(cell);
      if (seen.has(column.index)) return null;
      seen.add(column.index);
      mapped.add(column.index);
    }
  }
  // A column that only one row touches is more likely prose than a table.
  if (mapped.size < MIN_COLUMNS) return null;
  for (const column of columns) {
    if (!mapped.has(column.index)) return null;
  }

  const texts = cells.map((cell) => cell.block.text.trim());
  const textLength = median(texts.map((text) => text.length));
  if (textLength > MAX_MEDIAN_LENGTH) return null;
  const numeric = texts.filter((text) => NUMERIC_CELL.test(text) || DATE_CELL.test(text)).length;
  const structured = rows.every((row) => row.cells.length >= MIN_COLUMNS) && textLength <= 24;
  if (numeric / texts.length < 0.15 && !structured) return null;

  const bbox = unionBox(cells.map((cell) => cell.bbox));
  if (realTables.some((table) => table.bbox && iou(table.bbox, bbox) > 0.25)) return null;

  const fill =
    rows.reduce((sum, row) => sum + row.cells.length, 0) / (rows.length * columns.length);
  const alignment =
    cells.reduce((sum, cell) => {
      const distance = Math.abs(cell.bbox.x + cell.bbox.width / 2 - columnOf(cell).center);
      return sum + Math.max(0, 1 - distance / Math.max(tolerance, 1));
    }, 0) / cells.length;
  const confidence = clamp(
    0.45 + 0.2 * fill + 0.2 * alignment + 0.15 * Math.min(1, (numeric / texts.length) * 2),
  );

  return {
    id,
    page,
    bbox,
    method: 'text-alignment',
    confidence,
    columns: columns.map((column) => ({
      index: column.index,
      x: column.left,
      width: Math.max(1, column.right - column.left + tolerance),
    })),
    rows: rows.map((row) => ({
      order: rows.indexOf(row),
      cells: row.cells.map((cell) => ({
        blockId: cell.block.id,
        text: cell.block.text,
        bbox: cell.bbox,
        column: columnOf(cell).index,
      })),
    })),
  };
}

/**
 * Infers borderless table structure from text line alignment, spacing and
 * numeric content. Blocks are only tagged; text and coordinates are untouched.
 */
export function inferBorderlessTables(page: DocumentPage): OcrBorderlessTable[] {
  const candidates = page.blocks.filter(
    (block) =>
      block.bbox !== null &&
      block.type === 'paragraph' &&
      !block.text.includes('\n') &&
      block.text.trim().length > 0 &&
      typeof block.meta?.overlapOf !== 'string' &&
      block.meta?.borderlessTable === undefined,
  );
  if (candidates.length < MIN_CELLS) return [];

  const heights = candidates.map((block) => (block.bbox as DocumentBBox).height);
  const lineHeight = Math.max(6, median(heights));
  const groups = rowGroups(candidates);
  const realTables = page.blocks.filter((block) => block.type === 'table' && block.bbox);
  const tables: OcrBorderlessTable[] = [];
  let run: RowGroup[] = [];

  const flush = () => {
    if (run.length >= MIN_ROWS) {
      const table = candidateFor(
        page.number,
        `p${page.number}-bt${tables.length + 1}`,
        run,
        realTables,
      );
      if (table) tables.push(table);
    }
    run = [];
  };

  for (const group of groups) {
    const count = group.cells.length;
    const previous = run[run.length - 1];
    const gap = previous ? group.top - previous.bottom : 0;
    if (count < MIN_COLUMNS || count > MAX_COLUMNS || (previous && gap > lineHeight * 2.5)) {
      flush();
      if (count >= MIN_COLUMNS && count <= MAX_COLUMNS) run.push(group);
      continue;
    }
    run.push(group);
  }
  flush();
  return tables;
}

/** Adds inferred borderless tables to the DIR and tags their source blocks. */
export function annotateBorderlessTables(document: DocumentIrLike): OcrBorderlessTable[] {
  const tables: OcrBorderlessTable[] = [];
  for (const page of document.pages) {
    const found = inferBorderlessTables(page);
    for (const table of found) {
      tables.push(table);
      const blocks = new Map(page.blocks.map((block) => [block.id, block]));
      for (const row of table.rows) {
        for (const cell of row.cells) {
          const block = blocks.get(cell.blockId);
          if (!block) continue;
          block.meta = {
            ...block.meta,
            borderlessTable: { id: table.id, row: row.order, column: cell.column },
          };
        }
      }
    }
  }
  if (tables.length > 0) document.meta.borderlessTables = tables;
  return tables;
}

type DocumentIrLike = {
  pages: DocumentPage[];
  meta: Record<string, unknown>;
};
