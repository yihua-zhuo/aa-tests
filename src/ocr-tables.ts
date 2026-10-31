import type {
  DocumentBBox,
  DocumentBlock,
  DocumentIr,
  DocumentTableCell,
} from '../shared/types.ts';

export type TableColumnKind =
  | 'amount'
  | 'quantity'
  | 'percentage'
  | 'date'
  | 'number'
  | 'identifier'
  | 'currency'
  | 'text';

export type TableColumn = {
  index: number;
  /** Combined multi-level label, e.g. `金额 / 本期`. */
  label: string;
  path: string[];
  kind: TableColumnKind;
  unit: string | null;
};

export type TableSchema = {
  version: 1;
  headerRows: number;
  columns: TableColumn[];
};

export type NumericFormat =
  | 'plain'
  | 'decimal-dot'
  | 'decimal-comma'
  | 'thousands-dot'
  | 'thousands-comma'
  /** `1,280.00`: comma thousands, dot decimal. */
  | 'mixed-dot-decimal'
  /** `1.280,00`: dot thousands, comma decimal. */
  | 'mixed-comma-decimal';

export type NumericCandidate = {
  raw: string;
  normalized: string;
  value: number;
  format: NumericFormat;
  percent: boolean;
  negative: boolean;
  /** More than one parse is plausible for the same raw string. */
  ambiguous: boolean;
  preferred: boolean;
};

export type CellNumberCandidates = {
  row: number;
  column: number;
  raw: string;
  candidates: NumericCandidate[];
  ambiguous: boolean;
  /** Index into `candidates`; never used to rewrite the cell. */
  selected: number | null;
};

export type BusinessCheckCode =
  | 'required_columns'
  | 'debit_credit_balance'
  | 'tax'
  | 'currency_consistency'
  | 'date_range'
  | 'identifier_format';

export type BusinessCheck = {
  code: BusinessCheckCode;
  status: 'passed' | 'warning' | 'failed';
  message: string;
  row: number | null;
  column: number | null;
};

export type DateParts = { year: number; month: number; day: number };

const IDENTIFIER_HEADER =
  /序号|编号|编码|代码|单据号|订单号|发票号|合同号|^(?:id|no\.?|#|index)$|\b(?:invoice|order|serial|ref)\b/i;
const QUANTITY_HEADER = /数量|件数|人数|工时|天数|\b(?:qty|quantity|hours?|days?)\b/i;
const AMOUNT_HEADER =
  /金额|合计|总计|小计|总额|总价|单价|应付|实付|余额|税额|借方|贷方|\b(?:amount|total|sum|price|balance|tax|debit|credit)\b/i;
const PERCENTAGE_HEADER = /百分比|占比|比例|税率|折扣率|\b(?:percent(?:age)?|ratio|rate)\b/i;
const DATE_HEADER = /日期|时间|\bdate\b/i;
const NUMBER_HEADER = /数值|数字|计数|\b(?:value|number|count)\b/i;
const CURRENCY_HEADER = /币种|货币|币别|\bcurrency\b/i;
const DEBIT_HEADER = /借方|\bdebit\b/i;
const CREDIT_HEADER = /贷方|\bcredit\b/i;
const TAX_AMOUNT_HEADER = /税额|税金|增值税|\btax(?:\s+amount)?\b/i;
const TAX_RATE_HEADER = /税率|\btax\s+rate\b/i;
const BASE_AMOUNT_HEADER = /不含税|税前|base\s+amount|\bnet\b/i;
const PLACEHOLDER_CELL = /^(?:[-—–/\\]|n\/?a|无|暂无|待定|未知)$/i;
const NUMBER_SUFFIX =
  /^(?:%|元|圆|美元|欧元|英镑|件|个|台|套|箱|人|天|小时|月|年|usd|cny|rmb|eur|gbp)$/i;
const MAX_HEADER_ROWS = 3;
const MAX_NUMBER_CANDIDATES = 200;

export function tableRows(block: DocumentBlock): string[][] {
  if (block.rows && block.rows.length > 0) return block.rows;
  if (!block.cells || block.cells.length === 0) return [];
  const grid: string[][] = [];
  for (const cell of block.cells) {
    const row = Math.max(0, Math.floor(cell.row));
    const column = Math.max(0, Math.floor(cell.column));
    while (grid.length <= row) grid.push([]);
    const target = grid[row];
    if (!target) continue;
    while (target.length < column) target.push('');
    target[column] = cell.text;
  }
  return grid;
}

export function inferColumnKind(label: string): TableColumnKind {
  const title = label.trim();
  if (!title) return 'text';
  if (DATE_HEADER.test(title)) return 'date';
  if (PERCENTAGE_HEADER.test(title)) return 'percentage';
  if (QUANTITY_HEADER.test(title)) return 'quantity';
  if (AMOUNT_HEADER.test(title)) return 'amount';
  if (CURRENCY_HEADER.test(title)) return 'currency';
  if (IDENTIFIER_HEADER.test(title)) return 'identifier';
  if (NUMBER_HEADER.test(title)) return 'number';
  return 'text';
}

export function unitOf(label: string): string | null {
  const trimmed = label.trim();
  const bracketed = trimmed.match(
    /[（(]\s*(元|人民币|美元|欧元|英镑|%|usd|cny|rmb|eur|gbp)\s*[)）]/i,
  );
  if (bracketed?.[1]) return bracketed[1];
  const declared = trimmed.match(
    /单位\s*[:：]?\s*(元|人民币|美元|欧元|英镑|%|usd|cny|rmb|eur|gbp)/i,
  );
  if (declared?.[1]) return declared[1];
  const suffix = trimmed.match(/(元|人民币|美元|欧元|英镑|%|usd|cny|rmb|eur|gbp)$/i);
  return suffix?.[1] ?? null;
}

function isPlaceholder(value: string): boolean {
  return PLACEHOLDER_CELL.test(value.trim());
}

function cellLooksData(value: string): boolean {
  const text = value.trim();
  if (!text || isPlaceholder(text)) return false;
  return parseDateValue(text) !== null || numericCandidates(text).length > 0;
}

function dataRatio(row: readonly string[]): number {
  const values = row.map((cell) => cell.trim()).filter(Boolean);
  if (values.length === 0) return 0;
  return values.filter(cellLooksData).length / values.length;
}

function headerLike(row: readonly string[]): boolean {
  const values = row.map((cell) => cell.trim()).filter(Boolean);
  return values.length > 0 && dataRatio(row) < 0.5;
}

function dataLike(row: readonly string[]): boolean {
  return dataRatio(row) >= 0.5;
}

function hierarchicalFirstRow(row: readonly string[]): boolean {
  const values = row.map((cell) => cell.trim());
  const nonEmpty = values.filter(Boolean);
  if (nonEmpty.length > 0 && nonEmpty.length < values.length) return true;
  return new Set(nonEmpty).size !== nonEmpty.length;
}

function detectHeaderRows(rows: readonly string[][]): number {
  if (rows.length < 2) return 0;
  const first = rows[0] ?? [];
  if (!headerLike(first)) return 1;
  if (!hierarchicalFirstRow(first)) return 1;
  let headerRows = 1;
  for (let index = 1; index < Math.min(MAX_HEADER_ROWS, rows.length - 1); index += 1) {
    const row = rows[index];
    const next = rows[index + 1];
    if (!row || !next || !headerLike(row) || !dataLike(next)) break;
    headerRows = index + 1;
  }
  return headerRows;
}

/**
 * Multi-level headers are combined per column so `金额` and the following
 * `本期` row do not become unrelated blocks. Header detection is conservative:
 * an extra level is only used when the first row has empty or repeated labels.
 */
export function inferTableSchema(block: DocumentBlock): TableSchema | null {
  const rows = tableRows(block);
  if (rows.length < 2) return null;
  const headerRows = detectHeaderRows(rows);
  if (headerRows === 0) return null;
  const width = rows.reduce((max, row) => Math.max(max, row.length), 0);
  if (width === 0) return null;
  const columns: TableColumn[] = [];
  for (let index = 0; index < width; index += 1) {
    const path: string[] = [];
    for (const row of rows.slice(0, headerRows)) {
      const label = (row[index] ?? '').trim();
      if (label && path[path.length - 1] !== label) path.push(label);
    }
    const label = path.join(' / ');
    columns.push({
      index,
      label,
      path,
      kind: inferColumnKind(label),
      unit: unitOf(label),
    });
  }
  return { version: 1, headerRows, columns };
}

export function tableSchemaOf(block: DocumentBlock): TableSchema | null {
  const meta = block.meta?.columnSchema;
  if (meta && typeof meta === 'object') {
    const schema = meta as TableSchema;
    if (
      schema.version === 1 &&
      Number.isInteger(schema.headerRows) &&
      Array.isArray(schema.columns)
    ) {
      return schema;
    }
  }
  return inferTableSchema(block);
}

function pushCandidate(
  list: NumericCandidate[],
  raw: string,
  normalized: string,
  format: NumericFormat,
  percent: boolean,
  negative: boolean,
): void {
  if (!/^\d+(?:\.\d+)?$/.test(normalized)) return;
  const unsigned = Number(normalized);
  if (!Number.isFinite(unsigned)) return;
  if (list.some((candidate) => candidate.normalized === normalized)) return;
  list.push({
    raw,
    normalized,
    value: (negative ? -1 : 1) * unsigned,
    format,
    percent,
    negative,
    ambiguous: false,
    preferred: false,
  });
}

/**
 * Preserve every plausible reading before normalization. `1,280` can be a
 * thousands separator or a decimal comma, and `1.280` has the mirror problem;
 * the caller decides using column type and context.
 */
export function numericCandidates(value: string, kind?: TableColumnKind): NumericCandidate[] {
  const raw = value.trim();
  if (!raw) return [];
  let text = raw.replace(/[¥￥$€£\s]/g, '');
  let percent = false;
  if (/[％%]$/.test(text)) {
    percent = true;
    text = text.slice(0, -1);
  }
  let negative = false;
  if (/^\(.+\)$/.test(text)) {
    negative = true;
    text = text.slice(1, -1);
  }
  if (text.startsWith('-') || text.endsWith('-')) {
    negative = true;
    text = text.replace(/-/g, '');
  }
  const match = text.match(/^(\d[\d.,]*)(.*)$/);
  if (!match) return [];
  const numeric = match[1] ?? '';
  const suffix = (match[2] ?? '').trim();
  if (suffix && !NUMBER_SUFFIX.test(suffix)) return [];

  const candidates: NumericCandidate[] = [];
  const comma = numeric.lastIndexOf(',');
  const dot = numeric.lastIndexOf('.');
  if (comma >= 0 && dot >= 0) {
    const parts = numeric.split(comma > dot ? ',' : '.');
    const thousands = (parts[0] ?? '').split(comma > dot ? '.' : ',');
    if (
      parts.length !== 2 ||
      !/^\d{1,2}$/.test(parts[1] ?? '') ||
      !thousands.slice(1).every((group) => /^\d{3}$/.test(group))
    ) {
      return [];
    }
    const normalized = `${thousands.join('')}.${parts[1]}`;
    pushCandidate(
      candidates,
      raw,
      normalized,
      comma > dot ? 'mixed-comma-decimal' : 'mixed-dot-decimal',
      percent,
      negative,
    );
  } else if (comma >= 0) {
    const parts = numeric.split(',');
    const groups = parts.slice(1);
    const thousands = groups.every((group) => /^\d{3}$/.test(group));
    if (thousands) {
      pushCandidate(candidates, raw, parts.join(''), 'thousands-comma', percent, negative);
      if (parts.length === 2) {
        pushCandidate(candidates, raw, parts.join('.'), 'decimal-comma', percent, negative);
      }
    } else if (parts.length === 2 && /^\d{1,2}$/.test(parts[1] ?? '')) {
      pushCandidate(candidates, raw, parts.join('.'), 'decimal-comma', percent, negative);
    }
  } else if (dot >= 0) {
    const parts = numeric.split('.');
    const groups = parts.slice(1);
    const thousands = groups.every((group) => /^\d{3}$/.test(group));
    if (thousands) {
      pushCandidate(candidates, raw, parts.join(''), 'thousands-dot', percent, negative);
      if (parts.length === 2) {
        pushCandidate(candidates, raw, numeric, 'decimal-dot', percent, negative);
      }
    } else {
      pushCandidate(candidates, raw, numeric, 'decimal-dot', percent, negative);
    }
  } else {
    pushCandidate(candidates, raw, numeric, 'plain', percent, negative);
  }

  if (candidates.length > 1) {
    for (const candidate of candidates) candidate.ambiguous = true;
  }
  const order =
    kind === 'percentage'
      ? [
          'plain',
          'decimal-dot',
          'decimal-comma',
          'mixed-dot-decimal',
          'mixed-comma-decimal',
          'thousands-dot',
          'thousands-comma',
        ]
      : [
          'mixed-dot-decimal',
          'mixed-comma-decimal',
          'plain',
          'thousands-dot',
          'thousands-comma',
          'decimal-dot',
          'decimal-comma',
        ];
  const preferred = [...candidates].sort(
    (left, right) => order.indexOf(left.format) - order.indexOf(right.format),
  )[0];
  if (preferred) preferred.preferred = true;
  return candidates;
}

/** Single preference for compatibility; the full candidate list stays available. */
export function parseBusinessNumber(value: string): number | null {
  const candidates = numericCandidates(value);
  const preferred = candidates.find((candidate) => candidate.preferred) ?? candidates[0];
  return preferred ? preferred.value : null;
}

export function parseDateValue(value: string): DateParts | null {
  let text = value
    .trim()
    .replace(/(\d)\s*年\s*/g, '$1-')
    .replace(/(\d)\s*月\s*/g, '$1-')
    .replace(/日/g, '')
    .replace(/[./]/g, '-');
  if (/^\d{8}$/.test(text)) {
    text = `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
  }
  const parts = text
    .split('-')
    .map((part) => part.trim())
    .filter(Boolean)
    .map(Number);
  if (parts.length !== 3 || parts.some((part) => !Number.isInteger(part))) return null;
  const [first, second, third] = parts as [number, number, number];
  let year: number;
  let month: number;
  let day: number;
  if (first > 31) {
    [year, month, day] = [first, second, third];
  } else if (third > 31 || third >= 1000) {
    [day, month, year] = [first, second, third];
  } else {
    [day, month, year] = [first, second, third < 100 ? 2000 + third : third];
  }
  if (year < 1000 || year > 2999 || month < 1 || month > 12 || day < 1) return null;
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day <= days ? { year, month, day } : null;
}

export function parseDateLike(value: string): boolean {
  if (parseDateValue(value)) return true;
  const parts = value
    .trim()
    .replace(/(\d)\s*年\s*/g, '$1-')
    .replace(/(\d)\s*月\s*/g, '$1-')
    .replace(/日/g, '')
    .replace(/[./]/g, '-')
    .split('-')
    .map((part) => part.trim())
    .filter(Boolean)
    .map(Number);
  if (parts.some((part) => !Number.isInteger(part))) return false;
  if (parts.length !== 2) return false;
  const [left, right] = parts as [number, number];
  return (
    (left >= 1000 && left <= 2999 && right >= 1 && right <= 12) ||
    (left >= 1 && left <= 12 && right >= 1 && right <= 31)
  );
}

function candidateAt(value: string, kind: TableColumnKind): NumericCandidate | null {
  const candidates = numericCandidates(value, kind);
  return candidates.find((candidate) => candidate.preferred) ?? candidates[0] ?? null;
}

function tableCellMap(block: DocumentBlock): Map<string, DocumentTableCell> {
  const map = new Map<string, DocumentTableCell>();
  for (const cell of block.cells ?? []) {
    map.set(`${Math.floor(cell.row)}:${Math.floor(cell.column)}`, cell);
  }
  return map;
}

export function cellBBox(
  block: DocumentBlock,
  rows: readonly string[][],
  row: number,
  column: number,
): { bbox: DocumentBBox; estimated: boolean } | null {
  const direct = tableCellMap(block).get(`${row}:${column}`);
  if (direct?.bbox) return { bbox: direct.bbox, estimated: false };
  if (!block.bbox) return null;
  const rowCount = Math.max(1, rows.length);
  const columnCount = Math.max(
    1,
    rows.reduce((max, item) => Math.max(max, item.length), 0),
  );
  const width = block.bbox.width / columnCount;
  const height = block.bbox.height / rowCount;
  return {
    bbox: {
      x: block.bbox.x + width * column,
      y: block.bbox.y + height * row,
      width,
      height,
    },
    estimated: true,
  };
}

/**
 * Annotates table blocks with a column schema and ambiguous numeric parse
 * candidates. The cell text is never changed.
 */
export function annotateTableMetadata(document: DocumentIr): DocumentIr {
  for (const page of document.pages) {
    for (const block of page.blocks) {
      if (block.type !== 'table') continue;
      const schema = inferTableSchema(block);
      if (!schema) continue;
      const rows = tableRows(block);
      const numberCandidates: CellNumberCandidates[] = [];
      for (let row = schema.headerRows; row < rows.length; row += 1) {
        for (const column of schema.columns) {
          if (
            column.kind !== 'amount' &&
            column.kind !== 'quantity' &&
            column.kind !== 'percentage' &&
            column.kind !== 'number'
          ) {
            continue;
          }
          const raw = (rows[row]?.[column.index] ?? '').trim();
          if (!raw || isPlaceholder(raw)) continue;
          const candidates = numericCandidates(raw, column.kind);
          const interesting =
            candidates.length > 1 ||
            candidates[0]?.percent === true ||
            candidates[0]?.negative === true ||
            (candidates[0]?.format ?? 'plain') !== 'plain';
          if (!interesting) continue;
          const selected = candidates.findIndex((candidate) => candidate.preferred);
          numberCandidates.push({
            row,
            column: column.index,
            raw,
            candidates,
            ambiguous: candidates.some((candidate) => candidate.ambiguous),
            selected: selected >= 0 ? selected : null,
          });
          if (numberCandidates.length >= MAX_NUMBER_CANDIDATES) break;
        }
        if (numberCandidates.length >= MAX_NUMBER_CANDIDATES) break;
      }
      block.meta = { ...(block.meta ?? {}), columnSchema: schema };
      if (numberCandidates.length > 0) block.meta.numberCandidates = numberCandidates;
    }
  }
  return document;
}

function currencyOf(value: string): string | null {
  const text = value.trim();
  if (!text) return null;
  const upper = text.toUpperCase();
  if (/\$|\bUSD\b|美元/.test(upper)) return 'USD';
  if (/€|\bEUR\b|欧元/.test(upper)) return 'EUR';
  if (/£|\bGBP\b|英镑/.test(upper)) return 'GBP';
  if (/¥|￥|\bCNY\b|\bRMB\b|人民币|元|圆/.test(upper)) return 'CNY';
  return null;
}

function columnNumbers(
  rows: readonly string[][],
  headerRows: number,
  column: TableColumn,
): { values: number[]; rows: number[] } {
  const values: number[] = [];
  const rowIndexes: number[] = [];
  for (let row = headerRows; row < rows.length; row += 1) {
    const raw = (rows[row]?.[column.index] ?? '').trim();
    if (!raw || isPlaceholder(raw)) continue;
    const candidate = candidateAt(raw, column.kind);
    if (!candidate) continue;
    values.push(candidate.value);
    rowIndexes.push(row);
  }
  return { values, rows: rowIndexes };
}

function sumOf(rows: readonly string[][], headerRows: number, column: TableColumn): number {
  return columnNumbers(rows, headerRows, column).values.reduce((sum, value) => sum + value, 0);
}

function requiredColumnChecks(block: DocumentBlock, schema: TableSchema): BusinessCheck[] {
  const raw = block.meta?.requiredColumns;
  const required = Array.isArray(raw)
    ? raw.filter((item): item is string => typeof item === 'string' && item.trim() !== '')
    : [];
  if (required.length === 0) return [];
  const labels = schema.columns.map((column) => column.label.toLowerCase());
  const missing = required.filter((name) => {
    const needle = name.trim().toLowerCase();
    return !labels.some((label) => label.includes(needle) || needle.includes(label));
  });
  if (missing.length === 0) {
    return [
      {
        code: 'required_columns',
        status: 'passed',
        message: `必填列齐全：${required.join('、')}`,
        row: null,
        column: null,
      },
    ];
  }
  return [
    {
      code: 'required_columns',
      status: 'failed',
      message: `缺少必填列：${missing.join('、')}`,
      row: null,
      column: null,
    },
  ];
}

function balanceCheck(rows: readonly string[][], schema: TableSchema): BusinessCheck[] {
  const debit = schema.columns.filter((column) => DEBIT_HEADER.test(column.label));
  const credit = schema.columns.filter((column) => CREDIT_HEADER.test(column.label));
  if (debit.length === 0 || credit.length === 0) return [];
  let debitTotal = 0;
  let creditTotal = 0;
  for (const column of debit) debitTotal += sumOf(rows, schema.headerRows, column);
  for (const column of credit) creditTotal += sumOf(rows, schema.headerRows, column);
  const tolerance = Math.max(Math.abs(debitTotal) * 0.005, Math.abs(creditTotal) * 0.005, 0.01);
  const difference = Math.abs(debitTotal - creditTotal);
  return [
    {
      code: 'debit_credit_balance',
      status: difference <= tolerance ? 'passed' : 'failed',
      message:
        difference <= tolerance
          ? `借贷平衡：${debitTotal.toFixed(2)} = ${creditTotal.toFixed(2)}`
          : `借贷不平衡：借方 ${debitTotal.toFixed(2)}，贷方 ${creditTotal.toFixed(2)}`,
      row: null,
      column: null,
    },
  ];
}

function taxCheck(rows: readonly string[][], schema: TableSchema): BusinessCheck[] {
  const taxes = schema.columns.filter(
    (column) => TAX_AMOUNT_HEADER.test(column.label) && !BASE_AMOUNT_HEADER.test(column.label),
  );
  const rates = schema.columns.filter((column) => TAX_RATE_HEADER.test(column.label));
  if (taxes.length === 0 || rates.length === 0) return [];
  const bases = schema.columns.filter(
    (column) =>
      !taxes.includes(column) &&
      !rates.includes(column) &&
      (BASE_AMOUNT_HEADER.test(column.label) ||
        (column.kind === 'amount' && !DEBIT_HEADER.test(column.label))),
  );
  if (bases.length === 0) return [];
  const base = bases[0] as TableColumn;
  const tax = taxes[0] as TableColumn;
  const rate = rates[0] as TableColumn;
  let checked = 0;
  let mismatched = 0;
  let firstRow: number | null = null;
  for (let row = schema.headerRows; row < rows.length; row += 1) {
    const baseValue = candidateAt((rows[row]?.[base.index] ?? '').trim(), base.kind);
    const taxValue = candidateAt((rows[row]?.[tax.index] ?? '').trim(), tax.kind);
    const rateValue = candidateAt((rows[row]?.[rate.index] ?? '').trim(), rate.kind);
    if (!baseValue || !taxValue || !rateValue) continue;
    const normalizedRate =
      rateValue.percent || Math.abs(rateValue.value) > 1 ? rateValue.value / 100 : rateValue.value;
    const expected = baseValue.value * normalizedRate;
    checked += 1;
    if (Math.abs(expected - taxValue.value) > Math.max(Math.abs(expected) * 0.02, 0.02)) {
      mismatched += 1;
      if (firstRow === null) firstRow = row;
    }
  }
  if (checked === 0) return [];
  return [
    {
      code: 'tax',
      status: mismatched === 0 ? 'passed' : 'failed',
      message:
        mismatched === 0
          ? `${checked} 行税额校验通过`
          : `${mismatched}/${checked} 行税额与税率不一致`,
      row: firstRow,
      column: tax.index,
    },
  ];
}

function currencyCheck(rows: readonly string[][], schema: TableSchema): BusinessCheck[] {
  const relevant = schema.columns.filter(
    (column) => column.kind === 'amount' || column.kind === 'currency',
  );
  if (relevant.length === 0) return [];
  const currencies = new Set<string>();
  for (const column of relevant) {
    const columnCurrency = currencyOf(column.label);
    if (columnCurrency) currencies.add(columnCurrency);
    for (let row = schema.headerRows; row < rows.length; row += 1) {
      const raw = (rows[row]?.[column.index] ?? '').trim();
      const currency = currencyOf(raw);
      if (currency) currencies.add(currency);
    }
  }
  if (currencies.size === 0) return [];
  if (currencies.size <= 1) {
    const only = [...currencies][0];
    return [
      {
        code: 'currency_consistency',
        status: 'passed',
        message: only ? `币种一致：${only}` : '未发现币种冲突',
        row: null,
        column: null,
      },
    ];
  }
  return [
    {
      code: 'currency_consistency',
      status: 'warning',
      message: `金额列出现多种币种：${[...currencies].join('、')}`,
      row: null,
      column: null,
    },
  ];
}

function dateRangeCheck(
  rows: readonly string[][],
  schema: TableSchema,
  minYear: number,
  maxYear: number,
): BusinessCheck[] {
  const dates = schema.columns.filter((column) => column.kind === 'date');
  if (dates.length === 0) return [];
  let checked = 0;
  let outOfRange = 0;
  let first: { row: number; column: number } | null = null;
  for (const column of dates) {
    for (let row = schema.headerRows; row < rows.length; row += 1) {
      const raw = (rows[row]?.[column.index] ?? '').trim();
      if (!raw || isPlaceholder(raw)) continue;
      const parsed = parseDateValue(raw);
      if (!parsed) continue;
      checked += 1;
      if (parsed.year < minYear || parsed.year > maxYear) {
        outOfRange += 1;
        if (!first) first = { row, column: column.index };
      }
    }
  }
  if (checked === 0) return [];
  return [
    {
      code: 'date_range',
      status: outOfRange === 0 ? 'passed' : 'warning',
      message:
        outOfRange === 0
          ? `${checked} 个日期均在 ${minYear}–${maxYear} 范围内`
          : `${outOfRange}/${checked} 个日期超出 ${minYear}–${maxYear} 范围`,
      row: first?.row ?? null,
      column: first?.column ?? null,
    },
  ];
}

function identifierShape(value: string): 'digits' | 'alnum' | 'other' {
  const compact = value.replace(/[\s-]/g, '');
  if (/^\d+$/.test(compact)) return 'digits';
  if (/^[A-Za-z0-9]+$/.test(compact)) return 'alnum';
  return 'other';
}

function identifierCheck(rows: readonly string[][], schema: TableSchema): BusinessCheck[] {
  const identifiers = schema.columns.filter((column) => column.kind === 'identifier');
  for (const column of identifiers) {
    const shapes = new Set<'digits' | 'alnum'>();
    let checked = 0;
    let first: number | null = null;
    for (let row = schema.headerRows; row < rows.length; row += 1) {
      const raw = (rows[row]?.[column.index] ?? '').trim();
      if (!raw || isPlaceholder(raw)) continue;
      const shape = identifierShape(raw);
      if (shape === 'other') continue;
      checked += 1;
      if (shapes.size < 2) shapes.add(shape);
      if (shapes.size > 1 && first === null) first = row;
    }
    if (checked < 3 || shapes.size <= 1) continue;
    return [
      {
        code: 'identifier_format',
        status: 'warning',
        message: `${column.label || '编号'}列同时出现纯数字与字母编号`,
        row: first,
        column: column.index,
      },
    ];
  }
  return [];
}

export function tableBusinessChecks(
  block: DocumentBlock,
  schema: TableSchema | null = tableSchemaOf(block),
  options: { minYear?: number; maxYear?: number } = {},
): BusinessCheck[] {
  if (!schema) return [];
  const rows = tableRows(block);
  return [
    ...requiredColumnChecks(block, schema),
    ...balanceCheck(rows, schema),
    ...taxCheck(rows, schema),
    ...currencyCheck(rows, schema),
    ...dateRangeCheck(rows, schema, options.minYear ?? 1900, options.maxYear ?? 2100),
    ...identifierCheck(rows, schema),
  ];
}

export type TableBusinessSummary = {
  checked: number;
  passed: number;
  failed: number;
  warnings: number;
  checks: BusinessCheck[];
};

export function tableBusinessSummary(
  block: DocumentBlock,
  options: { minYear?: number; maxYear?: number } = {},
): TableBusinessSummary {
  const checks = tableBusinessChecks(block, tableSchemaOf(block), options);
  return {
    checked: checks.length,
    passed: checks.filter((check) => check.status === 'passed').length,
    failed: checks.filter((check) => check.status === 'failed').length,
    warnings: checks.filter((check) => check.status === 'warning').length,
    checks,
  };
}

export function isTypedCellColumn(column: TableColumn): boolean {
  return (
    column.kind === 'amount' ||
    column.kind === 'date' ||
    column.kind === 'quantity' ||
    column.kind === 'percentage' ||
    column.kind === 'number'
  );
}

export function cellNeedsRecovery(kind: TableColumnKind, text: string): boolean {
  const value = text.trim();
  if (!value || isPlaceholder(value)) return false;
  if (/[?？□]/.test(value)) return true;
  if (kind === 'date') return !parseDateLike(value);
  return numericCandidates(value, kind).length === 0;
}
