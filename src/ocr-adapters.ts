import type { DocumentBBox, DocumentFieldKind, DocumentSpecializedType } from '../shared/types.ts';
import { positiveIntEnv } from './db.ts';

export type RemoteRegionResult = {
  text: string;
  confidence: number | null;
  model: string | null;
  seconds: number;
  engine: string;
};

export type VlmRegionInput = {
  path: string;
  name: string;
  page: number;
  bbox: DocumentBBox;
  kind?: DocumentFieldKind | string | null;
  padding?: number;
  /** Original recognized text, so the model can repair rather than re-invent. */
  context?: string | null;
};

export type SpecializedRegionInput = {
  path: string;
  name: string;
  page: number;
  bbox: DocumentBBox;
  type: DocumentSpecializedType;
};

type RemotePayload = {
  text?: unknown;
  confidence?: unknown;
  model?: unknown;
  engine?: unknown;
  seconds?: unknown;
  error?: unknown;
  message?: unknown;
};

function baseUrl(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed.replace(/\/+$/, '') : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function numericOrNull(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.min(parsed, 1);
}

function secondsOrNull(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.round(parsed * 1000) / 1000;
}

async function postJson(
  url: string,
  path: string,
  token: string | null,
  timeoutMs: number,
  body: unknown,
  signal: AbortSignal | undefined,
  label: string,
): Promise<RemoteRegionResult> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers['x-ocr-token'] = token;
  const timeout = AbortSignal.timeout(timeoutMs);
  const response = await fetch(`${url}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
  });
  const raw = await response.text();
  let payload: RemotePayload = {};
  try {
    payload = raw ? (JSON.parse(raw) as RemotePayload) : {};
  } catch {
    // Non-JSON bodies surface through the status check below.
  }
  if (!response.ok) {
    const message =
      stringOrNull(payload.message) ?? stringOrNull(payload.error) ?? `HTTP ${response.status}`;
    throw new Error(`${label}: ${message.slice(0, 200)}`);
  }
  const text = typeof payload.text === 'string' ? payload.text.trim() : '';
  if (!text) throw new Error(`${label}: empty response`);
  return {
    text,
    confidence: numericOrNull(payload.confidence),
    model: stringOrNull(payload.model),
    seconds: secondsOrNull(payload.seconds) ?? 0,
    engine: stringOrNull(payload.engine) ?? label,
  };
}

/**
 * Optional HTTP adapter for a vision-language model that repairs a single
 * problem region. No model ships with this repository; without OCR_VLM_URL the
 * adapter is inert and the cascade keeps its local evidence only.
 */
export class VlmClient {
  readonly #url: string | null;
  readonly #token: string | null;
  readonly #model: string | null;
  readonly #timeoutMs: number;

  constructor(options: { url?: string; token?: string; model?: string; timeoutMs?: number } = {}) {
    this.#url = baseUrl(options.url ?? process.env.OCR_VLM_URL);
    this.#token = stringOrNull(options.token ?? process.env.OCR_VLM_TOKEN);
    this.#model = stringOrNull(options.model ?? process.env.OCR_VLM_MODEL);
    this.#timeoutMs = options.timeoutMs ?? positiveIntEnv('OCR_VLM_TIMEOUT_SECONDS', 45) * 1_000;
  }

  get configured(): boolean {
    return this.#url !== null;
  }

  async repair(input: VlmRegionInput, signal?: AbortSignal): Promise<RemoteRegionResult> {
    if (!this.#url) throw new Error('未配置 VLM 服务');
    return postJson(
      this.#url,
      '/repair',
      this.#token,
      this.#timeoutMs,
      {
        ...input,
        padding: input.padding ?? 0.35,
        model: this.#model,
      },
      signal,
      'vlm',
    );
  }
}

/**
 * Optional HTTP adapter for chart/handwriting/stamp/signature recognizers.
 * Results are advisory board evidence and never replace the OCR text.
 */
export class SpecializedClient {
  readonly #url: string | null;
  readonly #token: string | null;
  readonly #model: string | null;
  readonly #timeoutMs: number;

  constructor(options: { url?: string; token?: string; model?: string; timeoutMs?: number } = {}) {
    this.#url = baseUrl(options.url ?? process.env.OCR_SPECIALIZED_URL);
    this.#token = stringOrNull(options.token ?? process.env.OCR_SPECIALIZED_TOKEN);
    this.#model = stringOrNull(options.model ?? process.env.OCR_SPECIALIZED_MODEL);
    this.#timeoutMs =
      options.timeoutMs ?? positiveIntEnv('OCR_SPECIALIZED_TIMEOUT_SECONDS', 30) * 1_000;
  }

  get configured(): boolean {
    return this.#url !== null;
  }

  async recognize(
    input: SpecializedRegionInput,
    signal?: AbortSignal,
  ): Promise<RemoteRegionResult> {
    if (!this.#url) throw new Error('未配置专用区域识别服务');
    return postJson(
      this.#url,
      '/recognize',
      this.#token,
      this.#timeoutMs,
      { ...input, model: this.#model },
      signal,
      'specialized',
    );
  }
}
