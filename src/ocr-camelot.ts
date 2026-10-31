import type { DocumentBBox, DocumentBlock, DocumentIr } from '../shared/types.ts';
import { positiveIntEnv } from './db.ts';
import { log } from './logger.ts';

export type CamelotTable = {
  page: number;
  rows: string[][];
  bbox: DocumentBBox | null;
  flavor: string | null;
};

type CamelotPayload = {
  available?: unknown;
  tables?: unknown;
  reason?: unknown;
  truncated?: unknown;
};

export type CamelotResult = {
  tables: CamelotTable[];
  truncated: boolean;
};

function normalizeTable(value: unknown): CamelotTable | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const page = Number(record.page);
  if (!Number.isInteger(page) || page < 1) return null;
  if (!Array.isArray(record.rows)) return null;
  const rows: string[][] = [];
  for (const row of record.rows.slice(0, 500)) {
    if (!Array.isArray(row)) continue;
    rows.push(
      row.slice(0, 200).map((cell) => (typeof cell === 'string' ? cell : String(cell ?? ''))),
    );
  }
  if (rows.length === 0) return null;
  let bbox: DocumentBBox | null = null;
  const raw = record.bbox;
  if (raw && typeof raw === 'object') {
    const box = raw as Record<string, unknown>;
    const x = Number(box.x);
    const y = Number(box.y);
    const width = Number(box.width);
    const height = Number(box.height);
    if ([x, y, width, height].every(Number.isFinite) && width > 0 && height > 0) {
      bbox = { x, y, width, height };
    }
  }
  return {
    page,
    rows,
    bbox,
    flavor: typeof record.flavor === 'string' ? record.flavor : null,
  };
}

export type CamelotClientOptions = {
  url?: string;
  token?: string;
  timeoutMs?: number;
};

/**
 * Optional HTTP adapter for Camelot table extraction. It is inert unless
 * OCR_CAMELOT_URL points at a reachable service; failures never break OCR.
 */
export class CamelotClient {
  readonly #url: string | null;
  readonly #token: string | null;
  readonly #timeoutMs: number;

  constructor(options: CamelotClientOptions = {}) {
    const raw = options.url ?? process.env.OCR_CAMELOT_URL;
    this.#url = raw?.trim() ? raw.trim().replace(/\/+$/, '') : null;
    const token = options.token ?? process.env.OCR_CAMELOT_TOKEN;
    this.#token = token?.trim() ? token.trim() : null;
    this.#timeoutMs =
      options.timeoutMs ?? positiveIntEnv('OCR_CAMELOT_TIMEOUT_SECONDS', 30) * 1_000;
  }

  get configured(): boolean {
    return this.#url !== null;
  }

  async tables(path: string, name: string, signal?: AbortSignal): Promise<CamelotResult> {
    const empty: CamelotResult = { tables: [], truncated: false };
    if (!this.#url) return empty;
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.#token) headers['x-ocr-token'] = this.#token;
    const timeout = AbortSignal.timeout(this.#timeoutMs);
    try {
      const response = await fetch(`${this.#url}/tables`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ path, name }),
        signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
      });
      if (!response.ok) {
        log('warn', 'ocr.camelot_failed', { status: response.status });
        return empty;
      }
      const payload = (await response.json()) as CamelotPayload;
      if (payload.available === false) {
        log('info', 'ocr.camelot_unavailable', {
          reason: typeof payload.reason === 'string' ? payload.reason.slice(0, 200) : null,
        });
        return empty;
      }
      const tables = Array.isArray(payload.tables)
        ? payload.tables
            .map(normalizeTable)
            .filter((table): table is CamelotTable => table !== null)
        : [];
      return { tables, truncated: payload.truncated === true };
    } catch (error) {
      if (signal?.aborted) return empty;
      log('warn', 'ocr.camelot_failed', {
        message: error instanceof Error ? error.message.slice(0, 200) : String(error),
      });
      return empty;
    }
  }
}

function normalizedTableText(rows: readonly string[][]): string {
  return rows.flat().join('').replace(/\s+/g, '').toLowerCase();
}

function uniqueId(pageNumber: number, index: number, existing: Set<string>): string {
  let candidate = `camelot-p${pageNumber}-t${index}`;
  let suffix = 1;
  while (existing.has(candidate)) {
    candidate = `camelot-p${pageNumber}-t${index}-${suffix}`;
    suffix += 1;
  }
  existing.add(candidate);
  return candidate;
}

/**
 * Merge Camelot tables as DIR evidence. Existing table blocks win when their
 * normalized cell text matches; nothing here rewrites the engine's raw text.
 */
export function mergeCamelotTables(
  document: DocumentIr,
  tables: readonly CamelotTable[],
): DocumentIr {
  if (tables.length === 0) return document;
  const pages = document.pages.map((page) => ({ ...page, blocks: [...page.blocks] }));
  const existing = new Set(pages.flatMap((page) => page.blocks.map((block) => block.id)));
  const addedIds: string[] = [];
  let added = 0;
  for (const table of tables) {
    const page = pages.find((entry) => entry.number === table.page);
    if (!page) continue;
    const fingerprint = normalizedTableText(table.rows);
    if (!fingerprint) continue;
    const duplicate = page.blocks.some(
      (block) => block.type === 'table' && normalizedTableText(block.rows ?? []) === fingerprint,
    );
    if (duplicate) continue;
    const block: DocumentBlock = {
      id: uniqueId(table.page, added, existing),
      type: 'table',
      text: table.rows.map((row) => row.join('\t')).join('\n'),
      bbox: table.bbox,
      confidence: null,
      source: { engine: 'camelot', model: table.flavor, stage: 'camelot' },
      validation: null,
      order: page.blocks.length,
      rows: table.rows.map((row) => [...row]),
      meta: { camelot: true, flavor: table.flavor },
    };
    page.blocks.push(block);
    addedIds.push(block.id);
    added += 1;
  }
  if (added === 0) return document;
  const readingOrder =
    document.readingOrder.length > 0
      ? [...document.readingOrder, ...addedIds]
      : pages.flatMap((page) => page.blocks.map((block) => block.id));
  return {
    ...document,
    pages,
    readingOrder,
    meta: { ...document.meta, camelot: { tables: added } },
  };
}
