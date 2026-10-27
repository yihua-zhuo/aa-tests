import { useEffect, useMemo, useState } from 'react';
import { api, type WorkbenchRecord } from '../../api.ts';
import { formatDate } from '../../format.ts';
import { useApi, useToast } from '../../hooks/useApi.ts';
import { EmptyState, Toaster } from '../ui.tsx';
import {
  EnterpriseEmpty,
  EnterpriseStat,
  type EnterpriseTabProps,
  EnterpriseToolbar,
  PeoplePicker,
  ProjectPicker,
  ToneBadge,
  textOf,
} from './shared.tsx';

type StatusTone = 'success' | 'danger' | 'muted' | 'active' | 'warning';

function toneFor(status: string): StatusTone {
  if (['accepted', 'running', 'assigned', 'met', 'completed'].includes(status)) return 'success';
  if (['declined', 'expired', 'rejected', 'breached'].includes(status)) return 'danger';
  if (['pending', 'recommended', 'paused'].includes(status)) return 'warning';
  return 'muted';
}

const STATUS_LABELS: Record<string, string> = {
  pending: '待处理',
  recommended: '待决策',
  assigned: '已分派',
  rejected: '已拒绝',
  accepted: '已接受',
  declined: '已拒绝',
  expired: '已过期',
  running: '计时中',
  paused: '已暂停',
  met: '已达成',
  breached: '已超时',
};

function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status;
}

function fieldOptions(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => String(item)) : [];
}

type FormField = {
  key: string;
  label: string;
  type: string;
  required?: boolean;
  options?: unknown[];
  visibleWhen?: { key?: string; equals?: unknown };
};

export function ExecutionTab({ projects, people }: EnterpriseTabProps) {
  const [projectId, setProjectId] = useState(projects[0]?.id ?? '');
  const { toasts, show, dismiss } = useToast();

  useEffect(() => {
    if (!projectId && projects[0]) setProjectId(projects[0].id);
  }, [projectId, projects]);

  const tasksState = useApi((signal) => api.projectTasks(projectId, signal), [projectId], {
    skip: !projectId,
  });
  const policiesState = useApi((signal) => api.slaPolicies(signal), []);
  const scalesState = useApi((signal) => api.estimateScales(signal), []);
  const formsState = useApi((signal) => api.taskForms(signal), []);

  const tasks = tasksState.data?.tasks ?? [];
  const policies = policiesState.data?.items ?? [];
  const scales = scalesState.data?.items ?? [];
  const forms = formsState.data?.items ?? [];

  const [taskId, setTaskId] = useState('');
  useEffect(() => {
    if (tasks.length > 0 && !tasks.some((task) => task.id === taskId)) {
      setTaskId(tasks[0]?.id ?? '');
    }
  }, [tasks, taskId]);

  const slaState = useApi((signal) => api.taskSlaInstances(taskId, signal), [taskId], {
    skip: !taskId,
  });
  const recommendationsState = useApi(
    (signal) => api.dispatchRecommendations(taskId, signal),
    [taskId],
    { skip: !taskId },
  );
  const handoffsState = useApi((signal) => api.handoffs(taskId, signal), [taskId], {
    skip: !taskId,
  });
  const checklistState = useApi((signal) => api.taskChecklist(taskId, signal), [taskId], {
    skip: !taskId,
  });

  const slaInstances = slaState.data?.items ?? [];
  const recommendations = recommendationsState.data?.items ?? [];
  const handoffs = handoffsState.data?.items ?? [];
  const checklist = checklistState.data?.items ?? [];
  const task = tasks.find((entry) => entry.id === taskId);

  const peopleMap = useMemo(
    () => new Map(people.map((person) => [person.id, person.name])),
    [people],
  );

  const [estimatePoints, setEstimatePoints] = useState('');
  const [estimateHours, setEstimateHours] = useState('');
  const [estimateSize, setEstimateSize] = useState('');
  const [scaleName, setScaleName] = useState('');
  const [scaleKeys, setScaleKeys] = useState('XS,S,M,L,XL');
  const [handoffTo, setHandoffTo] = useState('');
  const [handoffNote, setHandoffNote] = useState('');
  const [handoffDue, setHandoffDue] = useState('');
  const [recommendationNote, setRecommendationNote] = useState('');
  const [selectedFormId, setSelectedFormId] = useState('');
  const [formValues, setFormValues] = useState<Record<string, string | number | boolean>>({});
  const [formSignature, setFormSignature] = useState('');
  const [formCompleted, setFormCompleted] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (task) {
      setEstimatePoints(task.estimatePoints === null ? '' : String(task.estimatePoints ?? ''));
      setEstimateHours(task.estimateHours === null ? '' : String(task.estimateHours ?? ''));
      setEstimateSize(task.estimateSize ?? '');
    }
    setSelectedFormId('');
    setFormValues({});
    setFormSignature('');
    setFormCompleted(false);
  }, [task]);

  const selectedForm = forms.find((form) => form.id === selectedFormId);
  const formFields = ((selectedForm?.fields as FormField[] | undefined) ?? []).filter((field) => {
    const rule = field.visibleWhen;
    if (!rule?.key) return true;
    return formValues[rule.key] === rule.equals;
  });

  const reloadExecution = () => {
    slaState.reload();
    recommendationsState.reload();
    handoffsState.reload();
    checklistState.reload();
    tasksState.reload();
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

  const treeAction = (action: 'indent' | 'outdent' | 'delete') =>
    act(
      () => api.taskTreeBulk({ projectId, action, taskIds: [taskId], parentId: null }),
      '任务树已更新',
      reloadExecution,
    );

  const changeStatus = (status: string) =>
    act(
      () =>
        api.taskTreeBulk({
          projectId,
          action: 'status',
          taskIds: [taskId],
          parentId: null,
          status,
        }),
      '任务状态已更新',
      reloadExecution,
    );

  const saveEstimate = () =>
    act(
      () =>
        api.updateTaskEstimate(taskId, {
          estimatePoints: estimatePoints === '' ? null : Number(estimatePoints),
          estimateHours: estimateHours === '' ? null : Number(estimateHours),
          estimateSize: estimateSize === '' ? null : estimateSize,
        }),
      '估算已保存',
      reloadExecution,
    );

  const createScale = () =>
    act(
      () =>
        api.createEstimateScale({
          name: scaleName.trim(),
          values: scaleKeys
            .split(',')
            .map((key) => key.trim())
            .filter(Boolean)
            .map((key) => ({ key, label: key })),
        }),
      '估算量表已创建',
      () => {
        setScaleName('');
        scalesState.reload();
      },
    );

  const attachSla = () =>
    act(() => api.attachSla(taskId, { auto: true }), 'SLA 已关联', reloadExecution);

  const slaAction = (action: 'pause' | 'resume' | 'escalate' | 'respond' | 'review') =>
    act(
      () => api.taskSlaAction(taskId, action, recommendationNote.trim() || undefined),
      'SLA 动作已执行',
      reloadExecution,
    );

  const tickSla = () => act(() => api.tickSla(), 'SLA 扫描完成', reloadExecution);

  const recommend = () =>
    act(async () => {
      await api.recommendDispatch({ taskId });
      recommendationsState.reload();
    }, '推荐已生成');

  const decideRecommendation = (recommendation: WorkbenchRecord, mode: 'assign' | 'reject') =>
    act(
      () =>
        api.decideDispatch({
          recommendationId: textOf(recommendation, 'id'),
          mode,
          fallback: true,
        }),
      mode === 'assign' ? '已确认分派' : '已拒绝推荐',
      reloadExecution,
    );

  const assignAll = () =>
    act(
      () =>
        api.decideDispatchBatch({
          recommendationIds: recommendations
            .filter((item) => textOf(item, 'status') === 'recommended')
            .map((item) => textOf(item, 'id')),
          mode: 'assign',
          fallback: true,
        }),
      '批量分派完成',
      reloadExecution,
    );

  const createHandoff = () =>
    act(
      () =>
        api.createHandoff(taskId, {
          toUserId: handoffTo || people[0]?.id || '',
          note: handoffNote.trim() || undefined,
          dueAt: handoffDue ? `${handoffDue}T23:59:59.000Z` : undefined,
        }),
      '交接已创建',
      () => {
        setHandoffNote('');
        setHandoffDue('');
        handoffsState.reload();
      },
    );

  const decideHandoff = (handoff: WorkbenchRecord, action: 'accept' | 'decline') =>
    act(
      () =>
        api.decideHandoff(textOf(handoff, 'id'), {
          action,
          note: recommendationNote.trim() || undefined,
          confirmChecklist: action === 'accept',
        }),
      action === 'accept' ? '交接已接受' : '交接已拒绝',
      reloadExecution,
    );

  const tickHandoffs = () => act(() => api.tickHandoffs(), '交接扫描完成', reloadExecution);

  const toggleChecklist = (item: WorkbenchRecord) =>
    act(
      () =>
        api.updateChecklistItem(textOf(item, 'id'), {
          done: !item.done,
        }),
      '检查项已更新',
      () => checklistState.reload(),
    );

  const submitForm = () =>
    act(
      () =>
        api.putTaskFormValues(taskId, selectedFormId, {
          values: formValues,
          completed: formCompleted,
          signature: formSignature.trim() || undefined,
        }),
      formCompleted ? '表单已提交' : '表单草稿已保存',
    );

  if (!projectId) {
    return (
      <div className="card card-pad">
        <EmptyState icon="check" title="请选择项目" compact />
      </div>
    );
  }

  return (
    <div className="enterprise-tab">
      <EnterpriseToolbar>
        <ProjectPicker projects={projects} value={projectId} onChange={setProjectId} />
        <label className="enterprise-picker">
          <span>选择任务</span>
          <select
            className="input input-sm"
            value={taskId}
            aria-label="选择任务"
            onChange={(event) => setTaskId(event.target.value)}
          >
            {tasks.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.title}
              </option>
            ))}
          </select>
        </label>
        <p className="enterprise-hint">任务树、估算、SLA、分派、交接与表单统一按任务操作。</p>
      </EnterpriseToolbar>

      {!task ? (
        <div className="card card-pad">
          <EmptyState icon="check" title="当前项目还没有任务" compact />
        </div>
      ) : (
        <>
          <div className="enterprise-stats">
            <EnterpriseStat label="SLA 实例" value={slaInstances.length} hint="计时与升级" />
            <EnterpriseStat
              label="待决策推荐"
              value={
                recommendations.filter((item) => textOf(item, 'status') === 'recommended').length
              }
              hint="自动分派候选"
              tone="mint"
            />
            <EnterpriseStat
              label="交接"
              value={handoffs.length}
              hint={`${handoffs.filter((item) => textOf(item, 'status') === 'pending').length} 待确认`}
              tone="sky"
            />
            <EnterpriseStat
              label="检查项"
              value={checklist.filter((item) => Boolean(item.done)).length}
              hint={`共 ${checklist.length} 项`}
              tone="peach"
            />
          </div>

          <div className="enterprise-columns">
            <section className="card card-pad">
              <header className="card-head">
                <div>
                  <h2>任务树与估算</h2>
                  <p className="card-sub">
                    批量缩进/提升任务层级，并设置故事点、工时或 T-shirt 量级。
                  </p>
                </div>
              </header>
              <div className="enterprise-inline-form">
                {['todo', 'in_progress', 'review', 'done'].map((status) => (
                  <button
                    key={status}
                    type="button"
                    className="btn btn-ghost btn-sm"
                    disabled={busy}
                    onClick={() => void changeStatus(status)}
                  >
                    {status === 'todo'
                      ? '待办'
                      : status === 'in_progress'
                        ? '进行中'
                        : status === 'review'
                          ? '待审核'
                          : '完成'}
                  </button>
                ))}
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  disabled={busy}
                  onClick={() => void treeAction('indent')}
                >
                  缩进
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  disabled={busy}
                  onClick={() => void treeAction('outdent')}
                >
                  提升
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  disabled={busy}
                  onClick={() => void treeAction('delete')}
                >
                  删除
                </button>
              </div>
              <div className="enterprise-inline-form">
                <input
                  className="input input-sm enterprise-narrow"
                  type="number"
                  min={0}
                  value={estimatePoints}
                  aria-label="故事点"
                  placeholder="故事点"
                  onChange={(event) => setEstimatePoints(event.target.value)}
                />
                <input
                  className="input input-sm enterprise-narrow"
                  type="number"
                  min={0}
                  step="0.5"
                  value={estimateHours}
                  aria-label="估算工时"
                  placeholder="估算工时"
                  onChange={(event) => setEstimateHours(event.target.value)}
                />
                <input
                  className="input input-sm enterprise-narrow"
                  value={estimateSize}
                  aria-label="估算量级"
                  placeholder="量级"
                  onChange={(event) => setEstimateSize(event.target.value)}
                />
                <button
                  type="button"
                  className="btn btn-soft btn-sm"
                  disabled={busy}
                  onClick={() => void saveEstimate()}
                >
                  保存估算
                </button>
              </div>
              <div className="enterprise-inline-form">
                <input
                  className="input input-sm"
                  value={scaleName}
                  aria-label="量级名称"
                  placeholder="自定义量级名称"
                  onChange={(event) => setScaleName(event.target.value)}
                />
                <input
                  className="input input-sm"
                  value={scaleKeys}
                  aria-label="量级取值"
                  placeholder="XS,S,M,L"
                  onChange={(event) => setScaleKeys(event.target.value)}
                />
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  disabled={busy || !scaleName.trim()}
                  onClick={() => void createScale()}
                >
                  新增量表
                </button>
              </div>
              <p className="table-muted">
                可用自定义量表：{scales.map((scale) => textOf(scale, 'name')).join('、') || '无'}
              </p>
            </section>

            <section className="card card-pad">
              <header className="card-head">
                <div>
                  <h2>任务 SLA</h2>
                  <p className="card-sub">关联响应/处理 SLA，暂停、恢复、升级并扫描超时。</p>
                </div>
              </header>
              <div className="enterprise-inline-form">
                <button
                  type="button"
                  className="btn btn-soft btn-sm"
                  disabled={busy}
                  onClick={() => void attachSla()}
                >
                  自动匹配策略
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  disabled={busy}
                  onClick={() => void tickSla()}
                >
                  扫描超时
                </button>
                <span className="table-muted">
                  {policies.length} 个策略：
                  {policies.map((policy) => textOf(policy, 'name')).join('、')}
                </span>
              </div>
              {slaInstances.length === 0 ? (
                <EnterpriseEmpty>当前任务未关联 SLA。</EnterpriseEmpty>
              ) : (
                <ul className="enterprise-sublist">
                  {slaInstances.map((instance) => (
                    <li key={textOf(instance, 'id')}>
                      <div className="enterprise-subject">
                        <span>
                          {statusLabel(textOf(instance, 'state'))}{' '}
                          <ToneBadge tone={toneFor(textOf(instance, 'state'))}>
                            {textOf(instance, 'policyName') || 'SLA'}
                          </ToneBadge>
                        </span>
                        <span className="table-muted">
                          响应截止 {formatDate(textOf(instance, 'responseDueAt'))} · 升级{' '}
                          {numberOfLevel(instance)}
                        </span>
                        <span className="enterprise-actions">
                          <button
                            type="button"
                            className="btn btn-ghost btn-sm"
                            disabled={busy}
                            onClick={() => void slaAction('pause')}
                          >
                            暂停
                          </button>
                          <button
                            type="button"
                            className="btn btn-ghost btn-sm"
                            disabled={busy}
                            onClick={() => void slaAction('resume')}
                          >
                            恢复
                          </button>
                          <button
                            type="button"
                            className="btn btn-ghost btn-sm"
                            disabled={busy}
                            onClick={() => void slaAction('escalate')}
                          >
                            升级
                          </button>
                        </span>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>

          <div className="enterprise-columns">
            <section className="card card-pad">
              <header className="card-head">
                <div>
                  <h2>自动分派</h2>
                  <p className="card-sub">按技能、负载与优先级推荐负责人，可逐条或批量确认。</p>
                </div>
              </header>
              <div className="enterprise-inline-form">
                <button
                  type="button"
                  className="btn btn-soft btn-sm"
                  disabled={busy}
                  onClick={() => void recommend()}
                >
                  生成推荐
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  disabled={
                    busy ||
                    recommendations.every((item) => textOf(item, 'status') !== 'recommended')
                  }
                  onClick={() => void assignAll()}
                >
                  批量接受
                </button>
              </div>
              {recommendations.length === 0 ? (
                <EnterpriseEmpty>当前任务暂无分派推荐。</EnterpriseEmpty>
              ) : (
                <ul className="enterprise-sublist">
                  {recommendations.map((recommendation) => (
                    <li key={textOf(recommendation, 'id')}>
                      <div className="enterprise-subject">
                        <span>
                          {peopleMap.get(textOf(recommendation, 'candidateId')) || '候选人'}{' '}
                          <ToneBadge tone={toneFor(textOf(recommendation, 'status'))}>
                            {statusLabel(textOf(recommendation, 'status'))}
                          </ToneBadge>
                        </span>
                        <span className="table-muted">
                          得分 {numberOfScore(recommendation)} ·{' '}
                          {(recommendation.reasons as unknown[] | undefined)?.join('、') ||
                            '综合评分'}
                        </span>
                        {textOf(recommendation, 'status') === 'recommended' ? (
                          <span className="enterprise-actions">
                            <button
                              type="button"
                              className="btn btn-ghost btn-sm"
                              disabled={busy}
                              onClick={() => void decideRecommendation(recommendation, 'assign')}
                            >
                              接受
                            </button>
                            <button
                              type="button"
                              className="btn btn-ghost btn-sm"
                              disabled={busy}
                              onClick={() => void decideRecommendation(recommendation, 'reject')}
                            >
                              拒绝
                            </button>
                          </span>
                        ) : null}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="card card-pad">
              <header className="card-head">
                <div>
                  <h2>任务交接</h2>
                  <p className="card-sub">交接清单自动汇总未完成事项，接收方需确认。</p>
                </div>
              </header>
              <div className="enterprise-inline-form">
                <PeoplePicker
                  people={people}
                  value={handoffTo || people[0]?.id || ''}
                  onChange={setHandoffTo}
                  label="接收人"
                />
                <input
                  className="input input-sm"
                  value={handoffNote}
                  aria-label="交接说明"
                  placeholder="交接说明"
                  onChange={(event) => setHandoffNote(event.target.value)}
                />
                <input
                  className="input input-sm"
                  type="date"
                  value={handoffDue}
                  aria-label="交接截止日期"
                  onChange={(event) => setHandoffDue(event.target.value)}
                />
                <button
                  type="button"
                  className="btn btn-soft btn-sm"
                  disabled={busy || people.length === 0}
                  onClick={() => void createHandoff()}
                >
                  发起交接
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  disabled={busy}
                  onClick={() => void tickHandoffs()}
                >
                  扫描过期
                </button>
              </div>
              {handoffs.length === 0 ? (
                <EnterpriseEmpty>当前任务没有交接记录。</EnterpriseEmpty>
              ) : (
                <ul className="enterprise-sublist">
                  {handoffs.map((handoff) => (
                    <li key={textOf(handoff, 'id')}>
                      <div className="enterprise-subject">
                        <span>
                          {peopleMap.get(textOf(handoff, 'fromUser')) || '发起人'} →{' '}
                          {peopleMap.get(textOf(handoff, 'toUser')) || '接收人'}{' '}
                          <ToneBadge tone={toneFor(textOf(handoff, 'status'))}>
                            {statusLabel(textOf(handoff, 'status'))}
                          </ToneBadge>
                        </span>
                        <span className="table-muted">
                          {textOf(handoff, 'note') || '无说明'} · 截止{' '}
                          {formatDate(textOf(handoff, 'dueAt'))}
                        </span>
                        {textOf(handoff, 'status') === 'pending' ? (
                          <span className="enterprise-actions">
                            <button
                              type="button"
                              className="btn btn-ghost btn-sm"
                              disabled={busy}
                              onClick={() => void decideHandoff(handoff, 'accept')}
                            >
                              接受
                            </button>
                            <button
                              type="button"
                              className="btn btn-ghost btn-sm"
                              disabled={busy}
                              onClick={() => void decideHandoff(handoff, 'decline')}
                            >
                              拒绝
                            </button>
                          </span>
                        ) : null}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>

          <div className="enterprise-columns">
            <section className="card card-pad">
              <header className="card-head">
                <div>
                  <h2>完成检查清单</h2>
                  <p className="card-sub">必填检查项未完成时，表单不能标记完成。</p>
                </div>
              </header>
              {checklist.length === 0 ? (
                <EnterpriseEmpty>当前任务没有检查项。</EnterpriseEmpty>
              ) : (
                <ul className="enterprise-sublist">
                  {checklist.map((item) => (
                    <li key={textOf(item, 'id')}>
                      <label className="checkbox">
                        <input
                          type="checkbox"
                          checked={Boolean(item.done)}
                          disabled={busy}
                          onChange={() => void toggleChecklist(item)}
                        />
                        {textOf(item, 'label')}
                        {item.required ? <ToneBadge tone="muted">必填</ToneBadge> : null}
                      </label>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="card card-pad">
              <header className="card-head">
                <div>
                  <h2>动态表单</h2>
                  <p className="card-sub">按表单定义渲染字段，服务端会重新校验所有规则。</p>
                </div>
              </header>
              <div className="enterprise-inline-form">
                <select
                  className="input input-sm"
                  value={selectedFormId}
                  aria-label="选择表单"
                  onChange={(event) => {
                    setSelectedFormId(event.target.value);
                    setFormValues({});
                  }}
                >
                  <option value="">选择表单</option>
                  {forms.map((form) => (
                    <option key={form.id} value={form.id}>
                      {textOf(form, 'name')}
                    </option>
                  ))}
                </select>
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={formCompleted}
                    onChange={(event) => setFormCompleted(event.target.checked)}
                  />
                  标记完成
                </label>
              </div>
              {selectedForm ? (
                <div className="enterprise-form">
                  {formFields.map((field) => {
                    const value = formValues[field.key];
                    const label = `${field.label}${field.required ? ' *' : ''}`;
                    if (field.type === 'textarea') {
                      return (
                        <label key={field.key} className="field">
                          <span>{label}</span>
                          <textarea
                            className="input textarea"
                            value={String(value ?? '')}
                            onChange={(event) =>
                              setFormValues((current) => ({
                                ...current,
                                [field.key]: event.target.value,
                              }))
                            }
                          />
                        </label>
                      );
                    }
                    if (field.type === 'select') {
                      return (
                        <label key={field.key} className="field">
                          <span>{label}</span>
                          <select
                            className="input"
                            value={String(value ?? '')}
                            onChange={(event) =>
                              setFormValues((current) => ({
                                ...current,
                                [field.key]: event.target.value,
                              }))
                            }
                          >
                            <option value="">请选择</option>
                            {fieldOptions(field.options).map((option) => (
                              <option key={option} value={option}>
                                {option}
                              </option>
                            ))}
                          </select>
                        </label>
                      );
                    }
                    if (field.type === 'checkbox') {
                      return (
                        <label key={field.key} className="checkbox">
                          <input
                            type="checkbox"
                            checked={Boolean(value)}
                            onChange={(event) =>
                              setFormValues((current) => ({
                                ...current,
                                [field.key]: event.target.checked,
                              }))
                            }
                          />
                          {label}
                        </label>
                      );
                    }
                    return (
                      <label key={field.key} className="field">
                        <span>{label}</span>
                        <input
                          className="input"
                          type={
                            field.type === 'number'
                              ? 'number'
                              : field.type === 'date'
                                ? 'date'
                                : 'text'
                          }
                          value={String(value ?? '')}
                          onChange={(event) =>
                            setFormValues((current) => ({
                              ...current,
                              [field.key]:
                                field.type === 'number'
                                  ? Number(event.target.value)
                                  : event.target.value,
                            }))
                          }
                        />
                      </label>
                    );
                  })}
                  <label className="field">
                    <span>签名确认</span>
                    <input
                      className="input"
                      value={formSignature}
                      aria-label="签名确认"
                      onChange={(event) => setFormSignature(event.target.value)}
                    />
                  </label>
                  <button
                    type="button"
                    className="btn btn-soft btn-sm"
                    disabled={busy}
                    onClick={() => void submitForm()}
                  >
                    {formCompleted ? '提交表单' : '保存草稿'}
                  </button>
                </div>
              ) : (
                <EnterpriseEmpty>选择表单后填写字段。</EnterpriseEmpty>
              )}
            </section>
          </div>

          <section className="card card-pad">
            <header className="card-head">
              <div>
                <h2>SLA 操作说明</h2>
                <p className="card-sub">暂停、恢复、升级等动作会写入审计；可填写说明后再执行。</p>
              </div>
            </header>
            <div className="enterprise-inline-form">
              <input
                className="input input-sm"
                value={recommendationNote}
                aria-label="操作说明"
                placeholder="操作说明（可选）"
                onChange={(event) => setRecommendationNote(event.target.value)}
              />
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                disabled={busy}
                onClick={() => void slaAction('respond')}
              >
                记录响应
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                disabled={busy}
                onClick={() => void slaAction('review')}
              >
                记录审核
              </button>
            </div>
          </section>
        </>
      )}

      <Toaster toasts={toasts} onDismiss={dismiss} />
    </div>
  );
}

function numberOfLevel(record: WorkbenchRecord): number {
  const value = Number(record.escalatedLevel ?? 0);
  return Number.isFinite(value) ? value : 0;
}

function numberOfScore(record: WorkbenchRecord): number {
  const value = Number(record.score ?? 0);
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : 0;
}
