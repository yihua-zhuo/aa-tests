import { useEffect, useRef, useState } from 'react';
import type {
  Attachment,
  AttachmentOcr,
  DocumentClass,
  DocumentFieldAgreement,
  DocumentFieldCandidate,
  DocumentFieldEvidence,
  DocumentFieldKind,
  DocumentIr,
  DocumentSpecializedFinding,
  OcrFieldProvenance,
  OcrFieldRevision,
  OcrMode,
  OcrRecoveryTrigger,
  OcrRoute,
  OcrVersionChain,
} from '../../../shared/types.ts';
import { api } from '../api.ts';
import { formatDateTime } from '../format.ts';
import { useApi } from '../hooks/useApi.ts';
import { Icon } from './Icon.tsx';
import {
  Avatar,
  ConfirmDialog,
  cx,
  EmptyState,
  ErrorState,
  Modal,
  Skeleton,
  Spinner,
} from './ui.tsx';

const VERSION_KIND_LABEL: Record<OcrVersionChain['nodes'][number]['kind'], string> = {
  original: '原始',
  stage: '阶段',
  selection: '候选选择',
  revision: '人工修订',
};

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function ocrLabel(item: Attachment): string {
  switch (item.ocr.status) {
    case 'done':
      return item.ocr.purgedAt
        ? 'OCR 文本已清理'
        : `OCR ${item.ocr.characters.toLocaleString()} 字${
            item.ocr.reviewRequired ? ' · 待复核' : ''
          }`;
    case 'pending':
      return 'OCR 排队中';
    case 'processing':
      return 'OCR 识别中';
    case 'failed':
      return 'OCR 失败';
    default:
      return '';
  }
}

function engineLabel(engine: AttachmentOcr['engine']): string {
  if (engine === 'paddle') return 'PaddleOCR';
  if (engine === 'docling') return 'Docling';
  return '本地 OCR';
}

function modelLabel(model: string | null): string {
  if (!model) return '';
  if (model === 'pdf-text') return 'PDF 文本层';
  if (model.endsWith('+pdf-text')) return `${model.slice(0, -9)} + PDF 文本层`;
  return model;
}

function formatSeconds(seconds: number): string {
  if (seconds >= 60) return `${(seconds / 60).toFixed(1)} 分钟`;
  return `${seconds.toFixed(1)} 秒`;
}

function isPdfName(name: string): boolean {
  return /\.pdf$/i.test(name);
}

function isImageName(name: string): boolean {
  return /\.(png|jpe?g|gif|webp|bmp|tiff?)$/i.test(name);
}

function modeLabel(mode: OcrMode): string {
  switch (mode) {
    case 'table':
      return '表格结构化';
    case 'structure':
      return '结构分析';
    case 'enhanced':
      return '增强预处理';
    default:
      return '自动布局';
  }
}

function routeLabel(route: OcrRoute | null): string {
  if (route === 'native') return '原生文本';
  if (route === 'hybrid') return '原生 + OCR';
  if (route === 'visual') return '视觉 OCR';
  return '';
}

function qualityLabel(status: 'pass' | 'review' | 'fail'): string {
  if (status === 'pass') return '通过';
  return status === 'review' ? '待复核' : '失败';
}

const DOC_CLASS_LABELS: Record<DocumentClass, string> = {
  invoice: '发票',
  receipt: '收据',
  contract: '合同',
  id_document: '证件',
  bank_receipt: '银行回单',
  purchase_order: '采购订单',
  delivery_note: '送货单',
  statement: '对账单',
  generic: '通用文档',
};

function stageLabel(kind: AttachmentOcr['stages'][number]['kind']): string {
  switch (kind) {
    case 'native':
      return '原生抽取';
    case 'visual':
      return '视觉识别';
    case 'recovery_dpi':
      return '提高 DPI';
    case 'recovery_structure':
      return '结构恢复';
    case 'recovery_enhance':
      return '增强预处理';
    case 'recovery_region':
      return '区域复认';
    case 'recovery_cell':
      return '单元格复认';
    case 'candidate':
      return '候选复认';
    case 'vlm':
      return 'VLM 复核';
    case 'camelot':
      return 'Camelot 表格';
    case 'specialized':
      return '专用区域识别';
    default:
      return '多模态恢复';
  }
}

function fieldKindLabel(kind: DocumentFieldKind): string {
  switch (kind) {
    case 'amount':
      return '金额';
    case 'date':
      return '日期';
    case 'identifier':
      return '编号';
    case 'account':
      return '账号';
    case 'quantity':
      return '数量';
    case 'percentage':
      return '比例';
    case 'text':
      return '文本行';
    default:
      return '数值';
  }
}

function reasonLabel(reason: DocumentFieldEvidence['reason']): string {
  switch (reason) {
    case 'initial_confirmed':
      return '原文已确认';
    case 'candidate_selected':
      return '候选已选中';
    case 'candidate_conflict':
      return '候选冲突';
    default:
      return '待确认';
  }
}

function agreementLabel(agreement: DocumentFieldAgreement): string {
  if (agreement === 'confirmed_independent') return '独立一致';
  if (agreement === 'confirmed_same_engine') return '同模型一致（不足以降级）';
  return agreement === 'conflict' ? '冲突' : '未确认';
}

const TRIGGER_LABEL: Record<OcrRecoveryTrigger, string> = {
  key_field: '关键字段',
  cell_recovery: '空单元格',
  low_confidence: '低置信度',
  low_coverage: '页面覆盖不足',
  table_structure: '表格结构风险',
  field_validation: '字段校验失败',
  numeric_confusion: '数字易混',
  detection_anomaly: '检测异常',
  ink_gap: '未覆盖墨迹',
  local_blur: '局部模糊',
  orientation_uncertain: '方向不确定',
  language_mismatch: '语言不符',
  image_quality: '图片质量',
  small_text: '小字号',
};

const INK_GAP_HINT =
  '把页面二值化后统计没有任何识别框覆盖的墨迹：这条漏检信号与识别置信度无关，' +
  '置信度很高的整页也可能漏掉一整行。补回的文本作为独立的待校验块追加，不改写任何已有识别框。';

const MACHINE_READABLE_HINT =
  '条码/二维码来自图像解码，与 OCR 不是同一读取路径；MRZ 校验位来自 ICAO 9303 的算术校验。' +
  '这类证据只用于交叉验证和降低关键字段复核门槛，从不改写识别文本；校验失败会强制进入复核。';

function fieldEvidenceOf(document: DocumentIr | null): DocumentFieldEvidence[] {
  const raw = document?.meta.fieldEvidence;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (item): item is DocumentFieldEvidence =>
      typeof item === 'object' &&
      item !== null &&
      typeof (item as DocumentFieldEvidence).blockId === 'string' &&
      Array.isArray((item as DocumentFieldEvidence).candidates),
  );
}

function specializedFindingsOf(document: DocumentIr | null): DocumentSpecializedFinding[] {
  const raw = document?.meta.specialized;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (item): item is DocumentSpecializedFinding =>
      typeof item === 'object' &&
      item !== null &&
      typeof (item as DocumentSpecializedFinding).type === 'string' &&
      typeof (item as DocumentSpecializedFinding).text === 'string',
  );
}

const SPECIALIZED_TYPE_LABEL: Record<DocumentSpecializedFinding['type'], string> = {
  chart: '图表',
  handwriting: '手写',
  stamp: '印章',
  signature: '签名',
};

function candidateSourceLabel(source: DocumentFieldCandidate['source']): string | null {
  if (source === 'vlm') return 'VLM';
  if (source === 'specialized') return '专用';
  return null;
}

const TEXT_LAYER_REASON_LABEL: Record<string, string> = {
  empty: '空文本层',
  short: '文本过短',
  garbage: '乱码字符',
  symbols: '可读字符不足',
};

function textLayerTrustOf(document: DocumentIr | null): {
  pages: number;
  trusted: number;
  threshold: number;
  minTrust: number | null;
  reasonText: string;
  crosscheck: {
    sampled: number;
    planned: number;
    matched: number;
    mismatched: number;
    threshold: number;
    minSimilarity: number | null;
    budgetExceeded: boolean;
  } | null;
} | null {
  const raw = document?.meta.textLayer;
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.pages !== 'number' || typeof value.trusted !== 'number') return null;
  const reasons =
    value.reasons && typeof value.reasons === 'object'
      ? Object.entries(value.reasons as Record<string, unknown>)
          .filter(
            (entry): entry is [string, number] => typeof entry[1] === 'number' && entry[1] > 0,
          )
          .map(([reason, count]) => `${TEXT_LAYER_REASON_LABEL[reason] ?? reason} ×${count}`)
      : [];
  const rawCrosscheck =
    value.crosscheck && typeof value.crosscheck === 'object'
      ? (value.crosscheck as Record<string, unknown>)
      : null;
  const num = (input: Record<string, unknown>, key: string): number | null =>
    typeof input[key] === 'number' && Number.isFinite(input[key]) ? (input[key] as number) : null;
  const sampled = rawCrosscheck ? num(rawCrosscheck, 'sampled') : null;
  const matched = rawCrosscheck ? num(rawCrosscheck, 'matched') : null;
  const mismatched = rawCrosscheck ? num(rawCrosscheck, 'mismatched') : null;
  return {
    pages: value.pages,
    trusted: value.trusted,
    threshold: typeof value.threshold === 'number' ? value.threshold : 0.6,
    minTrust:
      typeof value.minTrust === 'number' && Number.isFinite(value.minTrust) ? value.minTrust : null,
    reasonText: reasons.join(' · '),
    crosscheck:
      rawCrosscheck && sampled !== null && matched !== null && mismatched !== null
        ? {
            sampled,
            planned: num(rawCrosscheck, 'planned') ?? sampled,
            matched,
            mismatched,
            threshold: num(rawCrosscheck, 'threshold') ?? 0.85,
            minSimilarity: num(rawCrosscheck, 'minSimilarity'),
            budgetExceeded: rawCrosscheck.budgetExceeded === true,
          }
        : null,
  };
}

function preprocessStats(document: DocumentIr | null): { total: number; conflicts: number } {
  const raw = document?.meta.preprocess;
  if (!raw || typeof raw !== 'object') return { total: 0, conflicts: 0 };
  const pages = (raw as Record<string, unknown>).pages;
  if (!Array.isArray(pages)) return { total: 0, conflicts: 0 };
  let total = 0;
  let conflicts = 0;
  for (const page of pages) {
    if (!page || typeof page !== 'object') continue;
    const selection = (page as Record<string, unknown>).ocrSelection;
    if (!selection || typeof selection !== 'object') continue;
    total += 1;
    if ((selection as Record<string, unknown>).conflict === true) conflicts += 1;
  }
  return { total, conflicts };
}

function officeStats(document: DocumentIr | null): {
  charts: number;
  images: number;
  embedded: number;
  comments: number;
  hidden: number;
  revisions: number;
  deleted: number;
  inserted: number;
  headers: number;
  footers: number;
  footnotes: number;
  notes: number;
  grouped: number;
  unrendered: number;
} | null {
  const raw = document?.meta.office;
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const count = (key: string): number =>
    typeof record[key] === 'number' && Number.isFinite(record[key]) ? (record[key] as number) : 0;
  return {
    charts: count('charts'),
    images: count('images'),
    embedded: count('embeddedObjects'),
    comments: count('comments'),
    hidden: count('hiddenSlides'),
    revisions: count('revisions'),
    deleted: count('deletedText'),
    inserted: count('insertedText'),
    headers: count('headers'),
    footers: count('footers'),
    footnotes: count('footnotes') + count('endnotes'),
    notes: count('notes'),
    grouped: count('groupedShapes'),
    unrendered: count('unrendered'),
  };
}

function refinementCounts(document: DocumentIr | null): {
  templates: number;
  overlaps: number;
  continuations: number;
  borderless: number;
} {
  const raw = document?.meta.refinement;
  if (!raw || typeof raw !== 'object')
    return { templates: 0, overlaps: 0, continuations: 0, borderless: 0 };
  const stats = raw as Record<string, unknown>;
  const count = (key: string): number =>
    typeof stats[key] === 'number' && Number.isFinite(stats[key]) ? (stats[key] as number) : 0;
  return {
    templates: count('headers') + count('footers'),
    overlaps: count('overlaps'),
    continuations: count('continuations'),
    borderless: count('borderless'),
  };
}

function documentStats(document: DocumentIr | null): {
  pages: number;
  blocks: number;
  tables: number;
  templates: number;
  overlaps: number;
  continuations: number;
  borderless: number;
  headings: number;
  formulas: number;
  stamps: number;
  signatures: number;
  charts: number;
  handwriting: number;
  embedded: number;
  inkGaps: number;
  inkUnread: number;
  inkAnalyzedPages: number;
  inkRecovered: number;
  machineReadable: number;
  machineMrz: number;
  machineInvalid: number;
} | null {
  if (!document) return null;
  let blocks = 0;
  let tables = 0;
  let headings = 0;
  let formulas = 0;
  let stamps = 0;
  let signatures = 0;
  let charts = 0;
  let handwriting = 0;
  let embedded = 0;
  let inkGaps = 0;
  let inkUnread = 0;
  let inkAnalyzedPages = 0;
  let inkRecovered = 0;
  let machineReadable = 0;
  let machineMrz = 0;
  let machineInvalid = 0;
  for (const page of document.pages) {
    blocks += page.blocks.length;
    inkGaps += page.meta?.inkGaps?.length ?? 0;
    inkUnread += page.meta?.inkGapsDropped ?? 0;
    if (page.meta?.inkGaps !== undefined) inkAnalyzedPages += 1;
    for (const symbol of page.meta?.machineReadable ?? []) {
      machineReadable += 1;
      if (symbol.format === 'mrz') machineMrz += 1;
      if (symbol.checks && !symbol.checks.valid) machineInvalid += 1;
    }
    for (const block of page.blocks) {
      if (block.type === 'table') tables += 1;
      else if (block.type === 'heading') headings += 1;
      else if (block.type === 'formula') formulas += 1;
      else if (block.type === 'stamp') stamps += 1;
      else if (block.type === 'signature') signatures += 1;
      else if (block.type === 'chart') charts += 1;
      else if (block.type === 'handwriting') handwriting += 1;
      if (block.meta?.hybrid === 'embedded_image') embedded += 1;
      if (block.meta?.inkGap) inkRecovered += 1;
    }
  }
  return {
    pages: document.pages.length,
    blocks,
    tables,
    headings,
    formulas,
    stamps,
    signatures,
    charts,
    handwriting,
    embedded,
    inkGaps,
    inkUnread,
    inkAnalyzedPages,
    inkRecovered,
    machineReadable,
    machineMrz,
    machineInvalid,
    ...refinementCounts(document),
  };
}

function validationLabel(status: OcrFieldProvenance['validation']['status']): string {
  if (status === 'passed') return '校验通过';
  return status === 'flagged' ? '需复核' : '校验失败';
}

function FieldProvenanceSection({
  fields,
  projectId,
  attachmentId,
  canReview,
  show,
  onRevision,
}: {
  fields: OcrFieldProvenance[];
  projectId: string;
  attachmentId: string;
  canReview: boolean;
  show: (message: string, tone?: 'success' | 'error' | 'info') => void;
  onRevision: (revision: OcrFieldRevision) => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);

  if (fields.length === 0) return null;
  const revisionCount = fields.reduce((sum, field) => sum + field.revisions.length, 0);

  const begin = (field: OcrFieldProvenance) => {
    setEditing(field.id);
    setText(field.revisions[field.revisions.length - 1]?.revisedText ?? field.text);
    setReason('');
  };

  const save = async (field: OcrFieldProvenance) => {
    if (saving || !text.trim() || !reason.trim()) return;
    setSaving(true);
    try {
      const result = await api.reviseAttachmentOcrField(projectId, attachmentId, field.id, {
        revisedText: text,
        reason: reason.trim(),
      });
      onRevision(result.revision);
      setEditing(null);
      show('已保存人工修订，原始识别文本保持不变', 'success');
    } catch (cause) {
      show(cause instanceof Error ? cause.message : '保存修订失败', 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="ocr-fields">
      <header className="ocr-evidence-head">
        <strong>关键字段定位与人工复核</strong>
        <span>
          {fields.length} 个字段 · {revisionCount} 条修订
        </span>
      </header>
      <ul className="ocr-evidence-list">
        {fields.map((field) => (
          <li key={field.id}>
            <div className="ocr-evidence-head">
              <span className={`ocr-evidence-badge is-${field.validation.status}`}>
                {validationLabel(field.validation.status)}
              </span>
              <strong>{fieldKindLabel(field.kind)}</strong>
              <span>第 {field.page} 页</span>
              {field.cell ? (
                <span>
                  第 {field.cell.row + 1} 行 · {field.cell.header}
                </span>
              ) : null}
              <span>
                坐标{' '}
                {field.bbox
                  ? `${Math.round(field.bbox.x)},${Math.round(field.bbox.y)} · ${Math.round(
                      field.bbox.width,
                    )}×${Math.round(field.bbox.height)}`
                  : '未知'}
              </span>
              {field.confidence !== null ? (
                <span>置信度 {(field.confidence * 100).toFixed(1)}%</span>
              ) : null}
              <span>
                {field.source.engine}
                {field.source.model ? ` · ${field.source.model}` : ''} · {field.source.stage}
              </span>
            </div>
            <div className="ocr-evidence-row is-original">
              <span className="ocr-evidence-tag">原文</span>
              <code>{field.text || '（空）'}</code>
            </div>
            <div className="ocr-evidence-row">
              <span className="ocr-evidence-tag">校验</span>
              <span className="ocr-evidence-meta">{field.validation.rules.join('；')}</span>
              {field.validation.numeric ? (
                <span className="ocr-evidence-meta">
                  规范值 {field.validation.numeric.canonical ?? '无法解析'}
                </span>
              ) : null}
              {field.evidence ? (
                <span className="ocr-evidence-meta">
                  复认 {agreementLabel(field.evidence.agreement ?? 'unverified')} ·{' '}
                  {field.evidence.passes} 次
                </span>
              ) : null}
            </div>
            {field.validation.issues.length > 0 ? (
              <p className="field-hint">问题：{field.validation.issues.join('；')}</p>
            ) : null}
            {field.revisions.length > 0 ? (
              <div className="ocr-revisions">
                {field.revisions.map((revision) => (
                  <div key={revision.id} className="ocr-evidence-row">
                    <span className="ocr-evidence-tag">修订</span>
                    <code>{revision.revisedText}</code>
                    <span className="ocr-evidence-meta">
                      {revision.reason} · {revision.revisedBy?.name ?? '未知'} ·{' '}
                      {formatDateTime(revision.createdAt)}
                    </span>
                  </div>
                ))}
              </div>
            ) : null}
            {canReview ? (
              editing === field.id ? (
                <div className="ocr-revision-form">
                  <label>
                    修订值
                    <input
                      className="input"
                      value={text}
                      onChange={(event) => setText(event.target.value)}
                    />
                  </label>
                  <label>
                    修订原因
                    <input
                      className="input"
                      value={reason}
                      placeholder="例如：核对发票原件"
                      onChange={(event) => setReason(event.target.value)}
                    />
                  </label>
                  <div className="ocr-revision-actions">
                    <button
                      type="button"
                      className="btn btn-primary btn-sm"
                      disabled={saving || !text.trim() || !reason.trim()}
                      onClick={() => void save(field)}
                    >
                      {saving ? <Spinner size={14} /> : '保存修订'}
                    </button>
                    <button
                      type="button"
                      className="btn btn-soft btn-sm"
                      onClick={() => setEditing(null)}
                    >
                      取消
                    </button>
                  </div>
                </div>
              ) : (
                <button type="button" className="btn btn-soft btn-sm" onClick={() => begin(field)}>
                  记录人工修订
                </button>
              )
            ) : null}
          </li>
        ))}
      </ul>
      <p className="field-hint">
        修订会保留原始 OCR 值、修订值、原因、修改人与证据区域；原始识别文本不会被覆盖。
      </p>
    </section>
  );
}

export function AttachmentsPanel({
  projectId,
  canUpload,
  canManage,
  currentUserId,
  show,
}: {
  projectId: string;
  canUpload: boolean;
  canManage: boolean;
  currentUserId: string | undefined;
  show: (message: string, tone?: 'success' | 'error' | 'info') => void;
}) {
  const state = useApi((signal) => api.attachments(projectId, signal), [projectId]);
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<Attachment | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [ocrFor, setOcrFor] = useState<Attachment | null>(null);
  const [ocrData, setOcrData] = useState<AttachmentOcr | null>(null);
  const [ocrLoading, setOcrLoading] = useState(false);
  const [ocrRetrying, setOcrRetrying] = useState(false);
  const [ocrExporting, setOcrExporting] = useState(false);
  const [ocrFields, setOcrFields] = useState<OcrFieldProvenance[]>([]);
  const [ocrFieldsError, setOcrFieldsError] = useState<string | null>(null);
  const [ocrChain, setOcrChain] = useState<OcrVersionChain | null>(null);
  const [ocrChainError, setOcrChainError] = useState<string | null>(null);
  const [ocrPollError, setOcrPollError] = useState<string | null>(null);
  const [complaint, setComplaint] = useState('');
  const [complaining, setComplaining] = useState(false);
  const [rerunMode, setRerunMode] = useState<OcrMode>('auto');
  const [rerunDpi, setRerunDpi] = useState(200);
  const [showRawText, setShowRawText] = useState(false);
  const ocrRequestRef = useRef(0);

  const ocrActive =
    state.data?.attachments.some(
      (item) => item.ocr.status === 'pending' || item.ocr.status === 'processing',
    ) ?? false;

  useEffect(() => {
    if (!ocrActive) return;
    const timer = window.setInterval(state.reload, 5_000);
    return () => window.clearInterval(timer);
  }, [ocrActive, state.reload]);

  useEffect(() => {
    if (!ocrFor) return;
    if (ocrData?.status !== 'pending' && ocrData?.status !== 'processing') return;
    const timer = window.setInterval(() => {
      void api
        .attachmentOcr(projectId, ocrFor.id)
        .then((result) => {
          setOcrData(result.ocr);
          setOcrPollError(null);
          if (result.ocr.status === 'done' || result.ocr.status === 'failed') state.reload();
        })
        .catch((cause: unknown) => {
          setOcrPollError(cause instanceof Error ? cause.message : '刷新识别状态失败');
        });
    }, 2_000);
    return () => window.clearInterval(timer);
  }, [ocrFor, ocrData?.status, projectId, state.reload]);

  useEffect(() => {
    if (!ocrFor || ocrData?.status !== 'done') {
      setOcrFields([]);
      setOcrFieldsError(null);
      return;
    }
    let cancelled = false;
    setOcrFieldsError(null);
    api
      .attachmentOcrFields(projectId, ocrFor.id)
      .then((result) => {
        if (!cancelled) setOcrFields(result.fields);
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setOcrFieldsError(cause instanceof Error ? cause.message : '读取字段证据失败');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [ocrFor, ocrData?.status, projectId]);

  useEffect(() => {
    if (!ocrFor || ocrData?.status !== 'done') {
      setOcrChain(null);
      setOcrChainError(null);
      return;
    }
    let cancelled = false;
    setOcrChainError(null);
    api
      .attachmentOcrVersions(projectId, ocrFor.id)
      .then((result) => {
        if (!cancelled) setOcrChain(result.chain);
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setOcrChainError(cause instanceof Error ? cause.message : '读取版本链失败');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [ocrFor, ocrData?.status, projectId, ocrFields]);

  const submitComplaint = async () => {
    const note = complaint.trim();
    if (!ocrFor || note.length < 3 || complaining) return;
    setComplaining(true);
    try {
      await api.complainAttachmentOcr(projectId, ocrFor.id, note);
      setComplaint('');
      show('已提交识别问题，样本进入待标注池；原始识别文本保持不变', 'success');
    } catch (cause) {
      show(cause instanceof Error ? cause.message : '提交反馈失败', 'error');
    } finally {
      setComplaining(false);
    }
  };

  const applyFieldRevision = (revision: OcrFieldRevision) => {
    setOcrFields((current) =>
      current.map((field) =>
        field.id === revision.fieldId
          ? { ...field, revisions: [...field.revisions, revision] }
          : field,
      ),
    );
  };

  const closeOcr = () => {
    ocrRequestRef.current += 1;
    setOcrFor(null);
    setOcrPollError(null);
  };

  const openOcr = async (item: Attachment) => {
    const seq = ++ocrRequestRef.current;
    setOcrFor(item);
    setOcrData(null);
    setOcrPollError(null);
    setOcrLoading(true);
    setRerunMode(item.ocr.mode);
    setRerunDpi(item.ocr.dpi);
    try {
      const result = await api.attachmentOcr(projectId, item.id);
      if (seq !== ocrRequestRef.current) return;
      setOcrData(result.ocr);
      setRerunMode(result.ocr.mode);
      setRerunDpi(result.ocr.dpi);
    } catch (cause) {
      if (seq !== ocrRequestRef.current) return;
      show(cause instanceof Error ? cause.message : '读取识别结果失败', 'error');
      setOcrFor(null);
    } finally {
      if (seq === ocrRequestRef.current) setOcrLoading(false);
    }
  };

  const canRerun = Boolean(
    ocrFor &&
      (ocrData?.status === 'done' || ocrData?.status === 'failed') &&
      (canManage || (currentUserId && ocrFor.uploader?.id === currentUserId)),
  );
  const supportsModes = Boolean(
    ocrFor &&
      ocrFor.ocr.engine === 'paddle' &&
      (isImageName(ocrFor.name) || isPdfName(ocrFor.name)),
  );
  const pdfDpi = Boolean(ocrFor && isPdfName(ocrFor.name));

  const retryOcr = async () => {
    if (!ocrFor || ocrRetrying) return;
    setOcrRetrying(true);
    try {
      const result = await api.retryAttachmentOcr(projectId, ocrFor.id, {
        mode: supportsModes ? rerunMode : undefined,
        dpi: pdfDpi ? rerunDpi : undefined,
      });
      setOcrData(result.ocr);
      show('已重新加入识别队列');
      state.reload();
    } catch (cause) {
      show(cause instanceof Error ? cause.message : '重新识别失败', 'error');
    } finally {
      setOcrRetrying(false);
    }
  };

  const exportOcr = async () => {
    if (!ocrFor || ocrExporting) return;
    setOcrExporting(true);
    try {
      const result = await api.exportAttachmentOcr(projectId, ocrFor.id);
      const blob = new Blob([result.text], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = result.filename;
      document.body.append(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
      const replaced = Object.values(result.redactions).reduce((sum, count) => sum + count, 0);
      show(
        replaced > 0
          ? `已导出脱敏文本，替换 ${replaced} 处敏感信息`
          : '已导出脱敏文本（未检测到敏感字段）',
      );
    } catch (cause) {
      show(cause instanceof Error ? cause.message : '导出失败', 'error');
    } finally {
      setOcrExporting(false);
    }
  };

  const upload = async (file: File | undefined) => {
    if (!file || uploading) return;
    if (file.size > 10_000_000) {
      show('单个附件不能超过 10MB', 'error');
      return;
    }
    setUploading(true);
    try {
      await api.uploadAttachment(projectId, file);
      show(`已上传「${file.name}」`);
      state.reload();
    } catch (cause) {
      show(cause instanceof Error ? cause.message : '上传失败', 'error');
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  const remove = async () => {
    if (!pendingDelete || deleting) return;
    setDeleting(true);
    try {
      await api.deleteAttachment(projectId, pendingDelete.id);
      show(`已删除「${pendingDelete.name}」`);
      setPendingDelete(null);
      state.reload();
    } catch (cause) {
      show(cause instanceof Error ? cause.message : '删除失败', 'error');
    } finally {
      setDeleting(false);
    }
  };

  const limits = state.data?.limits;
  const usage = state.data?.usage;
  const documentInfo = documentStats(ocrData?.document ?? null);
  const layoutSummary = documentInfo
    ? [
        documentInfo.headings ? `标题 ${documentInfo.headings}` : '',
        documentInfo.formulas ? `公式 ${documentInfo.formulas}` : '',
        documentInfo.charts ? `图表 ${documentInfo.charts}` : '',
        documentInfo.handwriting ? `手写 ${documentInfo.handwriting}` : '',
        documentInfo.stamps ? `印章 ${documentInfo.stamps}` : '',
        documentInfo.signatures ? `签名 ${documentInfo.signatures}` : '',
        documentInfo.embedded ? `区域 OCR ${documentInfo.embedded}` : '',
        documentInfo.borderless ? `无框表 ${documentInfo.borderless}` : '',
      ]
        .filter(Boolean)
        .join(' · ')
    : '';
  const inkSummary = documentInfo
    ? documentInfo.inkAnalyzedPages === 0
      ? null
      : {
          gaps: documentInfo.inkGaps,
          unread: documentInfo.inkUnread,
          recovered: documentInfo.inkRecovered,
          pages: documentInfo.inkAnalyzedPages,
        }
    : null;
  const fieldEvidence = fieldEvidenceOf(ocrData?.document ?? null);
  const specializedFindings = specializedFindingsOf(ocrData?.document ?? null);
  const textLayerTrust = textLayerTrustOf(ocrData?.document ?? null);
  const machineSummary =
    documentInfo && documentInfo.machineReadable > 0
      ? {
          total: documentInfo.machineReadable,
          mrz: documentInfo.machineMrz,
          invalid: documentInfo.machineInvalid,
        }
      : null;
  const preprocess = preprocessStats(ocrData?.document ?? null);
  const office = officeStats(ocrData?.document ?? null);

  return (
    <section className="card card-pad">
      <header className="card-head">
        <div>
          <h2>附件</h2>
          <p className="card-sub">
            支持图片、PDF、文本、CSV、JSON 与 Office 文档，单个不超过 10MB，链接 10 分钟内有效。
          </p>
        </div>
        <span className="count-pill">{state.data?.attachments.length ?? 0}</span>
      </header>

      {canUpload ? (
        <div className="attachment-upload">
          <input
            ref={inputRef}
            id="attachment-file"
            className="visually-hidden"
            type="file"
            tabIndex={-1}
            aria-hidden="true"
            accept=".png,.jpg,.jpeg,.gif,.webp,.bmp,.tif,.tiff,.pdf,.txt,.md,.csv,.json,.zip,.docx,.xlsx,.pptx"
            onChange={(event) => void upload(event.target.files?.[0])}
          />
          <button
            type="button"
            className="btn btn-soft btn-sm"
            onClick={() => inputRef.current?.click()}
            disabled={uploading}
            aria-busy={uploading}
          >
            {uploading ? <Spinner size={15} /> : <Icon name="upload" size={15} />}
            {uploading ? '上传中…' : '上传附件'}
          </button>
          {limits && usage ? (
            <span className="attachment-usage">
              {usage.count}/{limits.maxCount} 个 · {formatBytes(usage.totalBytes)} /{' '}
              {formatBytes(limits.maxTotalBytes)}
            </span>
          ) : null}
        </div>
      ) : null}

      {state.loading && !state.data ? (
        <div className="attachment-skeleton">
          <Skeleton height={44} />
          <Skeleton height={44} />
        </div>
      ) : state.error ? (
        <ErrorState message={state.error} onRetry={state.reload} compact />
      ) : state.data && state.data.attachments.length > 0 ? (
        <ul className="attachment-list">
          {state.data.attachments.map((item) => {
            const removable = canManage || (currentUserId && item.uploader?.id === currentUserId);
            return (
              <li key={item.id} className="attachment-item">
                <span className="attachment-icon" aria-hidden="true">
                  <Icon name="file" size={18} />
                </span>
                <div className="attachment-copy">
                  <a
                    className="attachment-name"
                    href={item.downloadUrl}
                    download={item.name}
                    rel="noreferrer"
                  >
                    {item.name}
                  </a>
                  <span className="attachment-meta">
                    {formatBytes(item.size)} · {formatDateTime(item.createdAt)}
                    {item.uploader ? (
                      <>
                        {' · '}
                        <Avatar name={item.uploader.name} size={16} /> {item.uploader.name}
                      </>
                    ) : null}
                  </span>
                </div>
                {item.ocr.status !== 'skipped' ? (
                  <button
                    type="button"
                    className={cx(
                      'ocr-chip',
                      `is-${item.ocr.status}`,
                      item.ocr.reviewRequired && 'is-review',
                    )}
                    onClick={() => void openOcr(item)}
                    aria-label={`查看 ${item.name} 的识别文本`}
                    title={
                      item.ocr.purgedAt
                        ? `文本已按保留策略清除（${formatDateTime(item.ocr.purgedAt)}），重新识别可恢复`
                        : undefined
                    }
                  >
                    {item.ocr.status === 'processing' ? <Spinner size={12} /> : null}
                    {ocrLabel(item)}
                  </button>
                ) : null}
                <a
                  className="btn btn-icon btn-ghost btn-sm"
                  href={item.downloadUrl}
                  download={item.name}
                  aria-label={`下载 ${item.name}`}
                >
                  <Icon name="download" size={16} />
                </a>
                {removable ? (
                  <button
                    type="button"
                    className="btn btn-icon btn-ghost btn-sm"
                    onClick={() => setPendingDelete(item)}
                    aria-label={`删除 ${item.name}`}
                  >
                    <Icon name="trash" size={16} />
                  </button>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : (
        <EmptyState
          icon="folder"
          title="还没有附件"
          description={
            canUpload
              ? '上传需求文档、设计稿或数据文件与团队共享。'
              : '成员上传的文件会显示在这里。'
          }
          compact
        />
      )}

      <ConfirmDialog
        open={pendingDelete !== null}
        title="删除附件"
        message={`确定删除「${pendingDelete?.name ?? ''}」吗？附件、OCR 文本、字段修订与识别记录会一并删除，此操作不可撤销。`}
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => void remove()}
        busy={deleting}
      />

      <Modal
        open={ocrFor !== null}
        onClose={closeOcr}
        title="附件识别文本"
        description={ocrFor?.name}
        wide
        footer={
          <>
            <button type="button" className="btn btn-ghost" onClick={closeOcr}>
              关闭
            </button>
            {ocrData?.status === 'done' && !ocrData.purgedAt ? (
              <button
                type="button"
                className="btn btn-soft"
                onClick={() => void exportOcr()}
                disabled={ocrExporting}
              >
                {ocrExporting ? <Spinner size={16} /> : <Icon name="download" size={16} />}
                导出脱敏文本
              </button>
            ) : null}
            {canRerun ? (
              <button
                type="button"
                className={cx('btn', ocrData?.status === 'failed' ? 'btn-primary' : 'btn-soft')}
                onClick={() => void retryOcr()}
                disabled={ocrRetrying}
              >
                {ocrRetrying ? <Spinner size={16} /> : <Icon name="refresh" size={16} />}
                重新识别
              </button>
            ) : null}
          </>
        }
      >
        {canRerun && supportsModes ? (
          <div className="ocr-rerun-options">
            <label>
              <span>识别模式</span>
              <select
                value={rerunMode}
                onChange={(event) => setRerunMode(event.target.value as OcrMode)}
                disabled={ocrRetrying}
              >
                <option value="auto">自动布局</option>
                <option value="table">表格结构化</option>
                <option value="structure">结构分析</option>
                <option value="enhanced">增强预处理</option>
              </select>
            </label>
            {pdfDpi ? (
              <label>
                <span>渲染 DPI</span>
                <select
                  value={rerunDpi}
                  onChange={(event) => setRerunDpi(Number(event.target.value))}
                  disabled={ocrRetrying}
                >
                  <option value={150}>150</option>
                  <option value={200}>200</option>
                  <option value={300}>300</option>
                  <option value={400}>400</option>
                </select>
              </label>
            ) : null}
          </div>
        ) : null}
        {ocrPollError ? (
          <p className="field-hint" role="alert">
            状态刷新失败：{ocrPollError}（将自动重试）
          </p>
        ) : null}
        {ocrLoading ? (
          <div className="ocr-message" role="status" aria-live="polite">
            <Spinner size={18} />
            <div>
              <strong>正在读取</strong>
              <p>从附件服务获取识别结果…</p>
            </div>
          </div>
        ) : !ocrData ? (
          <p className="confirm-copy">暂无识别结果。</p>
        ) : ocrData.status === 'done' ? (
          <>
            {ocrData.purgedAt ? (
              <div className="ocr-message" role="status">
                <Icon name="clock" size={18} />
                <div>
                  <strong>识别文本已按保留策略清理</strong>
                  <p>
                    清理时间 {formatDateTime(ocrData.purgedAt)}
                    ，结构化文档、质量明细与字段证据不再保留；重新识别可恢复。
                  </p>
                </div>
              </div>
            ) : null}
            <p className="ocr-meta">
              {engineLabel(ocrData.engine)}
              {ocrData.model ? ` · ${modelLabel(ocrData.model)}` : ''}
              {ocrData.route ? ` · ${routeLabel(ocrData.route)}` : ''}
              {` · ${modeLabel(ocrData.mode)}`}
              {pdfDpi ? ` · ${ocrData.dpi} DPI` : ''}
              {ocrData.confidence !== null
                ? ` · 置信度 ${(ocrData.confidence * 100).toFixed(1)}%`
                : ''}
              {` · ${ocrData.characters.toLocaleString()} 字`}
              {ocrData.pages > 0 ? ` · ${ocrData.pages} 页` : ''}
              {ocrData.truncated ? ' · 仅部分页' : ''}
              {ocrData.seconds !== null ? ` · 耗时 ${formatSeconds(ocrData.seconds)}` : ''}
              {ocrData.updatedAt ? ` · ${formatDateTime(ocrData.updatedAt)}` : ''}
            </p>
            {ocrData.quality ? (
              <div className="ocr-quality">
                <span className={`ocr-quality-badge is-${ocrData.quality.status}`}>
                  质量 {Math.round(ocrData.quality.score * 100)}% ·{' '}
                  {qualityLabel(ocrData.quality.status)}
                </span>
                {ocrData.quality.docType ? (
                  <span
                    className={
                      ocrData.quality.docType.schema.missing.length > 0 ||
                      ocrData.quality.docType.schema.invalid.length > 0
                        ? 'ocr-review'
                        : undefined
                    }
                    title={
                      ocrData.quality.docType.evidence.length > 0
                        ? `判定依据：${ocrData.quality.docType.evidence.join('、')}`
                        : '没有足够证据判定业务类型，按通用文档评分'
                    }
                  >
                    {`类型 ${DOC_CLASS_LABELS[ocrData.quality.docType.type]} · ${Math.round(
                      ocrData.quality.docType.confidence * 100,
                    )}%`}
                    {ocrData.quality.docType.schema.coverage !== null
                      ? ` · 必填 ${Math.round(ocrData.quality.docType.schema.coverage * 100)}%`
                      : ''}
                    {ocrData.quality.docType.schema.missing.length > 0
                      ? ` · 缺 ${ocrData.quality.docType.schema.missing.join('、')}`
                      : ''}
                    {ocrData.quality.docType.schema.invalid.length > 0
                      ? ` · 格式无效 ${ocrData.quality.docType.schema.invalid.join('、')}`
                      : ''}
                    {ocrData.quality.docType.schema.conflicts.length > 0 ? ' · 字段矛盾' : ''}
                  </span>
                ) : null}
                {documentInfo ? (
                  <span>
                    结构化 {documentInfo.pages} 页 · {documentInfo.blocks} 块
                    {documentInfo.tables > 0 ? ` · ${documentInfo.tables} 个表格` : ''}
                    {documentInfo.templates > 0 ? ` · 页眉页脚 ${documentInfo.templates}` : ''}
                    {documentInfo.overlaps > 0 ? ` · 去重 ${documentInfo.overlaps}` : ''}
                    {documentInfo.continuations > 0
                      ? ` · 跨页表 ${documentInfo.continuations}`
                      : ''}
                  </span>
                ) : null}
                {layoutSummary ? <span>版面 {layoutSummary}</span> : null}
                {inkSummary ? (
                  <span
                    className={inkSummary.gaps + inkSummary.unread > 0 ? 'ocr-review' : undefined}
                    title={INK_GAP_HINT}
                  >
                    {`未覆盖墨迹 ${inkSummary.gaps + inkSummary.unread} · 核查 ${inkSummary.pages} 页`}
                    {inkSummary.unread > 0 ? `（含 ${inkSummary.unread} 处无法解析）` : ''}
                    {inkSummary.recovered > 0 ? ` · 墨迹补回 ${inkSummary.recovered}` : ''}
                  </span>
                ) : null}
                {machineSummary ? (
                  <span
                    className={machineSummary.invalid > 0 ? 'ocr-review' : undefined}
                    title={MACHINE_READABLE_HINT}
                  >
                    {`条码/QR/MRZ ${machineSummary.total} 条`}
                    {machineSummary.mrz > 0 ? ` · MRZ ${machineSummary.mrz}` : ''}
                    {machineSummary.invalid > 0
                      ? ` · 校验失败 ${machineSummary.invalid}`
                      : ' · 已解码'}
                  </span>
                ) : null}
                {preprocess.conflicts > 0 ? (
                  <span
                    className="ocr-review"
                    title="增强预处理候选丢失了原图识别出的数字 token。系统保留原图结果，并强制进入人工复核。"
                  >
                    {`预处理冲突 ${preprocess.conflicts}/${preprocess.total} 页`}
                  </span>
                ) : null}
                {office ? (
                  <span
                    className={
                      office.unrendered > 0 || office.hidden > 0 ? 'ocr-review' : undefined
                    }
                    title={[
                      `页眉 ${office.headers} · 页脚 ${office.footers}`,
                      `脚注尾注 ${office.footnotes}`,
                      `批注 ${office.comments} · 备注 ${office.notes}`,
                      `图表 ${office.charts} · 图片 ${office.images} · 嵌入对象 ${office.embedded}`,
                      `组合形状 ${office.grouped}`,
                      `修订 ${office.revisions}（删除 ${office.deleted} 字已忽略，插入 ${office.inserted} 字已保留）`,
                      office.unrendered > 0 ? `未识别对象 ${office.unrendered}` : '',
                      office.hidden > 0 ? `隐藏页 ${office.hidden}` : '',
                    ]
                      .filter(Boolean)
                      .join('；')}
                  >
                    {`Office 覆盖 · 图表 ${office.charts} · 图片 ${office.images} · 批注 ${office.comments}`}
                    {office.revisions > 0 ? ' · 修订已过滤' : ''}
                    {office.hidden > 0 ? ` · 隐藏 ${office.hidden}` : ''}
                  </span>
                ) : null}
                {textLayerTrust ? (
                  <span
                    className={
                      textLayerTrust.trusted < textLayerTrust.pages ? 'ocr-review' : undefined
                    }
                    title={`阈值 ${Math.round(textLayerTrust.threshold * 100)}%${
                      textLayerTrust.reasonText ? ` · 扣分原因：${textLayerTrust.reasonText}` : ''
                    }`}
                  >
                    PDF 文本层 {textLayerTrust.trusted}/{textLayerTrust.pages} 页可信
                    {textLayerTrust.minTrust !== null
                      ? ` · 最低 ${Math.round(textLayerTrust.minTrust * 100)}%`
                      : ''}
                  </span>
                ) : null}
                {textLayerTrust?.crosscheck && textLayerTrust.crosscheck.sampled > 0 ? (
                  <span
                    className={textLayerTrust.crosscheck.mismatched > 0 ? 'ocr-review' : undefined}
                    title={`抽样 ${textLayerTrust.crosscheck.sampled}/${textLayerTrust.crosscheck.planned} 页与渲染 OCR 比对，相似度阈值 ${Math.round(
                      textLayerTrust.crosscheck.threshold * 100,
                    )}%${textLayerTrust.crosscheck.budgetExceeded ? ' · 预算内未完成抽样' : ''}`}
                  >
                    {`文本层交叉验证 ${textLayerTrust.crosscheck.matched}/${textLayerTrust.crosscheck.sampled} 页一致${
                      textLayerTrust.crosscheck.minSimilarity !== null
                        ? ` · 最低 ${Math.round(textLayerTrust.crosscheck.minSimilarity * 100)}%`
                        : ''
                    }`}
                  </span>
                ) : null}
                {ocrData.reviewRequired ? <span className="ocr-review">建议人工复核</span> : null}
              </div>
            ) : null}
            {ocrData.quality?.issues.length ? (
              <ul className="ocr-issues">
                {ocrData.quality.issues.slice(0, 8).map((issue, index) => (
                  <li key={`${issue.code}-${index}`} className={`is-${issue.severity}`}>
                    {issue.message}
                    {issue.page ? `（第 ${issue.page} 页）` : ''}
                  </li>
                ))}
              </ul>
            ) : null}
            {ocrData.quality && ocrData.quality.hardRisks.length > 0 ? (
              <p className="field-hint" role="alert">
                {`${ocrData.quality.hardRisks.length} 项硬性风险：无论分数高低都按需要复核处理——`}
                {ocrData.quality.hardRisks.map((risk) => risk.message).join('；')}
              </p>
            ) : null}
            {ocrData.stages.length > 0 ? (
              <ol className="ocr-stages">
                {ocrData.stages.map((stage, index) => (
                  <li key={`${stage.kind}-${index}`} className={`is-${stage.status}`}>
                    <strong>{stageLabel(stage.kind)}</strong>
                    <span>
                      {stage.trigger ? `触发 ${TRIGGER_LABEL[stage.trigger] ?? stage.trigger}` : ''}
                      {stage.trigger ? ' · ' : ''}
                      {engineLabel(stage.engine)}
                      {stage.model && stage.model !== stage.engine
                        ? ` · ${modelLabel(stage.model)}`
                        : ''}
                      {` · ${modeLabel(stage.mode)}`}
                      {stage.dpi ? ` · ${stage.dpi} DPI` : ''}
                      {stage.status === 'failed' ? ' · 失败' : ''}
                      {stage.status === 'skipped' ? ' · 跳过' : ''}
                      {stage.score !== null ? ` · 质量 ${Math.round(stage.score * 100)}%` : ''}
                      {` · ${formatSeconds(stage.seconds)}`}
                      {stage.message ? ` · ${stage.message}` : ''}
                    </span>
                  </li>
                ))}
              </ol>
            ) : null}
            {ocrData.stages.length > 1 ? (
              <p className="field-hint">
                结果按硬性风险 → 关键字段覆盖 → 页面覆盖 → 字段校验 → 表格/阅读顺序 →
                融合分比较；融合分差 0.005 内视为平手。
              </p>
            ) : null}
            {ocrData.stages.some((stage) => stage.kind === 'candidate') ? (
              <p className="field-hint">
                整页候选复认是独立的第二意见；只有质量分严格提升才采用，未采用的结果仅保留在阶段记录中。
              </p>
            ) : null}
            {fieldEvidence.length > 0 ? (
              <section className="ocr-evidence">
                <header className="ocr-evidence-head">
                  <strong>关键字段证据</strong>
                  <span>
                    {fieldEvidence.length} 个字段 ·{' '}
                    {fieldEvidence.reduce((sum, item) => sum + item.candidates.length, 0)} 个候选
                  </span>
                </header>
                <ul className="ocr-evidence-list">
                  {fieldEvidence.map((evidence) => {
                    const agreement = evidence.agreement ?? 'unverified';
                    return (
                      <li
                        key={`${evidence.page}-${evidence.blockId}-${
                          evidence.cell ? `${evidence.cell.row}:${evidence.cell.column}` : 'block'
                        }`}
                      >
                        <div className="ocr-evidence-head">
                          <span className={`ocr-evidence-badge is-${agreement}`}>
                            {agreementLabel(agreement)}
                          </span>
                          <strong>{fieldKindLabel(evidence.kind)}</strong>
                          <span>第 {evidence.page} 页</span>
                          {evidence.inkGap ? (
                            <span title={INK_GAP_HINT}>
                              墨迹无识别框
                              {evidence.inkGap.kind === 'cell' ? '（表格空格）' : ''} ·{' '}
                              {evidence.inkGap.pixels.toLocaleString()} 像素
                            </span>
                          ) : null}
                          {evidence.cell ? (
                            <span>
                              第 {evidence.cell.row + 1} 行 · {evidence.cell.header}
                              {evidence.cell.bboxEstimated ? ' · 估算坐标' : ''}
                            </span>
                          ) : null}
                          {evidence.confidence !== null ? (
                            <span>原置信度 {(evidence.confidence * 100).toFixed(1)}%</span>
                          ) : null}
                          <span>{evidence.passes ?? evidence.candidates.length} 次复认</span>
                          {evidence.reason ? <span>{reasonLabel(evidence.reason)}</span> : null}
                        </div>
                        <div className="ocr-evidence-row is-original">
                          <span className="ocr-evidence-tag">原文</span>
                          <code>
                            {evidence.text ||
                              (evidence.inkGap ? '（此处原本没有任何识别框）' : '（空）')}
                          </code>
                        </div>
                        {evidence.candidates.map((candidate, index) => (
                          <div
                            key={`${candidate.pass ?? index}-${index}`}
                            className="ocr-evidence-row"
                          >
                            <span className="ocr-evidence-tag">
                              {candidateSourceLabel(candidate.source) ??
                                `#${candidate.pass ?? index + 1}`}
                            </span>
                            <code>{candidate.text || '（空）'}</code>
                            {typeof candidate.agreesWithInitial === 'boolean' ? (
                              <span
                                className={`ocr-evidence-flag ${
                                  candidate.agreesWithInitial ? 'is-agree' : 'is-disagree'
                                }`}
                              >
                                {candidate.agreesWithInitial ? '一致' : '不一致'}
                              </span>
                            ) : null}
                            <span className="ocr-evidence-meta">
                              {candidate.mode ? modeLabel(candidate.mode) : '自动'}
                              {candidate.dpi ? ` · ${candidate.dpi} DPI` : ''}
                              {candidate.padding
                                ? ` · 边距 ${Math.round(candidate.padding * 100)}%`
                                : ''}
                              {candidate.confidence !== null
                                ? ` · 置信度 ${(candidate.confidence * 100).toFixed(1)}%`
                                : ' · 无置信度'}
                              {candidate.model ? ` · ${candidate.model}` : ''}
                            </span>
                          </div>
                        ))}
                        {evidence.failed?.length ? (
                          <p className="field-hint">失败：{evidence.failed.join('；')}</p>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
                <p className="field-hint">
                  候选仅作为复核证据，不会替换原识别框的文本；未覆盖墨迹的候选作为独立的待校验块追加到文档末尾，
                  已有文本与结构化字段不受影响。
                </p>
              </section>
            ) : null}
            {specializedFindings.length > 0 ? (
              <section className="ocr-evidence">
                <header className="ocr-evidence-head">
                  <strong>专用区域识别</strong>
                  <span>{specializedFindings.length} 个区域</span>
                </header>
                <ul className="ocr-evidence-list">
                  {specializedFindings.map((finding, index) => (
                    <li key={`${finding.page}-${finding.blockId}-${index}`}>
                      <div className="ocr-evidence-row">
                        <span className="ocr-evidence-tag">
                          {SPECIALIZED_TYPE_LABEL[finding.type] ?? finding.type}
                        </span>
                        <code>{finding.text || '（空）'}</code>
                        <span className="ocr-evidence-meta">
                          第 {finding.page} 页
                          {finding.confidence !== null
                            ? ` · 置信度 ${(finding.confidence * 100).toFixed(1)}%`
                            : ''}
                          {finding.model ? ` · ${finding.model}` : ''}
                        </span>
                      </div>
                    </li>
                  ))}
                </ul>
                <p className="field-hint">专用识别结果仅作为复核证据，不替换 OCR 原文。</p>
              </section>
            ) : null}
            {ocrFieldsError ? (
              <p className="field-hint" role="alert">
                字段证据读取失败：{ocrFieldsError}
              </p>
            ) : null}
            {ocrFor ? (
              <FieldProvenanceSection
                fields={ocrFields}
                projectId={projectId}
                attachmentId={ocrFor.id}
                canReview={canRerun}
                show={show}
                onRevision={applyFieldRevision}
              />
            ) : null}
            {ocrChainError ? (
              <p className="field-hint" role="alert">
                版本链读取失败：{ocrChainError}
              </p>
            ) : null}
            {ocrChain && ocrChain.nodes.length > 0 ? (
              <section className="ocr-lineage">
                <header className="ocr-evidence-head">
                  <strong>版本链</strong>
                  <span>{ocrChain.nodes.length} 个节点 · 原文只读，修订独立记录</span>
                </header>
                <ol className="ocr-lineage-list">
                  {ocrChain.nodes.map((node) => (
                    <li key={node.id} className={`is-${node.kind}`}>
                      <div className="ocr-lineage-head">
                        <span className={`ocr-lineage-kind is-${node.kind}`}>
                          {VERSION_KIND_LABEL[node.kind]}
                        </span>
                        <strong>{node.label}</strong>
                        {node.model ? <span>{node.model}</span> : null}
                        {node.score !== null ? (
                          <span>质量 {Math.round(node.score * 100)}%</span>
                        ) : null}
                        {node.at ? <span>{formatDateTime(node.at)}</span> : null}
                      </div>
                      {node.text ? <code className="ocr-lineage-text">{node.text}</code> : null}
                      {node.parents.length > 0 ? (
                        <span className="ocr-lineage-parents">来源 {node.parents.join(' · ')}</span>
                      ) : null}
                    </li>
                  ))}
                </ol>
              </section>
            ) : null}
            {canRerun ? (
              <section className="ocr-complaint">
                <div>
                  <label className="field-label" htmlFor="ocr-complaint">
                    报告识别问题
                  </label>
                  <p className="field-hint" id="ocr-complaint-hint">
                    反馈进入待标注池并保留原文；系统不会自动改写识别文本。
                  </p>
                </div>
                <textarea
                  id="ocr-complaint"
                  className="textarea"
                  rows={2}
                  maxLength={500}
                  value={complaint}
                  onChange={(event) => setComplaint(event.target.value)}
                  placeholder="例如：金额 1280.00 被识别为 1280.0O"
                  disabled={complaining}
                  aria-describedby="ocr-complaint-hint"
                />
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => void submitComplaint()}
                  disabled={complaining || complaint.trim().length < 3}
                >
                  {complaining ? '提交中…' : '提交反馈'}
                </button>
              </section>
            ) : null}
            {ocrData.reviewRequired ? (
              <p className="field-hint">质量信号建议人工复核；系统不会自动改写识别原文。</p>
            ) : null}
            {ocrData.rawText && ocrData.rawText !== ocrData.text ? (
              <p className="field-hint">
                默认显示排版归一后的文本；归一只影响空格与全角符号，不会改动编号、时间与金额。
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => setShowRawText((value) => !value)}
                >
                  {showRawText ? '查看归一文本' : '查看引擎原文'}
                </button>
              </p>
            ) : null}
            {ocrData.purgedAt ? null : (
              <pre className="ocr-text">
                {(showRawText ? ocrData.rawText : ocrData.text) || '（未识别到文本）'}
              </pre>
            )}
          </>
        ) : ocrData.status === 'failed' ? (
          <div className="ocr-message is-failed" role="alert">
            <Icon name="alert" size={18} />
            <div>
              <strong>识别失败</strong>
              <p>{ocrData.error ?? '未知错误'}</p>
            </div>
          </div>
        ) : (
          <div className="ocr-message" role="status" aria-live="polite">
            <Spinner size={18} />
            <div>
              <strong>{ocrData.status === 'processing' ? '正在识别' : '排队中'}</strong>
              <p>本地 OCR 完成后文本会自动显示在这里。</p>
            </div>
          </div>
        )}
      </Modal>
    </section>
  );
}
