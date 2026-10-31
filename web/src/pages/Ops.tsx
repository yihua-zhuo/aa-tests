import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { canManageWorkspace } from '../../../shared/permissions.ts';
import type {
  FeatureFlagKey,
  OcrBenchFieldCategory,
  OcrBenchGateCheck,
  OcrBenchSplit,
  OcrBenchStatus,
  OcrChannel,
  OcrEngine,
  OcrExperimentResult,
  OcrMode,
  OpsBackup,
  OpsIntegrity,
  OpsSettings,
  UserDirectoryEntry,
} from '../../../shared/types.ts';
import { api, type OcrLabReplayResult } from '../api.ts';
import { Icon } from '../components/Icon.tsx';
import { OcrGovernancePanel } from '../components/OcrGovernancePanel.tsx';
import { ConfirmDialog, ErrorState, Field, Skeleton, Toaster } from '../components/ui.tsx';
import { formatDateTime, formatNumber } from '../format.ts';
import { useApi, useToast } from '../hooks/useApi.ts';
import { useAuth } from '../hooks/useAuth.tsx';

const FLAGS: Record<FeatureFlagKey, { label: string; description: string }> = {
  analytics: { label: '分析报表', description: '控制侧栏「分析」入口与报表导航' },
  audit_center: { label: '审计中心', description: '控制管理员审计日志页面入口' },
  webhooks: { label: 'Webhook 集成', description: '控制个人设置中的 Webhook 管理' },
  push_notifications: { label: 'Web Push', description: '控制浏览器推送通知订阅' },
  project_templates: { label: '项目模板', description: '控制「从模板创建」快捷入口' },
  enterprise: { label: '企业套件', description: '控制战略目标、组合、知识与治理工作台' },
};

const RETENTION_FIELDS: {
  key:
    | 'backupRetentionDays'
    | 'trashRetentionDays'
    | 'auditRetentionDays'
    | 'activityRetentionDays'
    | 'ocrRetentionDays';
  label: string;
  hint: string;
  min?: number;
}[] = [
  { key: 'backupRetentionDays', label: '备份保留天数', hint: '自动删除更早的快照' },
  { key: 'trashRetentionDays', label: '回收站保留天数', hint: '到期后彻底删除项目' },
  { key: 'auditRetentionDays', label: '审计日志保留天数', hint: '到期后裁剪审计记录' },
  { key: 'activityRetentionDays', label: '活动流保留天数', hint: '到期后裁剪动态' },
  {
    key: 'ocrRetentionDays',
    label: 'OCR 文本保留天数',
    hint: '到期清除识别文本、结构化结果与字段修订；0 表示永久保留',
    min: 0,
  },
];

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function benchStatusLabel(status: 'running' | 'done' | 'failed'): string {
  if (status === 'running') return '运行中';
  if (status === 'failed') return '失败';
  return '完成';
}

function benchRouteLabel(route: 'native' | 'visual' | 'hybrid' | null): string {
  if (route === 'native') return '原生';
  if (route === 'visual') return '视觉';
  if (route === 'hybrid') return '混合';
  return '—';
}

function benchQualityLabel(status: 'pass' | 'review' | 'fail' | null): string {
  if (status === 'pass') return '通过';
  if (status === 'review') return '待复核';
  if (status === 'fail') return '失败';
  return '—';
}

const MODE_LABEL: Record<OcrMode, string> = {
  auto: '自动',
  table: '表格',
  structure: '结构',
  enhanced: '增强',
};

const CHANNEL_LABEL: Record<OcrChannel, string> = {
  rgb: 'RGB',
  gray: '灰度',
  red: '红通道',
};

const STAGE_LABEL: Record<string, string> = {
  native: '原生解析',
  visual: '视觉 OCR',
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

function stageLabel(kind: string): string {
  return STAGE_LABEL[kind] ?? kind;
}

function engineLabel(engine: OcrEngine): string {
  return engine === 'docling' ? 'Docling' : 'PaddleOCR';
}

function benchDimensionLabel(
  dimension: 'kind' | 'language' | 'difficulty' | 'degradation',
): string {
  if (dimension === 'kind') return '类型';
  if (dimension === 'language') return '语言';
  if (dimension === 'difficulty') return '难度';
  return '退化类型';
}

const BENCH_GATE_LABELS: Record<string, string> = {
  cer: '总体 CER',
  numeric_cer: '数值 CER',
  symbol_cer: '关键符号 CER',
  field_accuracy_strong: '字段强命中率（位置/标签）',
  field_accuracy_lower: '字段强命中 95% 下界',
  fully_correct_lower: '文档全对率 95% 下界',
  evidence_sufficiency: '门禁证据充分性',
  pdf_evidence: 'PDF 样本证据',
  blind_evidence: '盲测样本证据',
  fully_correct: '文档全对率',
  failed_rate: '失败率',
  business_loss: '加权业务损失',
  table_structure: '表格 TEDS',
  calibration_ece: '校准 ECE',
  worst_group_cer: '最差分组 CER',
  worst_group_field_accuracy: '最差分组字段准确率',
};

function benchGateLabel(check: OcrBenchGateCheck): string {
  if (check.name.startsWith('cer:')) return `分类型 CER（${check.name.slice(4)}）`;
  if (check.name.startsWith('ece:')) return `分类型校准 ECE（${check.name.slice(4)}）`;
  if (check.name.startsWith('field_accuracy_lower:')) {
    const category = check.name.slice('field_accuracy_lower:'.length);
    return `字段准确率 95% 下界（${benchFieldCategoryLabel(category as OcrBenchFieldCategory)}）`;
  }
  const label = BENCH_GATE_LABELS[check.name] ?? check.name;
  return check.group
    ? `${label}（${benchDimensionLabel(check.group.dimension)}：${check.group.value}）`
    : label;
}

function benchEvidenceUnit(check: OcrBenchGateCheck): string {
  if (check.name.startsWith('field_accuracy')) return '个字段';
  if (check.name.startsWith('ece:') || check.name === 'calibration_ece') return '条置信样本';
  if (check.name === 'table_structure') return '张表';
  if (check.name === 'blind_evidence') return '份盲测样本';
  if (check.name === 'pdf_evidence') return '份 PDF 样本';
  return '份文档';
}

/** Count-style checks (evidence floors) must not be rendered as percentages. */
function benchGateIsCount(check: OcrBenchGateCheck): boolean {
  return (
    check.name === 'pdf_evidence' ||
    check.name === 'blind_evidence' ||
    check.name === 'evidence_sufficiency'
  );
}

function benchGateValue(check: OcrBenchGateCheck): string {
  if (benchGateIsCount(check)) return `${check.value ?? 0} 项`;
  return percent(check.value, 2);
}

function benchGateThreshold(check: OcrBenchGateCheck): string {
  if (benchGateIsCount(check)) return `${check.threshold} 项`;
  return percent(check.threshold, 2);
}

/** A rate measured on fewer observations than its threshold would need. */
function isThinGateEvidence(check: OcrBenchGateCheck): boolean {
  if (check.passed === false) return false;
  if (check.samples === undefined || check.requiredSamples == null) return false;
  return check.samples < check.requiredSamples;
}

type BenchGateVerdict = 'passed' | 'failed' | 'underpowered';

/**
 * A gate that only lacks samples is not the same as a gate that missed a
 * threshold: the first still needs a decision, the second is a regression.
 */
function benchGateVerdict(checks: OcrBenchGateCheck[]): BenchGateVerdict {
  const failed = checks.filter((check) => check.passed === false);
  if (failed.some((check) => check.name !== 'evidence_sufficiency')) return 'failed';
  return failed.length > 0 || checks.some(isThinGateEvidence) ? 'underpowered' : 'passed';
}

function benchGateVerdictLabel(verdict: BenchGateVerdict): string {
  if (verdict === 'passed') return '通过';
  return verdict === 'underpowered' ? '证据不足' : '未达标';
}

function benchReliabilityBasisLabel(basis: 'strong' | 'mixed' | 'weak'): string {
  if (basis === 'strong') return '强命中';
  return basis === 'mixed' ? '混合' : '弱命中';
}

function benchGateShortfall(check: OcrBenchGateCheck): string {
  const required = Math.ceil(check.requiredSamples ?? 0);
  return `${benchGateLabel(check)} 需 ${required} ${benchEvidenceUnit(check)}，当前 ${
    check.samples ?? 0
  }`;
}

function benchSplitLabel(split: OcrBenchSplit): string {
  switch (split) {
    case 'dev':
      return '调参集';
    case 'calibration':
      return '校准集';
    case 'blind':
      return '盲测集';
  }
}

function benchFieldCategoryLabel(category: OcrBenchFieldCategory): string {
  switch (category) {
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
    case 'currency':
      return '币种';
    default:
      return '其他';
  }
}

function percent(value: number | null, digits = 1): string {
  return value === null ? '—' : `${(value * 100).toFixed(digits)}%`;
}

function formatDuration(startedAt: string, finishedAt: string | null): string {
  if (!finishedAt) return '—';
  const seconds = (Date.parse(finishedAt) - Date.parse(startedAt)) / 1000;
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m${Math.round(seconds - minutes * 60)}s`;
}

export default function OpsPage() {
  const { user, refresh } = useAuth();
  const { toasts, show, dismiss } = useToast();
  const state = useApi((signal) => api.ops(signal), [], { live: false });
  const users = useApi(
    (signal) => api.users({ page: 1, pageSize: 50, role: 'all', status: 'all' }, signal),
    [],
    { live: false },
  );
  const [settings, setSettings] = useState<OpsSettings | null>(null);
  const [integrity, setIntegrity] = useState<OpsIntegrity | null>(null);
  const [checking, setChecking] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [restoreTarget, setRestoreTarget] = useState<OpsBackup | null>(null);
  const [demoConfirm, setDemoConfirm] = useState(false);
  const [selectedUser, setSelectedUser] = useState('');
  const [eraseTarget, setEraseTarget] = useState<UserDirectoryEntry | null>(null);
  const [bench, setBench] = useState<OcrBenchStatus | null>(null);
  const [benchError, setBenchError] = useState<string | null>(null);
  const [benchStarting, setBenchStarting] = useState(false);
  const [includePdf, setIncludePdf] = useState(true);
  const [experiment, setExperiment] = useState<OcrExperimentResult | null>(null);
  const [experimentError, setExperimentError] = useState<string | null>(null);
  const [experimentBusy, setExperimentBusy] = useState(false);
  const [experimentForm, setExperimentForm] = useState({
    engine: 'paddle' as OcrEngine,
    channels: ['rgb', 'gray', 'red'] as OcrChannel[],
    mode: 'auto' as OcrMode,
    dpi: '',
    sample: '6',
    topK: '2',
    full: true,
  });
  const [replayName, setReplayName] = useState('');
  const [replayIndex, setReplayIndex] = useState(0);
  const [replayBusy, setReplayBusy] = useState(false);
  const [replayResult, setReplayResult] = useState<OcrLabReplayResult | null>(null);
  const [replayError, setReplayError] = useState<string | null>(null);

  const status = state.data?.status;
  const canOperate = user ? canManageWorkspace(user.role, user.permissions) : false;
  const benchRunning = bench?.run?.status === 'running';
  const experimentRunning = experiment?.status === 'running';
  const failedGateChecks =
    bench?.aggregate?.gate?.checks.filter((check) => check.passed === false) ?? [];
  const thinGateChecks = bench?.aggregate?.gate?.checks.filter(isThinGateEvidence) ?? [];
  const gateVerdict = bench?.aggregate?.gate ? benchGateVerdict(bench.aggregate.gate.checks) : null;
  const benchResults = bench?.run?.results ?? [];
  const replayStages = benchResults.find((result) => result.name === replayName)?.stages ?? [];
  const replayStage = replayStages[replayIndex] ?? replayStages[0] ?? null;

  useEffect(() => {
    if (status) setSettings(status.settings);
  }, [status]);

  const loadBench = useCallback(async (signal?: AbortSignal) => {
    try {
      const result = await api.ocrLab(signal);
      setBench(result);
      setBenchError(null);
    } catch (cause) {
      if (signal?.aborted) return;
      setBenchError(cause instanceof Error ? cause.message : '加载基准状态失败');
    }
  }, []);

  const loadExperiment = useCallback(async (signal?: AbortSignal) => {
    try {
      const result = await api.ocrExperiment(signal);
      setExperiment(result);
      setExperimentError(null);
    } catch (cause) {
      if (signal?.aborted) return;
      setExperimentError(cause instanceof Error ? cause.message : '加载对照实验失败');
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void loadBench(controller.signal);
    void loadExperiment(controller.signal);
    return () => controller.abort();
  }, [loadBench, loadExperiment]);

  useEffect(() => {
    if (!benchRunning) return;
    const timer = window.setInterval(() => void loadBench(), 3_000);
    return () => window.clearInterval(timer);
  }, [benchRunning, loadBench]);

  useEffect(() => {
    if (!experimentRunning) return;
    const timer = window.setInterval(() => void loadExperiment(), 3_000);
    return () => window.clearInterval(timer);
  }, [experimentRunning, loadExperiment]);

  useEffect(() => {
    if (benchResults.length === 0) return;
    if (replayName && benchResults.some((result) => result.name === replayName)) return;
    const first = benchResults[0];
    if (!first) return;
    setReplayName(first.name);
    setReplayIndex(0);
  }, [benchResults, replayName]);

  useEffect(() => {
    if (replayIndex < replayStages.length) return;
    setReplayIndex(0);
  }, [replayStages.length, replayIndex]);

  useEffect(() => {
    if (users.data && users.data.users.length > 0 && !selectedUser) {
      setSelectedUser(users.data.users[0]!.id);
    }
  }, [users.data, selectedUser]);

  if (!canOperate) return <ErrorState message="只有工作区管理员可以访问运维面板。" />;

  if (state.error && !status) {
    return <ErrorState message={state.error} onRetry={state.reload} />;
  }

  if (!status || !settings) {
    return (
      <div className="page ops-page">
        <div className="ops-skeleton">
          <Skeleton height={140} />
          <Skeleton height={260} />
          <Skeleton height={200} />
        </div>
      </div>
    );
  }

  const runIntegrity = async () => {
    setChecking(true);
    try {
      const result = await api.opsIntegrity();
      setIntegrity(result.integrity);
      show(
        result.integrity.ok ? '数据库完整性检查通过' : '完整性检查发现问题',
        result.integrity.ok ? 'success' : 'error',
      );
    } catch (cause) {
      show(cause instanceof Error ? cause.message : '完整性检查失败', 'error');
    } finally {
      setChecking(false);
    }
  };

  const saveRetention = async (event: FormEvent) => {
    event.preventDefault();
    setBusy('retention');
    try {
      const result = await api.updateOpsSettings({
        backupRetentionDays: settings.backupRetentionDays,
        trashRetentionDays: settings.trashRetentionDays,
        auditRetentionDays: settings.auditRetentionDays,
        activityRetentionDays: settings.activityRetentionDays,
        ocrRetentionDays: settings.ocrRetentionDays,
      });
      setSettings(result.settings);
      show('保留期已更新，将在下一次备份任务中生效');
      state.reload();
    } catch (cause) {
      show(cause instanceof Error ? cause.message : '保存失败', 'error');
    } finally {
      setBusy(null);
    }
  };

  const createBackup = async () => {
    setBusy('backup');
    try {
      const result = await api.createBackup();
      show(`已创建备份 ${result.backup.name}`);
      state.reload();
    } catch (cause) {
      show(cause instanceof Error ? cause.message : '创建备份失败', 'error');
    } finally {
      setBusy(null);
    }
  };

  const stageRestore = async () => {
    if (!restoreTarget) return;
    setBusy('restore');
    try {
      const result = await api.stageRestore(restoreTarget.name);
      show(result.message);
      setRestoreTarget(null);
      state.reload();
    } catch (cause) {
      show(cause instanceof Error ? cause.message : '恢复失败', 'error');
    } finally {
      setBusy(null);
    }
  };

  const toggleFlag = async (key: FeatureFlagKey, enabled: boolean) => {
    setBusy(`flag:${key}`);
    try {
      await api.setFeature(key, enabled);
      show(`${FLAGS[key].label}已${enabled ? '启用' : '停用'}`);
      state.reload();
      await refresh();
    } catch (cause) {
      show(cause instanceof Error ? cause.message : '切换失败', 'error');
    } finally {
      setBusy(null);
    }
  };

  const setDemoData = async (enabled: boolean) => {
    setBusy('demo');
    try {
      const result = await api.toggleDemoData(enabled);
      show(
        enabled
          ? `已生成 ${result.demo.projects} 个演示项目`
          : `已清除 ${result.removed} 个演示项目`,
      );
      setDemoConfirm(false);
      state.reload();
    } catch (cause) {
      show(cause instanceof Error ? cause.message : '切换演示数据失败', 'error');
    } finally {
      setBusy(null);
    }
  };

  const eraseUser = async () => {
    if (!eraseTarget) return;
    setBusy('erase');
    try {
      await api.eraseUser(eraseTarget.id);
      show(`已匿名化 ${eraseTarget.name} 的个人数据`);
      setEraseTarget(null);
      state.reload();
      users.reload();
    } catch (cause) {
      show(cause instanceof Error ? cause.message : '删除失败', 'error');
    } finally {
      setBusy(null);
    }
  };

  const startBench = async () => {
    setBenchStarting(true);
    try {
      const result = await api.runOcrLab(includePdf);
      setBench(result);
      setBenchError(null);
      show('OCR 基准测试已开始');
    } catch (cause) {
      show(cause instanceof Error ? cause.message : '启动基准测试失败', 'error');
    } finally {
      setBenchStarting(false);
    }
  };

  const toggleChannel = (channel: OcrChannel) => {
    setExperimentForm((current) => ({
      ...current,
      channels: current.channels.includes(channel)
        ? current.channels.filter((value) => value !== channel)
        : [...current.channels, channel],
    }));
  };

  const startExperiment = async () => {
    if (experimentForm.channels.length === 0) {
      show('至少选择一个通道', 'error');
      return;
    }
    const dpi = experimentForm.dpi.trim() === '' ? null : Number(experimentForm.dpi);
    if (dpi !== null && (!Number.isFinite(dpi) || dpi < 100 || dpi > 400)) {
      show('DPI 必须是 100-400 之间的数字', 'error');
      return;
    }
    setExperimentBusy(true);
    try {
      const variants = experimentForm.channels.map((channel) => ({
        engine: experimentForm.engine,
        mode: experimentForm.mode,
        channel,
        dpi: dpi ?? undefined,
        label: `${experimentForm.engine} ${CHANNEL_LABEL[channel]} ${MODE_LABEL[experimentForm.mode]}`,
      }));
      const result = await api.startOcrExperiment({
        variants,
        includePdf,
        sample: Math.max(1, Math.floor(Number(experimentForm.sample) || 6)),
        topK: Math.max(1, Math.floor(Number(experimentForm.topK) || 2)),
        full: experimentForm.full,
      });
      setExperiment(result);
      setExperimentError(null);
      show('OCR 对照实验已开始');
    } catch (cause) {
      show(cause instanceof Error ? cause.message : '启动对照实验失败', 'error');
    } finally {
      setExperimentBusy(false);
    }
  };

  const runReplay = async () => {
    if (!replayName || !replayStage) return;
    const index = replayStages[replayIndex] ? replayIndex : 0;
    const occurrence =
      replayStages.slice(0, index + 1).filter((stage) => stage.kind === replayStage.kind).length ||
      1;
    setReplayBusy(true);
    try {
      const result = await api.replayOcrLab({
        name: replayName,
        kind: replayStage.kind,
        occurrence,
      });
      setReplayResult(result);
      setReplayError(null);
    } catch (cause) {
      setReplayResult(null);
      setReplayError(cause instanceof Error ? cause.message : '阶段重放失败');
    } finally {
      setReplayBusy(false);
    }
  };

  const target = users.data?.users.find((entry) => entry.id === selectedUser) ?? null;

  return (
    <div className="page ops-page">
      <header className="page-head">
        <div className="page-head-copy">
          <p className="eyebrow">Ops</p>
          <h1>运维面板</h1>
          <p className="page-sub">
            备份与恢复、数据库完整性、数据保留期、演示数据、功能开关与 GDPR 数据操作集中在这里。
          </p>
        </div>
        <div className="page-head-actions">
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => {
              state.reload();
              void loadBench();
              void loadExperiment();
            }}
          >
            <Icon name="refresh" size={16} />
            刷新
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void runIntegrity()}
            disabled={checking}
          >
            <Icon name="shield" size={16} />
            {checking ? '检查中…' : '检查完整性'}
          </button>
        </div>
      </header>

      <section className="card card-pad ops-summary">
        <div className="ops-metrics">
          <div className="ops-metric">
            <span className="stat-label">数据库状态</span>
            <strong className={status.healthy ? 'status-text is-active' : 'status-text is-danger'}>
              {status.healthy ? '正常' : '异常'}
            </strong>
            <small>
              SQLite {status.sqliteVersion} · schema v{status.schemaVersion}
            </small>
          </div>
          <div className="ops-metric">
            <span className="stat-label">数据库大小</span>
            <strong>{formatBytes(status.databaseBytes)}</strong>
            <small>含 WAL 文件</small>
          </div>
          <div className="ops-metric">
            <span className="stat-label">备份数量</span>
            <strong>{formatNumber(status.backups.length)}</strong>
            <small>{status.backupDir}</small>
          </div>
          <div className="ops-metric">
            <span className="stat-label">数据量</span>
            <strong>{formatNumber(status.counts.projects)} 项目</strong>
            <small>
              {formatNumber(status.counts.users)} 成员 · {formatNumber(status.counts.activities)}{' '}
              动态
            </small>
          </div>
        </div>
        {integrity ? (
          <div className={`ops-integrity ${integrity.ok ? 'is-ok' : 'is-bad'}`} role="status">
            <Icon name={integrity.ok ? 'check' : 'alert'} size={18} />
            <div>
              <strong>{integrity.ok ? '完整性检查通过' : '完整性检查失败'}</strong>
              <p>{integrity.messages.join('；')}</p>
              <small>{formatDateTime(integrity.checkedAt)}</small>
            </div>
          </div>
        ) : null}
        {status.pendingRestore ? (
          <div className="ops-integrity is-warn" role="status">
            <Icon name="alert" size={18} />
            <div>
              <strong>有排队中的恢复任务</strong>
              <p>重启服务后将用备份替换当前数据库，原数据库会保留为 .pre-restore-*.bak。</p>
            </div>
          </div>
        ) : null}
      </section>

      <div className="settings-grid">
        <div className="settings-column">
          <section className="card card-pad">
            <header className="card-head">
              <div>
                <h2>备份与恢复</h2>
                <p className="card-sub">
                  快照使用 VACUUM INTO，可在写入过程中安全执行；恢复需要重启服务。
                </p>
              </div>
              <Icon name="database" size={20} />
            </header>
            <div className="ops-actions">
              <button
                type="button"
                className="btn btn-soft"
                onClick={() => void createBackup()}
                disabled={busy === 'backup'}
              >
                <Icon name="download" size={16} />
                {busy === 'backup' ? '备份中…' : '立即备份'}
              </button>
            </div>
            {status.backups.length === 0 ? (
              <p className="muted">还没有备份文件。</p>
            ) : (
              <div className="table-wrap">
                <table className="table ops-backups">
                  <caption className="sr-only">可用备份</caption>
                  <thead>
                    <tr>
                      <th scope="col">文件</th>
                      <th scope="col">大小</th>
                      <th scope="col">创建时间</th>
                      <th scope="col">操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {status.backups.map((backup) => (
                      <tr key={backup.name}>
                        <td>
                          <code>{backup.name}</code>
                        </td>
                        <td>{formatBytes(backup.sizeBytes)}</td>
                        <td>{formatDateTime(backup.createdAt)}</td>
                        <td>
                          <button
                            type="button"
                            className="btn btn-ghost btn-xs"
                            onClick={() => setRestoreTarget(backup)}
                          >
                            恢复
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="card card-pad">
            <header className="card-head">
              <div>
                <h2>数据保留期</h2>
                <p className="card-sub">
                  每日备份任务会按这里的期限裁剪备份、回收站、审计日志、活动流与 OCR 文本；期限为 0
                  的 OCR 项表示永久保留。
                </p>
              </div>
              <Icon name="clock" size={20} />
            </header>
            <form className="form-grid" onSubmit={saveRetention}>
              {RETENTION_FIELDS.map((field) => (
                <Field
                  key={field.key}
                  label={field.label}
                  htmlFor={`ops-${field.key}`}
                  hint={field.hint}
                >
                  <input
                    id={`ops-${field.key}`}
                    className="input"
                    type="number"
                    min={field.min ?? 1}
                    max={3650}
                    required
                    value={settings[field.key]}
                    onChange={(event) =>
                      setSettings({ ...settings, [field.key]: Number(event.target.value) })
                    }
                  />
                </Field>
              ))}
              <div className="form-span-2 ops-actions">
                <button type="submit" className="btn btn-primary" disabled={busy === 'retention'}>
                  {busy === 'retention' ? '保存中…' : '保存保留期'}
                </button>
              </div>
            </form>
          </section>

          <section className="card card-pad">
            <header className="card-head">
              <div>
                <h2>演示数据</h2>
                <p className="card-sub">
                  演示项目用于产品展示；关闭会删除所有 is_demo 项目，重新开启会按内置模板重建。
                </p>
              </div>
              <Icon name="spark" size={20} />
            </header>
            <div className="ops-toggle-row">
              <div>
                <strong>{status.demo.enabled ? '演示数据已开启' : '演示数据已关闭'}</strong>
                <p className="muted">
                  {formatNumber(status.demo.projects)} 个演示项目 ·{' '}
                  {formatNumber(status.demo.users)} 个演示账号
                </p>
              </div>
              <button
                type="button"
                className={`btn ${status.demo.enabled ? 'btn-ghost' : 'btn-primary'}`}
                onClick={() => {
                  if (status.demo.enabled) setDemoConfirm(true);
                  else void setDemoData(true);
                }}
                disabled={busy === 'demo'}
              >
                {status.demo.enabled ? '清除演示数据' : '生成演示数据'}
              </button>
            </div>
          </section>
        </div>

        <div className="settings-column">
          <section className="card card-pad">
            <header className="card-head">
              <div>
                <h2>功能开关</h2>
                <p className="card-sub">停用后对应入口立即从导航与设置中隐藏，接口保持可用。</p>
              </div>
              <Icon name="settings" size={20} />
            </header>
            <ul className="ops-flags">
              {status.features.map((flag) => {
                const meta = FLAGS[flag.key];
                return (
                  <li key={flag.key}>
                    <label className="ops-flag">
                      <input
                        type="checkbox"
                        checked={flag.enabled}
                        disabled={busy === `flag:${flag.key}`}
                        onChange={(event) => void toggleFlag(flag.key, event.target.checked)}
                      />
                      <span>
                        <strong>{meta.label}</strong>
                        <small>{meta.description}</small>
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          </section>

          <section className="card card-pad">
            <header className="card-head">
              <div>
                <h2>GDPR 数据操作</h2>
                <p className="card-sub">
                  导出成员的全部个人数据；删除会匿名化账号并撤销会话、令牌与集成，且不可撤销。
                </p>
              </div>
              <Icon name="users" size={20} />
            </header>
            <Field label="选择成员" htmlFor="ops-gdpr-user">
              <select
                id="ops-gdpr-user"
                className="input"
                value={selectedUser}
                onChange={(event) => setSelectedUser(event.target.value)}
              >
                {(users.data?.users ?? []).map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.name} · {entry.email}
                    {entry.status === 'disabled' ? '（已停用）' : ''}
                  </option>
                ))}
              </select>
            </Field>
            {users.error ? <p className="field-hint">成员列表加载失败：{users.error}</p> : null}
            <div className="ops-actions">
              <a
                className={`btn btn-ghost${target ? '' : ' is-disabled'}`}
                href={target ? api.exportUserUrl(target.id) : undefined}
                download
                aria-disabled={!target}
                onClick={(event) => {
                  if (!target) event.preventDefault();
                }}
              >
                <Icon name="download" size={16} />
                导出 JSON
              </a>
              <button
                type="button"
                className="btn btn-danger"
                disabled={!target || target.id === user?.id}
                onClick={() => target && setEraseTarget(target)}
              >
                <Icon name="trash" size={16} />
                匿名化删除
              </button>
            </div>
            <p className="field-hint">会话与令牌会立即失效；成员创建的项目会转移给当前管理员。</p>
          </section>
        </div>
      </div>

      <section className="card card-pad ops-lab">
        <header className="card-head">
          <div>
            <h2>OCR 准确率基准</h2>
            <p className="card-sub">
              回放 benchmarks/ocr 样本，统计字符错误率（CER）、保留大小写/标点/词边界的原始
              CER，以及关键词召回；全部在本机 OCR 服务上运行。
            </p>
          </div>
          <Icon name="trend" size={20} />
        </header>
        {!bench ? (
          benchError ? (
            <div className="ops-integrity is-warn" role="alert">
              <Icon name="alert" size={18} />
              <div>
                <strong>基准状态加载失败</strong>
                <p>{benchError}</p>
                <button
                  type="button"
                  className="btn btn-soft btn-sm"
                  onClick={() => void loadBench()}
                >
                  重试
                </button>
              </div>
            </div>
          ) : (
            <Skeleton height={120} />
          )
        ) : !bench.available ? (
          <p className="muted">
            未配置本地 OCR 服务，设置 OCR_PADDLE_URL 或 OCR_DOCLING_URL 后可用。
          </p>
        ) : (
          <>
            {benchError ? (
              <p className="field-hint" role="status">
                刷新失败：{benchError}（显示最近一次成功加载的数据）
              </p>
            ) : null}
            <div className="ops-lab-meta">
              <span>{bench.files.length} 个样本 · 默认包含 PDF</span>
              <span>
                语料：<code>{bench.corpusDir}</code>
              </span>
              {Object.entries(bench.models).map(([engine, model]) => (
                <span key={engine}>
                  {engine}：{model || '模型未就绪'}
                </span>
              ))}
            </div>
            <div className="ops-actions">
              <label className="ops-lab-check">
                <input
                  type="checkbox"
                  checked={includePdf}
                  onChange={(event) => setIncludePdf(event.target.checked)}
                  disabled={benchRunning}
                />
                包含 PDF（较慢）
              </label>
              <button
                type="button"
                className="btn btn-soft"
                onClick={() => void startBench()}
                disabled={benchRunning || benchStarting || bench.files.length === 0}
              >
                <Icon name="refresh" size={16} />
                {benchRunning ? '运行中…' : benchStarting ? '启动中…' : '运行基准'}
              </button>
            </div>
            {bench.run ? (
              <>
                <p className="ocr-meta">
                  {bench.run.status === 'running'
                    ? '正在运行'
                    : bench.run.status === 'failed'
                      ? '运行失败'
                      : '最近一次运行'}
                  {' · '}
                  {bench.run.completed}/{bench.run.total} 完成
                  {bench.run.current ? ` · 当前 ${bench.run.current}` : ''}
                  {bench.run.includePdf ? ' · 含 PDF' : ''}
                  {bench.run.finishedAt ? ` · ${formatDateTime(bench.run.finishedAt)}` : ''}
                </p>
                {bench.run.error ? <p className="field-hint">失败原因：{bench.run.error}</p> : null}
                {bench.aggregate ? (
                  <div className="ops-lab-aggregate">
                    <div className="ops-lab-meta">
                      <span
                        className={`ops-lab-status ${
                          gateVerdict === 'passed'
                            ? 'is-done'
                            : gateVerdict === 'underpowered'
                              ? 'is-thin'
                              : gateVerdict === 'failed'
                                ? 'is-failed'
                                : ''
                        }`}
                      >
                        发布门禁：{gateVerdict ? benchGateVerdictLabel(gateVerdict) : '未评估'}
                      </span>
                      <span>
                        评估 {bench.aggregate.evaluated}/{bench.aggregate.files} 个样本 · 文档{' '}
                        {bench.aggregate.documents} · 页 {bench.aggregate.pages} · 字符{' '}
                        {formatNumber(bench.aggregate.characters)} · 失败 {bench.aggregate.failed}
                      </span>
                      <span>CER {percent(bench.aggregate.cer, 2)}</span>
                      <span>原始 CER {percent(bench.aggregate.rawCer, 2)}</span>
                      <span>数值 CER {percent(bench.aggregate.numericCer, 2)}</span>
                      <span>关键符号 CER {percent(bench.aggregate.symbolCer, 2)}</span>
                      <span>WER {percent(bench.aggregate.wer, 2)}</span>
                      <span>
                        字段弱命中{' '}
                        {bench.aggregate.fieldAccuracy
                          ? `${percent(bench.aggregate.fieldAccuracy.rate, 1)} (${bench.aggregate.fieldAccuracy.hit}/${bench.aggregate.fieldAccuracy.total}，95% CI ${percent(bench.aggregate.fieldAccuracy.interval[0], 1)}–${percent(bench.aggregate.fieldAccuracy.interval[1], 1)})`
                          : '—'}
                      </span>
                      <span>
                        字段强命中{' '}
                        {bench.aggregate.fieldStrong
                          ? `${percent(bench.aggregate.fieldStrong.rate, 1)} (${bench.aggregate.fieldStrong.hit}/${bench.aggregate.fieldStrong.total}，95% CI ${percent(bench.aggregate.fieldStrong.interval[0], 1)}–${percent(bench.aggregate.fieldStrong.interval[1], 1)})${
                              (bench.aggregate.fieldStrong.unverifiable ?? 0) > 0
                                ? `，另有 ${bench.aggregate.fieldStrong.unverifiable} 个字段无法定位未计入`
                                : ''
                            }`
                          : '—'}
                      </span>
                      <span>
                        精确字段{' '}
                        {bench.aggregate.fieldExact
                          ? `${percent(bench.aggregate.fieldExact.rate, 1)} (${bench.aggregate.fieldExact.hit}/${bench.aggregate.fieldExact.total}，95% CI ${percent(bench.aggregate.fieldExact.interval[0], 1)}–${percent(bench.aggregate.fieldExact.interval[1], 1)})`
                          : '—'}
                      </span>
                      <span>
                        全对率{' '}
                        {bench.aggregate.fullyCorrect
                          ? `${percent(bench.aggregate.fullyCorrect.rate, 1)} (${bench.aggregate.fullyCorrect.hit}/${bench.aggregate.fullyCorrect.total}，95% CI ${percent(bench.aggregate.fullyCorrect.interval[0], 1)}–${percent(bench.aggregate.fullyCorrect.interval[1], 1)})`
                          : '—'}
                      </span>
                      <span>
                        校准 ECE {percent(bench.aggregate.calibration.ece, 1)} · Brier{' '}
                        {bench.aggregate.calibration.brier === null
                          ? '—'
                          : bench.aggregate.calibration.brier.toFixed(3)}
                      </span>
                      <span>
                        业务损失{' '}
                        {bench.aggregate.businessLoss
                          ? percent(bench.aggregate.businessLoss.rate, 1)
                          : '—'}
                      </span>
                      <span>
                        表格{' '}
                        {bench.aggregate.tableStructure
                          ? `TEDS ${percent(bench.aggregate.tableStructure.teds, 1)} · 行 F1 ${percent(bench.aggregate.tableStructure.rowsF1, 1)} · 单元格 ${percent(bench.aggregate.tableStructure.cellAccuracy, 1)} · ${bench.aggregate.tableStructure.tables} 表`
                          : '—'}
                      </span>
                    </div>
                    <p className="field-hint">
                      语料切分：
                      {bench.aggregate.splits.every((item) => item.files === 0)
                        ? ' 未标注集合，门禁在全部样本上判定'
                        : bench.aggregate.splits
                            .map(
                              (item) =>
                                `${benchSplitLabel(item.split)} ${item.files} 份（评估 ${item.evaluated}${
                                  item.gateSplit
                                    ? ` · CER ${percent(item.cer, 2)} · 门禁判定集`
                                    : ''
                                }）`,
                            )
                            .join(' · ')}
                    </p>
                    {bench.aggregate.gate ? (
                      <details className="ops-lab-groups">
                        <summary>
                          门禁检查（{bench.aggregate.gate.checks.length} 项
                          {gateVerdict === 'failed'
                            ? `，${
                                failedGateChecks.filter(
                                  (check) => check.name !== 'evidence_sufficiency',
                                ).length
                              } 项未通过`
                            : gateVerdict === 'underpowered'
                              ? '，证据不足'
                              : '，全部通过'}
                          {thinGateChecks.length > 0 ? `，${thinGateChecks.length} 项需补样本` : ''}
                          ）
                        </summary>
                        {failedGateChecks.length > 0 ? (
                          <p className="field-hint" role="alert">
                            未通过：
                            {failedGateChecks
                              .map(
                                (check) =>
                                  `${benchGateLabel(check)} ${benchGateValue(check)} ${
                                    check.comparison === 'max' ? '>' : '<'
                                  } ${benchGateThreshold(check)}${check.note ? `（${check.note}）` : ''}`,
                              )
                              .join(' · ')}
                          </p>
                        ) : null}
                        {thinGateChecks.length > 0 ? (
                          <p className="field-hint">
                            {failedGateChecks.length === 0 ? '指标全部达标，但' : '此外，'}
                            以下指标样本量不足以支撑结论，需补充样本后再判定：
                            {thinGateChecks.map(benchGateShortfall).join(' · ')}
                          </p>
                        ) : null}
                        <ul className="ops-gate-list">
                          {bench.aggregate.gate.checks.map((check, index) => (
                            <li
                              key={`${check.name}-${check.group?.dimension ?? ''}-${
                                check.group?.value ?? ''
                              }-${index}`}
                              className={
                                check.passed === false
                                  ? 'is-failed'
                                  : check.passed === null
                                    ? 'is-unevaluated'
                                    : isThinGateEvidence(check)
                                      ? 'is-thin'
                                      : ''
                              }
                            >
                              <span>{benchGateLabel(check)}</span>
                              <span>
                                {benchGateValue(check)}{' '}
                                {check.comparison === 'max'
                                  ? check.passed === false
                                    ? '>'
                                    : '≤'
                                  : check.passed === false
                                    ? '<'
                                    : '≥'}{' '}
                                {benchGateThreshold(check)}
                              </span>
                              <span>
                                {check.passed === null
                                  ? isThinGateEvidence(check)
                                    ? '证据不足'
                                    : '未评估'
                                  : check.passed
                                    ? isThinGateEvidence(check)
                                      ? '通过但证据不足'
                                      : '通过'
                                    : '未通过'}
                                {isThinGateEvidence(check)
                                  ? ` · 样本 ${check.samples}，需 ${Math.ceil(
                                      check.requiredSamples ?? 0,
                                    )}`
                                  : ''}
                                {check.note ? ` · ${check.note}` : ''}
                              </span>
                            </li>
                          ))}
                        </ul>
                      </details>
                    ) : null}
                    <p className="field-hint">
                      错误分类：替换 {bench.aggregate.errors.substitutions} · 插入{' '}
                      {bench.aggregate.errors.insertions} · 删除 {bench.aggregate.errors.deletions}{' '}
                      · 缺失字段 {bench.aggregate.errors.missingFields}
                      {bench.aggregate.errors.top.length > 0
                        ? ` · ${bench.aggregate.errors.top
                            .map(
                              (item) =>
                                `${item.type}×${item.count}${
                                  item.samples.length > 0 ? `（${item.samples.join('、')}）` : ''
                                }`,
                            )
                            .join(' · ')}`
                        : ''}
                    </p>
                    {bench.aggregate.groups.length > 0 ? (
                      <details className="ops-lab-groups">
                        <summary>分层结果（{bench.aggregate.groups.length} 组）</summary>
                        <div className="table-wrap">
                          <table className="table">
                            <caption className="sr-only">OCR 基准分层结果</caption>
                            <thead>
                              <tr>
                                <th scope="col">维度</th>
                                <th scope="col">分组</th>
                                <th scope="col">样本</th>
                                <th scope="col">页</th>
                                <th scope="col">失败</th>
                                <th scope="col">CER</th>
                                <th scope="col">字段</th>
                                <th scope="col">字段样本</th>
                                <th scope="col">全对</th>
                              </tr>
                            </thead>
                            <tbody>
                              {bench.aggregate.groups.map((group) => (
                                <tr key={`${group.dimension}:${group.value}`}>
                                  <td>{benchDimensionLabel(group.dimension)}</td>
                                  <td>{group.value}</td>
                                  <td>{group.files}</td>
                                  <td>{group.pages}</td>
                                  <td>{group.failed}</td>
                                  <td>{percent(group.cer, 2)}</td>
                                  <td>{percent(group.fieldAccuracy, 1)}</td>
                                  <td>{group.fieldTotal ?? 0}</td>
                                  <td>{percent(group.fullyCorrectRate, 1)}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </details>
                    ) : null}
                    {bench.aggregate.calibrationGroups.length > 0 ? (
                      <details className="ops-lab-groups">
                        <summary>分组校准（{bench.aggregate.calibrationGroups.length} 组）</summary>
                        <div className="table-wrap">
                          <table className="table">
                            <caption className="sr-only">OCR 基准分组校准</caption>
                            <thead>
                              <tr>
                                <th scope="col">维度</th>
                                <th scope="col">分组</th>
                                <th scope="col">样本</th>
                                <th scope="col">ECE</th>
                                <th scope="col">Brier</th>
                              </tr>
                            </thead>
                            <tbody>
                              {bench.aggregate.calibrationGroups.map((group) => (
                                <tr key={`${group.dimension}:${group.value}`}>
                                  <td>{benchDimensionLabel(group.dimension)}</td>
                                  <td>{group.value}</td>
                                  <td>{group.calibration.samples}</td>
                                  <td>{percent(group.calibration.ece, 1)}</td>
                                  <td>
                                    {group.calibration.brier === null
                                      ? '—'
                                      : group.calibration.brier.toFixed(3)}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </details>
                    ) : null}
                    {bench.aggregate.fieldReliability.length > 0 ? (
                      <details className="ops-lab-groups">
                        <summary>
                          字段类别可靠性（{bench.aggregate.fieldReliability.length} 类）
                        </summary>
                        <div className="table-wrap">
                          <table className="table">
                            <caption className="sr-only">OCR 基准字段类别可靠性</caption>
                            <thead>
                              <tr>
                                <th scope="col">类别</th>
                                <th scope="col">样本</th>
                                <th scope="col">命中</th>
                                <th scope="col">口径</th>
                                <th scope="col">准确率</th>
                                <th scope="col">95% CI</th>
                                <th scope="col">ECE</th>
                                <th scope="col">Brier</th>
                              </tr>
                            </thead>
                            <tbody>
                              {bench.aggregate.fieldReliability.map((entry) => (
                                <tr key={entry.category}>
                                  <td>{benchFieldCategoryLabel(entry.category)}</td>
                                  <td>{entry.samples}</td>
                                  <td>{entry.hit}</td>
                                  <td
                                    title={`${entry.localized}/${entry.samples} 条判定可定位到页面区域或同块标签`}
                                  >
                                    {benchReliabilityBasisLabel(entry.basis)}（{entry.localized}/
                                    {entry.samples} 可定位）
                                  </td>
                                  <td>{percent(entry.accuracy, 1)}</td>
                                  <td>
                                    {entry.interval
                                      ? `${percent(entry.interval[0], 1)}–${percent(entry.interval[1], 1)}`
                                      : '—'}
                                  </td>
                                  <td>{percent(entry.calibration.ece, 1)}</td>
                                  <td>
                                    {entry.calibration.brier === null
                                      ? '—'
                                      : entry.calibration.brier.toFixed(3)}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </details>
                    ) : null}
                  </div>
                ) : null}
                {bench.run.results.length > 0 ? (
                  <div className="table-wrap">
                    <table className="table ops-lab-results">
                      <caption className="sr-only">OCR 基准结果</caption>
                      <thead>
                        <tr>
                          <th scope="col">样本</th>
                          <th scope="col">引擎</th>
                          <th scope="col">模型</th>
                          <th scope="col">路由</th>
                          <th scope="col">质量</th>
                          <th scope="col">耗时</th>
                          <th scope="col">字符</th>
                          <th scope="col">置信度</th>
                          <th scope="col">CER</th>
                          <th scope="col">原始 CER</th>
                          <th scope="col">数值 CER</th>
                          <th scope="col">关键符号 CER</th>
                          <th scope="col">WER</th>
                          <th scope="col">关键词</th>
                          <th scope="col">字段（弱/强/精确）</th>
                          <th scope="col">全对</th>
                          <th scope="col">业务损失</th>
                          <th scope="col">表格结构</th>
                          <th scope="col">错误</th>
                        </tr>
                      </thead>
                      <tbody>
                        {bench.run.results.map((result) => (
                          <tr key={result.name}>
                            <td>
                              {result.name}
                              {result.truncated ? '（截断）' : ''}
                              {result.lang ||
                              result.difficulty ||
                              result.split ||
                              result.degradations.length > 0 ? (
                                <small className="ops-lab-sample-meta">
                                  {[
                                    result.lang,
                                    result.difficulty,
                                    result.split ? benchSplitLabel(result.split) : null,
                                    result.degradations.length > 0
                                      ? result.degradations.join('+')
                                      : null,
                                    result.provenance?.annotator
                                      ? `标注 ${result.provenance.annotator}`
                                      : null,
                                    result.hashVerified === true
                                      ? '哈希✓'
                                      : result.hashVerified === false
                                        ? '哈希✗'
                                        : result.sha256
                                          ? `#${result.sha256.slice(0, 8)}`
                                          : null,
                                    result.uncertain.length > 0
                                      ? `存疑 ${result.uncertain.join(',')}`
                                      : null,
                                  ]
                                    .filter(Boolean)
                                    .join(' · ')}
                                </small>
                              ) : null}
                              {result.error ? (
                                <small className="ops-lab-error">{result.error}</small>
                              ) : null}
                            </td>
                            <td>{result.engine}</td>
                            <td>{result.model ?? '—'}</td>
                            <td>
                              {benchRouteLabel(result.route)}
                              {result.stages.length > 1 ? ` · ${result.stages.length} 步` : ''}
                            </td>
                            <td
                              className={result.qualityStatus ? `is-${result.qualityStatus}` : ''}
                            >
                              {result.qualityScore === null
                                ? '—'
                                : `${Math.round(result.qualityScore * 100)}% ${benchQualityLabel(
                                    result.qualityStatus,
                                  )}`}
                            </td>
                            <td>{result.seconds}s</td>
                            <td>{formatNumber(result.characters)}</td>
                            <td>
                              {result.confidence === null
                                ? '—'
                                : `${(result.confidence * 100).toFixed(1)}%`}
                            </td>
                            <td>
                              {result.cer === null ? '—' : `${(result.cer * 100).toFixed(2)}%`}
                            </td>
                            <td>
                              {result.rawCer === null
                                ? '—'
                                : `${(result.rawCer * 100).toFixed(2)}%`}
                            </td>
                            <td>
                              {result.numericCer === null
                                ? '—'
                                : `${(result.numericCer * 100).toFixed(2)}%`}
                            </td>
                            <td>
                              {result.symbolCer === null
                                ? '—'
                                : `${(result.symbolCer * 100).toFixed(2)}%`}
                            </td>
                            <td>{percent(result.wer, 2)}</td>
                            <td>
                              {result.keywordRecall
                                ? `${result.keywordRecall.hit}/${result.keywordRecall.total}`
                                : '—'}
                            </td>
                            <td
                              title={
                                result.fieldStrong && (result.fieldStrong.unverifiable ?? 0) > 0
                                  ? `强命中另有 ${result.fieldStrong.unverifiable} 个字段缺少位置证据，未计入 ${result.fieldStrong.total} 个可测字段`
                                  : undefined
                              }
                            >
                              {result.fieldAccuracy ? percent(result.fieldAccuracy.rate, 0) : '—'}
                              {result.fieldStrong
                                ? ` / ${percent(result.fieldStrong.rate, 0)}${
                                    (result.fieldStrong.unverifiable ?? 0) > 0
                                      ? `（${result.fieldStrong.unverifiable} 不可核）`
                                      : ''
                                  }`
                                : ''}
                              {result.fieldExact ? ` / ${percent(result.fieldExact.rate, 0)}` : ''}
                            </td>
                            <td>
                              {result.fullyCorrect === null ? '—' : result.fullyCorrect ? '✓' : '✗'}
                            </td>
                            <td>
                              {result.businessLoss ? percent(result.businessLoss.rate, 1) : '—'}
                            </td>
                            <td>
                              {result.tableMetrics
                                ? `TEDS ${percent(result.tableMetrics.teds, 1)} · 行 ${percent(
                                    result.tableMetrics.rowsF1,
                                    1,
                                  )} · 单元格 ${percent(result.tableMetrics.cellAccuracy, 1)}`
                                : '—'}
                            </td>
                            <td>
                              {result.errors && result.errors.types.length > 0
                                ? result.errors.types.join('、')
                                : '—'}
                              {result.confusions?.spans && result.confusions.spans.length > 0 ? (
                                <details className="ops-lab-spans">
                                  <summary>
                                    {`字符定位 ${result.confusions.spans.length} 处`}
                                  </summary>
                                  <ul>
                                    {result.confusions.spans.map((span, index) => (
                                      <li key={`${span.type}-${index}`}>
                                        <strong>
                                          {span.type === 'sub'
                                            ? '替换'
                                            : span.type === 'insert'
                                              ? '多识'
                                              : '漏识'}
                                        </strong>
                                        <span className="muted">
                                          {span.expectedOffset !== null
                                            ? ` · 真值@${span.expectedOffset}`
                                            : ''}
                                          {span.observedOffset !== null
                                            ? ` · 识别@${span.observedOffset}`
                                            : ''}
                                        </span>
                                        <br />
                                        <code title="真值上下文">
                                          {span.expectedContext || '—'}
                                        </code>
                                        {' → '}
                                        <code title="识别上下文">
                                          {span.observedContext || '—'}
                                        </code>
                                      </li>
                                    ))}
                                  </ul>
                                </details>
                              ) : null}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : null}
              </>
            ) : (
              <p className="muted">尚未运行。点击「运行基准」在本地 OCR 服务上回放语料。</p>
            )}
            {bench.history.length > 0 ? (
              <div className="ops-lab-history">
                <h3 className="ops-lab-subhead">历史运行（已持久化）</h3>
                <div className="table-wrap">
                  <table className="table">
                    <caption className="sr-only">OCR 基准历史运行</caption>
                    <thead>
                      <tr>
                        <th scope="col">开始时间</th>
                        <th scope="col">状态</th>
                        <th scope="col">完成</th>
                        <th scope="col">失败</th>
                        <th scope="col">耗时</th>
                        <th scope="col">PDF</th>
                      </tr>
                    </thead>
                    <tbody>
                      {bench.history.map((entry) => (
                        <tr key={entry.id}>
                          <td>{formatDateTime(entry.startedAt)}</td>
                          <td>
                            <span className={`ops-lab-status is-${entry.status}`}>
                              {benchStatusLabel(entry.status)}
                            </span>
                          </td>
                          <td>
                            {entry.completed}/{entry.total}
                          </td>
                          <td>{entry.failed}</td>
                          <td>{formatDuration(entry.startedAt, entry.finishedAt)}</td>
                          <td>{entry.includePdf ? '含' : '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ) : null}

            <details className="ops-lab-groups">
              <summary>
                模型与预处理对照实验
                {experiment ? `（${benchStatusLabel(experiment.status)}）` : ''}
              </summary>
              <p className="field-hint">
                同一批文件分别用不同通道（RGB/灰度/红通道）、模式与 DPI
                识别；先抽样筛选，再让排名靠前的变体跑全量语料，按 CER、字段与耗时综合排序。
              </p>
              {experimentError ? (
                <p className="field-hint" role="alert">
                  对照实验刷新失败：{experimentError}
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => void loadExperiment()}
                  >
                    重试
                  </button>
                </p>
              ) : null}
              <div className="form-grid">
                <Field label="引擎" htmlFor="ocr-exp-engine">
                  <select
                    id="ocr-exp-engine"
                    className="input"
                    value={experimentForm.engine}
                    onChange={(event) =>
                      setExperimentForm({
                        ...experimentForm,
                        engine: event.target.value as OcrEngine,
                      })
                    }
                    disabled={experimentRunning}
                  >
                    {(Object.keys(bench.models).length > 0
                      ? (Object.keys(bench.models) as OcrEngine[])
                      : (['paddle', 'docling'] as OcrEngine[])
                    ).map((engine) => (
                      <option key={engine} value={engine}>
                        {engine}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="模式与 DPI" htmlFor="ocr-exp-mode">
                  <div className="ops-actions">
                    <select
                      id="ocr-exp-mode"
                      className="input"
                      value={experimentForm.mode}
                      onChange={(event) =>
                        setExperimentForm({
                          ...experimentForm,
                          mode: event.target.value as OcrMode,
                        })
                      }
                      disabled={experimentRunning}
                    >
                      {Object.entries(MODE_LABEL).map(([value, label]) => (
                        <option key={value} value={value}>
                          {label}
                        </option>
                      ))}
                    </select>
                    <input
                      className="input input-sm"
                      type="number"
                      min={100}
                      max={400}
                      step={50}
                      placeholder="默认 DPI"
                      aria-label="对照实验 DPI"
                      value={experimentForm.dpi}
                      onChange={(event) =>
                        setExperimentForm({ ...experimentForm, dpi: event.target.value })
                      }
                      disabled={experimentRunning}
                    />
                  </div>
                </Field>
                <fieldset className="ops-lab-check" disabled={experimentRunning}>
                  <legend>通道</legend>
                  {(['rgb', 'gray', 'red'] as OcrChannel[]).map((channel) => (
                    <label key={channel}>
                      <input
                        type="checkbox"
                        checked={experimentForm.channels.includes(channel)}
                        onChange={() => toggleChannel(channel)}
                      />
                      {CHANNEL_LABEL[channel]}
                    </label>
                  ))}
                </fieldset>
                <Field label="筛选与晋级" htmlFor="ocr-exp-sample">
                  <div className="ops-actions">
                    <input
                      id="ocr-exp-sample"
                      className="input input-sm"
                      type="number"
                      min={1}
                      max={500}
                      aria-label="每个变体抽样文件数"
                      value={experimentForm.sample}
                      onChange={(event) =>
                        setExperimentForm({ ...experimentForm, sample: event.target.value })
                      }
                      disabled={experimentRunning}
                    />
                    <input
                      className="input input-sm"
                      type="number"
                      min={1}
                      max={12}
                      aria-label="晋级全量的变体数"
                      value={experimentForm.topK}
                      onChange={(event) =>
                        setExperimentForm({ ...experimentForm, topK: event.target.value })
                      }
                      disabled={experimentRunning}
                    />
                    <label className="ops-lab-check">
                      <input
                        type="checkbox"
                        checked={experimentForm.full}
                        onChange={(event) =>
                          setExperimentForm({ ...experimentForm, full: event.target.checked })
                        }
                        disabled={experimentRunning}
                      />
                      对晋级的变体跑全量
                    </label>
                  </div>
                </Field>
                <div className="form-span-2 ops-actions">
                  <button
                    type="button"
                    className="btn btn-soft"
                    onClick={() => void startExperiment()}
                    disabled={experimentRunning || experimentBusy}
                  >
                    <Icon name="trend" size={16} />
                    {experimentRunning
                      ? '实验运行中…'
                      : experimentBusy
                        ? '启动中…'
                        : '运行对照实验'}
                  </button>
                </div>
              </div>
              {experiment ? (
                <>
                  <p className="ocr-meta" role="status">
                    {benchStatusLabel(experiment.status)}
                    {' · '}
                    {experiment.stage === 'screen' ? '抽样筛选' : '全量语料'}
                    {' · '}
                    {experiment.variants.length} 个变体 · 筛选 {experiment.sampleSize} 个文件
                    {experiment.selected.length > 0
                      ? ` · 晋级 ${experiment.selected.join('、')}`
                      : ''}
                    {experiment.finishedAt ? ` · ${formatDateTime(experiment.finishedAt)}` : ''}
                  </p>
                  {experiment.error ? (
                    <p className="field-hint" role="alert">
                      实验失败：{experiment.error}
                    </p>
                  ) : null}
                  {(() => {
                    const summaries =
                      experiment.full && experiment.full.summaries.length > 0
                        ? experiment.full.summaries
                        : experiment.screen.summaries;
                    return summaries.length > 0 ? (
                      <div className="table-wrap">
                        <table className="table">
                          <caption className="sr-only">OCR 对照实验变体排名</caption>
                          <thead>
                            <tr>
                              <th scope="col">排名</th>
                              <th scope="col">变体</th>
                              <th scope="col">引擎</th>
                              <th scope="col">模型</th>
                              <th scope="col">模式</th>
                              <th scope="col">DPI</th>
                              <th scope="col">通道</th>
                              <th scope="col">文件</th>
                              <th scope="col">失败</th>
                              <th scope="col">CER</th>
                              <th scope="col">数值 CER</th>
                              <th scope="col">字段</th>
                              <th scope="col">耗时</th>
                              <th scope="col">得分</th>
                            </tr>
                          </thead>
                          <tbody>
                            {summaries.map((summary) => (
                              <tr key={summary.id}>
                                <td>{summary.rank ?? '—'}</td>
                                <td>{summary.label}</td>
                                <td>{summary.engine}</td>
                                <td>{summary.modelId ?? summary.profile ?? '—'}</td>
                                <td>{MODE_LABEL[summary.mode]}</td>
                                <td>{summary.dpi ?? '默认'}</td>
                                <td>{CHANNEL_LABEL[summary.channel]}</td>
                                <td>{summary.files}</td>
                                <td>{summary.failed}</td>
                                <td>{percent(summary.meanCer, 2)}</td>
                                <td>{percent(summary.meanNumericCer, 2)}</td>
                                <td>{percent(summary.fieldRate, 1)}</td>
                                <td>{summary.meanSeconds.toFixed(2)}s</td>
                                <td>{percent(summary.score, 2)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    ) : (
                      <p className="muted">实验尚未产生结果。</p>
                    );
                  })()}
                </>
              ) : (
                <p className="muted">尚无对照实验记录。</p>
              )}
            </details>

            <details className="ops-lab-groups">
              <summary>阶段重放（最近一次基准运行）</summary>
              <p className="field-hint">
                用持久化的阶段参数重跑单个阶段，比较输入/输出指纹与质量分，验证优化是否真正带来提升；
                候选阶段会在记录的实际引擎上重放。
              </p>
              {benchResults.length === 0 ? (
                <p className="muted">先运行一次基准测试，之后可以重放其中的阶段。</p>
              ) : (
                <>
                  <div className="ops-actions">
                    <label className="ops-lab-check">
                      样本
                      <select
                        className="input"
                        value={replayName}
                        onChange={(event) => {
                          setReplayName(event.target.value);
                          setReplayIndex(0);
                          setReplayResult(null);
                          setReplayError(null);
                        }}
                        disabled={replayBusy}
                      >
                        {benchResults.map((result) => (
                          <option key={result.name} value={result.name}>
                            {result.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="ops-lab-check">
                      阶段
                      <select
                        className="input"
                        value={String(replayIndex < replayStages.length ? replayIndex : 0)}
                        onChange={(event) => {
                          setReplayIndex(Number(event.target.value));
                          setReplayResult(null);
                          setReplayError(null);
                        }}
                        disabled={replayBusy || replayStages.length === 0}
                      >
                        {replayStages.map((stage, index) => {
                          const occurrence = replayStages
                            .slice(0, index + 1)
                            .filter((entry) => entry.kind === stage.kind).length;
                          return (
                            <option key={`${stage.kind}-${index}`} value={index}>
                              {stageLabel(stage.kind)}
                              {` · ${engineLabel(stage.engine)}`}
                              {stage.model && stage.model !== stage.engine
                                ? ` · ${stage.model}`
                                : ''}
                              {` · 第 ${occurrence} 次`}
                            </option>
                          );
                        })}
                      </select>
                    </label>
                    <button
                      type="button"
                      className="btn btn-soft"
                      onClick={() => void runReplay()}
                      disabled={replayBusy || !replayStage}
                    >
                      <Icon name="refresh" size={16} />
                      {replayBusy ? '重放中…' : '重放阶段'}
                    </button>
                  </div>
                  {replayError ? (
                    <p className="field-hint" role="alert">
                      重放失败：{replayError}
                    </p>
                  ) : null}
                  {replayResult ? (
                    <div className="ops-lab-aggregate">
                      <div className="ops-lab-meta" role="status">
                        <span>{stageLabel(replayResult.kind)}</span>
                        <span>{engineLabel(replayResult.engine)}</span>
                        <span>
                          输入指纹{' '}
                          {replayResult.inputMatches === null
                            ? '无法比较'
                            : replayResult.inputMatches
                              ? '一致'
                              : '已变化'}
                        </span>
                        <span>
                          输出{' '}
                          {replayResult.outputMatches === null
                            ? '区域重放'
                            : replayResult.outputMatches
                              ? '一致'
                              : '不同'}
                        </span>
                        <span>
                          质量 {percent(replayResult.scoreBefore, 1)} →{' '}
                          {percent(replayResult.scoreAfter, 1)}
                          {replayResult.scoreDelta === null
                            ? ''
                            : `（${replayResult.scoreDelta >= 0 ? '+' : ''}${(
                                replayResult.scoreDelta * 100
                              ).toFixed(1)}%）`}
                        </span>
                      </div>
                      {replayResult.candidate ? (
                        <pre className="ocr-text">{replayResult.candidate.text || '（空）'}</pre>
                      ) : null}
                    </div>
                  ) : null}
                </>
              )}
            </details>
          </>
        )}
      </section>

      <OcrGovernancePanel />

      <ConfirmDialog
        open={restoreTarget !== null}
        title="恢复备份"
        message={`将把 ${restoreTarget?.name ?? ''} 排入恢复队列。服务重启后当前数据库会被替换，并保留一份 .pre-restore 备份。`}
        confirmLabel="排队恢复"
        busy={busy === 'restore'}
        onCancel={() => setRestoreTarget(null)}
        onConfirm={() => void stageRestore()}
      />
      <ConfirmDialog
        open={demoConfirm}
        title="清除演示数据"
        message="所有演示项目及其任务、评论会被删除，演示账号保留。之后可随时重新生成。"
        confirmLabel="清除演示数据"
        busy={busy === 'demo'}
        onCancel={() => setDemoConfirm(false)}
        onConfirm={() => void setDemoData(false)}
      />
      <ConfirmDialog
        open={eraseTarget !== null}
        title="匿名化删除成员"
        message={`将永久删除 ${eraseTarget?.name ?? ''} 的个人数据并停用账号。该操作不可撤销。`}
        confirmLabel="匿名化删除"
        busy={busy === 'erase'}
        onCancel={() => setEraseTarget(null)}
        onConfirm={() => void eraseUser()}
      />
      <Toaster toasts={toasts} onDismiss={dismiss} />
    </div>
  );
}
