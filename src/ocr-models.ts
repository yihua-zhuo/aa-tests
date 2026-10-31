import { createHash } from 'node:crypto';
import type {
  OcrGreyConfig,
  OcrGreyMode,
  OcrGreyPlan,
  OcrModelCapability,
  OcrRouteDecision,
  OcrRouteInput,
  OcrRouteReason,
  OcrScript,
  OcrScriptProfile,
} from '../shared/types.ts';

/**
 * Hand-curated capability matrix. Accuracy stays `null` until a benchmark run
 * measures it; the matrix is used to reason about routing, not to fabricate
 * precision. Memory figures are rough resident-set estimates for CPU inference.
 */
export const MODEL_CAPABILITIES: readonly OcrModelCapability[] = [
  {
    id: 'paddle-v6-medium',
    engine: 'paddle',
    label: 'PP-OCRv6 medium',
    detector: 'PP-OCRv6_medium_det',
    recognizer: 'PP-OCRv6_medium_rec',
    scripts: ['han', 'latin'],
    languages: ['ch', 'en'],
    documentTypes: ['scan', 'photo', 'pdf-text', 'table'],
    speed: 4,
    memoryMb: 1_200,
    accuracy: null,
    strengths: ['中英混排', '版面行级检测', '通用文档默认'],
    limitations: ['日文假名/韩文/阿拉伯文非默认覆盖'],
    license: 'Apache-2.0',
    notes: '默认模型组合；基准未测出前不声称绝对准确率。',
    numeric: true,
  },
  {
    id: 'paddle-v6-server',
    engine: 'paddle',
    label: 'PP-OCRv6 server',
    detector: 'PP-OCRv6_server_det',
    recognizer: 'PP-OCRv6_server_rec',
    scripts: ['han', 'latin'],
    languages: ['ch', 'en'],
    documentTypes: ['scan', 'photo', 'pdf-text', 'dense'],
    speed: 2,
    memoryMb: 2_600,
    accuracy: null,
    strengths: ['小字号/低对比度', '密集文本'],
    limitations: ['显存/内存与延迟更高'],
    license: 'Apache-2.0',
    notes: '灰度候选模型；高风险文档或基准验证后放量。',
    numeric: true,
  },
  {
    id: 'paddle-v6-tiny',
    engine: 'paddle',
    label: 'PP-OCRv6 tiny',
    detector: 'PP-OCRv6_tiny_det',
    recognizer: 'PP-OCRv6_tiny_rec',
    scripts: ['han', 'latin'],
    languages: ['ch', 'en'],
    documentTypes: ['scan', 'photo'],
    speed: 5,
    memoryMb: 600,
    accuracy: null,
    strengths: ['低延迟', '低内存'],
    limitations: ['低质量图像与长尾字符退化'],
    license: 'Apache-2.0',
    notes: '仅在质量信号良好时作为低成本候选。',
    numeric: true,
  },
  {
    id: 'paddle-v5-server',
    engine: 'paddle',
    label: 'PP-OCRv5 server',
    detector: 'PP-OCRv5_server_det',
    recognizer: 'PP-OCRv5_server_rec',
    scripts: ['han', 'latin'],
    languages: ['ch', 'en'],
    documentTypes: ['scan', 'photo', 'pdf-text'],
    speed: 2,
    memoryMb: 2_400,
    accuracy: null,
    strengths: ['上一代稳定基线', '兼容回滚'],
    limitations: ['新版本模型在多数场景更优'],
    license: 'Apache-2.0',
    notes: '回滚与对比基线。',
    numeric: true,
  },
  {
    id: 'paddle-japan',
    engine: 'paddle',
    label: 'PaddleOCR 日文',
    detector: 'PP-OCRv5_server_det',
    recognizer: 'japan_PP-OCRv4_mobile_rec',
    scripts: ['kana', 'han', 'latin'],
    languages: ['japan'],
    documentTypes: ['scan', 'photo'],
    speed: 3,
    memoryMb: 1_300,
    accuracy: null,
    strengths: ['假名与日文汉字'],
    limitations: ['中文专属符号/排版可能退化'],
    license: 'Apache-2.0',
    notes: '检测到假名后切换。',
    numeric: true,
  },
  {
    id: 'paddle-korean',
    engine: 'paddle',
    label: 'PaddleOCR 韩文',
    detector: 'PP-OCRv5_server_det',
    recognizer: 'korean_PP-OCRv4_mobile_rec',
    scripts: ['hangul', 'han', 'latin'],
    languages: ['korean'],
    documentTypes: ['scan', 'photo'],
    speed: 3,
    memoryMb: 1_300,
    accuracy: null,
    strengths: ['韩文音节'],
    limitations: ['中英混排默认模型可能更稳'],
    license: 'Apache-2.0',
    notes: '检测到韩文后切换。',
    numeric: true,
  },
  {
    id: 'paddle-arabic',
    engine: 'paddle',
    label: 'PaddleOCR 阿拉伯文',
    detector: 'PP-OCRv5_server_det',
    recognizer: 'arabic_PP-OCRv4_mobile_rec',
    scripts: ['arabic', 'latin'],
    languages: ['arabic'],
    documentTypes: ['scan', 'photo'],
    speed: 3,
    memoryMb: 1_300,
    accuracy: null,
    strengths: ['阿拉伯字母连写'],
    limitations: ['RTL 阅读顺序需版面模块配合'],
    license: 'Apache-2.0',
    notes: '检测到阿拉伯文后切换。',
    numeric: true,
  },
  {
    id: 'paddle-latin',
    engine: 'paddle',
    label: 'PaddleOCR 拉丁文',
    detector: 'PP-OCRv5_server_det',
    recognizer: 'latin_PP-OCRv3_rec',
    scripts: ['latin'],
    languages: ['en', 'latin'],
    documentTypes: ['scan', 'photo', 'form'],
    speed: 4,
    memoryMb: 1_100,
    accuracy: null,
    strengths: ['纯拉丁字母/重音字符'],
    limitations: ['中英混排不如中文模型'],
    license: 'Apache-2.0',
    notes: '纯拉丁文本时用于减少中文模型的字符集偏置。',
    numeric: true,
  },
  {
    id: 'paddle-cyrillic',
    engine: 'paddle',
    label: 'PaddleOCR 西里尔文',
    detector: 'PP-OCRv5_server_det',
    recognizer: 'cyrillic_PP-OCRv3_rec',
    scripts: ['cyrillic', 'latin'],
    languages: ['ru', 'cyrillic'],
    documentTypes: ['scan', 'photo'],
    speed: 4,
    memoryMb: 1_100,
    accuracy: null,
    strengths: ['西里尔字母'],
    limitations: ['拉丁/中文混排退化'],
    license: 'Apache-2.0',
    notes: '检测到西里尔文后切换。',
    numeric: true,
  },
  {
    id: 'paddle-structure-v3',
    engine: 'paddle',
    label: 'PP-StructureV3',
    detector: 'PP-StructureV3',
    recognizer: 'PP-StructureV3',
    scripts: ['han', 'latin'],
    languages: ['ch', 'en'],
    documentTypes: ['table', 'form', 'layout'],
    speed: 1,
    memoryMb: 3_200,
    accuracy: null,
    strengths: ['表格结构', '版面/阅读顺序'],
    limitations: ['速度慢', '纯正文无收益'],
    license: 'Apache-2.0',
    notes: '仅显式 table/structure 模式使用。',
    numeric: true,
  },
  {
    id: 'docling-office',
    engine: 'docling',
    label: 'Docling Office',
    detector: null,
    recognizer: 'Docling',
    scripts: ['han', 'latin', 'kana', 'hangul', 'arabic', 'cyrillic', 'other'],
    languages: ['multi'],
    documentTypes: ['docx', 'xlsx', 'pptx'],
    speed: 3,
    memoryMb: 1_800,
    accuracy: null,
    strengths: ['原生 Office 结构保留'],
    limitations: ['不处理扫描图像/PDF'],
    license: 'MIT',
    notes: '由文件类型决定，不参与脚本路由。',
    numeric: true,
  },
];

const SCRIPT_TESTS: { script: OcrScript; pattern: RegExp }[] = [
  { script: 'han', pattern: /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u },
  { script: 'kana', pattern: /[\u3040-\u30ff\u31f0-\u31ff]/u },
  { script: 'hangul', pattern: /[\u1100-\u11ff\u3130-\u318f\uac00-\ud7af]/u },
  { script: 'arabic', pattern: /[\u0600-\u06ff\u0750-\u077f\ufb50-\ufdff\ufe70-\ufeff]/u },
  { script: 'cyrillic', pattern: /[\u0400-\u04ff\u0500-\u052f]/u },
  { script: 'latin', pattern: /[A-Za-z\u00c0-\u024f\u1e00-\u1eff]/u },
];

const DIGIT = /\p{Nd}/u;
const LETTER = /\p{L}/u;

const DECLARED_LANGUAGES: Record<string, string> = {
  zh: 'ch',
  zho: 'ch',
  chi: 'ch',
  ch: 'ch',
  cn: 'ch',
  chinese: 'ch',
  'zh-cn': 'ch',
  'zh-hans': 'ch',
  'zh-tw': 'ch',
  'zh-hant': 'ch',
  en: 'en',
  eng: 'en',
  english: 'en',
  ja: 'japan',
  jp: 'japan',
  jpn: 'japan',
  japanese: 'japan',
  ko: 'korean',
  kor: 'korean',
  korean: 'korean',
  ar: 'arabic',
  ara: 'arabic',
  arabic: 'arabic',
  ru: 'ru',
  rus: 'ru',
  russian: 'ru',
  cyrillic: 'ru',
  latin: 'en',
  mixed: 'ch',
};

const NUMERIC_NAME =
  /invoice|receipt|statement|bill|bank|ledger|tax|amount|发票|账单|对账|结算|金额|报价|税单|流水/i;
const TABLE_NAME = /table|sheet|grid|表格|明细|清单/i;

function percent(part: number, total: number): number {
  return total > 0 ? part / total : 0;
}

function languageFor(profile: OcrScriptProfile): string {
  const counts = new Map(profile.scripts.map((item) => [item.script, item.characters]));
  if ((counts.get('kana') ?? 0) > 0) return 'japan';
  if ((counts.get('hangul') ?? 0) > 0) return 'korean';
  if ((counts.get('arabic') ?? 0) > 0) return 'arabic';
  if ((counts.get('cyrillic') ?? 0) > 0) return 'ru';
  // A Chinese recognizer already covers embedded Latin abbreviations.
  if ((counts.get('han') ?? 0) > 0) return 'ch';
  return 'en';
}

/** Character-level script profile; whitespace is ignored for ratios. */
export function profileScript(text: string): OcrScriptProfile {
  const counts: Record<OcrScript, number> = {
    han: 0,
    latin: 0,
    kana: 0,
    hangul: 0,
    arabic: 0,
    cyrillic: 0,
    other: 0,
  };
  let digits = 0;
  let symbols = 0;
  let letters = 0;
  for (const char of text) {
    if (/\s/u.test(char)) continue;
    if (DIGIT.test(char)) {
      digits += 1;
      continue;
    }
    if (!LETTER.test(char)) {
      symbols += 1;
      continue;
    }
    letters += 1;
    const found = SCRIPT_TESTS.find((item) => item.pattern.test(char));
    counts[found?.script ?? 'other'] += 1;
  }
  const scripts = (Object.entries(counts) as [OcrScript, number][])
    .filter(([, characters]) => characters > 0)
    .map(([script, characters]) => ({ script, characters }))
    .sort((left, right) => right.characters - left.characters);
  const total = letters + digits + symbols;
  const dominant = scripts[0]?.script ?? (digits > 0 ? 'latin' : 'other');
  const second = scripts[1]?.characters ?? 0;
  const mixed = second >= Math.max(2, Math.ceil(letters * 0.15));
  const profile: OcrScriptProfile = {
    dominant,
    mixed,
    scripts,
    letters,
    digits,
    symbols,
    numericRatio: percent(digits + symbols, total),
    language: 'en',
  };
  profile.language = languageFor(profile);
  return profile;
}

export function languageHintOf(value: string | null | undefined): string | null {
  const key = value?.trim().toLowerCase();
  return key ? (DECLARED_LANGUAGES[key] ?? null) : null;
}

export function modelById(id: string): OcrModelCapability | null {
  return MODEL_CAPABILITIES.find((model) => model.id === id) ?? null;
}

/**
 * Map a capability id onto a sidecar profile name. Profiles may be configured
 * with or without the `paddle-` prefix; an unknown model returns null so the
 * caller keeps the default instead of sending an invalid request.
 */
export function profileForModel(
  profiles: readonly string[],
  modelId: string | null | undefined,
): string | null {
  if (!modelId) return null;
  if (profiles.includes(modelId)) return modelId;
  const stripped = modelId.replace(/^paddle-/, '');
  return profiles.includes(stripped) ? stripped : null;
}

export function modelsForLanguage(language: string | null): OcrModelCapability[] {
  if (!language) {
    return MODEL_CAPABILITIES.filter(
      (model) => model.id === 'paddle-v6-medium' || model.id === 'paddle-v6-server',
    );
  }
  return MODEL_CAPABILITIES.filter(
    (model) => model.engine === 'paddle' && model.languages.includes(language),
  );
}

function primaryModel(
  engine: 'paddle' | 'docling',
  language: string | null,
  mode: string,
  numeric: boolean,
): OcrModelCapability {
  if (engine === 'docling') {
    return modelById('docling-office') ?? MODEL_CAPABILITIES[0]!;
  }
  if (mode === 'table' || mode === 'structure') {
    return modelById('paddle-structure-v3') ?? MODEL_CAPABILITIES[0]!;
  }
  const byLanguage = language ? modelsForLanguage(language) : [];
  if (language === 'japan') return modelById('paddle-japan') ?? byLanguage[0]!;
  if (language === 'korean') return modelById('paddle-korean') ?? byLanguage[0]!;
  if (language === 'arabic') return modelById('paddle-arabic') ?? byLanguage[0]!;
  if (language === 'ru') return modelById('paddle-cyrillic') ?? byLanguage[0]!;
  if (language === 'en') {
    return modelById('paddle-latin') ?? byLanguage[0]!;
  }
  // Han/mixed and unknown scripts keep the general Chinese model.
  if (numeric) return modelById('paddle-v6-medium') ?? byLanguage[0]!;
  return modelById('paddle-v6-medium') ?? MODEL_CAPABILITIES[0]!;
}

function fallbacksFor(primary: OcrModelCapability): string[] {
  const sameEngine = MODEL_CAPABILITIES.filter(
    (model) =>
      model.engine === primary.engine &&
      model.id !== primary.id &&
      model.scripts.some((script) => primary.scripts.includes(script)),
  );
  return sameEngine
    .sort((left, right) => right.speed - left.speed)
    .slice(0, 2)
    .map((model) => model.id);
}

function numericIntent(input: OcrRouteInput, profile: OcrScriptProfile | null): boolean {
  const name = input.name ?? '';
  const kind = (input.kind ?? '').toLowerCase();
  if (NUMERIC_NAME.test(name) || ['invoice', 'receipt', 'statement', 'bank'].includes(kind)) {
    return true;
  }
  const ratio = input.numericRatio ?? profile?.numericRatio ?? 0;
  return ratio >= 0.45;
}

/**
 * Deterministic, explainable route. Explicit modes always win; otherwise the
 * declared/observed language, document kind, numeric density and image quality
 * select a model and mode. The decision is data, not hidden state, so benchmark
 * runs and replayed stages can be compared against the same inputs.
 */
export function routeOcr(input: OcrRouteInput): OcrRouteDecision {
  const profile = input.text?.trim() ? profileScript(input.text) : null;
  const declared = languageHintOf(input.lang);
  const language = declared ?? profile?.language ?? null;
  const engine = input.engine ?? 'paddle';
  const name = input.name ?? '';
  const kind = (input.kind ?? '').toLowerCase();
  const numeric = numericIntent(input, profile);
  const reasons: OcrRouteReason[] = [];
  let mode = input.mode ?? 'auto';
  let explicit = Boolean(input.mode && input.mode !== 'auto');

  if (declared) reasons.push({ code: 'declared_language', detail: input.lang ?? declared });
  if (profile) {
    reasons.push({
      code: 'script_profile',
      detail: `${profile.dominant}${profile.mixed ? '+mixed' : ''} letters=${profile.letters} digits=${profile.digits}`,
    });
  }
  if (numeric) {
    reasons.push({
      code: 'numeric_path',
      detail: `numeric ratio ${Math.round((input.numericRatio ?? profile?.numericRatio ?? 0) * 100)}%`,
    });
  }
  if (engine !== 'paddle' && mode !== 'auto') {
    reasons.push({ code: 'engine_mode_unsupported', detail: `${engine}:${mode}` });
    mode = 'auto';
    explicit = false;
  }
  if (explicit) {
    reasons.push({ code: 'explicit_mode', detail: mode });
  } else if (engine === 'paddle' && (kind === 'table' || TABLE_NAME.test(name))) {
    mode = 'table';
    reasons.push({ code: 'table_layout', detail: name || kind });
  } else if (
    input.quality?.blurry ||
    input.quality?.skewed ||
    input.quality?.glare ||
    input.quality?.shadow ||
    input.quality?.lowResolution
  ) {
    mode = 'enhanced';
    reasons.push({ code: 'image_quality', detail: 'enhanced preprocessing' });
  } else if (
    (input.width ?? 0) > 0 &&
    (input.height ?? 0) > 0 &&
    Math.max(input.width ?? 0, input.height ?? 0) < 1_000
  ) {
    mode = 'enhanced';
    reasons.push({
      code: 'low_resolution',
      detail: `${input.width}x${input.height}`,
    });
  }

  const primary = primaryModel(engine, language, mode, numeric);
  if (language) reasons.push({ code: 'language_model', detail: `${language}→${primary.id}` });
  else reasons.push({ code: 'default_model', detail: primary.id });
  if (mode !== 'auto') reasons.push({ code: 'mode', detail: mode });

  return {
    engine,
    mode,
    language: engine === 'docling' ? null : language,
    modelId: primary.id,
    numeric,
    fallbacks: fallbacksFor(primary),
    explicit,
    reasons,
  };
}

const DEFAULT_CONTROL_MODEL = 'paddle-v6-medium';
const DEFAULT_CANDIDATE_MODEL = 'paddle-v6-server';

function greyModeOf(value: string | undefined): OcrGreyMode {
  const mode = value?.trim().toLowerCase();
  return mode === 'shadow' || mode === 'rollback' ? mode : 'canary';
}

/** Configured grey release, or null when it is disabled. */
export function greyConfig(env: NodeJS.ProcessEnv = process.env): OcrGreyConfig | null {
  const raw = Number(env.OCR_GREY_PERCENT ?? '0');
  const mode = greyModeOf(env.OCR_GREY_MODE);
  const rollback = env.OCR_ROLLBACK_MODEL?.trim() || null;
  if (mode === 'rollback') {
    if (!rollback) return null;
    return {
      percent: 100,
      mode,
      candidateModelId: env.OCR_GREY_MODEL?.trim() || DEFAULT_CANDIDATE_MODEL,
      controlModelId: env.OCR_CONTROL_MODEL?.trim() || DEFAULT_CONTROL_MODEL,
      rollbackModelId: rollback,
    };
  }
  if (!Number.isFinite(raw) || raw <= 0 || raw >= 100) return null;
  const candidate = env.OCR_GREY_MODEL?.trim() || DEFAULT_CANDIDATE_MODEL;
  const control = env.OCR_CONTROL_MODEL?.trim() || DEFAULT_CONTROL_MODEL;
  return {
    percent: Math.floor(raw),
    mode,
    candidateModelId: candidate,
    controlModelId: control,
    rollbackModelId: rollback,
  };
}

/**
 * Stable cohort assignment: the same attachment id always lands in the same
 * bucket, so retries and replays do not flip between control and candidate.
 *
 * `shadow` keeps the control result authoritative while the candidate model
 * runs alongside it; `rollback` sends all traffic to the previous model.
 */
export function greyPlan(
  key: string,
  config: OcrGreyConfig | null = greyConfig(),
): OcrGreyPlan | null {
  if (!config) return null;
  if (config.mode === 'rollback' && config.rollbackModelId) {
    return {
      bucket: 0,
      percent: 100,
      mode: 'rollback',
      cohort: 'control',
      modelId: config.rollbackModelId,
      controlModelId: config.controlModelId,
      candidateModelId: config.candidateModelId,
      rollbackModelId: config.rollbackModelId,
      reasons: [`rollback ${config.rollbackModelId}`, `control ${config.controlModelId}`],
    };
  }
  const digest = createHash('sha256').update(key).digest();
  const bucket = digest.readUInt32BE(0) % 100;
  const cohort: OcrGreyPlan['cohort'] = bucket < config.percent ? 'candidate' : 'control';
  const authoritative =
    config.mode === 'shadow'
      ? config.controlModelId
      : cohort === 'candidate'
        ? config.candidateModelId
        : config.controlModelId;
  return {
    bucket,
    percent: config.percent,
    mode: config.mode,
    cohort,
    modelId: authoritative,
    controlModelId: config.controlModelId,
    candidateModelId: config.candidateModelId,
    rollbackModelId: config.rollbackModelId,
    reasons: [
      `bucket ${bucket} ${cohort === 'candidate' ? '<' : '>='} ${config.percent}`,
      config.mode === 'shadow' ? 'shadow candidate never replaces control' : `cohort ${cohort}`,
      `control ${config.controlModelId}`,
      `candidate ${config.candidateModelId}`,
    ],
  };
}

/** Fill measured accuracy from benchmark aggregates keyed by display model. */
export function withMeasuredAccuracy(
  models: readonly OcrModelCapability[],
  measured: Readonly<Record<string, number>>,
): OcrModelCapability[] {
  return models.map((model) => {
    const value = measured[model.label] ?? measured[model.id];
    return value === undefined ? model : { ...model, accuracy: value };
  });
}
