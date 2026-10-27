import { type FormEvent, useMemo, useState } from 'react';
import type { PortfolioConfig, PortfolioFactor, PortfolioScore } from '../../../../shared/types.ts';
import { api } from '../../api.ts';
import { formatDate } from '../../format.ts';
import { useApi, useToast } from '../../hooks/useApi.ts';
import { Icon } from '../Icon.tsx';
import { ConfirmDialog, EmptyState, ErrorState, Field, Modal, Spinner, Toaster } from '../ui.tsx';
import {
  EnterpriseEmpty,
  EnterpriseStat,
  type EnterpriseTabProps,
  EnterpriseToolbar,
  ToneBadge,
} from './shared.tsx';

const FACTOR_KEYS = ['value', 'delivery', 'risk', 'strategic'] as const;
const FACTOR_LABELS: Record<(typeof FACTOR_KEYS)[number], string> = {
  value: '业务价值',
  delivery: '交付确定性',
  risk: '风险水平',
  strategic: '战略契合',
};

function defaultWeights(): PortfolioFactor[] {
  return FACTOR_KEYS.map((key) => ({
    key,
    label: FACTOR_LABELS[key],
    weight: 0.25,
    direction: key === 'risk' ? 'negative' : 'positive',
  }));
}

export function PortfolioTab({ projects }: EnterpriseTabProps) {
  const configsState = useApi((signal) => api.portfolioConfigs(signal), []);
  const [configId, setConfigId] = useState('');
  const scoresState = useApi(
    (signal) => api.portfolioScores(configId || undefined, signal),
    [configId],
  );
  const [createOpen, setCreateOpen] = useState(false);
  const [scoring, setScoring] = useState(false);
  const [deleting, setDeleting] = useState<PortfolioConfig | null>(null);
  const [busy, setBusy] = useState(false);
  const { toasts, show, dismiss } = useToast();

  const configs = configsState.data ?? [];
  const scores = scoresState.data ?? [];
  const configMap = useMemo(() => new Map(configs.map((config) => [config.id, config])), [configs]);
  const average = scores.length
    ? scores.reduce((sum, score) => sum + (score.effectiveScore ?? 0), 0) / scores.length
    : 0;
  const missing = scores.filter((score) => score.missing.length > 0).length;

  const removeConfig = async () => {
    if (!deleting || busy) return;
    setBusy(true);
    try {
      await api.deletePortfolioConfig(deleting.id);
      show(`已删除评分模板「${deleting.name}」`);
      setDeleting(null);
      configsState.reload();
      scoresState.reload();
    } catch (cause) {
      show(cause instanceof Error ? cause.message : '删除失败', 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="enterprise-tab">
      <div className="enterprise-stats">
        <EnterpriseStat label="评分模板" value={configs.length} hint="按权重计算项目得分" />
        <EnterpriseStat label="已评分项目" value={scores.length} hint="当前筛选范围" tone="mint" />
        <EnterpriseStat
          label="平均得分"
          value={average ? average.toFixed(2) : '—'}
          hint="有效得分均值（0-5）"
          tone="sky"
        />
        <EnterpriseStat
          label="缺因子"
          value={missing}
          hint="缺失因子会降低置信度"
          tone={missing > 0 ? 'peach' : 'lilac'}
        />
      </div>

      <EnterpriseToolbar>
        <label className="enterprise-picker">
          <span>评分模板</span>
          <select
            className="input input-sm"
            value={configId}
            onChange={(event) => setConfigId(event.target.value)}
          >
            <option value="">全部模板</option>
            {configs.map((config) => (
              <option key={config.id} value={config.id}>
                {config.name}
              </option>
            ))}
          </select>
        </label>
        <div className="enterprise-toolbar-actions">
          <button
            type="button"
            className="btn btn-soft btn-sm"
            onClick={() => setScoring(true)}
            disabled={configs.length === 0 || projects.length === 0}
          >
            <Icon name="star" size={15} />
            项目评分
          </button>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={() => setCreateOpen(true)}
          >
            <Icon name="plus" size={16} />
            新建模板
          </button>
        </div>
      </EnterpriseToolbar>

      {configsState.error && !configsState.data ? (
        <div className="card card-pad">
          <ErrorState message={configsState.error} onRetry={configsState.reload} />
        </div>
      ) : null}

      {configs.length > 0 ? (
        <div className="enterprise-configs">
          {configs.map((config) => (
            <article key={config.id} className="card card-pad enterprise-config">
              <header className="card-head">
                <div>
                  <div className="card-title-row">
                    <h2>{config.name}</h2>
                    <ToneBadge tone={config.active ? 'success' : 'muted'}>
                      {config.active ? '启用' : '停用'}
                    </ToneBadge>
                  </div>
                  <p className="card-sub">
                    v{config.version} · {config.weights.length} 个因子 · 更新于{' '}
                    {formatDate(config.updatedAt)}
                  </p>
                </div>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  aria-label={`删除模板 ${config.name}`}
                  onClick={() => setDeleting(config)}
                >
                  <Icon name="trash" size={15} />
                </button>
              </header>
              <ul className="enterprise-factor-list">
                {config.weights.map((factor) => (
                  <li key={factor.key}>
                    <span>{factor.label}</span>
                    <span className="table-muted">
                      {Math.round(factor.weight * 100)}% ·{' '}
                      {factor.direction === 'negative' ? '负向' : '正向'}
                    </span>
                  </li>
                ))}
              </ul>
            </article>
          ))}
        </div>
      ) : null}

      {scoresState.error && !scoresState.data ? (
        <div className="card card-pad">
          <ErrorState message={scoresState.error} onRetry={scoresState.reload} />
        </div>
      ) : null}

      {scores.length === 0 ? (
        <div className="card card-pad">
          <EmptyState
            icon="star"
            title="还没有项目评分"
            description="创建评分模板后，为项目录入因子得分，即可在组合视图中横向对比。"
            compact
            action={
              configs.length > 0 ? (
                <button
                  type="button"
                  className="btn btn-soft btn-sm"
                  onClick={() => setScoring(true)}
                >
                  为项目评分
                </button>
              ) : (
                <button
                  type="button"
                  className="btn btn-soft btn-sm"
                  onClick={() => setCreateOpen(true)}
                >
                  新建模板
                </button>
              )
            }
          />
        </div>
      ) : (
        <div className="card table-card">
          <table className="data-table">
            <thead>
              <tr>
                <th>项目</th>
                <th>模板</th>
                <th>计算得分</th>
                <th>人工覆盖</th>
                <th>有效得分</th>
                <th>缺失因子</th>
                <th>评分时间</th>
              </tr>
            </thead>
            <tbody>
              {scores.map((score) => (
                <tr key={score.id}>
                  <td>{score.projectName}</td>
                  <td className="table-muted">{configMap.get(score.configId)?.name ?? '—'}</td>
                  <td>{score.score === null ? '—' : score.score.toFixed(2)}</td>
                  <td className="table-muted">
                    {score.overrideScore === null ? '—' : score.overrideScore.toFixed(2)}
                    {score.overrideReason ? <span title={score.overrideReason}> *</span> : null}
                  </td>
                  <td>
                    <strong>
                      {score.effectiveScore === null ? '—' : score.effectiveScore.toFixed(2)}
                    </strong>
                  </td>
                  <td className="table-muted">
                    {score.missing.length > 0 ? score.missing.join('、') : '无'}
                  </td>
                  <td className="table-muted">{formatDate(score.scoredAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <CreateConfigDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={(config) => {
          setCreateOpen(false);
          show(`已创建评分模板「${config.name}」`);
          configsState.reload();
        }}
        onError={(message) => show(message, 'error')}
      />

      <ScoreDialog
        open={scoring}
        projects={projects}
        configs={configs}
        onClose={() => setScoring(false)}
        onScored={(score) => {
          setScoring(false);
          show(`已为「${score.projectName}」评分`);
          scoresState.reload();
        }}
        onError={(message) => show(message, 'error')}
      />

      <ConfirmDialog
        open={deleting !== null}
        title="删除评分模板？"
        message={`模板「${deleting?.name ?? ''}」及其历史评分将被删除，操作不可撤销。`}
        busy={busy}
        onCancel={() => setDeleting(null)}
        onConfirm={() => void removeConfig()}
      />

      <Toaster toasts={toasts} onDismiss={dismiss} />
    </div>
  );
}

function CreateConfigDialog({
  open,
  onClose,
  onCreated,
  onError,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (config: PortfolioConfig) => void;
  onError: (message: string) => void;
}) {
  const [name, setName] = useState('');
  const [weights, setWeights] = useState<PortfolioFactor[]>(defaultWeights);
  const [busy, setBusy] = useState(false);
  const total = weights.reduce((sum, factor) => sum + factor.weight, 0);

  const setWeight = (key: string, value: number) => {
    setWeights((current) =>
      current.map((factor) => (factor.key === key ? { ...factor, weight: value } : factor)),
    );
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    if (Math.abs(total - 1) > 0.001) {
      onError('评分权重合计必须为 1');
      return;
    }
    setBusy(true);
    try {
      const config = await api.createPortfolioConfig({ name, weights, active: true });
      setName('');
      setWeights(defaultWeights());
      onCreated(config);
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : '创建失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="新建评分模板"
      description="权重合计必须为 1；负向因子会从得分中扣减。"
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            取消
          </button>
          <button
            type="submit"
            form="portfolio-config-form"
            className="btn btn-primary"
            disabled={busy}
          >
            {busy ? <Spinner size={16} /> : <Icon name="plus" size={16} />}
            创建模板
          </button>
        </>
      }
    >
      <form
        id="portfolio-config-form"
        className="form-grid"
        onSubmit={(event) => void submit(event)}
      >
        <Field
          label="模板名称"
          htmlFor="portfolio-name"
          hint={`当前权重合计 ${Math.round(total * 100)}%`}
        >
          <input
            id="portfolio-name"
            className="input"
            value={name}
            required
            maxLength={80}
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
        <div className="form-span-2 enterprise-weight-grid">
          {weights.map((factor) => (
            <Field key={factor.key} label={factor.label} htmlFor={`weight-${factor.key}`}>
              <input
                id={`weight-${factor.key}`}
                className="input"
                type="number"
                min={0}
                max={1}
                step={0.05}
                value={factor.weight}
                onChange={(event) => setWeight(factor.key, Number(event.target.value))}
              />
            </Field>
          ))}
        </div>
      </form>
    </Modal>
  );
}

function ScoreDialog({
  open,
  projects,
  configs,
  onClose,
  onScored,
  onError,
}: {
  open: boolean;
  projects: EnterpriseTabProps['projects'];
  configs: PortfolioConfig[];
  onClose: () => void;
  onScored: (score: PortfolioScore) => void;
  onError: (message: string) => void;
}) {
  const [projectId, setProjectId] = useState('');
  const [configId, setConfigId] = useState('');
  const [values, setValues] = useState<Record<string, string>>({});
  const [overrideScore, setOverrideScore] = useState('');
  const [overrideReason, setOverrideReason] = useState('');
  const [busy, setBusy] = useState(false);

  const config = configs.find((item) => item.id === configId) ?? configs[0];

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || !config) return;
    setBusy(true);
    try {
      const score = await api.scoreProject({
        projectId,
        configId: config.id,
        factors: config.weights.map((factor) => {
          const raw = values[factor.key];
          return { key: factor.key, value: raw === undefined || raw === '' ? null : Number(raw) };
        }),
        overrideScore: overrideScore === '' ? null : Number(overrideScore),
        overrideReason: overrideReason || null,
      });
      setValues({});
      setOverrideScore('');
      setOverrideReason('');
      onScored(score);
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : '评分失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="项目评分"
      description="因子取值 0-5，可留空表示缺失；人工覆盖必须填写理由。"
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            取消
          </button>
          <button
            type="submit"
            form="portfolio-score-form"
            className="btn btn-primary"
            disabled={busy}
          >
            {busy ? <Spinner size={16} /> : <Icon name="check" size={16} />}
            保存评分
          </button>
        </>
      }
    >
      <form
        id="portfolio-score-form"
        className="form-grid"
        onSubmit={(event) => void submit(event)}
      >
        <Field label="项目" htmlFor="score-project">
          <select
            id="score-project"
            className="input"
            value={projectId}
            required
            onChange={(event) => setProjectId(event.target.value)}
          >
            <option value="">请选择项目</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="评分模板" htmlFor="score-config">
          <select
            id="score-config"
            className="input"
            value={config?.id ?? ''}
            onChange={(event) => setConfigId(event.target.value)}
          >
            {configs.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </Field>
        {config?.weights.map((factor) => (
          <Field
            key={factor.key}
            label={`${factor.label}（${Math.round(factor.weight * 100)}%）`}
            htmlFor={`factor-${factor.key}`}
          >
            <input
              id={`factor-${factor.key}`}
              className="input"
              type="number"
              min={0}
              max={5}
              step={0.1}
              value={values[factor.key] ?? ''}
              onChange={(event) =>
                setValues((current) => ({ ...current, [factor.key]: event.target.value }))
              }
            />
          </Field>
        ))}
        <Field label="人工覆盖分" htmlFor="score-override" hint="0-5，留空表示不覆盖">
          <input
            id="score-override"
            className="input"
            type="number"
            min={0}
            max={5}
            step={0.1}
            value={overrideScore}
            onChange={(event) => setOverrideScore(event.target.value)}
          />
        </Field>
        <Field label="覆盖理由" htmlFor="score-reason">
          <input
            id="score-reason"
            className="input"
            maxLength={500}
            value={overrideReason}
            onChange={(event) => setOverrideReason(event.target.value)}
          />
        </Field>
        {config ? (
          <EnterpriseEmpty>
            当前模板共 {config.weights.length} 个因子，缺失因子会在评分结果中标注。
          </EnterpriseEmpty>
        ) : null}
      </form>
    </Modal>
  );
}
