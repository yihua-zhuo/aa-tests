import type { Permission } from './permissions.ts';

export type Role = 'admin' | 'manager' | 'pm' | 'viewer';
export type UserStatus = 'active' | 'disabled';
export type ProjectVisibility = 'workspace' | 'private';

export type CustomRole = {
  id: string;
  workspaceId: string;
  name: string;
  baseRole: Role;
  permissions: Permission[];
  memberCount: number;
  createdAt: string;
  updatedAt: string;
};

export type WorkspaceSummary = {
  id: string;
  name: string;
  createdAt: string;
  memberCount: number;
  projectCount: number;
};
export type DateRangeKey = 'today' | '7d' | '30d' | 'month' | 'last_month' | 'custom';
export type Granularity = 'day' | 'week' | 'month';

export type SessionUser = {
  id: string;
  email: string;
  name: string;
  role: Role;
  timezone: string;
  avatarUrl?: string | null;
  workspaceId?: string;
  workspaceName?: string;
  permissions?: Permission[];
  jitPermissions?: Permission[];
  customRole?: { id: string; name: string; baseRole: Role } | null;
};

export type User = SessionUser & {
  status: UserStatus;
  isDemo: boolean;
  createdAt: string;
  updatedAt: string;
  lastLoginAt: string | null;
  version: number;
};

export type UserOption = {
  id: string;
  name: string;
};

export type UserDirectoryEntry = UserOption & {
  email: string;
  role: Role;
  status: UserStatus;
  isDemo: boolean;
  avatarUrl: string | null;
  workspaceId?: string;
  customRoleId?: string | null;
  customRoleName?: string | null;
  createdAt: string;
  lastLoginAt: string | null;
  version: number;
};

export type UserListResult = {
  users: UserDirectoryEntry[];
  total: number;
  page: number;
  pageSize: number;
  counts: { total: number; active: number; disabled: number; admins: number };
};

export type Profile = SessionUser & {
  avatarUrl: string | null;
  createdAt: string;
  lastLoginAt: string | null;
  version: number;
};

export type Preferences = {
  defaultRange: DateRangeKey;
  emailNotifications: boolean;
  weeklyDigest: boolean;
  sidebarCollapsed: boolean;
  updatedAt: string;
  version: number;
};

export type SessionInfo = {
  id: string;
  current: boolean;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  ip: string | null;
  userAgent: string | null;
};

export type TokenScope = 'read' | 'write';

export type PersonalAccessToken = {
  id: string;
  name: string;
  scopes: TokenScope[];
  expiresAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
  revokedAt: string | null;
  expired: boolean;
};

export type TokenList = {
  tokens: PersonalAccessToken[];
  quota: { max: number; windowSeconds: number };
};

export type TokenCreateResult = {
  token: string;
  item: PersonalAccessToken;
};

export const WEBHOOK_EVENTS = [
  'project.created',
  'project.updated',
  'project.archived',
  'project.restored',
  'project.deleted',
  'task.created',
  'task.completed',
  'comment.created',
  'user.created',
  'user.disabled',
] as const;

export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

export type WebhookStatus = 'pending' | 'sent' | 'failed';

export type Webhook = {
  id: string;
  url: string;
  events: WebhookEvent[];
  active: boolean;
  createdAt: string;
  lastStatus: WebhookStatus | null;
  lastDeliveryAt: string | null;
};

export type WebhookCreateResult = {
  webhook: Webhook;
  secret: string;
};

export type WebhookDelivery = {
  id: string;
  event: WebhookEvent;
  status: WebhookStatus;
  attempts: number;
  responseStatus: number | null;
  createdAt: string;
  updatedAt: string;
};

export type ProjectStatus = 'planning' | 'active' | 'on_hold' | 'completed' | 'archived';

export type ProjectDueFilter = 'overdue' | 'week' | 'month';

export type Project = {
  id: string;
  name: string;
  description: string;
  status: ProjectStatus;
  progress: number;
  ownerId: string;
  ownerName: string;
  workspaceId: string;
  visibility: ProjectVisibility;
  startDate: string | null;
  dueDate: string | null;
  tags: string[];
  favorite: boolean;
  isDemo: boolean;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  version: number;
};

export type ProjectTagCount = { tag: string; count: number };

export type ProjectBatchAction = 'status' | 'owner' | 'archive';

export type ProjectBatchResult = {
  updated: number;
  skipped: string[];
};

export type ProjectViewQuery = {
  q?: string;
  status?: ProjectStatus | 'all';
  owner?: string;
  sort?: 'updated' | 'created' | 'name' | 'progress' | 'due';
  tag?: string;
  due?: ProjectDueFilter | 'all';
  favorite?: boolean;
  view?: 'grid' | 'list';
  pageSize?: number;
};

export type SavedView = {
  id: string;
  name: string;
  query: ProjectViewQuery;
  createdAt: string;
  updatedAt: string;
};

export type ProjectDetail = Project & {
  members: UserOption[];
};

export type TaskStatus = 'todo' | 'in_progress' | 'review' | 'done';
export type TaskPriority = 'low' | 'medium' | 'high' | 'urgent';

export type Task = {
  id: string;
  projectId: string;
  parentId: string | null;
  milestoneId: string | null;
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  assigneeId: string | null;
  assigneeName: string | null;
  dueDate: string | null;
  sortOrder: number;
  completedAt: string | null;
  estimatePoints: number | null;
  estimateHours: number | null;
  estimateSize: string | null;
  createdAt: string;
  updatedAt: string;
  version: number;
  commentCount: number;
  childCount: number;
  doneChildCount: number;
  rollupProgress: number;
  rollupEstimateHours: number;
};

export type Milestone = {
  id: string;
  projectId: string;
  title: string;
  dueDate: string | null;
  createdAt: string;
  taskCount: number;
  doneCount: number;
};

export type ProjectTasks = {
  tasks: Task[];
  milestones: Milestone[];
  progress: number;
  estimateTotals: {
    points: number;
    hours: number;
    sizes: Record<string, number>;
    loggedHours: number;
    varianceHours: number;
  };
};

export type OcrStatus = 'pending' | 'processing' | 'done' | 'failed' | 'skipped';
export type OcrEngine = 'paddle' | 'docling';
/**
 * auto = fast line-aware layout; table = PP-Structure table recognition;
 * structure = layout analysis with region-level routing; enhanced = orientation
 * and unwarping for photographed pages.
 */
export type OcrMode = 'auto' | 'table' | 'structure' | 'enhanced';
/** Photometric channel fed to visual OCR; red often preserves faded ink/stamps. */
export type OcrChannel = 'rgb' | 'gray' | 'red';
/** Where the text came from: native document objects, visual OCR, or both. */
export type OcrRoute = 'native' | 'visual' | 'hybrid';

/** Writing system observed in a sample or extraction. */
export type OcrScript = 'han' | 'latin' | 'kana' | 'hangul' | 'arabic' | 'cyrillic' | 'other';

export type OcrScriptProfile = {
  dominant: OcrScript;
  /** True when two or more scripts each carry a material share of letters. */
  mixed: boolean;
  scripts: { script: OcrScript; characters: number }[];
  letters: number;
  digits: number;
  symbols: number;
  /** Share of digits/punctuation over all non-space characters. */
  numericRatio: number;
  /** PaddleOCR language hint (`ch`, `en`, `japan`, `korean`, `arabic`, `ru`). */
  language: string;
};

/** Static, human-curated model facts; accuracy is filled from benchmark runs. */
export type OcrModelCapability = {
  id: string;
  engine: OcrEngine;
  label: string;
  detector: string | null;
  recognizer: string | null;
  scripts: OcrScript[];
  languages: string[];
  documentTypes: string[];
  /** 1 (slowest) to 5 (fastest). */
  speed: number;
  /** Approximate resident memory in MB. */
  memoryMb: number;
  /** Benchmark CER-based accuracy when measured; never guessed. */
  accuracy: number | null;
  strengths: string[];
  limitations: string[];
  license: string;
  notes: string;
  /** Supports a numeric/symbol-constrained recognition path. */
  numeric: boolean;
};

export type OcrRouteInput = {
  name?: string;
  engine?: OcrEngine;
  kind?: string | null;
  /** Declared language (`zh`, `en`, `japan`, `ko`, ...) when known. */
  lang?: string | null;
  mode?: OcrMode;
  text?: string | null;
  width?: number | null;
  height?: number | null;
  numericRatio?: number | null;
  quality?: {
    blurry?: boolean;
    skewed?: boolean;
    glare?: boolean;
    shadow?: boolean;
    lowResolution?: boolean;
  } | null;
};

export type OcrRouteReason = { code: string; detail: string };

/** Explainable model/mode selection. The same inputs always yield the same route. */
export type OcrRouteDecision = {
  engine: OcrEngine;
  mode: OcrMode;
  /** Language hint sent to the sidecar; null keeps the sidecar default. */
  language: string | null;
  modelId: string;
  /** Sidecar profile actually requested, when it differs from the default. */
  profile?: string | null;
  numeric: boolean;
  fallbacks: string[];
  /** True when the mode came from an explicit user request. */
  explicit: boolean;
  reasons: OcrRouteReason[];
};

/** Deterministic shadow/rollout assignment for a pipeline or model change. */
export type OcrGreyMode = 'canary' | 'shadow' | 'rollback';

export type OcrGreyPlan = {
  bucket: number;
  percent: number;
  mode: OcrGreyMode;
  cohort: 'control' | 'candidate';
  modelId: string;
  controlModelId: string;
  candidateModelId: string;
  rollbackModelId: string | null;
  reasons: string[];
};

export type OcrGreyConfig = {
  percent: number;
  mode: OcrGreyMode;
  candidateModelId: string;
  controlModelId: string;
  rollbackModelId: string | null;
};

export type OcrRegistryRole = 'control' | 'candidate' | 'rollback' | 'retired';

/** One model/pipeline variant tracked for automatic selection and release. */
export type OcrRegistryEntry = {
  id: string;
  engine: OcrEngine;
  /** Capability id or sidecar profile name. */
  modelId: string;
  /** Optional pipeline label, e.g. `structure` or `enhanced`. */
  pipeline: string;
  role: OcrRegistryRole;
  mode: OcrGreyMode;
  /** False pins the entry so automatic promotion/rollback leaves it alone. */
  auto: boolean;
  /** Candidate traffic share when the entry is in the candidate role. */
  percent: number;
  /** Latest benchmark score (0-1, higher is better) and its sample count. */
  benchmarkScore: number | null;
  benchmarkSamples: number;
  /** Latest production score (0-1, higher is better) and its sample count. */
  productionScore: number | null;
  productionSamples: number;
  note: string;
  decidedBy: string | null;
  decidedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type OcrRegistryAction =
  | 'register'
  | 'promote'
  | 'rollback'
  | 'hold'
  | 'retire'
  | 'percent'
  | 'pin';

/** Immutable audit trail for registry and grey-release changes. */
export type OcrRegistryDecision = {
  id: string;
  at: string;
  actor: 'auto' | 'human';
  action: OcrRegistryAction;
  engine: OcrEngine;
  modelId: string;
  pipeline: string;
  fromRole: OcrRegistryRole | null;
  toRole: OcrRegistryRole | null;
  percent: number | null;
  reason: string;
  metrics: Record<string, number | null>;
};

export type OcrRegistryPolicy = {
  /** Automatic promotion/rollback enabled. */
  auto: boolean;
  minSamples: number;
  promoteMargin: number;
  rollbackMargin: number;
  /** Maximum McNemar p-value allowed for automatic promotion. */
  significance: number;
};

/** Paired per-file benchmark outcome between candidate and control. */
export type OcrRegistrySignificance = {
  /** Files where the candidate's CER is lower (a win). */
  wins: number;
  /** Files where the control's CER is lower (a loss). */
  losses: number;
  /** Files with identical CER; excluded from the McNemar test. */
  ties: number;
  /** Files both variants completed with comparable metrics. */
  comparable: number;
  /** Exact two-sided McNemar p-value over discordant files. */
  pValue: number;
  /** wins > losses and pValue <= the policy threshold. */
  significant: boolean;
};

export type OcrRegistryState = {
  /** Active grey release derived from the registry; null when disabled. */
  config: OcrGreyConfig | null;
  control: OcrRegistryEntry | null;
  candidate: OcrRegistryEntry | null;
  rollback: OcrRegistryEntry | null;
  entries: OcrRegistryEntry[];
  decisions: OcrRegistryDecision[];
  policy: OcrRegistryPolicy;
};

export type OcrRegistryEvaluation = {
  action: 'promote' | 'rollback' | 'hold';
  reason: string;
  controlId: string | null;
  candidateId: string | null;
  rollbackId: string | null;
  /** Candidate − control benchmark score, when both are measured. */
  benchmarkDelta: number | null;
  /** Control − rollback production score, when both are measured. */
  productionDelta: number | null;
  /** Paired McNemar evidence for candidate vs control, when available. */
  benchmarkSignificance: OcrRegistrySignificance | null;
  applied: boolean;
};

/** Runtime fingerprint reported by a sidecar; drives cache invalidation. */
export type OcrModelRuntime = {
  engine: OcrEngine;
  model: string | null;
  modelSha256: string | null;
  pipeline: string | null;
  runtime: string | null;
  python: string | null;
  paddle: string | null;
  cuda: string | null;
};

export type DocumentBlockType =
  | 'paragraph'
  | 'heading'
  | 'table'
  | 'formula'
  | 'chart'
  | 'handwriting'
  | 'stamp'
  | 'signature'
  | 'header'
  | 'footer'
  | 'image';

export type DocumentBBox = { x: number; y: number; width: number; height: number };

export type DocumentSource = {
  engine: string;
  model: string | null;
  stage: 'native' | 'visual' | 'recovery' | 'vlm' | 'camelot' | 'specialized';
};

/** Orientation signals used to decide whether a page needs rotated re-OCR. */
export type OcrOrientationSignal = {
  /** EXIF orientation tag when present. */
  exif: number | null;
  /** Rotation in degrees applied from EXIF (0/90/180/270). */
  applied: number;
  /** Width/height ratio, used as a weak landscape hint. */
  aspect: number | null;
  /** True when the sidecar could not estimate skew reliably. */
  uncertain: boolean;
};

/** Advice to re-capture instead of trusting post-processing. */
export type OcrRetakeAdvice = {
  required: boolean;
  reasons: string[];
};

/** Cheap image signals measured before OCR; all optional when Pillow is absent. */
export type OcrPreflight = {
  width: number | null;
  height: number | null;
  /** Edge variance; low values indicate blur. */
  sharpness: number | null;
  /** Mean luminance, 0-1. */
  brightness: number | null;
  /** Luminance standard deviation, 0-1. */
  contrast: number | null;
  /** Embedded or assumed render DPI. */
  dpi: number | null;
  /** Low-frequency background range, 0-1; high values indicate shading. */
  shadow?: number | null;
  /** Fraction of near-white pixels, 0-1; high values indicate specular glare. */
  glare?: number | null;
  /** Median-residual noise estimate, 0-1. */
  noise?: number | null;
  /** Hasler-Süsstrunk colorfulness normalized to 0-1. */
  colorfulness?: number | null;
  /** Median near-horizontal line angle in degrees, positive clockwise. */
  skew?: number | null;
  orientation?: OcrOrientationSignal | null;
  /** Sidecar issue tags: blurry, underexposed, glare, shadow, skewed, noisy, ... */
  issues?: string[];
  retake?: OcrRetakeAdvice | null;
};

export type OcrRegionInput = {
  path: string;
  name: string;
  /** 1-based page or image frame. */
  page: number;
  /** Region in the coordinate space of the rendered page/image. */
  bbox: DocumentBBox;
  dpi?: number;
  /** DPI used to produce the bbox, when the request re-renders at another DPI. */
  bboxDpi?: number;
  mode?: OcrMode;
  /** Language hint for the sidecar recognizer (`ch`, `en`, `japan`, ...). */
  lang?: string;
  /** Named detector/recognizer profile for model comparison or canary runs. */
  model?: string;
  /** Extra context margin as a fraction of region height. */
  padding?: number;
};

export type OcrRegionResult = {
  text: string;
  confidence: number | null;
  engine: string;
  model: string | null;
  seconds: number;
};

export type DocumentFieldKind =
  | 'amount'
  | 'date'
  | 'identifier'
  | 'account'
  | 'quantity'
  | 'percentage'
  | 'number'
  /** Generic low-confidence line; not a business field. */
  | 'text';

export type DocumentFieldCandidate = {
  text: string;
  confidence: number | null;
  model: string | null;
  /** Engine that produced this candidate, when the recheck crossed engines. */
  engine?: string | null;
  source: 'region' | 'vlm' | 'specialized';
  bbox: DocumentBBox | null;
  /** 1-based region recovery pass that produced this candidate. */
  pass?: number;
  mode?: OcrMode;
  dpi?: number | null;
  padding?: number;
  /** Raw-text comparison against the original block; no normalization. */
  agreesWithInitial?: boolean;
  /**
   * Constrained numeric interpretation of this candidate. Never replaces the
   * recognized text; `canonical` is null when the field constraint fails.
   */
  numeric?: { canonical: string | null; valid: boolean } | null;
};

/**
 * Same-model re-reads repeat the same systematic errors, so corroboration is
 * split by independence: only `confirmed_independent` may lower a risk.
 */
export type DocumentFieldAgreement =
  | 'confirmed_independent'
  | 'confirmed_same_engine'
  | 'conflict'
  | 'unverified';

/** Key-field provenance: the original block plus any region-level candidates. */
export type DocumentFieldEvidence = {
  kind: DocumentFieldKind;
  page: number;
  blockId: string;
  bbox: DocumentBBox | null;
  text: string;
  confidence: number | null;
  source: DocumentSource;
  candidates: DocumentFieldCandidate[];
  /** `null` keeps the original text; candidates never rewrite it silently. */
  selected: 'initial' | 'candidate' | null;
  /** All successful candidates agree with the original vs at least one disagrees. */
  agreement: DocumentFieldAgreement;
  /** Region passes attempted for this field (successful or not). */
  passes: number;
  /** Per-pass failure summaries; candidates that did return are preserved. */
  failed: string[];
  /** Present when the target is one table cell instead of a whole text block. */
  cell?: {
    row: number;
    column: number;
    header: string;
    /** True when the crop box was interpolated from the table bbox. */
    bboxEstimated: boolean;
  };
  /**
   * Present when the target was ink no box covered: there is no original text to
   * corroborate, only the crop's own reading.
   */
  inkGap?: { id: string; kind: OcrInkGap['kind']; pixels: number };
  reason?: 'initial_confirmed' | 'candidate_selected' | 'candidate_conflict' | 'unverified';
};

export type DocumentValidation = {
  status: 'passed' | 'flagged' | 'failed';
  issues: string[];
};

/**
 * A machine-readable payload decoded independently of OCR: QR/barcode pixels
 * or an MRZ parsed from recognized text. It is evidence, never a text rewrite.
 */
export type DocumentMachineReadable = {
  format: 'qr' | 'barcode' | 'mrz';
  text: string;
  page: number;
  bbox?: DocumentBBox | null;
  /** Structured MRZ fields, when the payload is an MRZ. */
  fields?: Record<string, string | null>;
  /** Individual ICAO 9303 check-digit outcomes for MRZ fields. */
  checks?: { valid: boolean; failed: string[] };
};

export type DocumentSpecializedType = 'chart' | 'handwriting' | 'stamp' | 'signature';

/** Advisory recognizer output for non-text layout regions; never rewrites text. */
export type DocumentSpecializedFinding = {
  type: DocumentSpecializedType;
  page: number;
  blockId: string;
  bbox: DocumentBBox | null;
  text: string;
  confidence: number | null;
  model: string | null;
  seconds: number;
};

export type DocumentTableCell = {
  row: number;
  column: number;
  text: string;
  rowSpan?: number;
  columnSpan?: number;
  bbox?: DocumentBBox;
  /** Independent recognizer score for this cell, when the engine exposes it. */
  confidence?: number | null;
};

export type DocumentBlock = {
  id: string;
  type: DocumentBlockType;
  text: string;
  bbox: DocumentBBox | null;
  confidence: number | null;
  source: DocumentSource;
  validation: DocumentValidation | null;
  order: number;
  /** Table rows as plain strings, used when cell coordinates are unavailable. */
  rows?: string[][];
  cells?: DocumentTableCell[];
  meta?: Record<string, unknown>;
};

export type DocumentPage = {
  number: number;
  width: number | null;
  height: number | null;
  blocks: DocumentBlock[];
  source: DocumentSource | null;
  meta?: DocumentPageMeta;
};

/**
 * Ink that no recognition box explains. Stamps and already-recognized regions are
 * masked out first, so a gap is a pixel-level miss rather than a low score.
 */
export type OcrInkGap = {
  id: string;
  /** `cell` is ink inside a table whose other cells were filled. */
  kind: 'region' | 'cell';
  /** Table block owning the gap when kind is `cell`. */
  blockId: string | null;
  bbox: DocumentBBox;
  /** Uncovered ink pixels, converted back to page resolution. */
  pixels: number;
  /** Ink pixels per unit of the gap area. */
  density: number;
};

/** Page-level observations beside the recognized blocks. */
export type DocumentPageMeta = {
  inkGaps?: OcrInkGap[];
  /**
   * Gap entries the payload carried but could not be described (missing box or
   * pixel count, or beyond the parse limit). They are not counted as gaps, but a
   * page with dropped entries cannot claim full coverage either.
   */
  inkGapsDropped?: number;
  /** Barcode/QR pixels or MRZ bands decoded for this page. */
  machineReadable?: DocumentMachineReadable[];
};

/** How much of an Office package's non-body content was captured. */
export type DocumentOfficeCoverage = {
  deletedText?: number;
  insertedText?: number;
  revisions?: number;
  textBoxes?: number;
  headers?: number;
  footers?: number;
  footnotes?: number;
  endnotes?: number;
  comments?: number;
  charts?: number;
  images?: number;
  embeddedObjects?: number;
  hiddenSlides?: number;
  groupedShapes?: number;
  notes?: number;
  objects?: number;
  /** Charts/images/OLE payloads whose content is not in the extracted text. */
  unrendered?: number;
};

/**
 * How the sidecar chose between the enhanced candidate and the untouched page.
 * Confidence alone never accepts the enhanced reading; `conflict` means the
 * candidate dropped numeric tokens the original preserved.
 */
export type OcrPreprocessSelection = {
  page: number;
  selected: 'enhanced' | 'original';
  basis: 'numeric_conflict' | 'corrupt' | 'tokens' | 'confidence' | 'no_gain';
  conflict: boolean;
  agreement: number | null;
  missingTokens: number | null;
  addedTokens: number | null;
};

/**
 * Borderless table inferred from text alignment when no grid is available.
 * The participating blocks keep their own text and coordinates; this record
 * only describes the inferred grid.
 */
export type OcrBorderlessTable = {
  id: string;
  page: number;
  bbox: DocumentBBox;
  method: 'text-alignment';
  confidence: number;
  columns: { index: number; x: number; width: number }[];
  rows: {
    order: number;
    cells: { blockId: string; text: string; bbox: DocumentBBox; column: number }[];
  }[];
};

/** Cross-page table relationship; rows are never merged into block text. */
export type DocumentTableChain = {
  id: string;
  /** Ordered page/block references; each page keeps its original table. */
  blocks: { page: number; blockId: string }[];
  /** Concatenated row count with repeated headers excluded. */
  rows: number;
};

/** Unified Document Intermediate Representation shared by every engine. */
export type DocumentIr = {
  version: 1;
  route: OcrRoute;
  pages: DocumentPage[];
  readingOrder: string[];
  meta: Record<string, unknown>;
};

export type DocumentQualityIssue = {
  code:
    | 'empty_text'
    | 'truncated'
    | 'low_confidence'
    | 'confidence_unknown'
    | 'low_coverage'
    | 'empty_page'
    | 'table_integrity'
    | 'field_mismatch'
    | 'amount_words_mismatch'
    | 'identifier_checksum'
    | 'cell_type_mismatch'
    | 'business_constraint'
    | 'cell_recovery_conflict'
    | 'reading_order'
    | 'duplicate_content'
    | 'block_validation'
    | 'key_field_low_confidence'
    | 'key_field_same_engine_confirmation'
    | 'key_region_missing'
    | 'schema_field_missing'
    | 'schema_field_invalid'
    | 'schema_conflict'
    | 'machine_readable_confirmed'
    | 'machine_readable_partial'
    | 'machine_readable_mismatch'
    | 'preprocess_conflict'
    | 'embedded_object_unread'
    | 'tracked_changes_excluded'
    | 'hidden_content'
    | 'ink_without_text'
    | 'small_text'
    | 'text_layer_mismatch'
    | 'text_layer_crosscheck_incomplete'
    | 'image_blurry'
    | 'image_exposure'
    | 'image_low_resolution'
    | 'image_glare'
    | 'image_shadow'
    | 'image_skew'
    | 'image_noise'
    | 'image_orientation'
    | 'image_retake';
  severity: 'info' | 'warning' | 'error';
  message: string;
  page: number | null;
  blockId: string | null;
};

export type DocumentQualityRiskCode =
  | 'key_field_low_confidence'
  | 'key_region_missing'
  | 'schema_incomplete'
  | 'schema_invalid'
  | 'schema_conflict'
  | 'machine_readable_conflict'
  | 'preprocess_conflict'
  | 'ink_without_text'
  | 'field_validation_failed'
  | 'table_structure_risk'
  | 'image_quality'
  | 'image_retake'
  | 'small_text'
  | 'text_layer_mismatch';

/** A risk that forces review regardless of the weighted score. */
export type DocumentQualityRisk = {
  code: DocumentQualityRiskCode;
  severity: 'warning' | 'error';
  message: string;
  page: number | null;
  blockId: string | null;
};

/** Rule-based business type; `generic` means no type passed the evidence bar. */
export type DocumentClass =
  | 'invoice'
  | 'receipt'
  | 'contract'
  | 'id_document'
  | 'bank_receipt'
  | 'purchase_order'
  | 'delivery_note'
  | 'statement'
  | 'generic';

export type DocumentSchemaField = {
  key: string;
  label: string;
  kind: DocumentFieldKind;
  required: boolean;
  found: boolean;
  value: string | null;
  valid: boolean;
};

/** Per-class required/optional fields and cross-field constraints. */
export type DocumentClassification = {
  type: DocumentClass;
  /** Evidence strength of the classifier, not an OCR probability. */
  confidence: number;
  evidence: string[];
  schema: {
    fields: DocumentSchemaField[];
    /** Required labels that were not found at all. */
    missing: string[];
    /** Required labels that were found but failed their format check. */
    invalid: string[];
    /** Mutually inconsistent values (e.g. total below tax). */
    conflicts: string[];
    /** Share of required fields present and valid, 0-1; null when none. */
    coverage: number | null;
  };
};

/** OCR confidence, structure confidence and business validation kept separate. */
export type DocumentQualityComponents = {
  ocrConfidence: number | null;
  structureConfidence: number | null;
  fieldValidation: number | null;
  businessConsistency: number | null;
};

/** Heuristic, uncalibrated quality signal; never used to rewrite OCR text. */
export type DocumentQuality = {
  score: number;
  status: 'pass' | 'review' | 'fail';
  calibrated: boolean;
  signals: Record<string, number | null>;
  issues: DocumentQualityIssue[];
  components: DocumentQualityComponents;
  hardRisks: DocumentQualityRisk[];
  /** Business type and required-field schema, classified from text and layout. */
  docType?: DocumentClassification | null;
};

export type OcrStageKind =
  | 'native'
  | 'visual'
  | 'recovery_dpi'
  | 'recovery_structure'
  | 'recovery_enhance'
  | 'recovery_region'
  | 'recovery_cell'
  | 'candidate'
  | 'vlm'
  | 'camelot'
  | 'specialized';

export type OcrRecoveryTrigger =
  | 'key_field'
  | 'cell_recovery'
  | 'low_confidence'
  | 'low_coverage'
  | 'table_structure'
  | 'field_validation'
  | 'numeric_confusion'
  | 'detection_anomaly'
  | 'ink_gap'
  | 'local_blur'
  | 'orientation_uncertain'
  | 'language_mismatch'
  | 'image_quality'
  | 'small_text';

/** Why a recovery ran and the expected-value estimate used to decide it. */
export type OcrRecoveryDecision = {
  trigger: OcrRecoveryTrigger;
  /** Expected score gain (0-1) times the estimated success probability. */
  expectedGain: number;
  /** Estimated wall-clock cost in seconds. */
  costSeconds: number;
  /** expectedGain minus a normalized cost penalty; only positive values run. */
  value: number;
};

/** Exact request parameters a cascade stage ran with; used for replay. */
export type OcrStageParams = {
  mode: OcrMode;
  dpi: number | null;
  /** 1-based page/frame for region-level replays. */
  page: number | null;
  bbox: DocumentBBox | null;
  padding: number | null;
  /** Named model profile the stage requested, when it was not the default. */
  model?: string | null;
  /** Region category for replaying a `specialized` stage. */
  specializedType?: DocumentSpecializedType | null;
};

/** Quality scoring detail captured right after a stage finished. */
export type OcrStageQuality = {
  score: number;
  status: DocumentQuality['status'];
  calibrated: boolean;
  issues: DocumentQualityIssue['code'][];
  hardRisks: DocumentQualityRiskCode[];
  signals: Record<string, number | null>;
};

export type OcrStage = {
  kind: OcrStageKind;
  status: 'done' | 'skipped' | 'failed';
  mode: OcrMode;
  engine: OcrEngine;
  model: string | null;
  dpi: number | null;
  seconds: number;
  score: number | null;
  message: string | null;
  trigger?: OcrRecoveryTrigger;
  decision?: OcrRecoveryDecision;
  /** SHA-256 of the source file when the stage ran; replay verifies it still matches. */
  inputSha256?: string | null;
  /** SHA-256 over this stage's output DIR/text; replay detects changed results. */
  outputSha256?: string | null;
  /** Normalized parameters so the same request can be reissued. */
  params?: OcrStageParams;
  /** Scoring detail captured immediately after this stage. */
  quality?: OcrStageQuality;
};

/** Data-driven success rate for one recovery stage kind. */
export type OcrRecoveryYield = {
  stage: OcrStageKind;
  attempts: number;
  successes: number;
  /** Beta-smoothed probability the cascade uses for expected-value decisions. */
  probability: number;
  /** Hard-coded prior, shown for context and used when samples are scarce. */
  prior: number;
  updatedAt: string | null;
};

/** Which recorded stage to replay, optionally overridden to a single region. */
export type OcrStageReplayTarget = {
  kind: OcrStageKind;
  /** 1-based occurrence when a run contains several stages of the same kind. */
  occurrence?: number;
  /** Region replay overrides; default to the stage params when omitted. */
  page?: number | null;
  bbox?: DocumentBBox | null;
  padding?: number | null;
};

export type AttachmentOcrSummary = {
  status: OcrStatus;
  engine: OcrEngine | null;
  model: string | null;
  confidence: number | null;
  characters: number;
  pages: number;
  seconds: number | null;
  truncated: boolean;
  mode: OcrMode;
  dpi: number;
  route: OcrRoute | null;
  quality: DocumentQuality | null;
  reviewRequired: boolean;
  error: string | null;
  updatedAt: string | null;
  /** Set when the retention policy removed text and structured output. */
  purgedAt: string | null;
};

export type AttachmentOcr = AttachmentOcrSummary & {
  text: string;
  /** Engine output before display normalization; equals `text` for legacy rows. */
  rawText: string;
  stages: OcrStage[];
  document: DocumentIr | null;
};

export type OcrRedactionSummary = {
  idCards: number;
  phones: number;
  landlines: number;
  emails: number;
  bankCards: number;
  mrzLines: number;
};

/** Redacted plain-text export; the raw transcript never leaves the server. */
export type OcrExport = {
  filename: string;
  text: string;
  redactions: OcrRedactionSummary;
};

/** A human correction; the original OCR value is never overwritten. */
export type OcrFieldRevision = {
  id: string;
  attachmentId: string;
  projectId: string;
  fieldId: string;
  fieldKind: DocumentFieldKind;
  page: number;
  blockId: string | null;
  /** Evidence region to display next to the revision. */
  bbox: DocumentBBox | null;
  /** Original model output at the time the correction was recorded. */
  originalText: string;
  revisedText: string;
  reason: string;
  revisedBy: UserOption | null;
  createdAt: string;
};

/**
 * A human revision is an annotation, and annotators make mistakes too. Before a
 * revision is allowed to move a threshold it gets a reliability grade from the
 * second opinions recorded in `ocr_revision_reviews`.
 */
export type OcrAnnotationReliability =
  /** A reviewer who is not the reviser confirmed the corrected value. */
  | 'double_confirmed'
  /** The dispute was settled by a third reviewer. */
  | 'arbitrated'
  /** Only the original reviser vouched for it, with no second opinion yet. */
  | 'single_reviewer'
  /** Reviewers disagree; excluded from fitting until arbitration. */
  | 'disputed';

export type OcrRevisionReviewVerdict = 'confirm' | 'revise' | 'arbitrate';

/** One second opinion on a field revision, never from the reviser themselves. */
export type OcrRevisionReview = {
  id: string;
  revisionId: string;
  verdict: OcrRevisionReviewVerdict;
  /** Value proposed by the reviewer when the verdict is `revise` or `arbitrate`. */
  value: string | null;
  note: string | null;
  reviewedBy: UserOption | null;
  createdAt: string;
};

/** A revision with its second opinions, as the quality-control queue shows it. */
export type OcrRevisionQcItem = {
  revision: OcrFieldRevision;
  attachmentName: string;
  projectName: string | null;
  reliability: OcrAnnotationReliability;
  reviews: OcrRevisionReview[];
  /** Reviewers disagreed and nobody has arbitrated: this label is not usable yet. */
  needsArbitration: boolean;
};

export type OcrRevisionQcReviewer = {
  reviewerId: string | null;
  reviewerName: string;
  reviewed: number;
  confirmed: number;
  revised: number;
  /** Share of this reviewer's verdicts that agreed with the original reviser. */
  agreementRate: number | null;
};

export type OcrRevisionQcStats = {
  revisions: number;
  reviewed: number;
  unreviewed: number;
  doubleConfirmed: number;
  arbitrated: number;
  disputed: number;
  /** Share of second opinions that disagreed with the reviser. */
  disagreementRate: number | null;
  interval: [number, number];
  /** Share of revisions that have any second opinion. */
  coverage: number | null;
  byReviewer: OcrRevisionQcReviewer[];
  /** Grades of the labels actually offered to threshold fitting. */
  annotationMix: { doubleConfirmed: number; singleReviewer: number; disputed: number };
};

/**
 * One key business field locatable by page/block/bbox, with the model source,
 * validation rules and recovery candidates that produced it.
 */
export type OcrFieldProvenance = {
  /** `p{page}:{blockId}` or `p{page}:{blockId}:r{row}:c{column}` for cells. */
  id: string;
  kind: DocumentFieldKind;
  page: number;
  blockId: string;
  bbox: DocumentBBox | null;
  /** Original OCR text; revisions are stored separately and never replace it. */
  text: string;
  confidence: number | null;
  source: DocumentSource;
  /** Region descriptor a business system can crop or re-run OCR against. */
  crop: { page: number; bbox: DocumentBBox | null };
  cell?: { row: number; column: number; header: string };
  validation: {
    status: 'passed' | 'flagged' | 'failed';
    rules: string[];
    issues: string[];
    /** Numeric interpretation only; the recognized text stays unchanged. */
    numeric: { canonical: string | null; valid: boolean } | null;
  };
  evidence: {
    agreement: DocumentFieldAgreement | null;
    selected: 'initial' | 'candidate' | null;
    passes: number;
    failed: string[];
    candidates: DocumentFieldCandidate[];
  } | null;
  revisions: OcrFieldRevision[];
};

export type OcrFieldList = { fields: OcrFieldProvenance[] };

/** Why a production sample entered the annotation pool. */
export type OcrFeedbackErrorType =
  | 'low_confidence'
  | 'model_disagreement'
  | 'field_validation'
  | 'human_revision'
  | 'user_complaint';

export type OcrFeedbackStatus = 'pool' | 'sampled' | 'labeled' | 'dismissed';

/** Signal values are 0-1; higher means more likely to need annotation. */
export type OcrFeedbackSignals = {
  confidence: number | null;
  uncertainty: number;
  disagreement: number;
  fieldFailure: number;
  /** Rarity of the document category inside the current pool. */
  novelty: number;
  revision: number;
};

export type OcrFeedbackSample = {
  id: string;
  attachmentId: string | null;
  projectId: string | null;
  sha256: string | null;
  errorType: OcrFeedbackErrorType;
  /** Mime/extension category only; never extracted document text. */
  category: string;
  lang: string | null;
  page: number | null;
  blockId: string | null;
  fieldId: string | null;
  signals: OcrFeedbackSignals;
  /** Weighted annotation priority, 0-1. */
  priority: number;
  status: OcrFeedbackStatus;
  note: string | null;
  createdAt: string;
  sampledAt: string | null;
  labeledAt: string | null;
};

export type OcrFeedbackPool = {
  total: number;
  byErrorType: Record<OcrFeedbackErrorType, number>;
  byCategory: { category: string; count: number }[];
  byStatus: Record<OcrFeedbackStatus, number>;
  /** Samples not yet labeled or dismissed. */
  unlabeled: number;
};

export type OcrFeedbackStratum = {
  errorType: OcrFeedbackErrorType;
  category: string;
  available: number;
  selected: number;
};

export type OcrFeedbackBudget = {
  /** Annotation-cost budget; null means no budget cap. */
  limit: number | null;
  used: number;
  remaining: number | null;
};

export type OcrFeedbackCoverage = {
  categories: number;
  errorTypes: number;
  poolCategories: number;
  poolErrorTypes: number;
};

export type OcrFeedbackSelection = {
  samples: OcrFeedbackSample[];
  strata: OcrFeedbackStratum[];
  budget: OcrFeedbackBudget;
  coverage: OcrFeedbackCoverage;
  /** Pool samples left for a later round because of the total or cost cap. */
  skipped: number;
};

export type OcrKnowledgeEntityType = 'identifier' | 'account' | 'amount' | 'date';

/** One field occurrence of a normalized business entity. */
export type OcrKnowledgeOccurrence = {
  attachmentId: string;
  projectId: string;
  projectName: string | null;
  name: string;
  page: number;
  fieldId: string;
  fieldKind: DocumentFieldKind;
  /** Effective value: the latest human revision, otherwise the OCR text. */
  value: string;
  confidence: number | null;
  revised: boolean;
  createdAt: string;
};

/**
 * Cross-document business entity. `canonical` collapses formatting differences
 * (whitespace, case, thousands separators, date digit groups) while the raw
 * field text stays untouched in each occurrence.
 */
export type OcrKnowledgeEntity = {
  id: string;
  type: OcrKnowledgeEntityType;
  canonical: string;
  display: string;
  occurrences: OcrKnowledgeOccurrence[];
  /** Distinct attachments containing the entity. */
  documents: number;
  confidence: number | null;
  revised: boolean;
};

export type OcrKnowledgeRelationKind = 'shared' | 'mentions';

/** A reference discovered either by co-occurrence or by text mention. */
export type OcrKnowledgeRelation = {
  entityId: string;
  entityType: OcrKnowledgeEntityType;
  kind: OcrKnowledgeRelationKind;
  from: string;
  to: string;
};

export type OcrKnowledgeMetric = {
  key: string;
  label: string;
  value: number;
  unit: 'count' | 'amount';
  samples: number;
};

export type OcrKnowledgeGraph = {
  generatedAt: string;
  documents: number;
  entities: OcrKnowledgeEntity[];
  relations: OcrKnowledgeRelation[];
  metrics: OcrKnowledgeMetric[];
  byType: Record<OcrKnowledgeEntityType, number>;
  warnings: string[];
};

export type OcrDriftDimension =
  | 'resolution'
  | 'language'
  | 'file_type'
  | 'page_size'
  | 'noise'
  | 'layout';

export type OcrDriftBucket = {
  key: string;
  baseline: number;
  current: number;
  /** current share minus baseline share. */
  delta: number;
};

export type OcrDriftDimensionReport = {
  dimension: OcrDriftDimension;
  /** Total variation distance between the two distributions, 0-1. */
  totalVariation: number;
  threshold: number;
  status: 'stable' | 'drift' | 'insufficient';
  buckets: OcrDriftBucket[];
};

export type OcrDriftAlert = {
  dimension: OcrDriftDimension;
  severity: 'info' | 'warn' | 'critical';
  totalVariation: number;
  threshold: number;
  message: string;
  buckets: OcrDriftBucket[];
};

export type OcrDriftReport = {
  baselineSamples: number;
  currentSamples: number;
  baselineAt: string | null;
  generatedAt: string;
  dimensions: OcrDriftDimensionReport[];
  alerts: OcrDriftAlert[];
  /** Operational next step when any dimension drifted. */
  recommendation: string | null;
};

/** Persisted alert for audit/history; the live report is recomputed on read. */
export type OcrDriftAlertRecord = OcrDriftAlert & {
  id: string;
  status: 'open' | 'acknowledged';
  detectedAt: string;
  acknowledgedAt: string | null;
  acknowledgedBy: UserOption | null;
};

export type OcrDashboardBucket = {
  key: string;
  documents: number;
  done: number;
  failed: number;
  failureRate: number;
  reviewRate: number;
  truncationRate: number;
  /** Share of finished documents with at least one human field revision (observed, not true field error). */
  revisionObservedRate: number | null;
  /** 1 − mean confidence; a confidence-risk proxy only, production has no ground truth. */
  confidenceRiskProxy: number | null;
  seconds: number | null;
  secondsPerPage: number | null;
  pages: number;
  characters: number;
};

export type OcrStageStats = {
  stage: OcrStageKind;
  runs: number;
  failed: number;
  skipped: number;
  seconds: number;
};

export type OcrProductionDashboard = {
  windowDays: number;
  generatedAt: string;
  documents: number;
  done: number;
  failed: number;
  pending: number;
  processing: number;
  failureRate: number;
  reviewRate: number;
  truncationRate: number;
  revisionObservedRate: number | null;
  /** 1 − mean confidence; a confidence-risk proxy only, production has no ground truth. */
  confidenceRiskProxy: number | null;
  revisions: number;
  latency: { averageSeconds: number | null; p95Seconds: number | null };
  throughput: { pages: number; characters: number; charactersPerSecond: number | null };
  byModel: OcrDashboardBucket[];
  byLanguage: OcrDashboardBucket[];
  byFileType: OcrDashboardBucket[];
  /** Business type inferred from the attachment name (invoice/contract/report/...). */
  byBusinessType: OcrDashboardBucket[];
  /** Customer/organization dimension (workspace), keyed by workspace name. */
  byWorkspace: OcrDashboardBucket[];
  byPageBucket: OcrDashboardBucket[];
  byStage: OcrStageStats[];
  /** Fitted customer/organization threshold profiles, when available. */
  workspaceThresholds?: OcrThresholdProfile[];
  feedback: OcrFeedbackPool;
  drift: OcrDriftReport;
};

export type OcrVersionNodeKind = 'original' | 'stage' | 'selection' | 'revision';

/** One immutable step in an attachment's OCR lineage. */
export type OcrVersionNode = {
  id: string;
  kind: OcrVersionNodeKind;
  label: string;
  at: string | null;
  engine: OcrEngine | null;
  model: string | null;
  modelSha256: string | null;
  /** Stage input/output hash or field evidence region. */
  sha256: string | null;
  score: number | null;
  /** Present for revisions and selections; the original text is never replaced. */
  text: string | null;
  parents: string[];
  detail: Record<string, unknown>;
};

export type OcrVersionChain = {
  attachmentId: string;
  projectId: string;
  status: OcrStatus;
  nodes: OcrVersionNode[];
  revisions: OcrFieldRevision[];
};

export type OcrOptimizationStatus = 'proposed' | 'implemented' | 'measured' | 'rolled_back';

export type OcrOptimizationRisk = 'low' | 'medium' | 'high';

/** One ledger row: why a change was made, what it cost and what was observed. */
export type OcrOptimizationEntry = {
  id: string;
  title: string;
  targetError: string;
  /** Expected key-field accuracy lift, 0-1. */
  expectedGain: number;
  /** Person-days. */
  implementationCost: number;
  /** Relative extra inference cost (0 = free, 1 = doubles runtime). */
  inferenceCost: number;
  risk: OcrOptimizationRisk;
  benchmarkResult: string;
  productionResult: string;
  status: OcrOptimizationStatus;
  createdAt: string;
  updatedAt: string;
  /** expectedGain / (implementationCost + inferenceCost); higher ranks first. */
  score: number;
  createdBy: UserOption | null;
};

export type Attachment = {
  id: string;
  projectId: string;
  name: string;
  mime: string;
  size: number;
  uploader: UserOption | null;
  createdAt: string;
  downloadUrl: string;
  downloadExpiresAt: string;
  ocr: AttachmentOcrSummary;
};

export type AttachmentList = {
  attachments: Attachment[];
  limits: { maxBytes: number; maxCount: number; maxTotalBytes: number };
  usage: { count: number; totalBytes: number };
};

export type OcrBenchDifficulty = 'clean' | 'mild' | 'moderate' | 'severe';

export type OcrBenchProvenance = {
  annotator?: string;
  reviewer?: string;
  annotatedAt?: string;
  sha256?: string;
  source?: string;
};

/**
 * Corpus role. `dev` is for tuning, `calibration` for threshold fitting and
 * `blind` is reserved for the release gate so tuning cannot chase its numbers.
 */
export type OcrBenchSplit = 'dev' | 'calibration' | 'blind';

export const OCR_BENCH_SPLITS: readonly OcrBenchSplit[] = ['dev', 'calibration', 'blind'];

export function isOcrBenchSplit(value: unknown): value is OcrBenchSplit {
  return typeof value === 'string' && (OCR_BENCH_SPLITS as readonly string[]).includes(value);
}

export type OcrBenchSplitSummary = {
  split: OcrBenchSplit;
  files: number;
  evaluated: number;
  failed: number;
  cer: number | null;
  fieldAccuracy: { hit: number; total: number; rate: number; interval: [number, number] } | null;
  fullyCorrect: { hit: number; total: number; rate: number; interval: [number, number] } | null;
  /** True for the split the release gate was judged on. */
  gateSplit: boolean;
};

export type OcrBenchFile = {
  name: string;
  engine: OcrEngine;
  kind: string;
  lang: string | null;
  difficulty: OcrBenchDifficulty | null;
  degradations: string[];
  /** Annotation provenance from ground truth, including the source file hash. */
  provenance: OcrBenchProvenance | null;
  /** Field names whose ground truth is disputed and excluded from metrics. */
  uncertain: string[];
  split: OcrBenchSplit;
  /** Template family; every file of one family lands in the same split. */
  template: string;
};

export type OcrErrorDetail = {
  type: string;
  /** Number of files where this error category was observed. */
  count: number;
  /** Up to 3 corpus sample names, for drill-down. */
  samples: string[];
};

export type OcrErrorBreakdown = {
  substitutions: number;
  insertions: number;
  deletions: number;
  missingFields: number;
  /** Human-readable categories derived from the counts. */
  types: string[];
  /** Top error categories with counts and sample links. */
  top: OcrErrorDetail[];
};

export type OcrConfusionKind = 'digit' | 'letter' | 'width' | 'punctuation' | 'other';

export type OcrConfusionPair = {
  /** Expected→observed pair, e.g. `0→O`. */
  pair: string;
  kind: OcrConfusionKind;
  count: number;
};

export type OcrConfusionReport = {
  substitutions: number;
  /** Substitutions grouped by confusable class, highest count first. */
  matrix: OcrConfusionPair[];
  /** Earliest character edits with offsets and surrounding context. */
  spans?: OcrErrorSpan[];
  /** Full-width/half-width disagreements. */
  widthErrors: number;
  /** Comma/period/colon and other punctuation confusion. */
  punctuationErrors: number;
  numeric: {
    expectedDigits: number;
    matchedDigits: number;
    substituted: number;
    inserted: number;
    deleted: number;
  };
};

export type OcrErrorSpan = {
  type: 'sub' | 'insert' | 'delete';
  /** Offset in whitespace-free, lower-cased truth; null for insertions. */
  expectedOffset: number | null;
  /** Offset in whitespace-free, lower-cased OCR text; null for deletions. */
  observedOffset: number | null;
  expected: string;
  observed: string;
  expectedContext: string;
  observedContext: string;
};

/** Splits a text error into detection/segmentation vs recognition causes. */
export type OcrErrorDiagnosis = {
  detectionSuspect: boolean;
  segmentationSuspect: boolean;
  recognitionSuspect: boolean;
  reasons: string[];
};

export type OcrBenchTableMetrics = {
  /** Number of ground-truth tables evaluated for this sample. */
  tables: number;
  /** F1 over normalized row signatures. */
  rowsF1: number | null;
  /** F1 over normalized column signatures. */
  columnsF1: number | null;
  /** Share of ground-truth non-empty cells found at the same row/column. */
  cellAccuracy: number | null;
  /** Mean bbox IoU for cells whose ground truth provides coordinates. */
  cellIoU: number | null;
  /** Share of merged ground-truth cells with matching row/column spans. */
  mergedCellAccuracy: number | null;
  /** Simplified tree-edit similarity over the table structure and text. */
  teds: number | null;
};

export type OcrBenchBusinessLoss = {
  /** Sum of weight × per-field error severity. */
  loss: number;
  /** Sum of weights for all checked fields. */
  weight: number;
  /** loss / weight, 0-1. */
  rate: number;
};

export type OcrBenchFileResult = {
  name: string;
  engine: OcrEngine;
  kind: string;
  lang: string | null;
  difficulty: OcrBenchDifficulty | null;
  degradations: string[];
  /** Corpus role this sample was evaluated under; null for runs before splits. */
  split?: OcrBenchSplit | null;
  provenance: OcrBenchProvenance | null;
  uncertain: string[];
  /** SHA256 of the corpus file actually evaluated. */
  sha256: string | null;
  /** null when ground truth has no declared hash. */
  hashVerified: boolean | null;
  status: 'done' | 'failed';
  model: string | null;
  route: OcrRoute | null;
  qualityScore: number | null;
  qualityStatus: DocumentQuality['status'] | null;
  reviewRequired: boolean;
  stages: OcrStage[];
  seconds: number;
  characters: number;
  confidence: number | null;
  pages: number;
  truncated: boolean;
  cer: number | null;
  rawCer: number | null;
  numericCer: number | null;
  /** Error rate over amount-critical symbols: decimal, thousands, sign, currency, percent. */
  symbolCer: number | null;
  wer: number | null;
  keywordRecall: { hit: number; total: number } | null;
  /** Normalized match: case/punctuation/separator-insensitive. */
  fieldAccuracy: { hit: number; total: number; rate: number } | null;
  /**
   * Localized match: the value has to appear in its hinted page/region, in the
   * same block as its expected label, or where the truth text puts it. A field the
   * run cannot locate is excluded from `total` and tallied in `unverifiable`
   * (null on rows stored before the tally existed) — containment is never sold as
   * a strong hit.
   */
  fieldStrong: {
    hit: number;
    total: number;
    rate: number;
    unverifiable: number | null;
  } | null;
  /** Exact match after whitespace collapsing only. */
  fieldExact: { hit: number; total: number; rate: number } | null;
  /** Per-field outcomes for category reliability and calibration. */
  fieldOutcomes: OcrBenchFieldOutcome[];
  /** Every expected field matched and the text-level CER is zero. */
  fullyCorrect: boolean | null;
  errors: OcrErrorBreakdown | null;
  businessLoss: OcrBenchBusinessLoss | null;
  tableMetrics: OcrBenchTableMetrics | null;
  /** Confusable-pair matrix against ground truth. */
  confusions: OcrConfusionReport | null;
  /** Detection vs recognition attribution for the observed text errors. */
  diagnosis: OcrErrorDiagnosis | null;
  /** Explainable model/mode choice evaluated for this sample. */
  routing: OcrRouteDecision | null;
  /** Model file fingerprint reported by the sidecar for this extraction. */
  modelSha256: string | null;
  /** Pipeline/runtime versions captured with the result. */
  runtime: OcrModelRuntime | null;
  error: string | null;
};

export type OcrBenchRun = {
  id: string;
  status: 'running' | 'done' | 'failed';
  startedAt: string;
  finishedAt: string | null;
  includePdf: boolean;
  total: number;
  completed: number;
  current: string | null;
  results: OcrBenchFileResult[];
  error: string | null;
};

export type OcrBenchRunSummary = {
  id: string;
  status: 'running' | 'done' | 'failed';
  startedAt: string;
  finishedAt: string | null;
  includePdf: boolean;
  total: number;
  completed: number;
  failed: number;
  error: string | null;
};

export type OcrBenchGroup = {
  dimension: 'kind' | 'language' | 'difficulty' | 'degradation';
  value: string;
  files: number;
  /** Total processed pages in this bucket. */
  pages: number;
  failed: number;
  cer: number | null;
  /** Containment accuracy, kept for continuity; the gate ranks groups on the strong figure. */
  fieldAccuracy: number | null;
  /** Field comparisons behind `fieldAccuracy`; small buckets are noisy. */
  fieldTotal: number;
  /** Localized accuracy for this bucket; null when no field here could be localized. */
  fieldStrong: number | null;
  /** Localized comparisons behind `fieldStrong`. */
  fieldStrongTotal: number;
  fullyCorrectRate: number | null;
};

export type OcrBenchCalibrationBin = {
  lower: number;
  upper: number;
  count: number;
  confidence: number | null;
  accuracy: number | null;
};

export type OcrBenchCalibration = {
  samples: number;
  /** Expected calibration error over confidence-vs-fully-correct pairs. */
  ece: number | null;
  brier: number | null;
  bins: OcrBenchCalibrationBin[];
};

export type OcrBenchFieldCategory =
  | 'amount'
  | 'date'
  | 'identifier'
  | 'account'
  | 'quantity'
  | 'percentage'
  | 'currency'
  | 'other';

export type OcrBenchFieldOutcome = {
  field: string;
  category: OcrBenchFieldCategory;
  correct: boolean;
  /**
   * Which rule produced `correct`: true when the value was located inside an
   * annotated block, false when only containment was available. Absent on rows
   * stored before the distinction existed.
   */
  localized?: boolean;
};

export type OcrBenchFieldReliability = {
  category: OcrBenchFieldCategory;
  samples: number;
  hit: number;
  /** Samples whose verdict came from the localized (strong) rule. */
  localized: number;
  /** Which rule dominates this bucket, so a weak figure is never read as strong. */
  basis: 'strong' | 'mixed' | 'weak';
  accuracy: number | null;
  interval: [number, number] | null;
  /** Confidence-vs-correctness calibration for this field category. */
  calibration: OcrBenchCalibration;
};

export type OcrBenchCalibrationGroup = {
  dimension: 'kind' | 'language';
  value: string;
  calibration: OcrBenchCalibration;
};

export type OcrBenchGateCheck = {
  name: string;
  value: number | null;
  threshold: number;
  comparison: 'max' | 'min';
  passed: boolean | null;
  /** Worst-group attribution; absent for overall and per-kind checks. */
  group?: { dimension: OcrBenchGroup['dimension']; value: string };
  /** Human-readable caveat, e.g. a gate judged on development data. */
  note?: string;
  /** Observations behind a rate check; absent for CER-style or count checks. */
  samples?: number;
  /**
   * Observations needed to settle this check. For a rate it is the sample size
   * whose Wilson bound still clears `threshold` at the observed value; for
   * non-binomial metrics it is the fixed floor below which the check stays
   * unassessed. Null when no sample size can (the rate itself is the problem).
   * Below `samples`, a pass says more about the corpus size than about OCR.
   */
  requiredSamples?: number | null;
};

export type OcrBenchGate = {
  passed: boolean;
  checks: OcrBenchGateCheck[];
};

export type OcrBenchAggregate = {
  files: number;
  evaluated: number;
  failed: number;
  /** Evaluated documents (same as `evaluated`, named for reporting). */
  documents: number;
  /** Total processed pages across evaluated documents. */
  pages: number;
  /** Total recognized characters across evaluated documents. */
  characters: number;
  cer: number | null;
  rawCer: number | null;
  numericCer: number | null;
  /** Mean amount-critical symbol error rate; null when no sample carries such symbols. */
  symbolCer: number | null;
  wer: number | null;
  keywordRecall: { hit: number; total: number; rate: number } | null;
  fieldAccuracy: {
    hit: number;
    total: number;
    rate: number;
    interval: [number, number];
  } | null;
  /** Localized field match; the release gate is judged on this, not on `fieldAccuracy`. */
  fieldStrong: {
    hit: number;
    total: number;
    rate: number;
    interval: [number, number];
    /** Fields the corpus could not locate, excluded from `total`; null when a stored row predates the tally. */
    unverifiable: number | null;
  } | null;
  fieldExact: {
    hit: number;
    total: number;
    rate: number;
    interval: [number, number];
  } | null;
  /** Share of documents whose every key field is correct, with a 95% Wilson interval. */
  fullyCorrect: { hit: number; total: number; rate: number; interval: [number, number] } | null;
  errors: OcrErrorBreakdown;
  /** Weighted field loss; amount/account/date/currency errors weigh more. */
  businessLoss: OcrBenchBusinessLoss | null;
  /** Mean table structure metrics for samples with table ground truth. */
  tableStructure: (OcrBenchTableMetrics & { tables: number }) | null;
  groups: OcrBenchGroup[];
  /** Per-split sizes and metrics; the gate is judged on the blind split only. */
  splits: OcrBenchSplitSummary[];
  calibration: OcrBenchCalibration;
  calibrationGroups: OcrBenchCalibrationGroup[];
  fieldReliability: OcrBenchFieldReliability[];
  /** Corpus-wide confusable-pair matrix. */
  confusions: OcrConfusionReport;
  gate: OcrBenchGate | null;
};

export type OcrBenchStatus = {
  available: boolean;
  corpusDir: string;
  models: Partial<Record<OcrEngine, string>>;
  /** Static model capability matrix, including active runtime fingerprints. */
  matrix: OcrModelCapability[];
  /** Per-engine runtime versions and model file hashes. */
  runtime: Partial<Record<OcrEngine, OcrModelRuntime>>;
  /** Current grey-release assignment policy, when configured. */
  grey: OcrGreyConfig | null;
  files: OcrBenchFile[];
  run: OcrBenchRun | null;
  aggregate: OcrBenchAggregate | null;
  /** Latest fitted review/fail thresholds, one profile per dimension bucket. */
  thresholds: OcrThresholdProfile[];
  history: OcrBenchRunSummary[];
};

export type OcrExperimentVariantInput = {
  id?: string;
  label?: string;
  engine?: OcrEngine;
  /** Capability id from the model matrix, resolved to a sidecar profile. */
  modelId?: string | null;
  /** Explicit sidecar profile; takes precedence over `modelId`. */
  profile?: string | null;
  mode?: OcrMode;
  dpi?: number | null;
  /** Photometric channel: rgb (default), gray, or red. */
  channel?: OcrChannel;
};

export type OcrExperimentVariant = {
  id: string;
  label: string;
  engine: OcrEngine;
  modelId: string | null;
  profile: string | null;
  mode: OcrMode;
  dpi: number | null;
  channel: OcrChannel;
  /** Enhanced mode enables denoise/binarize/deskew preprocessing in the sidecar. */
  preprocess: 'original' | 'enhanced';
};

export type OcrExperimentRequest = {
  variants: OcrExperimentVariantInput[];
  includePdf?: boolean;
  /** Files per variant in the screening stage. */
  sample?: number;
  /** Best variants promoted to the full corpus. */
  topK?: number;
  full?: boolean;
};

export type OcrExperimentSample = {
  name: string;
  kind: string;
  lang: string | null;
  variantId: string;
  status: 'done' | 'failed';
  cer: number | null;
  rawCer: number | null;
  numericCer: number | null;
  wer: number | null;
  fieldRate: number | null;
  confidence: number | null;
  seconds: number;
  characters: number;
  error: string | null;
};

export type OcrExperimentVariantSummary = {
  id: string;
  label: string;
  engine: OcrEngine;
  modelId: string | null;
  profile: string | null;
  mode: OcrMode;
  dpi: number | null;
  channel: OcrChannel;
  preprocess: 'original' | 'enhanced';
  license: string | null;
  memoryMb: number | null;
  files: number;
  failed: number;
  meanCer: number | null;
  meanRawCer: number | null;
  meanNumericCer: number | null;
  meanWer: number | null;
  fieldRate: number | null;
  meanConfidence: number | null;
  meanSeconds: number;
  score: number | null;
  rank: number | null;
};

export type OcrExperimentStage = {
  files: string[];
  results: OcrExperimentSample[];
  summaries: OcrExperimentVariantSummary[];
};

export type OcrExperimentResult = {
  id: string;
  status: 'running' | 'done' | 'failed';
  startedAt: string;
  finishedAt: string | null;
  includePdf: boolean;
  sampleSize: number;
  topK: number | null;
  variants: OcrExperimentVariant[];
  stage: 'screen' | 'full';
  screen: OcrExperimentStage;
  full: OcrExperimentStage | null;
  selected: string[];
  error: string | null;
};

export type OcrThresholdDimension =
  | 'overall'
  | 'kind'
  | 'difficulty'
  | 'language'
  | 'file_type'
  | 'workspace';

export type OcrPassAuditVerdict = 'clean' | 'error';

/** One automatically passed document pulled into the unbiased audit queue. */
export type OcrPassAudit = {
  id: string;
  attachmentId: string;
  attachmentName: string;
  projectId: string;
  projectName: string | null;
  workspaceId: string | null;
  /** Document type stratum: file extension of the attachment. */
  docType: string;
  engine: string | null;
  model: string | null;
  qualityScore: number | null;
  confidence: number | null;
  period: string;
  sampledAt: string;
  /** Consensus state derived from the two independent verdicts. */
  status: 'pending' | 'clean' | 'error' | 'disputed';
  firstVerdict: OcrPassAuditVerdict | null;
  firstBy: string | null;
  firstAt: string | null;
  secondVerdict: OcrPassAuditVerdict | null;
  secondBy: string | null;
  secondAt: string | null;
  note: string | null;
};

export type OcrPassAuditStats = {
  sampled: number;
  pending: number;
  audited: number;
  clean: number;
  error: number;
  disputed: number;
  /** Share of audited documents that passed automatically yet contain an error. */
  silentErrorRate: number | null;
  /** 95% Wilson interval for the silent error rate. */
  interval: [number, number];
  /** Documents where the two reviewers disagreed. */
  disagreementRate: number | null;
  passDocuments: number;
  coverage: number | null;
  byDocType: {
    docType: string;
    sampled: number;
    audited: number;
    clean: number;
    error: number;
    disputed: number;
    silentErrorRate: number | null;
    interval: [number, number];
  }[];
};

/** One benchmark or production document used to fit review thresholds. */
export type OcrCalibrationSample = {
  confidence: number;
  /** Every expected field matched and the text-level CER is zero. */
  correct: boolean;
  /** Document needs human review (not fully correct). */
  severe: boolean;
  kind?: string | null;
  difficulty?: string | null;
  language?: string | null;
  fileType?: string | null;
  workspaceId?: string | null;
  /**
   * How this label was produced. Human revisions that nobody else confirmed are
   * down-weighted, and disputed ones are dropped, so annotator mistakes cannot
   * move a fitted threshold (review #69).
   */
  annotation?: OcrAnnotationReliability | null;
  /** Overrides the default weight of the reliability grade; 0 drops the sample. */
  weight?: number | null;
};

export type OcrThresholdFitOptions = {
  /** Buckets below this many samples are stored but marked uncalibrated. */
  minSamples?: number;
  /** Minimum severe-error samples before a bucket is trusted. */
  minPositives?: number;
  /** Target precision for the key-field confidence warning threshold. */
  keyFieldTarget?: number;
  /** Target precision for the automatic-fail threshold. */
  failTarget?: number;
};

/** One point of a monotonic raw-confidence -> calibrated-probability map. */
export type OcrConfidencePoint = {
  raw: number;
  calibrated: number;
};

export type OcrThresholdProfile = {
  id: string;
  dimension: OcrThresholdDimension;
  /** Bucket value, or `all` for the overall profile. */
  value: string;
  workspaceId: string | null;
  samples: number;
  /**
   * Label mass the fit actually used. Lower than `samples` when annotations are
   * down-weighted; disputed labels are dropped before fitting entirely.
   */
  effectiveSamples?: number;
  positives: number;
  /** Review when quality/confidence falls at or below this value. */
  reviewThreshold: number;
  failThreshold: number;
  keyFieldConfidence: number;
  precision: number | null;
  recall: number | null;
  falseReviewRate: number | null;
  /** Expected calibration error before applying `confidenceMap`. */
  ece: number | null;
  /** Expected calibration error after `confidenceMap`; null when no map. */
  calibratedEce?: number | null;
  brier: number | null;
  /**
   * Isotonic raw-confidence mapping fitted on this bucket. Applied before the
   * confidence signal enters the quality score and key-field thresholds.
   */
  confidenceMap?: OcrConfidencePoint[] | null;
  /** False when the bucket lacks enough samples or severe errors. */
  calibrated: boolean;
  createdAt: string;
  updatedAt: string;
};

export type OcrThresholdQuery = {
  kind?: string | null;
  difficulty?: string | null;
  language?: string | null;
  fileType?: string | null;
  workspaceId?: string | null;
};

export type Comment = {
  id: string;
  projectId: string;
  taskId: string | null;
  taskTitle: string | null;
  author: UserOption | null;
  body: string;
  mentions: UserOption[];
  createdAt: string;
};

export type CommentList = {
  comments: Comment[];
  total: number;
};

export type NotificationType = 'mention' | 'comment' | 'task_assigned' | 'weekly_digest';

export type AppNotification = {
  id: string;
  type: NotificationType;
  title: string;
  body: string;
  link: string | null;
  readAt: string | null;
  createdAt: string;
};

export type NotificationList = {
  notifications: AppNotification[];
  unread: number;
};

export type ProjectStatusCounts = {
  all: number;
  planning: number;
  active: number;
  on_hold: number;
  completed: number;
  archived: number;
};

export type ProjectOverview = {
  total: number;
  completed: number;
  active: number;
  planning: number;
  onHold: number;
  archived: number;
  completion: number;
};

export type ProjectListResult = {
  projects: Project[];
  total: number;
  page: number;
  pageSize: number;
  counts: ProjectStatusCounts;
  tags: ProjectTagCount[];
};

export type ProjectScaffoldResult = {
  project: ProjectDetail;
  milestones: number;
  tasks: number;
};

export type ProjectSearchHit = {
  id: string;
  name: string;
  status: ProjectStatus;
  progress: number;
};

export type ActivityType =
  | 'project.created'
  | 'project.updated'
  | 'project.status_changed'
  | 'project.completed'
  | 'project.archived'
  | 'project.restored'
  | 'project.deleted'
  | 'project.member_added'
  | 'project.member_removed'
  | 'project.imported'
  | 'project.template_applied'
  | 'project.duplicated'
  | 'task.created'
  | 'task.updated'
  | 'task.completed'
  | 'task.reopened'
  | 'task.deleted'
  | 'milestone.created'
  | 'milestone.deleted'
  | 'comment.created'
  | 'comment.deleted'
  | 'user.created'
  | 'user.role_changed'
  | 'user.disabled'
  | 'user.enabled'
  | 'user.password_changed';

export type ActivityItem = {
  seq: number;
  type: ActivityType;
  actor: UserOption | null;
  project: { id: string; name: string } | null;
  message: string;
  createdAt: string;
  meta: Record<string, unknown> | null;
  /** FTS snippet with `<mark>` markers, present on search hits only. */
  highlight?: string | null;
};

export type ActivityPage = {
  activities: ActivityItem[];
  nextCursor: number | null;
};

export type KpiFormat = 'currency' | 'number' | 'percent';

export type SparkPoint = {
  date: string;
  value: number;
};

export type KpiValue = {
  value: number;
  previous: number | null;
  delta: number | null;
  format: KpiFormat;
  sparkline: SparkPoint[];
};

export type RevenuePoint = {
  date: string;
  revenue: number;
};

export type ChannelSlice = {
  channel: string;
  sessions: number;
  share: number;
};

export type RangeInfo = {
  key: DateRangeKey;
  from: string;
  to: string;
  days: number;
  previous: { from: string; to: string; days: number };
  granularity: Granularity;
  timezone: string;
};

export type RuntimeInfo = {
  node: string;
  sqlite: string;
  pid: number;
  uptime: number;
};

export type CurrencyCode = 'USD' | 'CNY' | 'EUR' | 'GBP' | 'JPY' | 'HKD' | 'SGD';

export type WorkspaceSettings = {
  currency: CurrencyCode;
  rates: Record<CurrencyCode, number>;
  timeLogVisibility: 'all' | 'managers' | 'self';
  updatedAt: string;
};

export type PushStatus = {
  enabled: boolean;
  publicKey: string | null;
  subscriptions: number;
};

export type DashboardSummary = {
  range: RangeInfo;
  demo: boolean;
  currency: CurrencyCode;
  kpis: {
    revenue: KpiValue;
    customers: KpiValue;
    conversion: KpiValue;
  };
  revenue: RevenuePoint[];
  channels: ChannelSlice[];
  projects: ProjectOverview;
  activities: ActivityItem[];
  runtime: RuntimeInfo;
};

export type RevenueSeriesPoint = {
  bucket: string;
  label: string;
  revenue: number;
  previous: number | null;
};

export type RevenueReport = {
  range: RangeInfo;
  currency: CurrencyCode;
  granularity: Granularity;
  points: RevenueSeriesPoint[];
  total: number;
  previousTotal: number | null;
  delta: number | null;
  comparison: boolean;
};

export type ChannelPerformance = {
  channel: string;
  sessions: number;
  share: number;
  previousSessions: number | null;
  delta: number | null;
};

export type ChannelReport = {
  range: RangeInfo;
  channels: ChannelPerformance[];
  total: number;
};

export type AudienceReport = {
  range: RangeInfo;
  customers: number;
  previousCustomers: number | null;
  customerDelta: number | null;
  visitors: number;
  conversion: number;
  previousConversion: number | null;
  conversionDelta: number | null;
  daily: SparkPoint[];
};

export type MetricRecord = {
  date: string;
  revenue: number;
  customers: number;
  conversions: number;
  visitors: number;
  currency: CurrencyCode;
};

export type MetricDay = MetricRecord & { source: string };

export type MetricImportResult = {
  imported: number;
  skipped: number;
  errors: { row: number; message: string }[];
};

export type AnalyticsSourceSummary = {
  source: string;
  days: number;
  from: string;
  to: string;
  revenue: number;
};

export type ReportKind = 'revenue' | 'channels' | 'audience';

export type ReportFrequency = 'none' | 'weekly' | 'monthly';

export type SavedReportQuery = {
  kind: ReportKind;
  range: DateRangeKey;
  from?: string;
  to?: string;
  granularity?: Granularity;
  compare?: boolean;
};

export type SavedReport = {
  id: string;
  name: string;
  query: SavedReportQuery;
  frequency: ReportFrequency;
  lastRunAt: string | null;
  nextRunAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type SearchResults = {
  projects: ProjectSearchHit[];
  activities: ActivityItem[];
  users: UserDirectoryEntry[];
};

export type ImportIssue = { row: number; message: string };

export type ImportPreviewItem = {
  row: number;
  name: string;
  status: ProjectStatus;
  ownerEmail: string | null;
  members: string[];
};

export type ImportResult = {
  preview: boolean;
  imported: number;
  skipped: number;
  duplicates: number;
  errors: ImportIssue[];
  items: ImportPreviewItem[];
};

export type PresenceClient = {
  id: string;
  name: string;
  since: string;
};

export type TypingMessage = {
  type: 'typing';
  clientId: string;
  name: string;
  projectId: string;
  active: boolean;
};

export type SnapshotPayload = {
  user: SessionUser;
  projects: Project[];
  counts: ProjectStatusCounts;
  activities: ActivityItem[];
  cursor: number;
  clients: PresenceClient[];
  runtime: RuntimeInfo;
};

export type AuditEntry = {
  seq: number;
  actorId: string | null;
  actorName: string | null;
  action: string;
  target: string | null;
  ip: string | null;
  detail: unknown;
  createdAt: string;
};

export type AuditActionCount = { action: string; count: number };

export type AuditRetention = { maxRows: number; days: number };

export type AuditPage = {
  entries: AuditEntry[];
  total: number;
  page: number;
  pageSize: number;
  actions: AuditActionCount[];
  retention: AuditRetention;
};

export type AuditCleanupResult = { removed: number; days: number };

export const FEATURE_FLAG_KEYS = [
  'analytics',
  'audit_center',
  'webhooks',
  'push_notifications',
  'project_templates',
  'enterprise',
] as const;

export type FeatureFlagKey = (typeof FEATURE_FLAG_KEYS)[number];

export type FeatureFlags = Record<FeatureFlagKey, boolean>;

export type FeatureFlag = {
  key: FeatureFlagKey;
  enabled: boolean;
  updatedAt: string;
  updatedBy: string | null;
};

export type OpsSettings = {
  backupRetentionDays: number;
  trashRetentionDays: number;
  auditRetentionDays: number;
  activityRetentionDays: number;
  /** 0 keeps OCR text and field revisions indefinitely. */
  ocrRetentionDays: number;
  demoDataEnabled: boolean;
  updatedAt: string;
};

export type OpsBackup = {
  name: string;
  sizeBytes: number;
  createdAt: string;
};

export type OpsIntegrity = {
  ok: boolean;
  checkedAt: string;
  messages: string[];
};

export type OpsStatus = {
  healthy: boolean;
  schemaVersion: number;
  sqliteVersion: string;
  databaseBytes: number;
  backupDir: string;
  backups: OpsBackup[];
  settings: OpsSettings;
  features: FeatureFlag[];
  demo: { enabled: boolean; users: number; projects: number };
  counts: {
    users: number;
    projects: number;
    sessions: number;
    activities: number;
    auditEntries: number;
  };
  pendingRestore: string | null;
};

export type UserDataExport = {
  generatedAt: string;
  user: Record<string, unknown>;
  preferences: Record<string, unknown> | null;
  ownedProjects: Record<string, unknown>[];
  memberships: Record<string, unknown>[];
  assignedTasks: Record<string, unknown>[];
  comments: Record<string, unknown>[];
  activities: Record<string, unknown>[];
  sessions: Record<string, unknown>[];
  tokens: Record<string, unknown>[];
  webhooks: Record<string, unknown>[];
  notifications: Record<string, unknown>[];
  auditEntries: Record<string, unknown>[];
  attachments: Record<string, unknown>[];
};

// ---------------------------------------------------------------------------
// Enterprise module (schema v15)
// ---------------------------------------------------------------------------

export type GoalLevel = 'company' | 'department' | 'workspace' | 'project';
export type GoalStatus = 'active' | 'locked' | 'archived';
export type GoalUpdateMode = 'manual' | 'linked';

export type KeyResult = {
  id: string;
  goalId: string;
  title: string;
  unit: string;
  baseline: number | null;
  target: number | null;
  actual: number | null;
  weight: number;
  updateMode: GoalUpdateMode;
  progress: number;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type GoalLink = {
  id: string;
  goalId: string;
  keyResultId: string | null;
  projectId: string;
  projectName: string;
  taskId: string | null;
  taskTitle: string | null;
  milestoneId: string | null;
  milestoneTitle: string | null;
  createdAt: string;
};

export type Goal = {
  id: string;
  workspaceId: string;
  parentId: string | null;
  level: GoalLevel;
  projectId: string | null;
  title: string;
  description: string;
  ownerId: string | null;
  ownerName: string | null;
  weight: number;
  period: string;
  baseline: number | null;
  target: number | null;
  actual: number | null;
  unit: string;
  updateMode: GoalUpdateMode;
  status: GoalStatus;
  progress: number;
  keyResults: KeyResult[];
  links: GoalLink[];
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type GoalTree = {
  goals: Goal[];
  roots: string[];
};

export type GoalImpact = {
  goalId: string;
  expectedVersion: number;
  changes: Record<string, unknown>;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  affectedProjects: { id: string; name: string }[];
  affectedTasks: number;
  affectedMilestones: number;
  affectedGoals: { id: string; title: string }[];
  owners: UserOption[];
  risk: 'low' | 'medium' | 'high';
  requiresConfirmationFrom: UserOption[];
  generatedAt: string;
};

export type PortfolioFactor = {
  key: string;
  label: string;
  weight: number;
  direction: 'positive' | 'negative';
};

export type PortfolioConfig = {
  id: string;
  workspaceId: string;
  name: string;
  weights: PortfolioFactor[];
  version: number;
  active: boolean;
  createdAt: string;
  updatedAt: string;
};

export type PortfolioFactorValue = {
  key: string;
  value: number | null;
};

export type PortfolioScore = {
  id: string;
  projectId: string;
  projectName: string;
  projectStatus: ProjectStatus;
  configId: string;
  factors: PortfolioFactorValue[];
  missing: string[];
  score: number | null;
  overrideScore: number | null;
  overrideReason: string | null;
  effectiveScore: number | null;
  scoredAt: string;
  version: number;
};

export type DependencyType = 'FS' | 'SS' | 'FF' | 'SF';

export type TaskDependency = {
  id: string;
  projectId: string | null;
  predecessorId: string;
  predecessorTitle: string;
  predecessorProjectId: string;
  successorId: string;
  successorTitle: string;
  successorProjectId: string;
  type: DependencyType;
  lagDays: number;
  crossProject: boolean;
  createdAt: string;
};

export type CriticalPathNode = {
  taskId: string;
  title: string;
  projectId: string;
  projectName: string;
  earliestStart: string;
  earliestFinish: string;
  latestStart: string;
  latestFinish: string;
  floatDays: number;
  critical: boolean;
};

export type CriticalPath = {
  projectId: string;
  nodes: CriticalPathNode[];
  chain: string[];
  estimatedCompletion: string | null;
  cycles: string[][];
};

export type TimeLog = {
  id: string;
  taskId: string;
  taskTitle: string;
  userId: string | null;
  userName: string;
  minutes: number;
  workDate: string;
  note: string;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type TimeSummary = {
  taskId: string;
  estimateHours: number | null;
  actualMinutes: number;
  actualHours: number;
  varianceHours: number | null;
  logs: TimeLog[];
};

export type TaskBlocker = {
  id: string;
  taskId: string;
  taskTitle: string;
  reason: string;
  category: 'external' | 'decision' | 'environment' | 'data' | 'dependency' | 'other';
  ownerTeam: string;
  expectedResolveAt: string | null;
  status: 'open' | 'resolved';
  resolvedAt: string | null;
  resolvedByName: string | null;
  evidence: string;
  createdByName: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type BlockerReport = {
  open: number;
  resolved: number;
  blockedDays: number;
  byCategory: { category: string; count: number }[];
};

export type RecurrenceRule = {
  id: string;
  projectId: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  assigneeId: string | null;
  rule: string;
  timezone: string;
  startsOn: string;
  endsOn: string | null;
  count: number | null;
  exceptions: string[];
  holidays: string[];
  lastGeneratedOn: string | null;
  active: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type RecurrenceRunResult = {
  generated: { date: string; taskId: string }[];
  skipped: string[];
  nextOccurrence: string | null;
};

export type AutomationTrigger =
  | 'task.created'
  | 'task.updated'
  | 'task.completed'
  | 'blocker.created'
  | 'dependency.created';

export type AutomationCondition = {
  field: string;
  operator: 'eq' | 'neq' | 'in' | 'contains' | 'exists';
  value?: string | number | boolean | string[] | null;
};

export type AutomationAction = {
  type: 'set_status' | 'set_priority' | 'assign_to' | 'add_comment' | 'create_task' | 'notify';
  value?: string;
  title?: string;
};

export type AutomationRule = {
  id: string;
  workspaceId: string;
  projectId: string | null;
  name: string;
  trigger: AutomationTrigger;
  conditions: AutomationCondition[];
  actions: AutomationAction[];
  active: boolean;
  maxRunsPerHour: number;
  createdById: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type AutomationRun = {
  id: string;
  ruleId: string;
  ruleName: string;
  eventKey: string;
  mode: 'live' | 'dry_run' | 'replay';
  trigger: string;
  status: 'ok' | 'skipped' | 'failed';
  output: unknown;
  error: string | null;
  durationMs: number;
  replayOf: string | null;
  createdAt: string;
};

export type AutomationPreview = {
  matched: boolean;
  blockedReason: string | null;
  actions: { type: string; description: string }[];
  runs: AutomationRun[];
};

export type DocumentStatus = 'draft' | 'review' | 'published' | 'expired' | 'archived';
export type DocumentConfidentiality = 'internal' | 'restricted' | 'confidential';

export type ProjectDocument = {
  id: string;
  projectId: string;
  workspaceId: string | null;
  title: string;
  content: string;
  format: 'markdown' | 'text';
  status: DocumentStatus;
  ownerId: string | null;
  ownerName: string | null;
  confidentiality: DocumentConfidentiality;
  reviewDueAt: string | null;
  reviewCycleDays: number | null;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type DocumentVersion = {
  id: string;
  documentId: string;
  version: number;
  title: string;
  content: string;
  changeSummary: string;
  createdByName: string | null;
  createdAt: string;
};

export type DecisionStatus = 'proposed' | 'approved' | 'rejected' | 'superseded';

export type DecisionOption = {
  title: string;
  pros?: string;
  cons?: string;
};

export type DecisionRecord = {
  id: string;
  workspaceId: string;
  projectId: string | null;
  projectName: string | null;
  title: string;
  status: DecisionStatus;
  context: string;
  options: DecisionOption[];
  decision: string;
  consequences: string;
  decidedByName: string | null;
  reviewAt: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type DecisionVersion = {
  id: string;
  decisionId: string;
  version: number;
  snapshot: Record<string, unknown>;
  changeSummary: string;
  changedByName: string | null;
  createdAt: string;
};

export type MetricDefinition = {
  id: string;
  workspaceId: string;
  name: string;
  unit: string;
  formula: string;
  dimensions: string[];
  aggregation: string;
  source: string;
  refreshMinutes: number;
  ownerId: string | null;
  ownerName: string | null;
  status: 'draft' | 'published' | 'archived';
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type MetricPoint = {
  bucket: string;
  value: number | null;
};

export type MetricEvaluation = {
  metricId: string;
  name: string;
  unit: string;
  from: string;
  to: string;
  value: number | null;
  series: MetricPoint[];
  dependencies: string[];
  warnings: string[];
  refreshMinutes: number;
  source: string;
};

export type ProjectBudget = {
  id: string;
  projectId: string;
  projectName: string;
  costCenter: string;
  currency: CurrencyCode;
  budgetCents: number;
  committedCents: number;
  actualCents: number;
  forecastCents: number;
  fxRate: number;
  fxDate: string | null;
  thresholdPct: number;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type BudgetEntry = {
  id: string;
  budgetId: string;
  kind: 'committed' | 'actual' | 'forecast';
  amountCents: number;
  currency: CurrencyCode;
  fxRate: number;
  fxDate: string | null;
  note: string;
  createdAt: string;
};

export type BudgetSummary = {
  budget: ProjectBudget;
  entries: BudgetEntry[];
  remainingCents: number;
  burnPct: number;
  forecastRemainingCents: number;
  thresholdReached: boolean;
};

export type PermissionSimulationInput = {
  userId: string;
  resourceType: 'workspace' | 'project' | 'task';
  resourceId: string;
  action: string;
};

export type PermissionSource = {
  source: 'role' | 'custom_role' | 'jit';
  label: string;
  grants: string[];
};

export type PermissionSimulationResult = {
  allowed: boolean;
  reason: string;
  effectivePermissions: Permission[];
  sources: PermissionSource[];
  conflicts: string[];
  resourceLabel: string | null;
};

export type JitGrant = {
  id: string;
  workspaceId: string;
  userId: string;
  userName: string;
  resourceType: 'workspace' | 'project' | 'task';
  resourceId: string;
  action: string;
  permissions: Permission[];
  reason: string;
  status: 'pending' | 'active' | 'rejected' | 'revoked' | 'expired';
  requestedByName: string | null;
  approvedByName: string | null;
  startsAt: string;
  expiresAt: string;
  usedAt: string | null;
  createdAt: string;
  updatedAt: string;
  usedCount?: number;
  postReviewRequired?: boolean;
  postReviewedBy?: string | null;
  postReviewedAt?: string | null;
  emergency?: boolean;
};

/** Generic shape for the schema-v16 workbench resources. */
export type DomainRecord = { id: string } & Record<string, unknown>;

export type DomainList = {
  items: DomainRecord[];
  total: number;
};

export type WorkflowRunResult = {
  run: DomainRecord;
  events: DomainRecord[];
  status: 'completed' | 'waiting' | 'failed';
  error?: string;
};

export type PermissionSample = {
  id: string;
  workspaceId: string;
  name: string;
  userId: string;
  resourceType: string;
  resourceId: string;
  action: string;
  expectedAllow: boolean;
  lastResult?: { allowed: boolean; passed: boolean; reason: string } | null;
  createdAt: string;
};

export type CapacityRow = {
  userId: string;
  userName: string;
  role: string;
  skills: string[];
  weeklyHours: number;
  fte: number;
  supplyHours: number;
  allocatedHours: number;
  leaveHours: number;
  gapHours: number;
  overloaded: boolean;
};

export type ApprovalMetrics = {
  total: number;
  approved: number;
  rejected: number;
  pending: number;
  averageHours: number;
  overdueRate: number;
  returnRate: number;
  byStep: { step: number; label: string; averageHours: number; decisions: number }[];
  lowSample: boolean;
};
