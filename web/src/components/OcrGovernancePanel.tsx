import { type FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import type {
  DocumentFieldKind,
  OcrAnnotationReliability,
  OcrDriftAlertRecord,
  OcrEngine,
  OcrFeedbackErrorType,
  OcrFeedbackPool,
  OcrFeedbackSample,
  OcrFeedbackSelection,
  OcrFeedbackStatus,
  OcrGreyMode,
  OcrKnowledgeGraph,
  OcrOptimizationEntry,
  OcrOptimizationRisk,
  OcrOptimizationStatus,
  OcrPassAudit,
  OcrPassAuditStats,
  OcrPassAuditVerdict,
  OcrProductionDashboard,
  OcrRecoveryYield,
  OcrRegistryAction,
  OcrRegistryEntry,
  OcrRegistryRole,
  OcrRegistryState,
  OcrRevisionQcItem,
  OcrRevisionQcStats,
  OcrRevisionReviewVerdict,
  OcrStageKind,
  OcrThresholdDimension,
  OcrThresholdProfile,
} from '../../../shared/types.ts';
import { api } from '../api.ts';
import { formatCompactCurrency, formatDateTime, formatNumber } from '../format.ts';
import { useToast } from '../hooks/useApi.ts';
import { Icon } from './Icon.tsx';
import { ConfirmDialog, Field, Skeleton } from './ui.tsx';

const WINDOWS = [7, 30, 90, 365];

const ERROR_LABEL: Record<OcrFeedbackErrorType, string> = {
  low_confidence: '低置信',
  model_disagreement: '模型分歧',
  field_validation: '字段校验',
  human_revision: '人工修订',
  user_complaint: '用户投诉',
};

const STATUS_LABEL: Record<OcrFeedbackStatus, string> = {
  pool: '待标注',
  sampled: '已抽样',
  labeled: '已标注',
  dismissed: '已忽略',
};

const OPTIMIZATION_STATUS: Record<OcrOptimizationStatus, string> = {
  proposed: '提议',
  implemented: '已实现',
  measured: '已测量',
  rolled_back: '已回滚',
};

const ENTITY_TYPE_LABEL: Record<OcrKnowledgeGraph['entities'][number]['type'], string> = {
  identifier: '编号',
  account: '账号',
  amount: '金额',
  date: '日期',
};

const RELATION_LABEL: Record<OcrKnowledgeGraph['relations'][number]['kind'], string> = {
  shared: '共同出现',
  mentions: '正文引用',
};

const REGISTRY_ROLE_LABEL: Record<OcrRegistryRole, string> = {
  control: '控制',
  candidate: '候选',
  rollback: '回滚',
  retired: '退役',
};

const GREY_MODE_LABEL: Record<OcrGreyMode, string> = {
  canary: '灰度',
  shadow: '影子',
  rollback: '回滚',
};

const REGISTRY_ACTION_LABEL: Record<OcrRegistryAction, string> = {
  register: '登记',
  promote: '晋级',
  rollback: '回退',
  hold: '保留',
  retire: '退役',
  percent: '调整流量',
  pin: '固定状态',
};

const RISK_LABEL: Record<OcrOptimizationRisk, string> = {
  low: '低',
  medium: '中',
  high: '高',
};

const AUDIT_VERDICT_LABEL: Record<OcrPassAuditVerdict, string> = {
  clean: '干净',
  error: '有错',
};

const AUDIT_STATUS_LABEL: Record<OcrPassAudit['status'], string> = {
  pending: '待复核',
  clean: '一致通过',
  error: '静默错误',
  disputed: '分歧',
};

const FIELD_KIND_LABEL: Record<DocumentFieldKind, string> = {
  amount: '金额',
  date: '日期',
  identifier: '编号',
  account: '账号',
  quantity: '数量',
  percentage: '百分比',
  number: '数值',
  text: '文本',
};

const RELIABILITY_LABEL: Record<OcrAnnotationReliability, string> = {
  double_confirmed: '双人确认',
  arbitrated: '已仲裁',
  single_reviewer: '单人标注',
  disputed: '待仲裁',
};

const RELIABILITY_HINT: Record<OcrAnnotationReliability, string> = {
  double_confirmed: '另一名复核人确认了修订值，可直接作为标注真值使用。',
  arbitrated: '第三人给出了最终值，以仲裁结论作为标注真值。',
  single_reviewer: '只有修订人一方签字，作为标注时按权重折减。',
  disputed: '复核人改判且尚无人仲裁，该标注不会进入阈值拟合。',
};

const REVIEW_VERDICT_LABEL: Record<OcrRevisionReviewVerdict, string> = {
  confirm: '确认',
  revise: '改判',
  arbitrate: '仲裁',
};

const RECOVERY_STAGE_LABEL: Partial<Record<OcrStageKind, string>> = {
  recovery_dpi: '提高 DPI',
  recovery_structure: '结构恢复',
  recovery_enhance: '增强预处理',
  recovery_region: '区域复认',
  recovery_cell: '单元格复认',
  candidate: '候选复认',
  vlm: 'VLM 复核',
  camelot: 'Camelot 表格',
  specialized: '专用区域识别',
};

function recoveryStageLabel(kind: OcrStageKind): string {
  return RECOVERY_STAGE_LABEL[kind] ?? kind;
}

const THRESHOLD_DIMENSION_LABEL: Record<OcrThresholdDimension, string> = {
  overall: '整体',
  kind: '文档类型',
  difficulty: '难度',
  language: '语言',
  file_type: '文件类型',
  workspace: '客户/组织',
};

function pct(value: number | null, digits = 1): string {
  return value === null ? '—' : `${(value * 100).toFixed(digits)}%`;
}

function seconds(value: number | null): string {
  return value === null ? '—' : `${value.toFixed(2)}s`;
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : '请求失败';
}

function registryLabel(entry: OcrRegistryEntry): string {
  return [entry.engine, entry.modelId, entry.pipeline].filter(Boolean).join(' / ');
}

/**
 * Sample count plus the label mass actually used, which is lower once disputed
 * annotations are dropped and single-person revisions are down-weighted.
 */
function thresholdSampleText(profile: OcrThresholdProfile): string {
  const used = profile.effectiveSamples;
  const positives = `${formatNumber(profile.positives)} 正例`;
  if (used === undefined || used === profile.samples) {
    return `${formatNumber(profile.samples)} · ${positives}`;
  }
  return `${formatNumber(profile.samples)}（有效 ${formatNumber(used)}）· ${positives}`;
}

function tuningOf(
  entry: OcrRegistryEntry,
  tuning: Record<string, { percent: string; mode: OcrGreyMode }>,
): { percent: string; mode: OcrGreyMode } {
  return tuning[entry.id] ?? { percent: String(entry.percent), mode: entry.mode };
}

type DashboardBucketRow = {
  dimension: string;
  key: string;
  documents: number;
  done: number;
  failed: number;
  failureRate: number;
  reviewRate: number;
  revisionObservedRate: number | null;
  confidenceRiskProxy: number | null;
  seconds: number | null;
};

function bucketRows(dashboard: OcrProductionDashboard): DashboardBucketRow[] {
  return [
    ...dashboard.byModel.map((bucket) => ({ dimension: '模型', ...bucket })),
    ...dashboard.byLanguage.map((bucket) => ({ dimension: '语言', ...bucket })),
    ...dashboard.byFileType.map((bucket) => ({ dimension: '文件类型', ...bucket })),
    ...dashboard.byBusinessType.map((bucket) => ({ dimension: '业务类型', ...bucket })),
    ...dashboard.byWorkspace.map((bucket) => ({ dimension: '客户/组织', ...bucket })),
    ...dashboard.byPageBucket.map((bucket) => ({ dimension: '页数', ...bucket })),
  ].map((bucket) => ({
    dimension: bucket.dimension,
    key: bucket.key,
    documents: bucket.documents,
    done: bucket.done,
    failed: bucket.failed,
    failureRate: bucket.failureRate,
    reviewRate: bucket.reviewRate,
    revisionObservedRate: bucket.revisionObservedRate,
    confidenceRiskProxy: bucket.confidenceRiskProxy,
    seconds: bucket.seconds,
  }));
}

export function OcrGovernancePanel() {
  const { show } = useToast();
  const [days, setDays] = useState(30);
  const [dashboard, setDashboard] = useState<OcrProductionDashboard | null>(null);
  const [alerts, setAlerts] = useState<OcrDriftAlertRecord[]>([]);
  const [feedback, setFeedback] = useState<{
    pool: OcrFeedbackPool;
    samples: OcrFeedbackSample[];
    matched: number;
  } | null>(null);
  const [feedbackStatus, setFeedbackStatus] = useState<OcrFeedbackStatus | 'all'>('all');
  const [feedbackLimit, setFeedbackLimit] = useState(20);
  const [optimizations, setOptimizations] = useState<OcrOptimizationEntry[]>([]);
  const [knowledge, setKnowledge] = useState<OcrKnowledgeGraph | null>(null);
  const [calibration, setCalibration] = useState<OcrThresholdProfile[]>([]);
  const [calibrationError, setCalibrationError] = useState<string | null>(null);
  const [fitBusy, setFitBusy] = useState(false);
  const [selection, setSelection] = useState<OcrFeedbackSelection | null>(null);
  const [registry, setRegistry] = useState<OcrRegistryState | null>(null);
  const [registryError, setRegistryError] = useState<string | null>(null);
  const [yields, setYields] = useState<OcrRecoveryYield[]>([]);
  const [yieldError, setYieldError] = useState<string | null>(null);
  const [yieldMinSamples, setYieldMinSamples] = useState(5);
  const [pendingDecision, setPendingDecision] = useState<{
    entry: OcrRegistryEntry;
    action: 'rollback' | 'retire';
  } | null>(null);
  const [sampling, setSampling] = useState({ perStratum: '3', total: '10', budget: '12' });
  const [audits, setAudits] = useState<OcrPassAudit[]>([]);
  const [auditStats, setAuditStats] = useState<OcrPassAuditStats | null>(null);
  const [auditPeriod, setAuditPeriod] = useState('');
  const [auditFilter, setAuditFilter] = useState<'all' | 'pending' | 'audited'>('pending');
  const [auditError, setAuditError] = useState<string | null>(null);
  const [auditSampling, setAuditSampling] = useState({ fraction: '2', perType: '5' });
  const [auditNotes, setAuditNotes] = useState<Record<string, string>>({});
  const [revisionQueue, setRevisionQueue] = useState<OcrRevisionQcItem[]>([]);
  const [revisionStats, setRevisionStats] = useState<OcrRevisionQcStats | null>(null);
  const [revisionError, setRevisionError] = useState<string | null>(null);
  const [revisionValues, setRevisionValues] = useState<Record<string, string>>({});
  const [registryTuning, setRegistryTuning] = useState<
    Record<string, { percent: string; mode: OcrGreyMode }>
  >({});
  const [registryForm, setRegistryForm] = useState({
    engine: 'paddle' as OcrEngine,
    modelId: '',
    pipeline: '',
    role: 'candidate' as OcrRegistryRole,
    mode: 'canary' as OcrGreyMode,
    percent: '10',
    auto: true,
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [form, setForm] = useState({
    title: '',
    targetError: '',
    expectedGain: '0.05',
    implementationCost: '1',
    inferenceCost: '0.1',
    risk: 'medium' as OcrOptimizationRisk,
    benchmarkResult: '',
  });

  const loadSeq = useRef(0);

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    setLoading(true);
    setError(null);
    try {
      const [dash, pool, entries, graph] = await Promise.all([
        api.ocrDashboard(days),
        api.ocrFeedback({
          status: feedbackStatus === 'all' ? undefined : feedbackStatus,
          limit: feedbackLimit,
        }),
        api.ocrOptimizations(),
        api.ocrKnowledge({ limit: 200 }),
      ]);
      if (seq !== loadSeq.current) return;
      setDashboard(dash.dashboard);
      setAlerts(dash.alerts);
      setFeedback(pool);
      setOptimizations(entries.entries);
      setKnowledge(graph.graph);
      try {
        const thresholds = await api.ocrCalibration();
        if (seq !== loadSeq.current) return;
        setCalibration(thresholds.profiles);
        setCalibrationError(null);
      } catch (cause) {
        if (seq !== loadSeq.current) return;
        setCalibrationError(messageOf(cause));
      }
      try {
        const registryState = await api.ocrRegistry();
        if (seq !== loadSeq.current) return;
        setRegistry(registryState);
        setRegistryError(null);
      } catch (cause) {
        if (seq !== loadSeq.current) return;
        setRegistryError(messageOf(cause));
      }
      try {
        const yieldState = await api.ocrRecoveryYields();
        if (seq !== loadSeq.current) return;
        setYields(yieldState.yields);
        setYieldMinSamples(yieldState.minSamples);
        setYieldError(null);
      } catch (cause) {
        if (seq !== loadSeq.current) return;
        setYieldError(messageOf(cause));
      }
      try {
        const auditState = await api.ocrPassAudits({ status: auditFilter });
        if (seq !== loadSeq.current) return;
        setAudits(auditState.audits);
        setAuditStats(auditState.stats);
        setAuditPeriod(auditState.period);
        setAuditError(null);
      } catch (cause) {
        if (seq !== loadSeq.current) return;
        setAuditError(messageOf(cause));
      }
      try {
        const qc = await api.ocrRevisionQc({ limit: 25 });
        if (seq !== loadSeq.current) return;
        setRevisionQueue(qc.items);
        setRevisionStats(qc.stats);
        setRevisionError(null);
      } catch (cause) {
        if (seq !== loadSeq.current) return;
        setRevisionError(messageOf(cause));
      }
    } catch (cause) {
      if (seq !== loadSeq.current) return;
      setError(messageOf(cause));
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
  }, [auditFilter, days, feedbackStatus, feedbackLimit]);

  useEffect(() => {
    void load();
  }, [load]);

  const syncFeedback = async () => {
    setBusy('sync');
    try {
      const result = await api.syncOcrFeedback(days);
      show(`扫描 ${result.scanned} 个文档，新增 ${result.inserted} 个样本`, 'success');
      await load();
    } catch (cause) {
      show(messageOf(cause), 'error');
    } finally {
      setBusy(null);
    }
  };

  const sampleFeedback = async () => {
    setBusy('sample');
    try {
      const perStratum = Math.max(1, Math.floor(Number(sampling.perStratum) || 3));
      const total = Math.max(1, Math.floor(Number(sampling.total) || 10));
      const budget = Math.max(1, Math.floor(Number(sampling.budget) || 12));
      const result = await api.sampleOcrFeedback({ perStratum, total, budget });
      setSelection(result);
      show(
        `已抽取 ${result.samples.length} 个待标注样本（成本 ${result.budget.used}/${result.budget.limit}）`,
        'success',
      );
      await load();
    } catch (cause) {
      show(messageOf(cause), 'error');
    } finally {
      setBusy(null);
    }
  };

  const markFeedback = async (id: string, status: Exclude<OcrFeedbackStatus, 'sampled'>) => {
    setBusy(`feedback:${id}`);
    try {
      await api.markOcrFeedback(id, { status });
      await load();
    } catch (cause) {
      show(messageOf(cause), 'error');
    } finally {
      setBusy(null);
    }
  };

  const samplePassAudits = async () => {
    setBusy('audit:sample');
    try {
      const fraction = Math.min(0.2, Math.max(0.001, Number(auditSampling.fraction) / 100 || 0.02));
      const perType = Math.max(1, Math.floor(Number(auditSampling.perType) || 5));
      const result = await api.sampleOcrPassAudits({ fraction, perType });
      setAuditStats(result.stats);
      setAuditPeriod(result.period);
      show(
        `已抽取 ${result.created.length} 个通过文档（${result.period}，${result.strata.length} 类）`,
        'success',
      );
      await load();
    } catch (cause) {
      show(messageOf(cause), 'error');
    } finally {
      setBusy(null);
    }
  };

  const markPassAudit = async (id: string, verdict: OcrPassAuditVerdict) => {
    setBusy(`audit:${id}`);
    try {
      const note = auditNotes[id]?.trim();
      const result = await api.markOcrPassAudit(id, { verdict, ...(note ? { note } : {}) });
      setAuditStats(result.stats);
      setAuditNotes((current) => {
        const next = { ...current };
        delete next[id];
        return next;
      });
      await load();
    } catch (cause) {
      show(messageOf(cause), 'error');
    } finally {
      setBusy(null);
    }
  };

  const reviewRevision = async (id: string, verdict: OcrRevisionReviewVerdict) => {
    setBusy(`revision:${id}:${verdict}`);
    try {
      const value = revisionValues[id]?.trim();
      const result = await api.reviewOcrRevision(id, {
        verdict,
        ...(value ? { value } : {}),
      });
      setRevisionStats(result.stats);
      setRevisionValues((current) => {
        const next = { ...current };
        delete next[id];
        return next;
      });
      show(
        verdict === 'confirm'
          ? '已确认修订，该标注可作为双人确认样本进入阈值拟合'
          : verdict === 'revise'
            ? '已改判，该标注在仲裁前不会参与阈值拟合'
            : '已仲裁，最终值以仲裁结论为准',
        'success',
      );
      await load();
    } catch (cause) {
      show(messageOf(cause), 'error');
    } finally {
      setBusy(null);
    }
  };

  const saveBaseline = async () => {
    setBusy('baseline');
    try {
      const result = await api.saveOcrDriftBaseline(days);
      show(`已保存基线（${result.baseline.samples} 个文档）`, 'success');
      await load();
    } catch (cause) {
      show(messageOf(cause), 'error');
    } finally {
      setBusy(null);
    }
  };

  const checkDrift = async () => {
    setBusy('drift');
    try {
      const result = await api.checkOcrDrift(days);
      setAlerts(result.alerts);
      setDashboard((current) => (current ? { ...current, drift: result.drift } : current));
      show(
        result.inserted > 0 ? `检测到漂移，新增 ${result.inserted} 条告警` : '未发现新的漂移告警',
        result.inserted > 0 ? 'error' : 'success',
      );
      await load();
    } catch (cause) {
      show(messageOf(cause), 'error');
    } finally {
      setBusy(null);
    }
  };

  const createOptimization = async (event: FormEvent) => {
    event.preventDefault();
    setBusy('optimization');
    try {
      await api.createOcrOptimization({
        title: form.title.trim(),
        targetError: form.targetError.trim(),
        expectedGain: Number(form.expectedGain),
        implementationCost: Number(form.implementationCost),
        inferenceCost: Number(form.inferenceCost),
        risk: form.risk,
        benchmarkResult: form.benchmarkResult.trim() || undefined,
      });
      setForm({ ...form, title: '', targetError: '', benchmarkResult: '' });
      show('已加入优化台账', 'success');
      await load();
    } catch (cause) {
      show(messageOf(cause), 'error');
    } finally {
      setBusy(null);
    }
  };

  const updateOptimization = async (id: string, status: OcrOptimizationStatus) => {
    setBusy(`optimization:${id}`);
    try {
      await api.updateOcrOptimization(id, { status });
      await load();
    } catch (cause) {
      show(messageOf(cause), 'error');
    } finally {
      setBusy(null);
    }
  };

  const fitCalibration = async () => {
    setFitBusy(true);
    try {
      const result = await api.fitOcrCalibration({});
      setCalibration(result.profiles);
      setCalibrationError(null);
      show(`已用最近基准样本拟合 ${result.profiles.length} 个阈值配置`, 'success');
    } catch (cause) {
      setCalibrationError(messageOf(cause));
      show(messageOf(cause), 'error');
    } finally {
      setFitBusy(false);
    }
  };

  const evaluateRegistry = async () => {
    setBusy('registry:evaluate');
    try {
      const result = await api.evaluateOcrRegistry({});
      setRegistry(result);
      show(
        `自动评估：${REGISTRY_ACTION_LABEL[result.evaluation.action]}（${result.evaluation.reason}）`,
        'success',
      );
    } catch (cause) {
      show(messageOf(cause), 'error');
    } finally {
      setBusy(null);
    }
  };

  const decideRegistry = async (
    entry: OcrRegistryEntry,
    action: 'promote' | 'rollback' | 'hold' | 'retire' | 'pin',
    pin?: boolean,
  ) => {
    setBusy(`registry:${entry.id}:${action}`);
    try {
      const result = await api.decideOcrRegistry({
        id: entry.id,
        action,
        mode: action === 'rollback' ? 'rollback' : undefined,
        pin,
      });
      setRegistry(result);
      const label =
        action === 'pin' ? (pin ? '已固定' : '已恢复自动') : `已${REGISTRY_ACTION_LABEL[action]}`;
      show(`${registryLabel(entry)} ${label}`, 'success');
    } catch (cause) {
      show(messageOf(cause), 'error');
    } finally {
      setBusy(null);
    }
  };

  const confirmDecision = async () => {
    if (!pendingDecision) return;
    const { entry, action } = pendingDecision;
    await decideRegistry(entry, action);
    setPendingDecision(null);
  };

  const adjustRegistry = async (entry: OcrRegistryEntry) => {
    const draft = tuningOf(entry, registryTuning);
    setBusy(`registry:${entry.id}:percent`);
    try {
      const result = await api.decideOcrRegistry({
        id: entry.id,
        action: 'percent',
        percent: Math.max(0, Math.min(99, Math.floor(Number(draft.percent) || 0))),
        mode: draft.mode,
      });
      setRegistry(result);
      setRegistryTuning((current) => {
        const next = { ...current };
        delete next[entry.id];
        return next;
      });
      show(`${registryLabel(entry)} 灰度已更新`, 'success');
    } catch (cause) {
      show(messageOf(cause), 'error');
    } finally {
      setBusy(null);
    }
  };

  const registerRegistry = async (event: FormEvent) => {
    event.preventDefault();
    setBusy('registry:register');
    try {
      const result = await api.registerOcrRegistry({
        engine: registryForm.engine,
        modelId: registryForm.modelId.trim(),
        pipeline: registryForm.pipeline.trim() || undefined,
        role: registryForm.role,
        mode: registryForm.mode,
        percent: registryForm.role === 'candidate' ? Number(registryForm.percent) : undefined,
        auto: registryForm.auto,
      });
      setRegistry(result);
      setRegistryForm({ ...registryForm, modelId: '', pipeline: '' });
      show('已登记模型变体', 'success');
    } catch (cause) {
      show(messageOf(cause), 'error');
    } finally {
      setBusy(null);
    }
  };

  const rows = dashboard ? bucketRows(dashboard) : [];
  const drift = dashboard?.drift;

  return (
    <section className="card card-pad ocr-governance">
      <header className="card-head">
        <div>
          <h2>OCR 生产治理</h2>
          <p className="card-sub">
            生产看板只汇总元数据与代理指标，不展示文档正文；错误样本、漂移告警与优化台账均按工作区管理员权限访问。
          </p>
        </div>
        <Icon name="shield" size={20} />
      </header>

      <div className="ops-actions ocr-governance-actions">
        <label className="ops-lab-check">
          统计窗口
          <select
            className="input"
            value={days}
            onChange={(event) => setDays(Number(event.target.value))}
          >
            {WINDOWS.map((value) => (
              <option key={value} value={value}>
                最近 {value} 天
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="btn btn-soft"
          onClick={() => void syncFeedback()}
          disabled={busy !== null}
        >
          <Icon name="refresh" size={16} />
          回流样本
        </button>
        <label className="ops-lab-check">
          每层样本
          <input
            className="input input-sm ocr-sampling-input"
            type="number"
            min={1}
            max={50}
            step={1}
            value={sampling.perStratum}
            aria-label="每层抽样数"
            onChange={(event) => setSampling({ ...sampling, perStratum: event.target.value })}
          />
        </label>
        <label className="ops-lab-check">
          抽样总量
          <input
            className="input input-sm ocr-sampling-input"
            type="number"
            min={1}
            max={500}
            step={1}
            value={sampling.total}
            aria-label="抽样总量"
            onChange={(event) => setSampling({ ...sampling, total: event.target.value })}
          />
        </label>
        <label className="ops-lab-check">
          标注预算
          <input
            className="input input-sm ocr-sampling-input"
            type="number"
            min={1}
            max={10000}
            step={1}
            value={sampling.budget}
            aria-label="标注预算"
            onChange={(event) => setSampling({ ...sampling, budget: event.target.value })}
          />
        </label>
        <button
          type="button"
          className="btn btn-soft"
          onClick={() => void sampleFeedback()}
          disabled={busy !== null}
        >
          主动学习抽样
        </button>
        <button
          type="button"
          className="btn btn-soft"
          onClick={() => void saveBaseline()}
          disabled={busy !== null}
        >
          保存漂移基线
        </button>
        <button
          type="button"
          className="btn btn-soft"
          onClick={() => void checkDrift()}
          disabled={busy !== null}
        >
          检查漂移
        </button>
      </div>

      {error ? (
        <p className="field-hint" role="alert">
          {error}
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => void load()}>
            重试
          </button>
        </p>
      ) : null}
      {loading && !dashboard ? <Skeleton height={180} /> : null}

      {dashboard ? (
        <>
          <div className="ops-metrics ocr-governance-metrics">
            <div className="ops-metric">
              <span className="stat-label">文档</span>
              <strong>{formatNumber(dashboard.documents)}</strong>
              <small>
                完成 {formatNumber(dashboard.done)} · 失败 {formatNumber(dashboard.failed)} · 排队{' '}
                {formatNumber(dashboard.pending)} · 处理中 {formatNumber(dashboard.processing)}
              </small>
            </div>
            <div className="ops-metric">
              <span className="stat-label">失败率 / 复核率</span>
              <strong>{pct(dashboard.failureRate)}</strong>
              <small>
                复核 {pct(dashboard.reviewRate)} · 截断 {pct(dashboard.truncationRate)}
              </small>
            </div>
            <div className="ops-metric">
              <span className="stat-label">修订观察率（代理）</span>
              <strong>{pct(dashboard.revisionObservedRate)}</strong>
              <small>{formatNumber(dashboard.revisions)} 处人工修订，非真实字段错误率</small>
            </div>
            <div className="ops-metric">
              <span className="stat-label">置信风险代理</span>
              <strong>{pct(dashboard.confidenceRiskProxy, 2)}</strong>
              <small>1 − 平均置信度，非真实 CER</small>
            </div>
            <div className="ops-metric">
              <span className="stat-label">耗时</span>
              <strong>{seconds(dashboard.latency.averageSeconds)}</strong>
              <small>p95 {seconds(dashboard.latency.p95Seconds)}</small>
            </div>
            <div className="ops-metric">
              <span className="stat-label">吞吐</span>
              <strong>
                {dashboard.throughput.charactersPerSecond === null
                  ? '—'
                  : `${formatNumber(Math.round(dashboard.throughput.charactersPerSecond))}/s`}
              </strong>
              <small>
                {formatNumber(dashboard.throughput.pages)} 页 ·{' '}
                {formatNumber(dashboard.throughput.characters)} 字符
              </small>
            </div>
          </div>

          {drift ? (
            <div className="ocr-governance-drift">
              <div className="ops-lab-meta">
                <span>
                  漂移基线 {drift.baselineSamples} 个 · 当前 {drift.currentSamples} 个
                  {drift.baselineAt ? ` · ${formatDateTime(drift.baselineAt)}` : ''}
                </span>
                {drift.dimensions.map((dimension) => (
                  <span
                    key={dimension.dimension}
                    className={`ocr-drift-chip is-${dimension.status}`}
                    title={`TV ${pct(dimension.totalVariation)} · 阈值 ${pct(dimension.threshold)}`}
                  >
                    {dimension.dimension} {pct(dimension.totalVariation)}
                  </span>
                ))}
              </div>
              {drift.recommendation ? <p className="field-hint">{drift.recommendation}</p> : null}
            </div>
          ) : null}

          <details className="ops-lab-groups" open>
            <summary>分组指标（{rows.length} 组）</summary>
            <div className="table-wrap">
              <table className="table">
                <caption className="sr-only">OCR 生产分组指标</caption>
                <thead>
                  <tr>
                    <th scope="col">维度</th>
                    <th scope="col">分组</th>
                    <th scope="col">文档</th>
                    <th scope="col">完成</th>
                    <th scope="col">失败率</th>
                    <th scope="col">复核率</th>
                    <th scope="col">修订观察（代理）</th>
                    <th scope="col">置信风险（代理）</th>
                    <th scope="col">平均耗时</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={`${row.dimension}:${row.key}`}>
                      <td>{row.dimension}</td>
                      <td>{row.key}</td>
                      <td>{formatNumber(row.documents)}</td>
                      <td>{formatNumber(row.done)}</td>
                      <td>{pct(row.failureRate)}</td>
                      <td>{pct(row.reviewRate)}</td>
                      <td>{pct(row.revisionObservedRate)}</td>
                      <td>{pct(row.confidenceRiskProxy, 2)}</td>
                      <td>{seconds(row.seconds)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>

          {(dashboard.workspaceThresholds?.length ?? 0) > 0 ? (
            <details className="ops-lab-groups">
              <summary>客户/组织阈值（{dashboard.workspaceThresholds?.length} 个）</summary>
              <div className="table-wrap">
                <table className="table">
                  <caption className="sr-only">客户/组织拟合阈值</caption>
                  <thead>
                    <tr>
                      <th scope="col">组织</th>
                      <th scope="col">样本</th>
                      <th scope="col">校准</th>
                      <th scope="col">复核阈值</th>
                      <th scope="col">失败阈值</th>
                      <th scope="col">关键字段</th>
                      <th scope="col">ECE</th>
                      <th scope="col">更新时间</th>
                    </tr>
                  </thead>
                  <tbody>
                    {dashboard.workspaceThresholds?.map((profile) => (
                      <tr key={profile.id}>
                        <td>{profile.value}</td>
                        <td>{thresholdSampleText(profile)}</td>
                        <td>{profile.calibrated ? '已校准' : '样本不足'}</td>
                        <td>{pct(profile.reviewThreshold)}</td>
                        <td>{pct(profile.failThreshold)}</td>
                        <td>{pct(profile.keyFieldConfidence)}</td>
                        <td>{pct(profile.ece, 2)}</td>
                        <td>{formatDateTime(profile.updatedAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="field-hint">
                阈值按人工标注样本拟合（Youden J、精确率与关键字段目标）；ECE/Brier
                仅作报告，不作为启用条件。样本不足的组织回退到整体阈值，分歧标注剔除、
                单人修订降权后的样本数见「有效」。
              </p>
            </details>
          ) : null}

          <details className="ops-lab-groups">
            <summary>处理阶段（{dashboard.byStage.length} 个）</summary>
            <div className="table-wrap">
              <table className="table">
                <caption className="sr-only">OCR 阶段统计</caption>
                <thead>
                  <tr>
                    <th scope="col">阶段</th>
                    <th scope="col">运行</th>
                    <th scope="col">失败</th>
                    <th scope="col">跳过</th>
                    <th scope="col">累计耗时</th>
                  </tr>
                </thead>
                <tbody>
                  {dashboard.byStage.map((item) => (
                    <tr key={item.stage}>
                      <td>{item.stage}</td>
                      <td>{formatNumber(item.runs)}</td>
                      <td>{formatNumber(item.failed)}</td>
                      <td>{formatNumber(item.skipped)}</td>
                      <td>{seconds(item.seconds)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>

          <div className="ocr-governance-grid">
            <div>
              <div className="card-head ocr-governance-subhead">
                <div>
                  <h3>错误样本池</h3>
                  <p className="card-sub">
                    共 {feedback?.pool.total ?? 0} 个 · 待处理 {feedback?.pool.unlabeled ?? 0} 个 ·
                    按错误类型与文档类别分层。
                    {feedback
                      ? ` 当前筛选 ${formatNumber(feedback.matched)} 个，显示 ${feedback.samples.length} 个。`
                      : ''}
                  </p>
                </div>
                <select
                  className="input"
                  aria-label="按样本状态过滤"
                  value={feedbackStatus}
                  onChange={(event) => {
                    setFeedbackLimit(20);
                    setFeedbackStatus(event.target.value as OcrFeedbackStatus | 'all');
                  }}
                >
                  <option value="all">全部状态</option>
                  {Object.entries(STATUS_LABEL).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </div>
              {feedback && feedback.samples.length > 0 ? (
                <div className="table-wrap">
                  <table className="table">
                    <caption className="sr-only">OCR 错误样本</caption>
                    <thead>
                      <tr>
                        <th scope="col">类型</th>
                        <th scope="col">类别</th>
                        <th scope="col">优先级</th>
                        <th scope="col">状态</th>
                        <th scope="col">说明</th>
                        <th scope="col">操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      {feedback.samples.map((sample) => (
                        <tr key={sample.id}>
                          <td>{ERROR_LABEL[sample.errorType]}</td>
                          <td>{sample.category}</td>
                          <td>{sample.priority.toFixed(2)}</td>
                          <td>{STATUS_LABEL[sample.status]}</td>
                          <td title={sample.note ?? ''}>{sample.note ?? '—'}</td>
                          <td>
                            <div className="ops-actions">
                              {sample.status !== 'labeled' ? (
                                <button
                                  type="button"
                                  className="btn btn-ghost btn-sm"
                                  onClick={() => void markFeedback(sample.id, 'labeled')}
                                  disabled={busy !== null}
                                >
                                  已标注
                                </button>
                              ) : null}
                              {sample.status !== 'dismissed' ? (
                                <button
                                  type="button"
                                  className="btn btn-ghost btn-sm"
                                  onClick={() => void markFeedback(sample.id, 'dismissed')}
                                  disabled={busy !== null}
                                >
                                  忽略
                                </button>
                              ) : null}
                              {sample.status === 'dismissed' ? (
                                <button
                                  type="button"
                                  className="btn btn-ghost btn-sm"
                                  onClick={() => void markFeedback(sample.id, 'pool')}
                                  disabled={busy !== null}
                                >
                                  恢复
                                </button>
                              ) : null}
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="muted">样本池为空。运行 OCR 后点击「回流样本」。</p>
              )}
              {feedback && feedback.samples.length < feedback.matched ? (
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => setFeedbackLimit((current) => Math.min(1000, current + 20))}
                  disabled={loading}
                >
                  加载更多（{feedback.samples.length}/{formatNumber(feedback.matched)}）
                </button>
              ) : null}
              {selection ? (
                <p className="field-hint">
                  本次抽样 {selection.samples.length} 条（成本 {selection.budget.used}/
                  {selection.budget.limit ?? '不限'}，覆盖 {selection.coverage.categories}/
                  {selection.coverage.poolCategories} 类文档）：
                  {selection.samples
                    .map((sample) => `${ERROR_LABEL[sample.errorType]}/${sample.category}`)
                    .join('、') || '无'}
                </p>
              ) : null}
            </div>

            <div>
              <div className="card-head ocr-governance-subhead">
                <div>
                  <h3>漂移告警</h3>
                  <p className="card-sub">按维度与日期去重，保留最近 20 条。</p>
                </div>
              </div>
              {alerts.length > 0 ? (
                <ul className="ocr-governance-alerts">
                  {alerts.map((alert) => (
                    <li key={alert.id}>
                      <span
                        className={`ocr-drift-chip is-${alert.severity === 'critical' ? 'drift' : 'warn'}`}
                      >
                        {alert.dimension}
                      </span>
                      <div>
                        <strong>{alert.message}</strong>
                        <small>
                          {formatDateTime(alert.detectedAt)} ·{' '}
                          {alert.status === 'open' ? '待处理' : '已确认'}
                        </small>
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="muted">暂无漂移告警。</p>
              )}
            </div>
          </div>

          <details className="ops-lab-groups" open={audits.length > 0}>
            <summary>
              通过文档随机审计（静默错误率{' '}
              {auditStats?.silentErrorRate === null || auditStats?.silentErrorRate === undefined
                ? '—'
                : pct(auditStats.silentErrorRate)}
              ，已审 {auditStats?.audited ?? 0}/{auditStats?.sampled ?? 0} 个）
            </summary>
            <p className="field-hint">
              自动判定为通过不等于文档正确。每周按文件类型分层随机抽样，两名复核人各自独立给出「干净/有错」
              结论；一致有错与两人分歧都计入静默错误率，审计结论同时作为无偏样本参与阈值拟合。当前周期{' '}
              {auditPeriod || '—'}。
            </p>
            {auditError ? (
              <p className="field-hint" role="alert">
                审计数据加载失败：{auditError}
              </p>
            ) : null}
            {auditStats ? (
              <div className="ops-lab-meta">
                <span title="满足自动通过条件的文档总数">
                  通过文档 {formatNumber(auditStats.passDocuments)} 个
                </span>
                <span title="本周期货架数量与抽样覆盖率">
                  抽样 {formatNumber(auditStats.sampled)} 个 · 覆盖 {pct(auditStats.coverage)}
                </span>
                <span>待复核 {auditStats.pending} 个</span>
                <span>一致通过 {auditStats.clean} 个</span>
                <span>一致有错 {auditStats.error} 个</span>
                <span>两人分歧 {auditStats.disputed} 个</span>
                <span title="两名复核人结论不同的比例，偏高说明标注口径需要统一">
                  分歧率 {pct(auditStats.disagreementRate)}
                </span>
                <span title="静默错误率的 95% Wilson 置信区间">
                  95% 区间 {pct(auditStats.interval[0])}–{pct(auditStats.interval[1])}
                </span>
              </div>
            ) : null}
            <div className="ops-actions ocr-governance-actions">
              <label className="ops-lab-check">
                抽样比例（%）
                <input
                  className="input input-sm ocr-sampling-input"
                  type="number"
                  min={0.1}
                  max={20}
                  step={0.1}
                  value={auditSampling.fraction}
                  aria-label="通过文档抽样比例（百分比）"
                  onChange={(event) =>
                    setAuditSampling({ ...auditSampling, fraction: event.target.value })
                  }
                />
              </label>
              <label className="ops-lab-check">
                每类上限
                <input
                  className="input input-sm ocr-sampling-input"
                  type="number"
                  min={1}
                  max={50}
                  step={1}
                  value={auditSampling.perType}
                  aria-label="每个文件类型的抽样上限"
                  onChange={(event) =>
                    setAuditSampling({ ...auditSampling, perType: event.target.value })
                  }
                />
              </label>
              <button
                type="button"
                className="btn btn-soft"
                onClick={() => void samplePassAudits()}
                disabled={busy !== null}
              >
                <Icon name="refresh" size={16} />
                抽取本周审计样本
              </button>
              <label className="ops-lab-check">
                队列
                <select
                  className="input"
                  value={auditFilter}
                  aria-label="审计队列筛选"
                  onChange={(event) =>
                    setAuditFilter(event.target.value as 'all' | 'pending' | 'audited')
                  }
                >
                  <option value="pending">待复核</option>
                  <option value="audited">已审结</option>
                  <option value="all">全部</option>
                </select>
              </label>
            </div>
            {audits.length > 0 ? (
              <div className="table-wrap">
                <table className="table">
                  <caption className="sr-only">通过文档审计队列</caption>
                  <thead>
                    <tr>
                      <th scope="col">文档</th>
                      <th scope="col">文件类型</th>
                      <th scope="col">引擎</th>
                      <th scope="col">质量分</th>
                      <th scope="col">置信度</th>
                      <th scope="col">一审 / 二审</th>
                      <th scope="col">结论</th>
                      <th scope="col">标注</th>
                    </tr>
                  </thead>
                  <tbody>
                    {audits.map((audit) => (
                      <tr key={audit.id}>
                        <td title={audit.projectName ?? ''}>{audit.attachmentName}</td>
                        <td>{audit.docType}</td>
                        <td>{audit.engine ?? '—'}</td>
                        <td>{audit.qualityScore === null ? '—' : audit.qualityScore.toFixed(2)}</td>
                        <td>{pct(audit.confidence)}</td>
                        <td>
                          {audit.firstVerdict ? AUDIT_VERDICT_LABEL[audit.firstVerdict] : '—'} /{' '}
                          {audit.secondVerdict ? AUDIT_VERDICT_LABEL[audit.secondVerdict] : '—'}
                        </td>
                        <td>{AUDIT_STATUS_LABEL[audit.status]}</td>
                        <td>
                          <div className="ops-actions">
                            <input
                              className="input input-sm"
                              placeholder="错误说明（可选）"
                              aria-label={`${audit.attachmentName} 的审计说明`}
                              maxLength={500}
                              value={auditNotes[audit.id] ?? ''}
                              onChange={(event) =>
                                setAuditNotes((current) => ({
                                  ...current,
                                  [audit.id]: event.target.value,
                                }))
                              }
                            />
                            <button
                              type="button"
                              className="btn btn-ghost btn-sm"
                              onClick={() => void markPassAudit(audit.id, 'clean')}
                              disabled={busy !== null}
                            >
                              干净
                            </button>
                            <button
                              type="button"
                              className="btn btn-ghost btn-sm"
                              onClick={() => void markPassAudit(audit.id, 'error')}
                              disabled={busy !== null}
                            >
                              有错
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="muted">
                {auditFilter === 'pending'
                  ? '没有待复核样本，可点击「抽取本周审计样本」。'
                  : '该队列暂无样本。'}
              </p>
            )}
            {auditStats && auditStats.byDocType.length > 0 ? (
              <>
                <div className="table-wrap">
                  <table className="table">
                    <caption className="sr-only">按文件类型的静默错误率</caption>
                    <thead>
                      <tr>
                        <th scope="col">文件类型</th>
                        <th scope="col">抽样</th>
                        <th scope="col">已审</th>
                        <th scope="col">干净</th>
                        <th scope="col">有错</th>
                        <th scope="col">分歧</th>
                        <th scope="col">静默错误率</th>
                        <th scope="col">95% 区间</th>
                      </tr>
                    </thead>
                    <tbody>
                      {auditStats.byDocType.map((row) => (
                        <tr key={row.docType}>
                          <td>{row.docType}</td>
                          <td>{row.sampled}</td>
                          <td>{row.audited}</td>
                          <td>{row.clean}</td>
                          <td>{row.error}</td>
                          <td>{row.disputed}</td>
                          <td>{pct(row.silentErrorRate)}</td>
                          <td>
                            {row.silentErrorRate === null
                              ? '—'
                              : `${pct(row.interval[0])}–${pct(row.interval[1])}`}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="field-hint">
                  已审结数量不足时置信区间较宽，仅供趋势判断；只有两名复核人结论一致才算审结。
                </p>
              </>
            ) : null}
          </details>

          <details className="ops-lab-groups" open={revisionQueue.length > 0}>
            <summary>
              人工修订质检（{revisionStats?.reviewed ?? 0}/{revisionStats?.revisions ?? 0} 条已复核
              · 分歧率 {revisionStats ? pct(revisionStats.disagreementRate) : '—'}）
            </summary>
            <p className="field-hint">
              人工修订是标注而不是事实：修订人同样会出错。队列优先送审分歧样本，其余按稳定哈希顺序抽取，
              修订人不能复核自己的修订；确认、改判、仲裁分别对应双人确认、待仲裁、已仲裁三档可靠性，
              单人标注在阈值拟合中降权，分歧标注直接剔除。
            </p>
            {revisionError ? (
              <p className="field-hint" role="alert">
                修订质检数据加载失败：{revisionError}
              </p>
            ) : null}
            {revisionStats ? (
              <div className="ops-lab-meta">
                <span title="历史人工字段修订总数">修订 {revisionStats.revisions} 条</span>
                <span>待复核 {revisionStats.unreviewed} 条</span>
                <span>双人确认 {revisionStats.doubleConfirmed} 条</span>
                <span>已仲裁 {revisionStats.arbitrated} 条</span>
                <span title="有人改判但还无人给出最终值">待仲裁 {revisionStats.disputed} 条</span>
                <span title="复核覆盖率">复核覆盖 {pct(revisionStats.coverage)}</span>
                <span title="复核人改判占已出具意见的比例">
                  分歧率 {pct(revisionStats.disagreementRate)}
                  {revisionStats.disagreementRate === null
                    ? ''
                    : ` · 95% 区间 ${pct(revisionStats.interval[0])}–${pct(revisionStats.interval[1])}`}
                </span>
                <span title="作为标注真值使用的构成">
                  标注构成 双人 {revisionStats.annotationMix.doubleConfirmed} / 单人{' '}
                  {revisionStats.annotationMix.singleReviewer} / 分歧{' '}
                  {revisionStats.annotationMix.disputed}
                </span>
              </div>
            ) : null}
            {revisionQueue.length > 0 ? (
              <div className="table-wrap">
                <table className="table">
                  <caption className="sr-only">人工修订复核队列</caption>
                  <thead>
                    <tr>
                      <th scope="col">文档</th>
                      <th scope="col">字段</th>
                      <th scope="col">识别值</th>
                      <th scope="col">修订值</th>
                      <th scope="col">修订人</th>
                      <th scope="col">已有复核</th>
                      <th scope="col">可靠性</th>
                      <th scope="col">出具意见</th>
                    </tr>
                  </thead>
                  <tbody>
                    {revisionQueue.map((item) => {
                      const id = item.revision.id;
                      const value = revisionValues[id] ?? '';
                      return (
                        <tr key={id}>
                          <td title={item.projectName ?? ''}>{item.attachmentName}</td>
                          <td>
                            {FIELD_KIND_LABEL[item.revision.fieldKind]}·{item.revision.fieldId}
                          </td>
                          <td className="ocr-qc-value" title={item.revision.originalText}>
                            {item.revision.originalText}
                          </td>
                          <td className="ocr-qc-value" title={item.revision.revisedText}>
                            {item.revision.revisedText}
                          </td>
                          <td>{item.revision.revisedBy?.name ?? '—'}</td>
                          <td>
                            {item.reviews.length > 0
                              ? item.reviews
                                  .map(
                                    (review) =>
                                      `${REVIEW_VERDICT_LABEL[review.verdict]}·${review.reviewedBy?.name ?? '—'}`,
                                  )
                                  .join(' / ')
                              : '无人复核'}
                          </td>
                          <td title={RELIABILITY_HINT[item.reliability]}>
                            {RELIABILITY_LABEL[item.reliability]}
                          </td>
                          <td>
                            <div className="ops-actions">
                              <input
                                className="input input-sm"
                                placeholder="改判或仲裁的最终值"
                                aria-label={`${item.attachmentName} ${item.revision.fieldId} 的复核值`}
                                maxLength={2000}
                                value={value}
                                onChange={(event) =>
                                  setRevisionValues((current) => ({
                                    ...current,
                                    [id]: event.target.value,
                                  }))
                                }
                              />
                              <button
                                type="button"
                                className="btn btn-ghost btn-sm"
                                onClick={() => void reviewRevision(id, 'confirm')}
                                disabled={busy !== null}
                              >
                                确认
                              </button>
                              <button
                                type="button"
                                className="btn btn-ghost btn-sm"
                                onClick={() => void reviewRevision(id, 'revise')}
                                disabled={busy !== null || value.trim() === ''}
                              >
                                改判
                              </button>
                              <button
                                type="button"
                                className="btn btn-ghost btn-sm"
                                onClick={() => void reviewRevision(id, 'arbitrate')}
                                disabled={busy !== null || value.trim() === ''}
                              >
                                仲裁
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="muted">
                {revisionStats && revisionStats.revisions > 0
                  ? '待复核队列已清空，新的人工修订会自动进入队列。'
                  : '暂无人工字段修订记录。'}
              </p>
            )}
            {revisionStats && revisionStats.byReviewer.length > 0 ? (
              <>
                <div className="table-wrap">
                  <table className="table">
                    <caption className="sr-only">复核人一致性</caption>
                    <thead>
                      <tr>
                        <th scope="col">复核人</th>
                        <th scope="col">出具意见</th>
                        <th scope="col">确认</th>
                        <th scope="col">改判</th>
                        <th scope="col">确认率</th>
                      </tr>
                    </thead>
                    <tbody>
                      {revisionStats.byReviewer.map((row) => (
                        <tr key={`${row.reviewerId ?? 'unknown'}-${row.reviewerName}`}>
                          <td>{row.reviewerName}</td>
                          <td>{row.reviewed}</td>
                          <td>{row.confirmed}</td>
                          <td>{row.revised}</td>
                          <td title="确认率异常偏低通常说明修订口径不稳定，应先统一规范而不是继续放量">
                            {pct(row.agreementRate)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="field-hint">
                  确认率＝同一复核人确认他人修订的比例；分歧集中说明字段规范需要统一。
                </p>
              </>
            ) : null}
          </details>

          {knowledge ? (
            <details className="ops-lab-groups" open={knowledge.entities.length > 0}>
              <summary>
                文档知识图谱（{formatNumber(knowledge.documents)} 个文档 ·{' '}
                {formatNumber(knowledge.entities.length)} 个实体 ·{' '}
                {formatNumber(knowledge.relations.length)} 条引用）
              </summary>
              {knowledge.metrics.length > 0 ? (
                <div className="ops-lab-meta">
                  {knowledge.metrics.slice(0, 8).map((metric) => (
                    <span key={metric.key} title={`基于 ${metric.samples} 个样本`}>
                      {metric.label}{' '}
                      {metric.unit === 'amount'
                        ? formatCompactCurrency(metric.value)
                        : `${formatNumber(metric.value)} 项`}
                    </span>
                  ))}
                  {knowledge.metrics.length > 8 ? (
                    <span>仅显示前 8 项（共 {knowledge.metrics.length} 项）</span>
                  ) : null}
                </div>
              ) : null}
              {knowledge.warnings.length > 0 ? (
                <p className="field-hint">{knowledge.warnings.join('；')}</p>
              ) : null}
              {knowledge.entities.length > 0 ? (
                <>
                  <div className="table-wrap">
                    <table className="table">
                      <caption className="sr-only">跨文档实体</caption>
                      <thead>
                        <tr>
                          <th scope="col">类型</th>
                          <th scope="col">实体</th>
                          <th scope="col">文档</th>
                          <th scope="col">出现</th>
                          <th scope="col">置信度</th>
                          <th scope="col">修订</th>
                        </tr>
                      </thead>
                      <tbody>
                        {knowledge.entities.slice(0, 20).map((entity) => (
                          <tr key={entity.id}>
                            <td>{ENTITY_TYPE_LABEL[entity.type]}</td>
                            <td>{entity.display}</td>
                            <td>{formatNumber(entity.documents)}</td>
                            <td>{formatNumber(entity.occurrences.length)}</td>
                            <td>{pct(entity.confidence)}</td>
                            <td>{entity.revised ? '含人工修订' : '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {knowledge.entities.length > 20 ? (
                    <p className="field-hint">
                      仅显示前 20 个实体（共 {formatNumber(knowledge.entities.length)} 个）。
                    </p>
                  ) : null}
                </>
              ) : (
                <p className="muted">
                  暂无可用实体。完成 OCR 且包含编号/金额/日期字段后会自动出现。
                </p>
              )}
              {knowledge.relations.length > 0 ? (
                <div className="ops-lab-meta">
                  {knowledge.relations.slice(0, 12).map((relation) => (
                    <span
                      key={`${relation.entityId}:${relation.from}:${relation.to}`}
                      title={`${RELATION_LABEL[relation.kind]} · ${relation.from} → ${relation.to}`}
                    >
                      {RELATION_LABEL[relation.kind]} · {relation.from} → {relation.to}
                    </span>
                  ))}
                  {knowledge.relations.length > 12 ? (
                    <span>
                      仅显示前 12 条引用（共 {formatNumber(knowledge.relations.length)} 条）
                    </span>
                  ) : null}
                </div>
              ) : null}
              <p className="field-hint">
                知识图谱只读：实体来自已识别关键字段，优先采用最新人工修订值；正文引用只建立关系，不改写任何文本。
              </p>
            </details>
          ) : null}

          <details className="ops-lab-groups">
            <summary>恢复收益（Beta 平滑 · {yields.length} 项）</summary>
            <p className="field-hint">
              每次识别后记录恢复阶段是否提升质量分；样本达到 {yieldMinSamples}{' '}
              次后才参与级联期望收益计算，不足时沿用先验。统计只读，不改写任何文本。
            </p>
            {yieldError ? (
              <p className="field-hint" role="alert">
                恢复收益刷新失败：{yieldError}
              </p>
            ) : null}
            {yields.length > 0 ? (
              <div className="table-wrap">
                <table className="table">
                  <caption className="sr-only">OCR 恢复阶段收益</caption>
                  <thead>
                    <tr>
                      <th scope="col">阶段</th>
                      <th scope="col">尝试</th>
                      <th scope="col">成功</th>
                      <th scope="col">平滑成功率</th>
                      <th scope="col">先验</th>
                      <th scope="col">更新时间</th>
                    </tr>
                  </thead>
                  <tbody>
                    {yields.map((item) => (
                      <tr key={item.stage}>
                        <td>{recoveryStageLabel(item.stage)}</td>
                        <td>{formatNumber(item.attempts)}</td>
                        <td>{formatNumber(item.successes)}</td>
                        <td>{pct(item.probability)}</td>
                        <td>{pct(item.prior)}</td>
                        <td>{item.updatedAt ? formatDateTime(item.updatedAt) : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="muted">尚无恢复阶段记录；完成带恢复动作的识别后会在此累计。</p>
            )}
          </details>

          <details className="ops-lab-groups">
            <summary>质量阈值配置（{calibration.length} 项）</summary>
            <p className="field-hint">
              复核/失败/关键字段阈值由人工标注样本拟合（Youden J、精确率与关键字段目标）；
              样本不足的分组保留拟合值但标记为未校准，运行时回退到整体阈值。分歧标注会被剔除、
              单人修订会降权，因此「有效」样本数可能小于样本数。
            </p>
            <div className="ops-actions">
              <button
                type="button"
                className="btn btn-soft"
                onClick={() => void fitCalibration()}
                disabled={fitBusy}
              >
                <Icon name="refresh" size={16} />
                {fitBusy ? '拟合中…' : '用最近基准样本重新拟合'}
              </button>
            </div>
            {calibrationError ? (
              <p className="field-hint" role="alert">
                {calibrationError}
              </p>
            ) : null}
            {calibration.length > 0 ? (
              <div className="table-wrap">
                <table className="table">
                  <caption className="sr-only">OCR 质量阈值配置</caption>
                  <thead>
                    <tr>
                      <th scope="col">维度</th>
                      <th scope="col">分组</th>
                      <th scope="col">样本</th>
                      <th scope="col">校准</th>
                      <th scope="col">复核阈值</th>
                      <th scope="col">失败阈值</th>
                      <th scope="col">关键字段</th>
                      <th scope="col">ECE</th>
                      <th scope="col">更新时间</th>
                    </tr>
                  </thead>
                  <tbody>
                    {calibration.map((profile) => (
                      <tr key={profile.id}>
                        <td>{THRESHOLD_DIMENSION_LABEL[profile.dimension]}</td>
                        <td>{profile.value}</td>
                        <td>{thresholdSampleText(profile)}</td>
                        <td>{profile.calibrated ? '已校准' : '样本不足'}</td>
                        <td>{pct(profile.reviewThreshold)}</td>
                        <td>{pct(profile.failThreshold)}</td>
                        <td>{pct(profile.keyFieldConfidence)}</td>
                        <td>{pct(profile.ece, 2)}</td>
                        <td>{formatDateTime(profile.updatedAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="muted">尚无拟合阈值；运行基准后点击上方按钮拟合。</p>
            )}
          </details>

          {registry ? (
            <details className="ops-lab-groups">
              <summary>
                模型注册表与灰度（{registry.entries.length} 项 · 自动
                {registry.policy.auto ? '开启' : '关闭'}）
              </summary>
              {registryError ? (
                <p className="field-hint" role="alert">
                  注册表刷新失败：{registryError}（显示最近一次成功加载的数据）。
                </p>
              ) : null}
              <div className="ops-lab-meta">
                <span>控制 {registry.control ? registryLabel(registry.control) : '—'}</span>
                <span>候选 {registry.candidate ? registryLabel(registry.candidate) : '—'}</span>
                <span>回滚 {registry.rollback ? registryLabel(registry.rollback) : '—'}</span>
                <span>
                  最小样本 {registry.policy.minSamples} · 晋级 +{pct(registry.policy.promoteMargin)}{' '}
                  · 回滚 −{pct(registry.policy.rollbackMargin)} · 显著性 p≤
                  {registry.policy.significance}
                </span>
              </div>
              <div className="ops-actions">
                <button
                  type="button"
                  className="btn btn-soft"
                  onClick={() => void evaluateRegistry()}
                  disabled={busy !== null}
                >
                  运行自动评估
                </button>
              </div>
              {registry.entries.length > 0 ? (
                <div className="table-wrap">
                  <table className="table">
                    <caption className="sr-only">OCR 模型注册表</caption>
                    <thead>
                      <tr>
                        <th scope="col">模型</th>
                        <th scope="col">角色</th>
                        <th scope="col">灰度</th>
                        <th scope="col">比例</th>
                        <th scope="col">基准</th>
                        <th scope="col">生产</th>
                        <th scope="col">自动</th>
                        <th scope="col">操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      {registry.entries.map((entry) => {
                        const draft = tuningOf(entry, registryTuning);
                        const tuningDirty =
                          entry.role === 'candidate' &&
                          (draft.percent !== String(entry.percent) || draft.mode !== entry.mode);
                        return (
                          <tr key={entry.id}>
                            <td>{registryLabel(entry)}</td>
                            <td>{REGISTRY_ROLE_LABEL[entry.role]}</td>
                            <td>
                              {entry.role === 'candidate' ? (
                                <select
                                  className="input input-sm ocr-registry-mode"
                                  aria-label={`${registryLabel(entry)} 灰度模式`}
                                  value={draft.mode}
                                  onChange={(event) =>
                                    setRegistryTuning({
                                      ...registryTuning,
                                      [entry.id]: {
                                        ...draft,
                                        mode: event.target.value as OcrGreyMode,
                                      },
                                    })
                                  }
                                  disabled={busy !== null}
                                >
                                  <option value="canary">灰度</option>
                                  <option value="shadow">影子</option>
                                  <option value="rollback">回滚</option>
                                </select>
                              ) : (
                                GREY_MODE_LABEL[entry.mode]
                              )}
                            </td>
                            <td>
                              {entry.role === 'candidate' ? (
                                <input
                                  className="input input-sm ocr-registry-percent"
                                  type="number"
                                  min={0}
                                  max={99}
                                  step={1}
                                  aria-label={`${registryLabel(entry)} 灰度比例`}
                                  value={draft.percent}
                                  onChange={(event) =>
                                    setRegistryTuning({
                                      ...registryTuning,
                                      [entry.id]: { ...draft, percent: event.target.value },
                                    })
                                  }
                                  disabled={busy !== null}
                                />
                              ) : (
                                '—'
                              )}
                            </td>
                            <td>
                              {pct(entry.benchmarkScore)} · {formatNumber(entry.benchmarkSamples)}{' '}
                              样本
                            </td>
                            <td>
                              {pct(entry.productionScore)} · {formatNumber(entry.productionSamples)}{' '}
                              样本
                            </td>
                            <td>{entry.auto ? '是' : '人工固定'}</td>
                            <td>
                              <div className="ops-actions">
                                {entry.role !== 'control' && entry.role !== 'retired' ? (
                                  <button
                                    type="button"
                                    className="btn btn-ghost btn-sm"
                                    aria-label={`晋级 ${registryLabel(entry)}`}
                                    onClick={() => void decideRegistry(entry, 'promote')}
                                    disabled={busy !== null}
                                  >
                                    晋级
                                  </button>
                                ) : null}
                                {entry.role !== 'rollback' && entry.role !== 'retired' ? (
                                  <button
                                    type="button"
                                    className="btn btn-ghost btn-sm"
                                    aria-label={`回退到 ${registryLabel(entry)}`}
                                    onClick={() =>
                                      setPendingDecision({ entry, action: 'rollback' })
                                    }
                                    disabled={busy !== null}
                                  >
                                    回退
                                  </button>
                                ) : null}
                                {entry.role === 'candidate' ? (
                                  <button
                                    type="button"
                                    className="btn btn-ghost btn-sm"
                                    aria-label={`保留 ${registryLabel(entry)}`}
                                    onClick={() => void decideRegistry(entry, 'hold')}
                                    disabled={busy !== null}
                                  >
                                    保留
                                  </button>
                                ) : null}
                                {entry.role === 'candidate' ? (
                                  <button
                                    type="button"
                                    className="btn btn-ghost btn-sm"
                                    aria-label={`应用 ${registryLabel(entry)} 灰度配置`}
                                    onClick={() => void adjustRegistry(entry)}
                                    disabled={busy !== null || !tuningDirty}
                                  >
                                    应用灰度
                                  </button>
                                ) : null}
                                {entry.role !== 'retired' ? (
                                  <>
                                    <button
                                      type="button"
                                      className="btn btn-ghost btn-sm"
                                      aria-pressed={!entry.auto}
                                      aria-label={`${entry.auto ? '固定' : '恢复自动'} ${registryLabel(entry)}`}
                                      onClick={() => void decideRegistry(entry, 'pin', entry.auto)}
                                      disabled={busy !== null}
                                    >
                                      {entry.auto ? '固定' : '恢复自动'}
                                    </button>
                                    <button
                                      type="button"
                                      className="btn btn-ghost btn-sm"
                                      aria-label={`退役 ${registryLabel(entry)}`}
                                      onClick={() =>
                                        setPendingDecision({ entry, action: 'retire' })
                                      }
                                      disabled={busy !== null}
                                    >
                                      退役
                                    </button>
                                  </>
                                ) : null}
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="muted">
                  注册表为空，OCR 使用环境变量灰度配置。登记两个模型后可开启自动晋级/回滚。
                </p>
              )}
              <form className="form-grid" onSubmit={registerRegistry}>
                <Field label="引擎" htmlFor="ocr-reg-engine">
                  <select
                    id="ocr-reg-engine"
                    className="input"
                    value={registryForm.engine}
                    onChange={(event) =>
                      setRegistryForm({ ...registryForm, engine: event.target.value as OcrEngine })
                    }
                  >
                    <option value="paddle">paddle</option>
                    <option value="docling">docling</option>
                  </select>
                </Field>
                <Field label="模型 ID" htmlFor="ocr-reg-model">
                  <input
                    id="ocr-reg-model"
                    className="input"
                    value={registryForm.modelId}
                    onChange={(event) =>
                      setRegistryForm({ ...registryForm, modelId: event.target.value })
                    }
                    required
                    maxLength={120}
                  />
                </Field>
                <Field
                  label="流水线"
                  htmlFor="ocr-reg-pipeline"
                  hint="可选，如 structure / enhanced"
                >
                  <input
                    id="ocr-reg-pipeline"
                    className="input"
                    value={registryForm.pipeline}
                    onChange={(event) =>
                      setRegistryForm({ ...registryForm, pipeline: event.target.value })
                    }
                    maxLength={60}
                  />
                </Field>
                <Field label="角色" htmlFor="ocr-reg-role">
                  <select
                    id="ocr-reg-role"
                    className="input"
                    value={registryForm.role}
                    onChange={(event) =>
                      setRegistryForm({
                        ...registryForm,
                        role: event.target.value as OcrRegistryRole,
                      })
                    }
                  >
                    <option value="control">控制</option>
                    <option value="candidate">候选</option>
                    <option value="rollback">回滚</option>
                  </select>
                </Field>
                <Field label="灰度模式" htmlFor="ocr-reg-mode" hint="仅候选角色生效">
                  <select
                    id="ocr-reg-mode"
                    className="input"
                    value={registryForm.mode}
                    disabled={registryForm.role !== 'candidate'}
                    onChange={(event) =>
                      setRegistryForm({ ...registryForm, mode: event.target.value as OcrGreyMode })
                    }
                  >
                    <option value="canary">灰度（按比例分流）</option>
                    <option value="shadow">影子（只记录不返回）</option>
                  </select>
                </Field>
                <Field
                  label="候选流量（%）"
                  htmlFor="ocr-reg-percent"
                  hint="仅候选角色生效，最高 99%"
                >
                  <input
                    id="ocr-reg-percent"
                    className="input"
                    type="number"
                    min={0}
                    max={99}
                    step={1}
                    value={registryForm.percent}
                    disabled={registryForm.role !== 'candidate'}
                    onChange={(event) =>
                      setRegistryForm({ ...registryForm, percent: event.target.value })
                    }
                  />
                </Field>
                <Field label="自动决策" htmlFor="ocr-reg-auto">
                  <label className="ops-lab-check">
                    <input
                      id="ocr-reg-auto"
                      type="checkbox"
                      checked={registryForm.auto}
                      onChange={(event) =>
                        setRegistryForm({ ...registryForm, auto: event.target.checked })
                      }
                    />
                    允许自动晋级/回滚
                  </label>
                </Field>
                <div className="form-span-2 ops-actions">
                  <button type="submit" className="btn btn-primary" disabled={busy !== null}>
                    {busy === 'registry:register' ? '登记中…' : '登记模型变体'}
                  </button>
                </div>
              </form>
              {registry.decisions.length > 0 ? (
                <div className="ops-lab-meta">
                  {registry.decisions.slice(0, 8).map((decision) => (
                    <span key={decision.id} title={decision.reason}>
                      {decision.actor === 'auto' ? '自动' : '人工'} ·{' '}
                      {REGISTRY_ACTION_LABEL[decision.action]} ·{' '}
                      {[decision.engine, decision.modelId, decision.pipeline]
                        .filter(Boolean)
                        .join(' / ')}
                      {decision.percent === null ? '' : ` · ${decision.percent}%`}
                    </span>
                  ))}
                  {registry.decisions.length > 8 ? (
                    <span>仅显示最近 8 条（共 {formatNumber(registry.decisions.length)} 条）</span>
                  ) : null}
                </div>
              ) : null}
              <p className="field-hint">
                注册表按 SHA-256
                桶分配灰度流量；自动晋级/回滚受最小样本与余量约束，人工固定后不再自动调整，所有决策写入审计。
              </p>
            </details>
          ) : registryError ? (
            <details className="ops-lab-groups">
              <summary>模型注册表与灰度（加载失败）</summary>
              <p className="field-hint" role="alert">
                {registryError}
              </p>
              <button
                type="button"
                className="btn btn-soft"
                onClick={() => void load()}
                disabled={loading}
              >
                重试
              </button>
            </details>
          ) : null}

          <div className="ocr-governance-ledger">
            <div className="card-head ocr-governance-subhead">
              <div>
                <h3>优化台账</h3>
                <p className="card-sub">
                  按「预期收益 / (实现成本 + 推理成本)」排序，避免同时引入多个改动后无法归因。
                </p>
              </div>
            </div>
            {optimizations.length > 0 ? (
              <div className="table-wrap">
                <table className="table">
                  <caption className="sr-only">OCR 优化台账</caption>
                  <thead>
                    <tr>
                      <th scope="col">优化项</th>
                      <th scope="col">目标错误</th>
                      <th scope="col">收益</th>
                      <th scope="col">成本</th>
                      <th scope="col">风险</th>
                      <th scope="col">得分</th>
                      <th scope="col">状态</th>
                    </tr>
                  </thead>
                  <tbody>
                    {optimizations.map((entry) => (
                      <tr key={entry.id}>
                        <td>{entry.title}</td>
                        <td>{entry.targetError}</td>
                        <td>{pct(entry.expectedGain)}</td>
                        <td>
                          {entry.implementationCost} 人日 + {entry.inferenceCost} 推理
                        </td>
                        <td>{RISK_LABEL[entry.risk]}</td>
                        <td>{entry.score.toFixed(2)}</td>
                        <td>
                          <select
                            className="input"
                            aria-label={`更新 ${entry.title} 状态`}
                            value={entry.status}
                            onChange={(event) =>
                              void updateOptimization(
                                entry.id,
                                event.target.value as OcrOptimizationStatus,
                              )
                            }
                            disabled={busy !== null}
                          >
                            {Object.entries(OPTIMIZATION_STATUS).map(([value, label]) => (
                              <option key={value} value={value}>
                                {label}
                              </option>
                            ))}
                          </select>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="muted">尚未记录优化项。</p>
            )}
            <form className="form-grid" onSubmit={createOptimization}>
              <Field label="优化项" htmlFor="ocr-opt-title">
                <input
                  id="ocr-opt-title"
                  className="input"
                  value={form.title}
                  onChange={(event) => setForm({ ...form, title: event.target.value })}
                  required
                  maxLength={200}
                />
              </Field>
              <Field label="目标错误类型" htmlFor="ocr-opt-target">
                <input
                  id="ocr-opt-target"
                  className="input"
                  value={form.targetError}
                  onChange={(event) => setForm({ ...form, targetError: event.target.value })}
                  required
                  maxLength={200}
                />
              </Field>
              <Field label="预期收益（0-1）" htmlFor="ocr-opt-gain">
                <input
                  id="ocr-opt-gain"
                  className="input"
                  type="number"
                  min={0}
                  max={1}
                  step={0.01}
                  value={form.expectedGain}
                  onChange={(event) => setForm({ ...form, expectedGain: event.target.value })}
                  required
                />
              </Field>
              <Field label="实现成本（人日）" htmlFor="ocr-opt-cost">
                <input
                  id="ocr-opt-cost"
                  className="input"
                  type="number"
                  min={0}
                  max={1000}
                  step={0.1}
                  value={form.implementationCost}
                  onChange={(event) => setForm({ ...form, implementationCost: event.target.value })}
                  required
                />
              </Field>
              <Field label="推理成本（相对）" htmlFor="ocr-opt-inference">
                <input
                  id="ocr-opt-inference"
                  className="input"
                  type="number"
                  min={0}
                  max={10}
                  step={0.01}
                  value={form.inferenceCost}
                  onChange={(event) => setForm({ ...form, inferenceCost: event.target.value })}
                  required
                />
              </Field>
              <Field label="风险" htmlFor="ocr-opt-risk">
                <select
                  id="ocr-opt-risk"
                  className="input"
                  value={form.risk}
                  onChange={(event) =>
                    setForm({ ...form, risk: event.target.value as OcrOptimizationRisk })
                  }
                >
                  <option value="low">低</option>
                  <option value="medium">中</option>
                  <option value="high">高</option>
                </select>
              </Field>
              <Field label="基准结果" htmlFor="ocr-opt-bench" hint="可选，最多 2000 字符">
                <input
                  id="ocr-opt-bench"
                  className="input"
                  value={form.benchmarkResult}
                  onChange={(event) => setForm({ ...form, benchmarkResult: event.target.value })}
                  maxLength={2000}
                />
              </Field>
              <div className="form-span-2 ops-actions">
                <button type="submit" className="btn btn-primary" disabled={busy !== null}>
                  {busy === 'optimization' ? '保存中…' : '加入台账'}
                </button>
              </div>
            </form>
          </div>
        </>
      ) : null}

      <ConfirmDialog
        open={pendingDecision !== null}
        title={pendingDecision?.action === 'retire' ? '退役模型变体' : '回退到该模型'}
        message={
          pendingDecision?.action === 'retire'
            ? `退役「${registryLabel(pendingDecision.entry)}」后，它将不再参与灰度与自动决策，历史指标仍会保留。确定继续？`
            : pendingDecision
              ? `将灰度流量切回「${registryLabel(pendingDecision.entry)}」并替换当前控制模型。确定继续？`
              : ''
        }
        confirmLabel={pendingDecision?.action === 'retire' ? '确认退役' : '确认回退'}
        busy={busy !== null}
        onCancel={() => setPendingDecision(null)}
        onConfirm={() => void confirmDecision()}
      />
    </section>
  );
}
