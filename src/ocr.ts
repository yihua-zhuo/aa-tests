import { createHash } from 'node:crypto';
import { extname } from 'node:path';
import type {
  DocumentBBox,
  DocumentBlock,
  DocumentBlockType,
  DocumentIr,
  DocumentPage,
  DocumentPageMeta,
  DocumentSource,
  DocumentTableCell,
  DocumentValidation,
  OcrChannel,
  OcrEngine,
  OcrInkGap,
  OcrMode,
  OcrModelRuntime,
  OcrOrientationSignal,
  OcrPreflight,
  OcrRegionInput,
  OcrRegionResult,
  OcrRoute,
} from '../shared/types.ts';
import { positiveIntEnv } from './db.ts';
import { refineDocumentIr } from './document-ir.ts';
import {
  SpecializedClient,
  type SpecializedRegionInput,
  VlmClient,
  type VlmRegionInput,
} from './ocr-adapters.ts';
import { CamelotClient, mergeCamelotTables } from './ocr-camelot.ts';
import { annotateTableMetadata } from './ocr-tables.ts';

const PADDLE_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.bmp',
  '.tif',
  '.tiff',
  '.pdf',
]);
const DOCLING_EXTENSIONS = new Set(['.docx', '.xlsx', '.pptx']);
/** Formats Docling can read as a second engine, including PDFs and page images. */
const DOCLING_CANDIDATE_EXTENSIONS = new Set([
  '.pdf',
  '.png',
  '.jpg',
  '.jpeg',
  '.tif',
  '.tiff',
  '.bmp',
  '.webp',
  ...DOCLING_EXTENSIONS,
]);
/** Sidecar statuses caused by the input itself; retrying cannot succeed. */
const PERMANENT_INPUT_STATUSES = new Set([400, 409, 413, 415, 422]);

const HEALTH_TIMEOUT_MS = 5_000;
const MODEL_TTL_MS = 5 * 60_000;
const MODEL_FAILURE_TTL_MS = 30_000;

const CACHE_ENV_PREFIXES = [
  'OCR_LANGS',
  'OCR_MODES',
  'OCR_MODEL',
  'OCR_PADDLE_',
  'OCR_PDF_',
  'OCR_PREPROCESS_',
  'OCR_CASCADE_',
  'OCR_REGION_',
  'OCR_CELL_',
  'OCR_VLM_',
  'OCR_SPECIALIZED_',
  'OCR_HYBRID_',
  'OCR_MAX_',
  'OCR_CHANNELS',
  'OCR_CONTROL_MODEL',
  'OCR_GREY_',
];

/**
 * Fingerprint every setting that can change OCR output but is not part of the
 * engine/model label. Cached text is reusable only when this hash matches.
 * URLs, tokens and review/gate tuning are excluded: they do not alter text.
 */
export function ocrConfigFingerprint(env: NodeJS.ProcessEnv = process.env): string {
  const entries = Object.keys(env)
    .filter(
      (key) =>
        CACHE_ENV_PREFIXES.some((prefix) => key.startsWith(prefix)) &&
        !key.endsWith('_URL') &&
        !key.endsWith('_TOKEN'),
    )
    .sort()
    .map((key) => `${key}=${env[key] ?? ''}`);
  return createHash('sha256').update(entries.join('\n')).digest('hex').slice(0, 16);
}

/**
 * Images and PDFs go through PaddleOCR (layout-aware page images), Office
 * documents go through Docling. Plain text formats are skipped entirely.
 */
export function ocrEngineFor(name: string): OcrEngine | null {
  const extension = extname(name).toLowerCase();
  if (PADDLE_EXTENSIONS.has(extension)) return 'paddle';
  if (DOCLING_EXTENSIONS.has(extension)) return 'docling';
  return null;
}

/**
 * Engines other than the primary that can read this file. Paddle owns images
 * and PDFs; Docling owns Office but can also parse PDFs and OCR page images,
 * which makes it the only cross-engine candidate today.
 */
export function ocrCandidateEnginesFor(name: string, primary: OcrEngine): OcrEngine[] {
  const extension = extname(name).toLowerCase();
  const support: Record<OcrEngine, ReadonlySet<string>> = {
    paddle: PADDLE_EXTENSIONS,
    docling: DOCLING_CANDIDATE_EXTENSIONS,
  };
  return (Object.keys(support) as OcrEngine[]).filter(
    (engine) => engine !== primary && support[engine].has(extension),
  );
}

export type OcrExtraction = {
  text: string;
  /** Engine output before display normalization; exact matching uses this. */
  rawText?: string;
  /** Display label, e.g. `PP-OCRv6-medium+pdf-text`. */
  engine: string;
  /** Base engine model used for cache validation, e.g. `PP-OCRv6-medium@dir1`. */
  model: string | null;
  confidence: number | null;
  pages: number;
  truncated: boolean;
  /** Native objects, visual OCR, or a mix. */
  route: OcrRoute | null;
  /** Unified document representation when the sidecar supports it. */
  document: DocumentIr | null;
  /** Image quality measured before OCR when the sidecar supports it. */
  preflight?: OcrPreflight | null;
  /** Model file fingerprint used in the cache key, when the sidecar reports it. */
  modelSha256?: string | null;
  /** Python/Paddle/CUDA versions captured with this extraction. */
  runtime?: OcrModelRuntime | null;
  /** Camelot table augmentation, when the optional service returned tables. */
  camelot?: {
    tables: number;
    seconds: number;
    model: string | null;
    truncated?: boolean;
  } | null;
};

export type OcrInput = {
  path: string;
  name: string;
  /** auto | table | structure | enhanced; unsupported modes fall back. */
  mode?: OcrMode;
  /** PDF render DPI override; ignored for images. */
  dpi?: number;
  /** Photometric channel for visual OCR; default rgb. */
  channel?: OcrChannel;
  /** Recognizer language hint selected by the explainable router. */
  lang?: string;
  /** Optional named detector/recognizer profile from the sidecar. */
  model?: string;
};

export type OcrClientOptions = {
  paddleUrl?: string;
  doclingUrl?: string;
  token?: string;
  timeoutMs?: number;
  maxCharacters?: number;
  camelotUrl?: string;
  camelotToken?: string;
  camelotTimeoutMs?: number;
  vlmUrl?: string;
  vlmToken?: string;
  vlmModel?: string;
  vlmTimeoutMs?: number;
  specializedUrl?: string;
  specializedToken?: string;
  specializedModel?: string;
  specializedTimeoutMs?: number;
};

type SidecarPayload = {
  text?: unknown;
  rawText?: unknown;
  engine?: unknown;
  model?: unknown;
  pipeline?: unknown;
  runtime?: unknown;
  modelSha256?: unknown;
  model_sha256?: unknown;
  modelProfile?: unknown;
  model_profile?: unknown;
  modelProfiles?: unknown;
  model_profiles?: unknown;
  python?: unknown;
  paddle?: unknown;
  cuda?: unknown;
  confidence?: unknown;
  pages?: unknown;
  truncated?: unknown;
  route?: unknown;
  document?: unknown;
  preflight?: unknown;
  seconds?: unknown;
  error?: unknown;
  message?: unknown;
};

const ROUTES = new Set<OcrRoute>(['native', 'visual', 'hybrid']);
const BLOCK_TYPES = new Set<DocumentBlockType>([
  'paragraph',
  'heading',
  'table',
  'formula',
  'chart',
  'handwriting',
  'stamp',
  'signature',
  'header',
  'footer',
  'image',
]);
const SOURCE_STAGES = new Set<DocumentSource['stage']>(['native', 'visual', 'recovery', 'vlm']);
const PAGE_LIMIT = 200;
const BLOCK_LIMIT = 3_000;
const CELL_LIMIT = 5_000;
const INK_GAP_LIMIT = 24;
const MAX_TEXT = 100_000;

type ModelCacheEntry = { model: string | null; expiresAt: number };

function normalizeBase(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed.replace(/\/+$/, '') : null;
}

const SIDECAR_ERROR_LABELS: ReadonlyArray<[string, string]> = [
  ['password_required', 'PDF 已加密，需要密码后才能读取（不会重复重试）'],
];

function errorMessage(payload: SidecarPayload, status: number): string {
  const message =
    typeof payload.error === 'string'
      ? payload.error
      : typeof payload.message === 'string'
        ? payload.message
        : null;
  if (!message) return `OCR 服务返回 HTTP ${status}`;
  const label = SIDECAR_ERROR_LABELS.find(([code]) => message.startsWith(code))?.[1];
  return `OCR 服务：${label ?? message}`;
}

function confidenceOf(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.min(1, Math.max(0, value));
}

function pagesOf(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return 0;
  return Math.min(100_000, Math.floor(value));
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function textValue(value: unknown, max = MAX_TEXT): string {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

export function parseOcrRoute(value: unknown): OcrRoute | null {
  return typeof value === 'string' && ROUTES.has(value as OcrRoute) ? (value as OcrRoute) : null;
}

function parseBBox(value: unknown): DocumentBBox | null {
  const raw = asRecord(value);
  if (!raw) return null;
  const x = finiteNumber(raw.x);
  const y = finiteNumber(raw.y);
  const width = finiteNumber(raw.width);
  const height = finiteNumber(raw.height);
  return x === null || y === null || width === null || height === null
    ? null
    : { x, y, width, height };
}

function parseSource(value: unknown, fallbackStage: DocumentSource['stage']): DocumentSource {
  const raw = asRecord(value);
  const stage = raw?.stage;
  return {
    engine: textValue(raw?.engine, 80) || 'sidecar',
    model: textValue(raw?.model, 120) || null,
    stage:
      typeof stage === 'string' && SOURCE_STAGES.has(stage as DocumentSource['stage'])
        ? (stage as DocumentSource['stage'])
        : fallbackStage,
  };
}

function parseValidation(value: unknown): DocumentValidation | null {
  const raw = asRecord(value);
  if (!raw) return null;
  const status = raw.status;
  if (status !== 'passed' && status !== 'flagged' && status !== 'failed') return null;
  const issues = Array.isArray(raw.issues)
    ? raw.issues.filter((item): item is string => typeof item === 'string').slice(0, 20)
    : [];
  return { status, issues };
}

function parseRows(value: unknown): string[][] | undefined {
  if (!Array.isArray(value)) return undefined;
  const rows = value
    .slice(0, 1_000)
    .map((row) =>
      Array.isArray(row) ? row.slice(0, 200).map((cell) => textValue(cell, 20_000)) : [],
    );
  return rows.length > 0 ? rows : undefined;
}

function parseCells(value: unknown): DocumentTableCell[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const cells: DocumentTableCell[] = [];
  for (const item of value.slice(0, CELL_LIMIT)) {
    const raw = asRecord(item);
    if (!raw) continue;
    const row = finiteNumber(raw.row);
    const column = finiteNumber(raw.column);
    if (row === null || column === null) continue;
    const cell: DocumentTableCell = {
      row: Math.max(0, Math.floor(row)),
      column: Math.max(0, Math.floor(column)),
      text: textValue(raw.text, 20_000),
    };
    const rowSpan = finiteNumber(raw.rowSpan);
    const columnSpan = finiteNumber(raw.columnSpan);
    const bbox = parseBBox(raw.bbox);
    const confidence = confidenceOf(raw.confidence);
    if (rowSpan !== null && rowSpan > 0) cell.rowSpan = Math.floor(rowSpan);
    if (columnSpan !== null && columnSpan > 0) cell.columnSpan = Math.floor(columnSpan);
    if (bbox) cell.bbox = bbox;
    if (confidence !== null) cell.confidence = confidence;
    cells.push(cell);
  }
  return cells.length > 0 ? cells : undefined;
}

/**
 * Page-level observations are opt-in: unknown keys stay unknown. An empty
 * `inkGaps` list means the page was analyzed and nothing was left unexplained,
 * which is different from the analysis never running. Entries the payload could
 * not describe are counted in `inkGapsDropped`, because silently losing one would
 * turn "we could not read this gap" into "there is no gap".
 */
function parsePageMeta(value: unknown, page: number): DocumentPageMeta | undefined {
  const gaps = asRecord(value)?.inkGaps;
  if (!Array.isArray(gaps)) return undefined;
  const inkGaps: OcrInkGap[] = [];
  let dropped = 0;
  for (const item of gaps) {
    const entry = asRecord(item);
    const bbox = entry ? parseBBox(entry.bbox) : null;
    const pixels = entry ? finiteNumber(entry.pixels) : null;
    if (!entry || !bbox || pixels === null || pixels < 1) {
      dropped += 1;
      continue;
    }
    if (inkGaps.length >= INK_GAP_LIMIT) {
      dropped += 1;
      continue;
    }
    const density = finiteNumber(entry.density);
    // Gap ids are only unique per page, so the fallback has to be page-scoped too.
    const id = textValue(entry.id, 40) || `p${page}-g${inkGaps.length}`;
    inkGaps.push({
      id,
      kind: entry.kind === 'cell' ? 'cell' : 'region',
      blockId: typeof entry.blockId === 'string' ? textValue(entry.blockId, 60) : null,
      bbox,
      pixels: Math.floor(pixels),
      density: density === null ? 0 : Math.max(0, Math.min(1, density)),
    });
  }
  return dropped > 0 ? { inkGaps, inkGapsDropped: dropped } : { inkGaps };
}

function parseBlock(value: unknown, index: number): DocumentBlock | null {
  const raw = asRecord(value);
  if (!raw) return null;
  const type = raw.type;
  const order = finiteNumber(raw.order);
  const block: DocumentBlock = {
    id: textValue(raw.id, 120) || `b${index}`,
    type:
      typeof type === 'string' && BLOCK_TYPES.has(type as DocumentBlockType)
        ? (type as DocumentBlockType)
        : 'paragraph',
    text: textValue(raw.text),
    bbox: parseBBox(raw.bbox),
    confidence: confidenceOf(raw.confidence),
    source: parseSource(raw.source, 'visual'),
    validation: parseValidation(raw.validation),
    order: order === null ? index : order,
  };
  const rows = parseRows(raw.rows);
  const cells = parseCells(raw.cells);
  const meta = asRecord(raw.meta);
  if (rows) block.rows = rows;
  if (cells) block.cells = cells;
  if (meta) block.meta = meta;
  return block;
}

function parseDocumentIr(value: unknown): DocumentIr | null {
  const raw = asRecord(value);
  if (raw?.version !== 1 || !Array.isArray(raw.pages)) return null;
  const pages: DocumentPage[] = [];
  for (const item of raw.pages.slice(0, PAGE_LIMIT)) {
    const page = asRecord(item);
    if (!page) continue;
    const number = finiteNumber(page.number);
    const pageNumber = number !== null && number >= 1 ? Math.floor(number) : pages.length + 1;
    const blocks = Array.isArray(page.blocks)
      ? page.blocks
          .slice(0, BLOCK_LIMIT)
          .map((block, index) => parseBlock(block, index))
          .filter((block): block is DocumentBlock => block !== null)
      : [];
    pages.push({
      number: pageNumber,
      width: finiteNumber(page.width),
      height: finiteNumber(page.height),
      blocks,
      source: page.source ? parseSource(page.source, 'native') : null,
      meta: parsePageMeta(page.meta, pageNumber),
    });
  }
  if (pages.length === 0) return null;
  const readingOrder = Array.isArray(raw.readingOrder)
    ? raw.readingOrder.filter((item): item is string => typeof item === 'string').slice(0, 20_000)
    : [];
  return {
    version: 1,
    route: parseOcrRoute(raw.route) ?? 'visual',
    pages,
    readingOrder,
    meta: asRecord(raw.meta) ?? {},
  };
}

function parseOrientation(value: unknown): OcrOrientationSignal | null {
  const raw = asRecord(value);
  if (!raw) return null;
  const applied = finiteNumber(raw.applied);
  return {
    exif: finiteNumber(raw.exif),
    applied: applied === null ? 0 : applied,
    aspect: finiteNumber(raw.aspect),
    uncertain: raw.uncertain === true,
  };
}

function parsePreflight(value: unknown): OcrPreflight | null {
  const raw = asRecord(value);
  if (!raw) return null;
  const pick = (key: string): number | null => {
    const number = finiteNumber(raw[key]);
    return number === null ? null : number;
  };
  const core = {
    width: pick('width'),
    height: pick('height'),
    sharpness: pick('sharpness'),
    brightness: pick('brightness'),
    contrast: pick('contrast'),
    dpi: pick('dpi'),
  };
  const issues = Array.isArray(raw.issues)
    ? raw.issues.filter((item): item is string => typeof item === 'string').slice(0, 20)
    : [];
  const orientation = parseOrientation(raw.orientation);
  const retakeRaw = asRecord(raw.retake);
  const retake = retakeRaw
    ? {
        required: retakeRaw.required === true,
        reasons: Array.isArray(retakeRaw.reasons)
          ? retakeRaw.reasons
              .filter((item): item is string => typeof item === 'string')
              .slice(0, 20)
          : [],
      }
    : null;
  const preflight: OcrPreflight = {
    ...core,
    shadow: pick('shadow'),
    glare: pick('glare'),
    noise: pick('noise'),
    colorfulness: pick('colorfulness'),
    skew: pick('skew'),
    orientation,
    issues,
    retake,
  };
  const hasCore = Object.values(core).some((item) => item !== null);
  return hasCore || issues.length > 0 || orientation !== null || retake?.required === true
    ? preflight
    : null;
}

/**
 * Cache key includes the sidecar post-processing version, runtime version and,
 * when reported, the model file SHA256. A model replaced under the same name
 * therefore cannot reuse old attachments.
 */
function cacheModel(
  model: string | null,
  pipeline: unknown,
  runtime: unknown,
  modelSha256: unknown,
): string | null {
  if (!model) return null;
  const parts = [model];
  for (const value of [pipeline, runtime, modelSha256]) {
    const version = typeof value === 'string' ? value.trim() : '';
    if (version) parts.push(version);
  }
  return parts.join('@');
}

function stringField(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function runtimeInfo(
  engine: OcrEngine,
  payload: SidecarPayload,
  model: string | null,
): OcrModelRuntime | null {
  const pipeline = stringField(payload.pipeline);
  const runtime = stringField(payload.runtime);
  const modelSha256 = stringField(payload.modelSha256) ?? stringField(payload.model_sha256);
  if (!model && !pipeline && !runtime && !modelSha256) return null;
  return {
    engine,
    model,
    modelSha256,
    pipeline,
    runtime,
    python: stringField(payload.python),
    paddle: stringField(payload.paddle),
    cuda: stringField(payload.cuda),
  };
}

export function displayModelName(model: string | null): string | null {
  return model ? (model.split('@')[0] ?? model) : null;
}

/** 4xx responses usually mean a bad file or configuration, so retrying won't help. */
export class OcrClientError extends Error {
  readonly permanent: boolean;

  constructor(message: string, permanent: boolean) {
    super(message);
    this.name = 'OcrClientError';
    this.permanent = permanent;
  }
}

export class OcrClient {
  readonly #endpoints: Record<OcrEngine, string | null>;
  readonly #token: string | null;
  readonly #timeoutMs: number;
  readonly #maxCharacters: number;
  readonly #modelCache = new Map<OcrEngine, ModelCacheEntry>();
  readonly #modelPending = new Map<OcrEngine, Promise<string | null>>();
  readonly #runtimeCache = new Map<OcrEngine, { info: OcrModelRuntime; expiresAt: number }>();
  readonly #profileCache = new Map<OcrEngine, { names: string[]; expiresAt: number }>();
  readonly #camelot: CamelotClient;
  readonly #vlm: VlmClient;
  readonly #specialized: SpecializedClient;

  constructor(options: OcrClientOptions = {}) {
    this.#endpoints = {
      paddle: normalizeBase(options.paddleUrl ?? process.env.OCR_PADDLE_URL),
      docling: normalizeBase(options.doclingUrl ?? process.env.OCR_DOCLING_URL),
    };
    const token = options.token ?? process.env.OCR_TOKEN;
    this.#token = token?.trim() ? token.trim() : null;
    this.#timeoutMs = options.timeoutMs ?? positiveIntEnv('OCR_TIMEOUT_SECONDS', 300) * 1_000;
    this.#maxCharacters = options.maxCharacters ?? positiveIntEnv('OCR_MAX_CHARACTERS', 500_000);
    this.#camelot = new CamelotClient({
      url: options.camelotUrl,
      token: options.camelotToken,
      timeoutMs: options.camelotTimeoutMs,
    });
    this.#vlm = new VlmClient({
      url: options.vlmUrl,
      token: options.vlmToken,
      model: options.vlmModel,
      timeoutMs: options.vlmTimeoutMs,
    });
    this.#specialized = new SpecializedClient({
      url: options.specializedUrl,
      token: options.specializedToken,
      model: options.specializedModel,
      timeoutMs: options.specializedTimeoutMs,
    });
  }

  get engines(): OcrEngine[] {
    return (Object.keys(this.#endpoints) as OcrEngine[]).filter((engine) =>
      Boolean(this.#endpoints[engine]),
    );
  }

  get configured(): boolean {
    return this.engines.length > 0;
  }

  supports(engine: OcrEngine): boolean {
    return this.#endpoints[engine] !== null;
  }

  /** Configured engines that can read the same file as a candidate. */
  candidatesFor(engine: OcrEngine, name: string): OcrEngine[] {
    return ocrCandidateEnginesFor(name, engine).filter((candidate) => this.supports(candidate));
  }

  get timeoutMs(): number {
    return this.#timeoutMs;
  }

  get vlmConfigured(): boolean {
    return this.#vlm.configured;
  }

  get specializedConfigured(): boolean {
    return this.#specialized.configured;
  }

  /** Optional VLM repair for one problem region; never rewrites stored text. */
  async repairRegion(input: VlmRegionInput, signal?: AbortSignal): Promise<OcrRegionResult> {
    const result = await this.#vlm.repair(input, signal);
    return {
      text: result.text.slice(0, this.#maxCharacters),
      confidence: result.confidence,
      engine: result.engine,
      model: result.model,
      seconds: result.seconds,
    };
  }

  /** Optional chart/handwriting/stamp/signature recognizer for one region. */
  async recognizeSpecial(
    input: SpecializedRegionInput,
    signal?: AbortSignal,
  ): Promise<OcrRegionResult> {
    const result = await this.#specialized.recognize(input, signal);
    return {
      text: result.text.slice(0, this.#maxCharacters),
      confidence: result.confidence,
      engine: result.engine,
      model: result.model,
      seconds: result.seconds,
    };
  }

  /** Cached model only, without a health request; `null` when unknown. */
  peekModel(engine: OcrEngine): string | null {
    const cached = this.#modelCache.get(engine);
    return cached && cached.expiresAt > Date.now() ? cached.model : null;
  }

  /** Last health/runtime fingerprint for an engine; `null` when unknown. */
  async runtimeFor(engine: OcrEngine): Promise<OcrModelRuntime | null> {
    const cached = this.#runtimeCache.get(engine);
    if (cached && cached.expiresAt > Date.now()) return cached.info;
    const base = this.#endpoints[engine];
    if (!base) return null;
    const headers: Record<string, string> = {};
    if (this.#token) headers['x-ocr-token'] = this.#token;
    try {
      const response = await fetch(`${base}/health`, {
        headers,
        signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = (await response.json()) as SidecarPayload;
      const rawModel = stringField(payload.model);
      const info = runtimeInfo(engine, payload, rawModel);
      if (info) this.#runtimeCache.set(engine, { info, expiresAt: MODEL_TTL_MS });
      return info;
    } catch {
      return null;
    }
  }

  /**
   * Base model currently loaded by the sidecar. Cached reuse is only trusted
   * for extractions produced by this exact model; `null` disables reuse.
   */
  async modelFor(engine: OcrEngine): Promise<string | null> {
    const cached = this.#modelCache.get(engine);
    if (cached && cached.expiresAt > Date.now()) return cached.model;
    const pending = this.#modelPending.get(engine);
    if (pending) return pending;
    const base = this.#endpoints[engine];
    if (!base) return null;

    const task = (async () => {
      try {
        const headers: Record<string, string> = {};
        if (this.#token) headers['x-ocr-token'] = this.#token;
        const response = await fetch(`${base}/health`, {
          headers,
          signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const payload = (await response.json()) as SidecarPayload;
        const rawModel = stringField(payload.model);
        const model = cacheModel(
          rawModel,
          payload.pipeline,
          payload.runtime,
          payload.modelSha256 ?? payload.model_sha256,
        );
        const info = runtimeInfo(engine, payload, rawModel);
        if (info) this.#runtimeCache.set(engine, { info, expiresAt: MODEL_TTL_MS });
        this.#rememberModel(engine, model, model ? MODEL_TTL_MS : MODEL_FAILURE_TTL_MS);
        return model;
      } catch {
        this.#rememberModel(engine, null, MODEL_FAILURE_TTL_MS);
        return null;
      } finally {
        this.#modelPending.delete(engine);
      }
    })();
    this.#modelPending.set(engine, task);
    return task;
  }

  #rememberModel(engine: OcrEngine, model: string | null, ttlMs: number): void {
    this.#modelCache.set(engine, { model, expiresAt: Date.now() + ttlMs });
  }

  /** Named model profiles advertised by the sidecar; empty when unsupported. */
  async profilesFor(engine: OcrEngine): Promise<string[]> {
    const cached = this.#profileCache.get(engine);
    if (cached && cached.expiresAt > Date.now()) return cached.names;
    const base = this.#endpoints[engine];
    if (!base) return [];
    try {
      const headers: Record<string, string> = {};
      if (this.#token) headers['x-ocr-token'] = this.#token;
      const response = await fetch(`${base}/health`, {
        headers,
        signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = (await response.json()) as SidecarPayload;
      const raw = payload.modelProfiles ?? payload.model_profiles;
      const names = Array.isArray(raw)
        ? raw.filter((item): item is string => typeof item === 'string' && item.trim() !== '')
        : [];
      this.#profileCache.set(engine, { names, expiresAt: MODEL_TTL_MS });
      return names;
    } catch {
      this.#profileCache.set(engine, { names: [], expiresAt: MODEL_FAILURE_TTL_MS });
      return [];
    }
  }

  async extract(engine: OcrEngine, input: OcrInput, signal?: AbortSignal): Promise<OcrExtraction> {
    const base = this.#endpoints[engine];
    if (!base) throw new Error(`未配置 ${engine} OCR 服务`);

    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.#token) headers['x-ocr-token'] = this.#token;
    const timeout = AbortSignal.timeout(this.#timeoutMs);

    const response = await fetch(`${base}/extract`, {
      method: 'POST',
      headers,
      body: JSON.stringify(input),
      signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
    });
    const raw = await response.text();
    let payload: SidecarPayload = {};
    try {
      payload = raw ? (JSON.parse(raw) as SidecarPayload) : {};
    } catch {
      // Non-JSON error bodies still need to surface usefully.
    }

    if (!response.ok) {
      throw new OcrClientError(
        errorMessage(payload, response.status),
        PERMANENT_INPUT_STATUSES.has(response.status),
      );
    }
    if (typeof payload.text !== 'string' || !payload.text.trim()) {
      throw new Error('OCR 服务未返回文本');
    }

    const cut = payload.text.length > this.#maxCharacters;
    // Truncation is metadata (`truncated` below), never an in-band note that
    // search, field matching or CER evaluation would read as document content.
    const text = cut ? payload.text.slice(0, this.#maxCharacters) : payload.text;
    const payloadRaw = stringField(payload.rawText);
    const rawText = (payloadRaw ?? text).slice(0, this.#maxCharacters);
    const rawModel = stringField(payload.model);
    const modelSha256 = stringField(payload.modelSha256) ?? stringField(payload.model_sha256);
    const model = cacheModel(rawModel, payload.pipeline, payload.runtime, modelSha256);
    // Explicit modes may run a separate pipeline model; only the base
    // extraction refreshes the model used to validate auto-mode cache entries.
    const baseMode = !input.mode || input.mode === 'auto';
    if (model && baseMode) this.#rememberModel(engine, model, MODEL_TTL_MS);
    const info = runtimeInfo(engine, payload, rawModel);
    if (info && baseMode) this.#runtimeCache.set(engine, { info, expiresAt: MODEL_TTL_MS });
    const parsed = parseDocumentIr(payload.document);
    let document = parsed ? refineDocumentIr(annotateTableMetadata(parsed)) : null;
    let camelot: OcrExtraction['camelot'] = null;
    if (document && this.#camelot.configured && extname(input.name).toLowerCase() === '.pdf') {
      const started = Date.now();
      const result = await this.#camelot.tables(input.path, input.name, signal);
      const tables = result.tables;
      if (tables.length > 0) {
        const merged = mergeCamelotTables(document, tables);
        if (merged !== document) {
          document = refineDocumentIr(annotateTableMetadata(merged));
          camelot = {
            tables: tables.length,
            seconds: Math.max(0.1, Math.round((Date.now() - started) / 100) / 10),
            model: tables[0]?.flavor ?? null,
            truncated: result.truncated,
          };
        }
      }
    }

    return {
      text,
      rawText,
      engine: typeof payload.engine === 'string' ? payload.engine : engine,
      model,
      confidence: confidenceOf(payload.confidence),
      pages: pagesOf(payload.pages),
      truncated: payload.truncated === true || cut || Boolean(camelot?.truncated),
      route: parseOcrRoute(payload.route),
      document,
      preflight: parsePreflight(payload.preflight),
      modelSha256,
      runtime: info,
      camelot,
    };
  }

  /**
   * Re-recognize one region (block bbox) from the original file. Used for
   * key fields and low-confidence lines; the result is a candidate and never
   * replaces the initial text automatically.
   */
  async extractRegion(
    engine: OcrEngine,
    input: OcrRegionInput,
    signal?: AbortSignal,
  ): Promise<OcrRegionResult> {
    const base = this.#endpoints[engine];
    if (!base) throw new Error(`未配置 ${engine} OCR 服务`);

    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.#token) headers['x-ocr-token'] = this.#token;
    const timeout = AbortSignal.timeout(this.#timeoutMs);
    const response = await fetch(`${base}/extract-region`, {
      method: 'POST',
      headers,
      body: JSON.stringify(input),
      signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
    });
    const raw = await response.text();
    let payload: SidecarPayload = {};
    try {
      payload = raw ? (JSON.parse(raw) as SidecarPayload) : {};
    } catch {
      // Non-JSON error bodies still need to surface usefully.
    }
    if (!response.ok) {
      throw new OcrClientError(
        errorMessage(payload, response.status),
        PERMANENT_INPUT_STATUSES.has(response.status),
      );
    }
    if (typeof payload.text !== 'string' || !payload.text.trim()) {
      throw new Error('区域识别未返回文本');
    }
    const seconds = finiteNumber(payload.seconds);
    return {
      text: payload.text.slice(0, this.#maxCharacters),
      confidence: confidenceOf(payload.confidence),
      engine: typeof payload.engine === 'string' ? payload.engine : engine,
      model:
        typeof payload.model === 'string' && payload.model.trim() ? payload.model.trim() : null,
      seconds: seconds === null ? 0 : Math.max(0, seconds),
    };
  }
}
