import { useEffect, useState } from 'react';
import { canManageWorkspace } from '../../../../shared/permissions.ts';
import { api, type WorkbenchRecord } from '../../api.ts';
import { formatDate } from '../../format.ts';
import { useApi, useToast } from '../../hooks/useApi.ts';
import { useAuth } from '../../hooks/useAuth.tsx';
import { Icon } from '../Icon.tsx';
import { EmptyState, Toaster } from '../ui.tsx';
import {
  EnterpriseEmpty,
  EnterpriseStat,
  type EnterpriseTabProps,
  EnterpriseToolbar,
  listOf,
  numberOf,
  ProjectPicker,
  ToneBadge,
  textOf,
} from './shared.tsx';

type StatusTone = 'success' | 'danger' | 'muted' | 'active' | 'warning';

const STATUS_LABELS: Record<string, string> = {
  pending: '待审批',
  approved: '已通过',
  rejected: '已拒绝',
  waived: '已豁免',
  withdrawn: '已撤回',
  active: '生效中',
  superseded: '已替代',
  draft: '草稿',
  submitted: '待审批',
  implemented: '已实施',
  closed: '已结项',
  reopened: '已重开',
  submittedVersion: '待审阅',
};

function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status;
}

function statusTone(status: string): StatusTone {
  if (['approved', 'active', 'implemented', 'closed'].includes(status)) return 'success';
  if (['rejected', 'withdrawn'].includes(status)) return 'danger';
  if (['pending', 'submitted', 'reopened'].includes(status)) return 'warning';
  return 'muted';
}

function ids(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

export function DeliveryTab({ projects }: EnterpriseTabProps) {
  const { user } = useAuth();
  const manager = Boolean(user && canManageWorkspace(user.role, user.permissions));
  const [projectId, setProjectId] = useState(projects[0]?.id ?? '');
  const { toasts, show, dismiss } = useToast();

  useEffect(() => {
    if (!projectId && projects[0]) setProjectId(projects[0].id);
  }, [projectId, projects]);

  const gatesState = useApi((signal) => api.stageGates(projectId, signal), [projectId], {
    skip: !projectId,
  });
  const baselinesState = useApi((signal) => api.baselines(projectId, signal), [projectId], {
    skip: !projectId,
  });
  const changesState = useApi((signal) => api.changeRequests(projectId, signal), [projectId], {
    skip: !projectId,
  });
  const deliverablesState = useApi((signal) => api.deliverables(projectId, signal), [projectId], {
    skip: !projectId,
  });
  const tasksState = useApi((signal) => api.projectTasks(projectId, signal), [projectId], {
    skip: !projectId,
  });
  const closureState = useApi((signal) => api.projectClosure(projectId, signal), [projectId], {
    skip: !projectId,
  });
  const capacityState = useApi((signal) => api.capacity(undefined, undefined, signal), [], {
    skip: !manager,
  });

  const gates = gatesState.data?.items ?? [];
  const baselines = baselinesState.data?.items ?? [];
  const changes = changesState.data?.items ?? [];
  const deliverables = deliverablesState.data?.items ?? [];
  const taskTitles = new Map((tasksState.data?.tasks ?? []).map((task) => [task.id, task.title]));
  const closure = closureState.data?.closure ?? null;
  const benefits = closureState.data?.benefits ?? [];
  const capacity = (capacityState.data ?? []) as unknown as WorkbenchRecord[];

  const [gateName, setGateName] = useState('');
  const [gatePhase, setGatePhase] = useState('delivery');
  const [gateHours, setGateHours] = useState('48');
  const [baselineReason, setBaselineReason] = useState('');
  const [baselineLabel, setBaselineLabel] = useState('');
  const [changeTitle, setChangeTitle] = useState('');
  const [changeKind, setChangeKind] = useState('scope');
  const [changeReason, setChangeReason] = useState('');
  const [deliverableName, setDeliverableName] = useState('');
  const [deliverableRequired, setDeliverableRequired] = useState(true);
  const [reviewNote, setReviewNote] = useState('');
  const [selectedDeliverable, setSelectedDeliverable] = useState('');
  const [versionName, setVersionName] = useState('');
  const [versionChecksum, setVersionChecksum] = useState('');
  const [versionNote, setVersionNote] = useState('');
  const [versionList, setVersionList] = useState<WorkbenchRecord[]>([]);
  const [variance, setVariance] = useState<WorkbenchRecord | null>(null);
  const [acceptance, setAcceptance] = useState('验收报告');
  const [openItems, setOpenItems] = useState('');
  const [actualCost, setActualCost] = useState('0');
  const [feedback, setFeedback] = useState('');
  const [benefitLabel, setBenefitLabel] = useState('效率提升');
  const [benefitTarget, setBenefitTarget] = useState('20');
  const [benefitDue, setBenefitDue] = useState('');
  const [profileDraft, setProfileDraft] = useState<Record<string, string>>({});
  const [scenario, setScenario] = useState<{
    from: string;
    to: string;
    items: WorkbenchRecord[];
  } | null>(null);
  const [busy, setBusy] = useState(false);

  const reloadDelivery = () => {
    gatesState.reload();
    baselinesState.reload();
    changesState.reload();
    deliverablesState.reload();
    closureState.reload();
  };

  const act = async (task: () => Promise<unknown>, message: string, after?: () => void) => {
    if (busy) return;
    setBusy(true);
    try {
      await task();
      show(message);
      after?.();
    } catch (cause) {
      show(cause instanceof Error ? cause.message : '操作失败', 'error');
    } finally {
      setBusy(false);
    }
  };

  const createGate = () =>
    act(
      () =>
        api.createStageGate(projectId, {
          name: gateName.trim(),
          phase: gatePhase.trim() || undefined,
          slaHours: Number(gateHours) || undefined,
        }),
      '阶段门已创建',
      () => {
        setGateName('');
        reloadDelivery();
      },
    );

  const decideGate = (gate: WorkbenchRecord, action: 'approve' | 'reject') =>
    act(
      () =>
        api.decideStageGate(textOf(gate, 'id'), {
          action,
          note: reviewNote.trim() || undefined,
          version: numberOf(gate, 'version', 1),
        }),
      action === 'approve' ? '阶段门已通过' : '阶段门已拒绝',
      reloadDelivery,
    );

  const createBaseline = () =>
    act(
      () =>
        api.createBaseline(projectId, {
          reason: baselineReason.trim(),
          label: baselineLabel.trim() || undefined,
        }),
      '基线已创建',
      () => {
        setBaselineReason('');
        setBaselineLabel('');
        reloadDelivery();
      },
    );

  const decideBaseline = (baseline: WorkbenchRecord, action: 'approve' | 'reject') =>
    act(
      () =>
        api.decideBaseline(textOf(baseline, 'id'), {
          action,
          note: reviewNote.trim() || undefined,
        }),
      action === 'approve' ? '基线已批准' : '基线已拒绝',
      reloadDelivery,
    );

  const loadVariance = (baseline: WorkbenchRecord) =>
    act(async () => {
      setVariance(await api.baselineVariance(textOf(baseline, 'id')));
    }, '偏差已加载');

  const createChange = () =>
    act(
      () =>
        api.createChangeRequest(projectId, {
          title: changeTitle.trim(),
          kind: changeKind as 'scope' | 'schedule' | 'budget' | 'resource' | 'other',
          reason: changeReason.trim() || undefined,
        }),
      '变更请求已创建',
      () => {
        setChangeTitle('');
        setChangeReason('');
        reloadDelivery();
      },
    );

  const decideChange = (change: WorkbenchRecord, action: 'approve' | 'reject' | 'implement') =>
    act(
      () =>
        api.decideChangeRequest(textOf(change, 'id'), {
          action,
          note: reviewNote.trim() || '界面审批',
          version: numberOf(change, 'version', 1),
        }),
      action === 'implement' ? '变更已实施' : action === 'approve' ? '变更已批准' : '变更已拒绝',
      reloadDelivery,
    );

  const createDeliverable = () =>
    act(
      () =>
        api.createDeliverable(projectId, {
          name: deliverableName.trim(),
          required: deliverableRequired,
        }),
      '交付物已创建',
      () => {
        setDeliverableName('');
        reloadDelivery();
      },
    );

  const openVersions = (deliverable: WorkbenchRecord) =>
    act(async () => {
      const id = textOf(deliverable, 'id');
      setSelectedDeliverable(id);
      const list = await api.deliverableVersions(id);
      setVersionList(list.items);
    }, '版本已加载');

  const addVersion = () =>
    act(
      async () => {
        await api.addDeliverableVersion(selectedDeliverable, {
          filename: versionName.trim(),
          checksum: versionChecksum.trim() || undefined,
          note: versionNote.trim() || undefined,
        });
        const list = await api.deliverableVersions(selectedDeliverable);
        setVersionList(list.items);
        deliverablesState.reload();
      },
      '新版本已提交',
      () => {
        setVersionName('');
        setVersionChecksum('');
        setVersionNote('');
      },
    );

  const reviewDeliverable = (deliverable: WorkbenchRecord, action: 'approve' | 'reject') =>
    act(
      () =>
        api.reviewDeliverable(textOf(deliverable, 'id'), {
          action,
          note: reviewNote.trim() || undefined,
        }),
      action === 'approve' ? '交付物已签收' : '交付物已退回',
      () => {
        deliverablesState.reload();
        if (selectedDeliverable) {
          void api
            .deliverableVersions(selectedDeliverable)
            .then((list) => setVersionList(list.items))
            .catch(() => undefined);
        }
      },
    );

  const closeProject = () =>
    act(
      () =>
        api.closeProject(projectId, {
          acceptance: ids(acceptance).map((item) => ({ item, accepted: true })),
          actualCostCents: Math.max(0, Math.round((Number(actualCost) || 0) * 100)),
          openItems: ids(openItems),
          feedback: feedback.trim() || undefined,
          benefitPlan: benefitLabel.trim()
            ? [
                {
                  label: benefitLabel.trim(),
                  targetValue: Number(benefitTarget) || 0,
                  dueOn: benefitDue || new Date().toISOString().slice(0, 10),
                },
              ]
            : [],
        }),
      '项目已结项',
      reloadDelivery,
    );

  const reopen = (row: WorkbenchRecord) =>
    act(
      () => api.reopenClosure(textOf(row, 'id'), reviewNote.trim() || '业务需要重新打开'),
      '项目已重新打开',
      reloadDelivery,
    );

  const recordBenefit = (review: WorkbenchRecord) =>
    act(
      () =>
        api.recordBenefit(textOf(review, 'id'), {
          actual: { value: Number(benefitTarget) || 0 },
          note: reviewNote.trim() || '界面复盘',
        }),
      '收益已记录',
      reloadDelivery,
    );

  const saveProfile = (row: WorkbenchRecord) =>
    act(
      () =>
        api.updateCapacityProfile(textOf(row, 'userId'), {
          weeklyHours: Number(profileDraft[textOf(row, 'userId')] ?? numberOf(row, 'weeklyHours')),
        }),
      '容量画像已保存',
      capacityState.reload,
    );

  const simulate = (row: WorkbenchRecord) =>
    act(async () => {
      const userId = textOf(row, 'userId');
      const hours = Number(profileDraft[userId] ?? numberOf(row, 'weeklyHours'));
      const result = await api.capacityScenario({
        adjustments: [{ userId, weeklyHours: hours }],
      });
      setScenario(result as unknown as { from: string; to: string; items: WorkbenchRecord[] });
    }, '容量情景已生成');

  if (!projectId) {
    return (
      <div className="card card-pad">
        <EmptyState icon="file" title="请选择项目" compact />
      </div>
    );
  }

  return (
    <div className="enterprise-tab">
      <EnterpriseToolbar>
        <ProjectPicker projects={projects} value={projectId} onChange={setProjectId} />
        <p className="enterprise-hint">阶段门、基线、变更、容量、结项与交付物统一按项目治理。</p>
      </EnterpriseToolbar>

      <div className="enterprise-stats">
        <EnterpriseStat label="阶段门" value={gates.length} hint="审批与材料检查" />
        <EnterpriseStat label="基线" value={baselines.length} hint="激活后计算偏差" tone="mint" />
        <EnterpriseStat label="变更请求" value={changes.length} hint="批准后实施" tone="sky" />
        <EnterpriseStat
          label="交付物"
          value={deliverables.length}
          hint={`${deliverables.filter((item) => textOf(item, 'status') === 'approved').length} 已签收`}
          tone="peach"
        />
      </div>

      <div className="enterprise-columns">
        <section className="card card-pad">
          <header className="card-head">
            <div>
              <h2>阶段门</h2>
              <p className="card-sub">定义阶段门与审批时限，通过后进入下一阶段。</p>
            </div>
          </header>
          {!manager ? (
            <EnterpriseEmpty>只有项目管理者可以创建或审批阶段门。</EnterpriseEmpty>
          ) : (
            <div className="enterprise-inline-form">
              <input
                className="input input-sm"
                value={gateName}
                aria-label="阶段门名称"
                placeholder="阶段门名称"
                onChange={(event) => setGateName(event.target.value)}
              />
              <input
                className="input input-sm"
                value={gatePhase}
                aria-label="阶段"
                placeholder="阶段"
                onChange={(event) => setGatePhase(event.target.value)}
              />
              <input
                className="input input-sm enterprise-narrow"
                type="number"
                min={1}
                max={8760}
                value={gateHours}
                aria-label="审批时限（小时）"
                onChange={(event) => setGateHours(event.target.value)}
              />
              <button
                type="button"
                className="btn btn-soft btn-sm"
                disabled={busy || !gateName.trim()}
                onClick={() => void createGate()}
              >
                <Icon name="plus" size={15} />
                创建
              </button>
            </div>
          )}
          {gates.length === 0 ? (
            <EnterpriseEmpty>当前项目还没有阶段门。</EnterpriseEmpty>
          ) : (
            <ul className="enterprise-sublist">
              {gates.map((gate) => {
                const status = textOf(gate, 'status');
                return (
                  <li key={textOf(gate, 'id')}>
                    <div className="enterprise-subject">
                      <span>
                        {textOf(gate, 'name')}{' '}
                        <ToneBadge tone={statusTone(status)}>{statusLabel(status)}</ToneBadge>
                      </span>
                      <span className="table-muted">
                        {textOf(gate, 'phase') || '未分阶段'} ·{' '}
                        {textOf(gate, 'dueAt')
                          ? `截止 ${formatDate(textOf(gate, 'dueAt'))}`
                          : '无截止时间'}
                      </span>
                      {manager && status === 'pending' ? (
                        <span className="enterprise-actions">
                          <button
                            type="button"
                            className="btn btn-ghost btn-sm"
                            onClick={() => void decideGate(gate, 'approve')}
                          >
                            通过
                          </button>
                          <button
                            type="button"
                            className="btn btn-ghost btn-sm"
                            onClick={() => void decideGate(gate, 'reject')}
                          >
                            拒绝
                          </button>
                        </span>
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section className="card card-pad">
          <header className="card-head">
            <div>
              <h2>基线</h2>
              <p className="card-sub">激活基线后冻结任务快照，可对比新增、删除与变更。</p>
            </div>
          </header>
          {manager ? (
            <div className="enterprise-inline-form">
              <input
                className="input input-sm"
                value={baselineLabel}
                aria-label="基线名称"
                placeholder="基线名称"
                onChange={(event) => setBaselineLabel(event.target.value)}
              />
              <input
                className="input input-sm"
                value={baselineReason}
                aria-label="基线原因"
                placeholder="创建原因（必填）"
                onChange={(event) => setBaselineReason(event.target.value)}
              />
              <button
                type="button"
                className="btn btn-soft btn-sm"
                disabled={busy || !baselineReason.trim()}
                onClick={() => void createBaseline()}
              >
                <Icon name="plus" size={15} />
                创建
              </button>
            </div>
          ) : null}
          {baselines.length === 0 ? (
            <EnterpriseEmpty>当前项目还没有基线。</EnterpriseEmpty>
          ) : (
            <ul className="enterprise-sublist">
              {baselines.map((baseline) => {
                const status = textOf(baseline, 'status');
                return (
                  <li key={textOf(baseline, 'id')}>
                    <div className="enterprise-subject">
                      <span>
                        {textOf(baseline, 'label') || `基线 v${numberOf(baseline, 'versionNo')}`}{' '}
                        <ToneBadge tone={statusTone(status)}>{statusLabel(status)}</ToneBadge>
                      </span>
                      <span className="table-muted">{textOf(baseline, 'reason')}</span>
                      <span className="enterprise-actions">
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          onClick={() => void loadVariance(baseline)}
                        >
                          偏差
                        </button>
                        {manager && status === 'pending' ? (
                          <>
                            <button
                              type="button"
                              className="btn btn-ghost btn-sm"
                              onClick={() => void decideBaseline(baseline, 'approve')}
                            >
                              批准
                            </button>
                            <button
                              type="button"
                              className="btn btn-ghost btn-sm"
                              onClick={() => void decideBaseline(baseline, 'reject')}
                            >
                              拒绝
                            </button>
                          </>
                        ) : null}
                      </span>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
          {variance ? (
            <div className="enterprise-inline-note">
              新增 {numberOf(variance, 'added', listOf(variance, 'added').length)} · 删除{' '}
              {numberOf(variance, 'removed', listOf(variance, 'removed').length)} · 变更{' '}
              {numberOf(variance, 'changed', listOf(variance, 'changed').length)} · 未变{' '}
              {numberOf(variance, 'unchanged')}
            </div>
          ) : null}
        </section>
      </div>

      <div className="enterprise-columns">
        <section className="card card-pad">
          <header className="card-head">
            <div>
              <h2>变更请求</h2>
              <p className="card-sub">范围、时间与预算变更需审批，批准后可实施。</p>
            </div>
          </header>
          {manager ? (
            <div className="enterprise-inline-form">
              <input
                className="input input-sm"
                value={changeTitle}
                aria-label="变更标题"
                placeholder="变更标题"
                onChange={(event) => setChangeTitle(event.target.value)}
              />
              <select
                className="input input-sm"
                value={changeKind}
                aria-label="变更类型"
                onChange={(event) => setChangeKind(event.target.value)}
              >
                {[
                  ['scope', '范围'],
                  ['schedule', '时间'],
                  ['budget', '预算'],
                  ['resource', '资源'],
                  ['other', '其他'],
                ].map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
              <input
                className="input input-sm"
                value={changeReason}
                aria-label="变更原因"
                placeholder="变更原因"
                onChange={(event) => setChangeReason(event.target.value)}
              />
              <button
                type="button"
                className="btn btn-soft btn-sm"
                disabled={busy || !changeTitle.trim()}
                onClick={() => void createChange()}
              >
                <Icon name="plus" size={15} />
                提交
              </button>
            </div>
          ) : null}
          {changes.length === 0 ? (
            <EnterpriseEmpty>当前项目还没有变更请求。</EnterpriseEmpty>
          ) : (
            <ul className="enterprise-sublist">
              {changes.map((change) => {
                const status = textOf(change, 'status');
                return (
                  <li key={textOf(change, 'id')}>
                    <div className="enterprise-subject">
                      <span>
                        {textOf(change, 'title')}{' '}
                        <ToneBadge tone={statusTone(status)}>{statusLabel(status)}</ToneBadge>
                      </span>
                      <span className="table-muted">
                        {textOf(change, 'kind')} · {textOf(change, 'reason')}
                      </span>
                      {manager ? (
                        <span className="enterprise-actions">
                          {status === 'draft' || status === 'submitted' ? (
                            <>
                              <button
                                type="button"
                                className="btn btn-ghost btn-sm"
                                onClick={() => void decideChange(change, 'approve')}
                              >
                                批准
                              </button>
                              <button
                                type="button"
                                className="btn btn-ghost btn-sm"
                                onClick={() => void decideChange(change, 'reject')}
                              >
                                拒绝
                              </button>
                            </>
                          ) : null}
                          {status === 'approved' ? (
                            <button
                              type="button"
                              className="btn btn-ghost btn-sm"
                              onClick={() => void decideChange(change, 'implement')}
                            >
                              实施
                            </button>
                          ) : null}
                        </span>
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section className="card card-pad">
          <header className="card-head">
            <div>
              <h2>交付物</h2>
              <p className="card-sub">版本需带校验和，新版本提交后重新验收。</p>
            </div>
          </header>
          <div className="enterprise-inline-form">
            <input
              className="input input-sm"
              value={deliverableName}
              aria-label="交付物名称"
              placeholder="交付物名称"
              onChange={(event) => setDeliverableName(event.target.value)}
            />
            <label className="checkbox">
              <input
                type="checkbox"
                checked={deliverableRequired}
                onChange={(event) => setDeliverableRequired(event.target.checked)}
              />
              必填
            </label>
            <button
              type="button"
              className="btn btn-soft btn-sm"
              disabled={busy || !deliverableName.trim()}
              onClick={() => void createDeliverable()}
            >
              <Icon name="plus" size={15} />
              创建
            </button>
          </div>
          {deliverables.length === 0 ? (
            <EnterpriseEmpty>当前项目还没有交付物。</EnterpriseEmpty>
          ) : (
            <ul className="enterprise-sublist">
              {deliverables.map((deliverable) => {
                const status = textOf(deliverable, 'status');
                return (
                  <li key={textOf(deliverable, 'id')}>
                    <div className="enterprise-subject">
                      <span>
                        {textOf(deliverable, 'name')}{' '}
                        {textOf(deliverable, 'required') === 'true' ? (
                          <ToneBadge tone="muted">必填</ToneBadge>
                        ) : null}
                        <ToneBadge tone={statusTone(status)}>{statusLabel(status)}</ToneBadge>
                      </span>
                      <span className="table-muted">
                        v{numberOf(deliverable, 'currentVersion')} ·{' '}
                        {taskTitles.get(textOf(deliverable, 'taskId')) ?? '未关联任务'}
                      </span>
                      <span className="enterprise-actions">
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          onClick={() => void openVersions(deliverable)}
                        >
                          版本
                        </button>
                        {manager && status !== 'approved' ? (
                          <>
                            <button
                              type="button"
                              className="btn btn-ghost btn-sm"
                              onClick={() => void reviewDeliverable(deliverable, 'approve')}
                            >
                              签收
                            </button>
                            <button
                              type="button"
                              className="btn btn-ghost btn-sm"
                              onClick={() => void reviewDeliverable(deliverable, 'reject')}
                            >
                              退回
                            </button>
                          </>
                        ) : null}
                      </span>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
          {selectedDeliverable ? (
            <div className="enterprise-inline-note">
              <strong>版本记录</strong>
              <ul className="enterprise-sublist">
                {versionList.map((version) => (
                  <li key={textOf(version, 'id')}>
                    v{numberOf(version, 'version')} · {textOf(version, 'filename')} ·{' '}
                    {statusLabel(textOf(version, 'status'))}
                  </li>
                ))}
              </ul>
              <div className="enterprise-inline-form">
                <input
                  className="input input-sm"
                  value={versionName}
                  aria-label="版本文件名"
                  placeholder="文件名"
                  onChange={(event) => setVersionName(event.target.value)}
                />
                <input
                  className="input input-sm"
                  value={versionChecksum}
                  aria-label="版本校验和"
                  placeholder="sha256 校验和"
                  onChange={(event) => setVersionChecksum(event.target.value)}
                />
                <input
                  className="input input-sm"
                  value={versionNote}
                  aria-label="版本说明"
                  placeholder="变更说明"
                  onChange={(event) => setVersionNote(event.target.value)}
                />
                <button
                  type="button"
                  className="btn btn-soft btn-sm"
                  disabled={busy || !versionName.trim()}
                  onClick={() => void addVersion()}
                >
                  提交版本
                </button>
              </div>
            </div>
          ) : null}
        </section>
      </div>

      <section className="card card-pad">
        <header className="card-head">
          <div>
            <h2>结项与收益复盘</h2>
            <p className="card-sub">结项前校验未完成任务与必填交付物，结项后按计划记录收益。</p>
          </div>
        </header>
        <label className="enterprise-inline-note">
          <span>审批说明（可选）</span>
          <input
            className="input input-sm"
            value={reviewNote}
            aria-label="审批说明"
            placeholder="填写审批或重开说明"
            onChange={(event) => setReviewNote(event.target.value)}
          />
        </label>
        {!closure ? (
          manager ? (
            <div className="enterprise-inline-form">
              <input
                className="input input-sm"
                value={acceptance}
                aria-label="验收项"
                placeholder="验收项（逗号分隔）"
                onChange={(event) => setAcceptance(event.target.value)}
              />
              <input
                className="input input-sm"
                value={openItems}
                aria-label="遗留项"
                placeholder="遗留项（逗号分隔）"
                onChange={(event) => setOpenItems(event.target.value)}
              />
              <input
                className="input input-sm enterprise-narrow"
                type="number"
                min={0}
                value={actualCost}
                aria-label="实际成本（元）"
                onChange={(event) => setActualCost(event.target.value)}
              />
              <input
                className="input input-sm"
                value={feedback}
                aria-label="结项反馈"
                placeholder="反馈"
                onChange={(event) => setFeedback(event.target.value)}
              />
              <input
                className="input input-sm"
                value={benefitLabel}
                aria-label="收益指标"
                placeholder="收益指标"
                onChange={(event) => setBenefitLabel(event.target.value)}
              />
              <input
                className="input input-sm enterprise-narrow"
                type="number"
                value={benefitTarget}
                aria-label="收益目标"
                placeholder="目标"
                onChange={(event) => setBenefitTarget(event.target.value)}
              />
              <input
                className="input input-sm"
                type="date"
                value={benefitDue}
                aria-label="收益复盘日期"
                onChange={(event) => setBenefitDue(event.target.value)}
              />
              <button
                type="button"
                className="btn btn-soft btn-sm"
                disabled={busy}
                onClick={() => void closeProject()}
              >
                提交结项
              </button>
            </div>
          ) : (
            <EnterpriseEmpty>项目尚未结项。</EnterpriseEmpty>
          )
        ) : (
          <>
            <div className="enterprise-inline-note">
              状态 {statusLabel(textOf(closure, 'status'))} · 实际成本{' '}
              {(numberOf(closure, 'actual_cost_cents') / 100).toFixed(2)} 元 ·{' '}
              {textOf(closure, 'feedback') || '无反馈'}
              {manager && textOf(closure, 'status') === 'closed' ? (
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => void reopen(closure)}
                >
                  重新打开
                </button>
              ) : null}
            </div>
            {benefits.length === 0 ? (
              <EnterpriseEmpty>尚未生成收益复盘计划。</EnterpriseEmpty>
            ) : (
              <ul className="enterprise-sublist">
                {benefits.map((review) => (
                  <li key={textOf(review, 'id')}>
                    <div className="enterprise-subject">
                      <span>
                        {formatDate(textOf(review, 'due_on'))}{' '}
                        <ToneBadge tone={statusTone(textOf(review, 'status'))}>
                          {statusLabel(textOf(review, 'status'))}
                        </ToneBadge>
                      </span>
                      <span className="table-muted">
                        实际值 {textOf(review, 'actual_json', '{}')}
                      </span>
                      {manager && textOf(review, 'status') === 'pending' ? (
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          onClick={() => void recordBenefit(review)}
                        >
                          记录收益
                        </button>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </section>

      {manager ? (
        <section className="card card-pad">
          <header className="card-head">
            <div>
              <h2>资源容量</h2>
              <p className="card-sub">调整成员可用工时并模拟供需缺口。</p>
            </div>
          </header>
          {capacity.length === 0 ? (
            <EnterpriseEmpty>暂无容量画像。</EnterpriseEmpty>
          ) : (
            <div className="card table-card">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>成员</th>
                    <th>周工时</th>
                    <th>供给</th>
                    <th>分配</th>
                    <th>缺口</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {capacity.map((row) => {
                    const userId = textOf(row, 'userId');
                    return (
                      <tr key={userId}>
                        <td>{textOf(row, 'userName')}</td>
                        <td>
                          <input
                            className="input input-sm enterprise-narrow"
                            type="number"
                            min={0}
                            max={168}
                            value={profileDraft[userId] ?? String(numberOf(row, 'weeklyHours'))}
                            aria-label={`${textOf(row, 'userName')} 周工时`}
                            onChange={(event) =>
                              setProfileDraft((current) => ({
                                ...current,
                                [userId]: event.target.value,
                              }))
                            }
                          />
                        </td>
                        <td>{numberOf(row, 'supplyHours')}</td>
                        <td>{numberOf(row, 'allocatedHours')}</td>
                        <td>{numberOf(row, 'gapHours')}</td>
                        <td>
                          <button
                            type="button"
                            className="btn btn-ghost btn-sm"
                            disabled={busy}
                            onClick={() => void saveProfile(row)}
                          >
                            保存
                          </button>
                          <button
                            type="button"
                            className="btn btn-ghost btn-sm"
                            disabled={busy}
                            onClick={() => void simulate(row)}
                          >
                            模拟
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {scenario ? (
            <div className="enterprise-inline-note">
              情景 {formatDate(scenario.from)} → {formatDate(scenario.to)}：
              {scenario.items
                .map(
                  (item) =>
                    `${textOf(item, 'userName')} 缺口 ${numberOf(item, 'proposedGapHours')} 小时`,
                )
                .join('；')}
            </div>
          ) : null}
        </section>
      ) : null}

      <Toaster toasts={toasts} onDismiss={dismiss} />
    </div>
  );
}
