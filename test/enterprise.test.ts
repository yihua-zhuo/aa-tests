import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Hono } from 'hono';
import type {
  AutomationPreview,
  AutomationRule,
  AutomationRun,
  BlockerReport,
  BudgetSummary,
  CriticalPath,
  DecisionRecord,
  DecisionVersion,
  DocumentVersion,
  Goal,
  GoalImpact,
  GoalTree,
  JitGrant,
  KeyResult,
  MetricDefinition,
  MetricEvaluation,
  PermissionSimulationResult,
  PortfolioConfig,
  PortfolioScore,
  ProjectDetail,
  ProjectDocument,
  RecurrenceRule,
  Role,
  Task,
  TaskBlocker,
  TaskDependency,
  TimeLog,
  TimeSummary,
} from '../shared/types.ts';
import type { AppEnv } from '../src/app-env.ts';
import {
  DEMO,
  getJson,
  login,
  PASSWORD,
  sendJson,
  TEST_NOW,
  testApp,
  testStore,
} from './helpers.ts';

const ROLES = ['admin', 'manager', 'pm', 'viewer'] as const;

type Ctx = {
  store: ReturnType<typeof testStore>;
  app: Hono<AppEnv>;
  cookies: Record<Role, string>;
};

async function setup(): Promise<Ctx> {
  const store = testStore();
  const { app } = testApp(store);
  const cookies = {} as Record<Role, string>;
  for (const role of ROLES) cookies[role] = await login(app, DEMO[role].email, PASSWORD);
  return { store, app, cookies };
}

async function createProject(
  app: Hono<AppEnv>,
  cookie: string,
  name: string,
  extra: Record<string, unknown> = {},
): Promise<ProjectDetail> {
  const result = await sendJson<ProjectDetail>(app, cookie, 'POST', '/api/projects', {
    name,
    ...extra,
  });
  assert.equal(result.status, 201, JSON.stringify(result.body));
  return result.body;
}

async function createTask(
  app: Hono<AppEnv>,
  cookie: string,
  projectId: string,
  body: Record<string, unknown>,
): Promise<Task> {
  const result = await sendJson<Task>(
    app,
    cookie,
    'POST',
    `/api/projects/${projectId}/tasks`,
    body,
  );
  assert.equal(result.status, 201, JSON.stringify(result.body));
  return result.body;
}

async function remove(app: Hono<AppEnv>, cookie: string, path: string): Promise<Response> {
  return await app.request(path, { method: 'DELETE', headers: { cookie } });
}

test('goals support key results, optimistic concurrency, impact previews and change logs', async () => {
  const { store, app, cookies } = await setup();
  try {
    const created = await sendJson<Goal>(app, cookies.admin, 'POST', '/api/goals', {
      title: '年度营收目标',
      level: 'company',
      baseline: 0,
      target: 100,
      actual: 25,
      unit: '百万',
      period: '2026',
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.progress, 25);
    assert.equal(created.body.version, 1);
    assert.equal(created.body.ownerName, DEMO.admin.name);

    const denied = await sendJson(app, cookies.pm, 'POST', '/api/goals', { title: '越权目标' });
    assert.equal(denied.status, 403);

    const keyResult = await sendJson<KeyResult>(
      app,
      cookies.admin,
      'POST',
      `/api/goals/${created.body.id}/key-results`,
      { title: '新签合同额', target: 10, actual: 5, weight: 1 },
    );
    assert.equal(keyResult.status, 201);
    assert.equal(keyResult.body.progress, 50);

    const afterKeyResult = await getJson<Goal>(app, cookies.admin, `/api/goals/${created.body.id}`);
    assert.equal(afterKeyResult.progress, 50);
    assert.equal(afterKeyResult.keyResults.length, 1);
    assert.equal(afterKeyResult.version, 2);

    const updated = await sendJson<Goal>(
      app,
      cookies.admin,
      'PATCH',
      `/api/goals/${created.body.id}`,
      { actual: 60, version: afterKeyResult.version, reason: '季度复盘调整' },
    );
    assert.equal(updated.status, 200);
    assert.equal(updated.body.actual, 60);
    assert.equal(updated.body.version, 3);

    const stale = await sendJson<{ error: string; current: Goal }>(
      app,
      cookies.admin,
      'PATCH',
      `/api/goals/${created.body.id}`,
      { actual: 90, version: afterKeyResult.version },
    );
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error, 'conflict');
    assert.equal(stale.body.current.actual, 60);
    assert.equal(stale.body.current.version, 3);

    const changes = await getJson<Record<string, unknown>[]>(
      app,
      cookies.admin,
      `/api/goals/${created.body.id}/changes`,
    );
    assert.equal(changes.length, 1);
    const [change] = changes;
    assert.ok(change);
    assert.equal(change.reason, '季度复盘调整');
    assert.equal(change.actorName, DEMO.admin.name);
    assert.equal((change.before as Record<string, unknown>).actual, 25);
    assert.equal((change.after as Record<string, unknown>).actual, 60);

    const impact = await sendJson<GoalImpact>(
      app,
      cookies.admin,
      'POST',
      `/api/goals/${created.body.id}/impact`,
      { target: 130 },
    );
    assert.equal(impact.status, 200);
    assert.equal(impact.body.expectedVersion, 3);
    assert.equal(impact.body.risk, 'high');
    assert.ok(impact.body.owners.some((owner) => owner.id === DEMO.admin.id));

    const missingProject = await sendJson(app, cookies.admin, 'POST', '/api/goals', {
      title: '缺少项目的目标',
      level: 'project',
    });
    assert.equal(missingProject.status, 400);

    const privateProject = await createProject(app, cookies.admin, '私有目标项目', {
      visibility: 'private',
    });
    const scoped = await sendJson<Goal>(app, cookies.admin, 'POST', '/api/goals', {
      title: '私有项目目标',
      level: 'project',
      projectId: privateProject.id,
      target: 10,
    });
    assert.equal(scoped.status, 201);
    assert.equal(scoped.body.projectId, privateProject.id);

    const hidden = await app.request(`/api/goals/${scoped.body.id}`, {
      headers: { cookie: cookies.pm },
    });
    assert.equal(hidden.status, 404, 'invisible project goals are indistinguishable from missing');

    const adminList = await getJson<GoalTree>(app, cookies.admin, '/api/goals');
    const pmList = await getJson<GoalTree>(app, cookies.pm, '/api/goals');
    assert.ok(adminList.goals.some((goal) => goal.id === scoped.body.id));
    assert.ok(!pmList.goals.some((goal) => goal.id === scoped.body.id));
    assert.ok(adminList.roots.includes(created.body.id));
  } finally {
    store.close();
  }
});

test('portfolio scoring validates weights, factors and overrides', async () => {
  const { store, app, cookies } = await setup();
  try {
    const project = await createProject(app, cookies.admin, '组合评分项目', {
      memberIds: [DEMO.pm.id],
    });

    const badWeights = await sendJson(app, cookies.admin, 'POST', '/api/portfolio/configs', {
      name: '非法权重',
      weights: [
        { key: 'value', weight: 0.6 },
        { key: 'delivery', weight: 0.5 },
      ],
    });
    assert.equal(badWeights.status, 400);

    const config = await sendJson<PortfolioConfig>(
      app,
      cookies.admin,
      'POST',
      '/api/portfolio/configs',
      {
        name: '企业价值评分',
        weights: [
          { key: 'value', weight: 0.6 },
          { key: 'delivery', weight: 0.4 },
        ],
      },
    );
    assert.equal(config.status, 201);
    assert.equal(config.body.weights.length, 2);

    const scored = await sendJson<PortfolioScore>(
      app,
      cookies.admin,
      'POST',
      '/api/portfolio/scores',
      {
        projectId: project.id,
        configId: config.body.id,
        factors: [
          { key: 'value', value: 4 },
          { key: 'delivery', value: 3 },
        ],
      },
    );
    assert.equal(scored.status, 200);
    assert.equal(scored.body.score, 3.6);
    assert.equal(scored.body.effectiveScore, 3.6);

    const missingReason = await sendJson(app, cookies.admin, 'POST', '/api/portfolio/scores', {
      projectId: project.id,
      configId: config.body.id,
      factors: [{ key: 'value', value: 4 }],
      overrideScore: 4.5,
    });
    assert.equal(missingReason.status, 400);

    const override = await sendJson<PortfolioScore>(
      app,
      cookies.admin,
      'POST',
      '/api/portfolio/scores',
      {
        projectId: project.id,
        configId: config.body.id,
        factors: [
          { key: 'value', value: 4 },
          { key: 'delivery', value: 3 },
        ],
        overrideScore: 4.5,
        overrideReason: '战略优先级调整',
      },
    );
    assert.equal(override.status, 200);
    assert.equal(override.body.effectiveScore, 4.5);

    const unknown = await sendJson(app, cookies.admin, 'POST', '/api/portfolio/scores', {
      projectId: project.id,
      configId: config.body.id,
      factors: [{ key: 'bogus', value: 3 }],
    });
    assert.equal(unknown.status, 400);

    const denied = await sendJson(app, cookies.pm, 'POST', '/api/portfolio/scores', {
      projectId: project.id,
      configId: config.body.id,
      factors: [{ key: 'value', value: 5 }],
    });
    assert.equal(denied.status, 403, 'viewers of a project cannot rescore it');

    const scores = await getJson<PortfolioScore[]>(
      app,
      cookies.admin,
      `/api/portfolio/scores?configId=${config.body.id}`,
    );
    assert.equal(scores.length, 1);
    assert.equal(scores[0]?.projectId, project.id);
  } finally {
    store.close();
  }
});

test('dependencies detect cycles and the critical path highlights the chain', async () => {
  const { store, app, cookies } = await setup();
  try {
    const project = await createProject(app, cookies.admin, '计划项目', {
      memberIds: [DEMO.pm.id],
    });
    const first = await createTask(app, cookies.admin, project.id, {
      title: '需求',
      estimateHours: 8,
    });
    const second = await createTask(app, cookies.admin, project.id, {
      title: '开发',
      estimateHours: 16,
    });
    const third = await createTask(app, cookies.admin, project.id, {
      title: '上线',
      estimateHours: 8,
    });

    const edge = await sendJson<TaskDependency>(
      app,
      cookies.admin,
      'POST',
      `/api/projects/${project.id}/dependencies`,
      { predecessorId: first.id, successorId: second.id, type: 'FS' },
    );
    assert.equal(edge.status, 201);
    assert.equal(edge.body.lagDays, 0);

    const secondEdge = await sendJson<TaskDependency>(
      app,
      cookies.admin,
      'POST',
      `/api/projects/${project.id}/dependencies`,
      { predecessorId: second.id, successorId: third.id },
    );
    assert.equal(secondEdge.status, 201);

    const cycle = await sendJson(
      app,
      cookies.admin,
      'POST',
      `/api/projects/${project.id}/dependencies`,
      {
        predecessorId: third.id,
        successorId: first.id,
      },
    );
    assert.equal(cycle.status, 400);

    const dependencies = await getJson<TaskDependency[]>(
      app,
      cookies.pm,
      `/api/projects/${project.id}/dependencies`,
    );
    assert.equal(dependencies.length, 2);

    const path = await getJson<CriticalPath>(
      app,
      cookies.admin,
      `/api/projects/${project.id}/critical-path`,
    );
    assert.equal(path.nodes.length, 3);
    assert.equal(path.chain.length, 3);
    assert.deepEqual(path.cycles, []);
    assert.ok(path.estimatedCompletion);

    const denied = await sendJson(
      app,
      cookies.pm,
      'POST',
      `/api/projects/${project.id}/dependencies`,
      {
        predecessorId: first.id,
        successorId: third.id,
      },
    );
    assert.equal(denied.status, 403);

    const privateProject = await createProject(app, cookies.admin, '隐藏计划项目', {
      visibility: 'private',
    });
    const hidden = await app.request(`/api/projects/${privateProject.id}/critical-path`, {
      headers: { cookie: cookies.pm },
    });
    assert.equal(hidden.status, 404);
  } finally {
    store.close();
  }
});

test('blockers capture evidence and surface conflicts on repeated resolution', async () => {
  const { store, app, cookies } = await setup();
  try {
    const project = await createProject(app, cookies.admin, '阻塞项目', {
      memberIds: [DEMO.pm.id],
    });
    const task = await createTask(app, cookies.admin, project.id, { title: '等待审批' });

    const blocker = await sendJson<TaskBlocker>(
      app,
      cookies.admin,
      'POST',
      `/api/tasks/${task.id}/blockers`,
      { reason: '等待安全评审', category: 'external', ownerTeam: '安全团队' },
    );
    assert.equal(blocker.status, 201);
    assert.equal(blocker.body.status, 'open');
    assert.equal(blocker.body.version, 1);

    const report = await getJson<BlockerReport>(
      app,
      cookies.admin,
      `/api/projects/${project.id}/blockers/report`,
    );
    assert.equal(report.open, 1);
    assert.equal(report.resolved, 0);
    assert.deepEqual(report.byCategory, [{ category: 'external', count: 1 }]);

    const resolved = await sendJson<TaskBlocker>(
      app,
      cookies.admin,
      'POST',
      `/api/projects/${project.id}/blockers/${blocker.body.id}/resolve`,
      { evidence: '安全评审已通过', version: 1 },
    );
    assert.equal(resolved.status, 200);
    assert.equal(resolved.body.status, 'resolved');
    assert.equal(resolved.body.resolvedByName, DEMO.admin.name);

    const stale = await sendJson<{ error: string; current: TaskBlocker }>(
      app,
      cookies.admin,
      'POST',
      `/api/projects/${project.id}/blockers/${blocker.body.id}/resolve`,
      { evidence: '重复提交', version: 1 },
    );
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error, 'conflict');
    assert.equal(stale.body.current.status, 'resolved');

    const listed = await getJson<TaskBlocker[]>(
      app,
      cookies.admin,
      `/api/projects/${project.id}/blockers?status=resolved`,
    );
    assert.equal(listed.length, 1);

    const denied = await sendJson(app, cookies.pm, 'POST', `/api/tasks/${task.id}/blockers`, {
      reason: '越权阻塞',
    });
    assert.equal(denied.status, 201, 'project viewers may report blockers');
    const deniedResolve = await sendJson(
      app,
      cookies.pm,
      'POST',
      `/api/projects/${project.id}/blockers/${blocker.body.id}/resolve`,
      { evidence: '越权解除', version: 2 },
    );
    assert.equal(deniedResolve.status, 403);
  } finally {
    store.close();
  }
});

test('time logs honour idempotency keys and version checks', async () => {
  const { store, app, cookies } = await setup();
  try {
    const project = await createProject(app, cookies.admin, '工时项目');
    const task = await createTask(app, cookies.admin, project.id, {
      title: '实现接口',
      estimateHours: 4,
    });
    const other = await createTask(app, cookies.admin, project.id, { title: '另一个任务' });

    const log = await sendJson<TimeLog>(
      app,
      cookies.admin,
      'POST',
      `/api/tasks/${task.id}/time-logs`,
      {
        minutes: 90,
        workDate: '2026-06-10',
        note: '第一轮实现',
        idempotencyKey: 'time-log-1',
      },
    );
    assert.equal(log.status, 201);
    assert.equal(log.body.minutes, 90);

    const replay = await sendJson<TimeLog>(
      app,
      cookies.admin,
      'POST',
      `/api/tasks/${task.id}/time-logs`,
      { minutes: 30, workDate: '2026-06-11', idempotencyKey: 'time-log-1' },
    );
    assert.equal(replay.status, 201);
    assert.equal(replay.body.id, log.body.id, 'replayed requests return the original log');
    assert.equal(replay.body.minutes, 90);

    const reused = await sendJson(app, cookies.admin, 'POST', `/api/tasks/${other.id}/time-logs`, {
      minutes: 10,
      workDate: '2026-06-11',
      idempotencyKey: 'time-log-1',
    });
    assert.equal(reused.status, 400, 'an idempotency key cannot cross tasks');

    const updated = await sendJson<TimeLog>(
      app,
      cookies.admin,
      'PATCH',
      `/api/tasks/${task.id}/time-logs/${log.body.id}`,
      { minutes: 120, version: 1 },
    );
    assert.equal(updated.status, 200);
    assert.equal(updated.body.minutes, 120);
    assert.equal(updated.body.version, 2);

    const stale = await sendJson<{ error: string }>(
      app,
      cookies.admin,
      'PATCH',
      `/api/tasks/${task.id}/time-logs/${log.body.id}`,
      { minutes: 60, version: 1 },
    );
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error, 'conflict');

    const summary = await getJson<TimeSummary>(
      app,
      cookies.admin,
      `/api/tasks/${task.id}/time-logs/summary`,
    );
    assert.equal(summary.actualMinutes, 120);
    assert.equal(summary.actualHours, 2);
    assert.equal(summary.varianceHours, -2);
    assert.equal(summary.logs.length, 1);
  } finally {
    store.close();
  }
});

test('recurring tasks generate occurrences once and report the next date', async () => {
  const { store, app, cookies } = await setup();
  try {
    const project = await createProject(app, cookies.admin, '重复任务项目', {
      memberIds: [DEMO.pm.id],
    });

    const invalid = await sendJson(
      app,
      cookies.admin,
      'POST',
      `/api/projects/${project.id}/recurrences`,
      {
        title: '非法规则',
        rule: 'every day',
        startsOn: '2026-06-01',
      },
    );
    assert.equal(invalid.status, 400);

    const rule = await sendJson<RecurrenceRule>(
      app,
      cookies.admin,
      'POST',
      `/api/projects/${project.id}/recurrences`,
      {
        title: '隔日巡检',
        rule: 'FREQ=DAILY;INTERVAL=2',
        startsOn: '2026-06-01',
        endsOn: '2026-06-05',
        priority: 'high',
      },
    );
    assert.equal(rule.status, 201);
    assert.equal(rule.body.active, true);

    const firstRun = await sendJson<{
      generated: { date: string; taskId: string }[];
      skipped: string[];
      nextOccurrence: string | null;
    }>(app, cookies.admin, 'POST', `/api/recurrences/${rule.body.id}/run`, {
      through: '2026-06-10',
    });
    assert.equal(firstRun.status, 200);
    assert.deepEqual(
      firstRun.body.generated.map((item) => item.date),
      ['2026-06-01', '2026-06-03', '2026-06-05'],
    );
    assert.deepEqual(firstRun.body.skipped, []);
    assert.equal(firstRun.body.nextOccurrence, '2026-06-11');

    const secondRun = await sendJson<{ generated: unknown[]; skipped: string[] }>(
      app,
      cookies.admin,
      'POST',
      `/api/recurrences/${rule.body.id}/run`,
      { through: '2026-06-10' },
    );
    assert.equal(secondRun.status, 200);
    assert.equal(secondRun.body.generated.length, 0);
    assert.equal(secondRun.body.skipped.length, 3);

    const tasks = await getJson<{ tasks: Task[] }>(
      app,
      cookies.admin,
      `/api/projects/${project.id}/tasks`,
    );
    const generated = tasks.tasks.filter((task) => task.title === '隔日巡检');
    assert.equal(generated.length, 3);
    assert.ok(generated.every((task) => task.priority === 'high'));

    const denied = await sendJson(app, cookies.pm, 'POST', `/api/recurrences/${rule.body.id}/run`, {
      through: '2026-06-20',
    });
    assert.equal(denied.status, 403);

    const removed = await remove(app, cookies.admin, `/api/recurrences/${rule.body.id}`);
    assert.equal(removed.status, 204);
  } finally {
    store.close();
  }
});

test('automation rules dry-run, execute on events and report runs', async () => {
  const { store, app, cookies } = await setup();
  try {
    const project = await createProject(app, cookies.admin, '自动化项目');

    const rule = await sendJson<AutomationRule>(
      app,
      cookies.admin,
      'POST',
      '/api/automation/rules',
      {
        name: '创建即高优',
        projectId: project.id,
        trigger: 'task.created',
        actions: [{ type: 'set_priority', value: 'high' }],
        maxRunsPerHour: 10,
      },
    );
    assert.equal(rule.status, 201);
    assert.equal(rule.body.version, 1);

    const dryRun = await sendJson<AutomationPreview>(
      app,
      cookies.admin,
      'POST',
      `/api/automation/rules/${rule.body.id}/dry-run`,
      {
        trigger: 'task.created',
        eventKey: 'dry-run-1',
        task: { title: '演练任务', priority: 'low' },
      },
    );
    assert.equal(dryRun.status, 200);
    assert.equal(dryRun.body.matched, true);
    assert.equal(dryRun.body.blockedReason, null);
    assert.equal(dryRun.body.actions[0]?.type, 'set_priority');

    const mismatch = await sendJson<AutomationPreview>(
      app,
      cookies.admin,
      'POST',
      `/api/automation/rules/${rule.body.id}/dry-run`,
      { trigger: 'task.completed', task: { title: '演练任务' } },
    );
    assert.equal(mismatch.status, 200);
    assert.equal(mismatch.body.matched, false);
    assert.equal(mismatch.body.blockedReason, 'trigger_mismatch');

    const created = await createTask(app, cookies.admin, project.id, {
      title: '自动化命中任务',
      priority: 'low',
    });
    assert.equal(created.priority, 'low');

    const tasks = await getJson<{ tasks: Task[] }>(
      app,
      cookies.admin,
      `/api/projects/${project.id}/tasks`,
    );
    const matched = tasks.tasks.find((task) => task.title === '自动化命中任务');
    assert.equal(matched?.priority, 'high', 'live automation applied the action');

    const runs = await getJson<AutomationRun[]>(
      app,
      cookies.admin,
      `/api/automation/runs?ruleId=${rule.body.id}`,
    );
    assert.ok(runs.some((run) => run.mode === 'live' && run.status === 'ok'));
    assert.ok(runs.some((run) => run.mode === 'dry_run'));

    const updated = await sendJson<AutomationRule>(
      app,
      cookies.admin,
      'PATCH',
      `/api/automation/rules/${rule.body.id}`,
      { name: '创建即高优（更新）', version: 1 },
    );
    assert.equal(updated.status, 200);
    assert.equal(updated.body.version, 2);

    const stale = await sendJson<{ error: string }>(
      app,
      cookies.admin,
      'PATCH',
      `/api/automation/rules/${rule.body.id}`,
      { name: '过期写入', version: 1 },
    );
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error, 'conflict');

    const denied = await sendJson(app, cookies.pm, 'POST', '/api/automation/rules', {
      name: '越权规则',
      trigger: 'task.created',
      actions: [{ type: 'set_priority', value: 'high' }],
    });
    assert.equal(denied.status, 403);
  } finally {
    store.close();
  }
});

test('documents keep a restorable version history', async () => {
  const { store, app, cookies } = await setup();
  try {
    const project = await createProject(app, cookies.admin, '知识库项目', {
      memberIds: [DEMO.pm.id],
    });
    const document = await sendJson<ProjectDocument>(
      app,
      cookies.admin,
      'POST',
      `/api/projects/${project.id}/documents`,
      { title: '运行手册', content: '第一版', status: 'published' },
    );
    assert.equal(document.status, 201);
    assert.equal(document.body.version, 1);

    const updated = await sendJson<ProjectDocument>(
      app,
      cookies.admin,
      'PATCH',
      `/api/documents/${document.body.id}`,
      { content: '第二版', version: 1, changeSummary: '补充步骤' },
    );
    assert.equal(updated.status, 200);
    assert.equal(updated.body.content, '第二版');
    assert.equal(updated.body.version, 2);

    let versions = await getJson<DocumentVersion[]>(
      app,
      cookies.admin,
      `/api/documents/${document.body.id}/versions`,
    );
    assert.deepEqual(
      versions.map((version) => version.version),
      [2, 1],
    );

    const restored = await sendJson<ProjectDocument>(
      app,
      cookies.admin,
      'POST',
      `/api/documents/${document.body.id}/restore`,
      { version: 1 },
    );
    assert.equal(restored.status, 200);
    assert.equal(restored.body.content, '第一版');
    assert.equal(restored.body.version, 3);

    versions = await getJson<DocumentVersion[]>(
      app,
      cookies.admin,
      `/api/documents/${document.body.id}/versions`,
    );
    assert.deepEqual(
      versions.map((version) => version.version),
      [3, 2, 1],
    );
    assert.equal(versions[0]?.changeSummary, '恢复到版本 v1');

    const stale = await sendJson<{ error: string }>(
      app,
      cookies.admin,
      'PATCH',
      `/api/documents/${document.body.id}`,
      { content: '过期内容', version: 1 },
    );
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error, 'conflict');

    const denied = await sendJson(app, cookies.pm, 'PATCH', `/api/documents/${document.body.id}`, {
      content: '越权修改',
      version: 3,
    });
    assert.equal(denied.status, 403);

    const privateProject = await createProject(app, cookies.admin, '隐藏知识项目', {
      visibility: 'private',
    });
    const privateDocument = await sendJson<ProjectDocument>(
      app,
      cookies.admin,
      'POST',
      `/api/projects/${privateProject.id}/documents`,
      { title: '机密文档' },
    );
    assert.equal(privateDocument.status, 201);
    const hidden = await app.request(`/api/documents/${privateDocument.body.id}`, {
      headers: { cookie: cookies.pm },
    });
    assert.equal(hidden.status, 404);
  } finally {
    store.close();
  }
});

test('document review cycles expire overdue knowledge and resurface it for review', async () => {
  const { store, app, cookies } = await setup();
  const dayKey = (offsetDays: number) =>
    new Date(TEST_NOW.getTime() + offsetDays * 86_400_000).toISOString().slice(0, 10);
  try {
    const project = await createProject(app, cookies.admin, '知识生命周期项目');
    const document = await sendJson<ProjectDocument>(
      app,
      cookies.admin,
      'POST',
      `/api/projects/${project.id}/documents`,
      { title: 'SOP 手册', status: 'published', reviewCycleDays: 30 },
    );
    assert.equal(document.status, 201);
    assert.equal(document.body.status, 'published');
    assert.equal(document.body.reviewCycleDays, 30);
    assert.ok(document.body.reviewDueAt, 'review cycle derives a due date');

    const extended = await sendJson<ProjectDocument>(
      app,
      cookies.admin,
      'PATCH',
      `/api/documents/${document.body.id}`,
      { reviewCycleDays: 90, version: 1 },
    );
    assert.equal(extended.status, 200);
    assert.equal(extended.body.reviewCycleDays, 90);
    assert.ok(
      String(extended.body.reviewDueAt) > String(document.body.reviewDueAt),
      'longer cycles push the review date out',
    );

    const stale = await sendJson<ProjectDocument>(
      app,
      cookies.admin,
      'POST',
      `/api/projects/${project.id}/documents`,
      { title: '过期规范', status: 'published', reviewDueAt: '2020-01-01' },
    );
    assert.equal(stale.status, 201);
    const upcoming = await sendJson<ProjectDocument>(
      app,
      cookies.admin,
      'POST',
      `/api/projects/${project.id}/documents`,
      { title: '即将复核', status: 'published', reviewDueAt: dayKey(3) },
    );
    assert.equal(upcoming.status, 201);

    const tick = await sendJson<{ reminded: number; expired: number }>(
      app,
      cookies.admin,
      'POST',
      '/api/documents/tick-reminders',
      {},
    );
    assert.equal(tick.status, 200);
    assert.equal(tick.body.expired, 1);
    assert.equal(tick.body.reminded, 1);

    const expired = await getJson<ProjectDocument>(
      app,
      cookies.admin,
      `/api/documents/${stale.body.id}`,
    );
    assert.equal(expired.status, 'expired');

    const again = await sendJson<{ reminded: number; expired: number }>(
      app,
      cookies.admin,
      'POST',
      '/api/documents/tick-reminders',
      {},
    );
    assert.equal(again.body.expired, 0);
    assert.equal(again.body.reminded, 0);

    const queue = await getJson<{ items: { id: string; type: string }[] }>(
      app,
      cookies.admin,
      '/api/knowledge/review',
    );
    assert.ok(
      queue.items.some((item) => item.id === stale.body.id),
      'expired documents stay in the review queue',
    );
  } finally {
    store.close();
  }
});

test('decision records enforce approval rules and keep versions', async () => {
  const { store, app, cookies } = await setup();
  try {
    const project = await createProject(app, cookies.admin, '决策项目', {
      memberIds: [DEMO.pm.id],
    });
    const decision = await sendJson<DecisionRecord>(app, cookies.admin, 'POST', '/api/decisions', {
      projectId: project.id,
      title: '选择消息队列',
      context: '需要支持多区域投递',
      options: [
        { title: 'Kafka', pros: '生态成熟', cons: '运维成本高' },
        { title: 'SQS', pros: '托管', cons: '耦合云厂商' },
      ],
    });
    assert.equal(decision.status, 201);
    assert.equal(decision.body.status, 'proposed');
    assert.equal(decision.body.options.length, 2);

    const missingDecision = await sendJson(
      app,
      cookies.admin,
      'PATCH',
      `/api/decisions/${decision.body.id}`,
      { status: 'approved', version: 1 },
    );
    assert.equal(missingDecision.status, 400);

    const approved = await sendJson<DecisionRecord>(
      app,
      cookies.admin,
      'PATCH',
      `/api/decisions/${decision.body.id}`,
      { status: 'approved', decision: '采用 Kafka', version: 1 },
    );
    assert.equal(approved.status, 200);
    assert.equal(approved.body.status, 'approved');
    assert.equal(approved.body.decidedByName, DEMO.admin.name);
    assert.equal(approved.body.version, 2);

    const reopen = await sendJson(
      app,
      cookies.admin,
      'PATCH',
      `/api/decisions/${decision.body.id}`,
      { status: 'rejected', decision: '撤回', version: 2 },
    );
    assert.equal(reopen.status, 400);

    const versions = await getJson<DecisionVersion[]>(
      app,
      cookies.admin,
      `/api/decisions/${decision.body.id}/versions`,
    );
    assert.deepEqual(
      versions.map((version) => version.version),
      [2, 1],
    );

    const denied = await sendJson(app, cookies.pm, 'PATCH', `/api/decisions/${decision.body.id}`, {
      context: '越权修改',
      version: 2,
    });
    assert.equal(denied.status, 403);

    const privateProject = await createProject(app, cookies.admin, '隐藏决策项目', {
      visibility: 'private',
    });
    const privateDecision = await sendJson<DecisionRecord>(
      app,
      cookies.admin,
      'POST',
      '/api/decisions',
      { projectId: privateProject.id, title: '机密决策' },
    );
    assert.equal(privateDecision.status, 201);
    const hidden = await app.request(`/api/decisions/${privateDecision.body.id}`, {
      headers: { cookie: cookies.pm },
    });
    assert.equal(hidden.status, 404);
    const hiddenList = await getJson<DecisionRecord[]>(app, cookies.pm, '/api/decisions');
    assert.ok(!hiddenList.some((item) => item.id === privateDecision.body.id));
  } finally {
    store.close();
  }
});

test('metric definitions validate formulas and evaluate seeded analytics', async () => {
  const { store, app, cookies } = await setup();
  try {
    const metric = await sendJson<MetricDefinition>(app, cookies.admin, 'POST', '/api/metrics', {
      name: '访问量',
      unit: '次',
      formula: 'visitors',
    });
    assert.equal(metric.status, 201);
    assert.equal(metric.body.status, 'draft');

    const duplicate = await sendJson(app, cookies.admin, 'POST', '/api/metrics', {
      name: '访问量',
      formula: 'customers',
    });
    assert.equal(duplicate.status, 400);

    const badFormula = await sendJson(app, cookies.admin, 'POST', '/api/metrics', {
      name: '非法公式',
      formula: 'unknown_field + 1',
    });
    assert.equal(badFormula.status, 400);

    const evaluation = await sendJson<MetricEvaluation>(
      app,
      cookies.admin,
      'POST',
      `/api/metrics/${metric.body.id}/evaluate`,
      { from: '2026-06-01', to: '2026-06-15' },
    );
    assert.equal(evaluation.status, 200);
    assert.equal(evaluation.body.series.length, 15);
    assert.ok((evaluation.body.value ?? 0) > 0);
    assert.deepEqual(evaluation.body.warnings, []);

    const reversed = await sendJson<MetricEvaluation>(
      app,
      cookies.admin,
      'POST',
      `/api/metrics/${metric.body.id}/evaluate`,
      { from: '2026-06-15', to: '2026-06-01' },
    );
    assert.equal(reversed.status, 200);
    assert.equal(reversed.body.value, null);
    assert.ok(reversed.body.warnings.some((warning) => warning.includes('开始日期')));

    const published = await sendJson<MetricDefinition>(
      app,
      cookies.admin,
      'PATCH',
      `/api/metrics/${metric.body.id}`,
      { status: 'published', version: 1 },
    );
    assert.equal(published.status, 200);
    assert.equal(published.body.version, 2);

    const versions = await getJson<Record<string, unknown>[]>(
      app,
      cookies.admin,
      `/api/metrics/${metric.body.id}/versions`,
    );
    assert.equal(versions.length, 2);

    const denied = await sendJson(app, cookies.pm, 'POST', '/api/metrics', {
      name: '越权指标',
      formula: 'visitors',
    });
    assert.equal(denied.status, 403);
  } finally {
    store.close();
  }
});

test('budgets aggregate entries idempotently and enforce versions', async () => {
  const { store, app, cookies } = await setup();
  try {
    const project = await createProject(app, cookies.admin, '预算项目', {
      memberIds: [DEMO.pm.id],
    });
    const otherProject = await createProject(app, cookies.admin, '第二预算项目');

    const budget = await sendJson<BudgetSummary>(
      app,
      cookies.admin,
      'PUT',
      `/api/projects/${project.id}/budget`,
      { budgetCents: 1_000_000, currency: 'USD', thresholdPct: 80, costCenter: '增长' },
    );
    assert.equal(budget.status, 200);
    assert.equal(budget.body.budget.budgetCents, 1_000_000);
    assert.equal(budget.body.burnPct, 0);

    const entry = await sendJson<BudgetSummary & { replayed: boolean }>(
      app,
      cookies.admin,
      'POST',
      `/api/projects/${project.id}/budget/entries`,
      { kind: 'actual', amountCents: 400_000, idempotencyKey: 'budget-entry-1' },
    );
    assert.equal(entry.status, 201);
    assert.equal(entry.body.replayed, false);
    assert.equal(entry.body.budget.actualCents, 400_000);
    assert.equal(entry.body.burnPct, 40);
    assert.equal(entry.body.remainingCents, 600_000);

    const replay = await sendJson<BudgetSummary & { replayed: boolean }>(
      app,
      cookies.admin,
      'POST',
      `/api/projects/${project.id}/budget/entries`,
      { kind: 'actual', amountCents: 400_000, idempotencyKey: 'budget-entry-1' },
    );
    assert.equal(replay.status, 201);
    assert.equal(replay.body.replayed, true);
    assert.equal(replay.body.budget.actualCents, 400_000);
    assert.equal(replay.body.entries.length, 1);

    await sendJson(app, cookies.admin, 'PUT', `/api/projects/${otherProject.id}/budget`, {
      budgetCents: 500_000,
      currency: 'USD',
    });
    const crossBudget = await sendJson(
      app,
      cookies.admin,
      'POST',
      `/api/projects/${otherProject.id}/budget/entries`,
      { kind: 'actual', amountCents: 10_000, idempotencyKey: 'budget-entry-1' },
    );
    assert.equal(crossBudget.status, 400);

    const updated = await sendJson<BudgetSummary>(
      app,
      cookies.admin,
      'PUT',
      `/api/projects/${project.id}/budget`,
      { budgetCents: 2_000_000, version: 2 },
    );
    assert.equal(updated.status, 200);
    assert.equal(updated.body.budget.version, 3);
    assert.equal(updated.body.remainingCents, 1_600_000);
    assert.equal(updated.body.burnPct, 20);

    const stale = await sendJson<{ error: string }>(
      app,
      cookies.admin,
      'PUT',
      `/api/projects/${project.id}/budget`,
      { budgetCents: 3_000_000, version: 2 },
    );
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error, 'conflict');

    const denied = await sendJson(app, cookies.pm, 'PUT', `/api/projects/${project.id}/budget`, {
      budgetCents: 10,
    });
    assert.equal(denied.status, 403);
  } finally {
    store.close();
  }
});

test('governance simulation explains access and just-in-time grants require a second approver', async () => {
  const { store, app, cookies } = await setup();
  try {
    const project = await createProject(app, cookies.admin, '治理项目', {
      memberIds: [DEMO.pm.id],
    });
    const privateProject = await createProject(app, cookies.admin, '治理私有项目', {
      visibility: 'private',
    });

    const allowed = await sendJson<PermissionSimulationResult>(
      app,
      cookies.admin,
      'POST',
      '/api/governance/simulate',
      {
        userId: DEMO.pm.id,
        resourceType: 'project',
        resourceId: project.id,
        action: 'view',
      },
    );
    assert.equal(allowed.status, 200);
    assert.equal(allowed.body.allowed, true);
    assert.equal(allowed.body.resourceLabel, '治理项目');
    assert.equal(allowed.body.sources[0]?.source, 'role');

    const cannotDelete = await sendJson<PermissionSimulationResult>(
      app,
      cookies.admin,
      'POST',
      '/api/governance/simulate',
      {
        userId: DEMO.pm.id,
        resourceType: 'project',
        resourceId: project.id,
        action: 'delete',
      },
    );
    assert.equal(cannotDelete.status, 200);
    assert.equal(cannotDelete.body.allowed, false);

    const hiddenProject = await sendJson<PermissionSimulationResult>(
      app,
      cookies.admin,
      'POST',
      '/api/governance/simulate',
      {
        userId: DEMO.pm.id,
        resourceType: 'project',
        resourceId: privateProject.id,
        action: 'view',
      },
    );
    assert.equal(hiddenProject.status, 200);
    assert.equal(hiddenProject.body.allowed, false);

    const deniedSimulation = await sendJson(app, cookies.pm, 'POST', '/api/governance/simulate', {
      userId: DEMO.pm.id,
      resourceType: 'workspace',
      resourceId: 'ws_default',
      action: 'view',
    });
    assert.equal(deniedSimulation.status, 403);

    const selfGrant = await sendJson<JitGrant>(app, cookies.admin, 'POST', '/api/governance/jit', {
      userId: DEMO.admin.id,
      permissions: ['projects.create'],
      resourceType: 'workspace',
      reason: '自查权限',
      durationMinutes: 30,
    });
    assert.equal(selfGrant.status, 201);
    assert.equal(selfGrant.body.status, 'pending');

    const selfApproval = await sendJson<{ error: string; message: string }>(
      app,
      cookies.admin,
      'POST',
      `/api/governance/jit/${selfGrant.body.id}/approve`,
      {},
    );
    assert.equal(selfApproval.status, 400);
    assert.match(selfApproval.body.message, /不能审批自己/);

    const grant = await sendJson<JitGrant>(app, cookies.admin, 'POST', '/api/governance/jit', {
      userId: DEMO.pm.id,
      permissions: ['projects.view_all'],
      resourceType: 'project',
      resourceId: project.id,
      reason: '跨项目审计',
      durationMinutes: 60,
    });
    assert.equal(grant.status, 201);
    assert.equal(grant.body.userId, DEMO.pm.id);

    const approved = await sendJson<JitGrant>(
      app,
      cookies.admin,
      'POST',
      `/api/governance/jit/${grant.body.id}/approve`,
      {},
    );
    assert.equal(approved.status, 200);
    assert.equal(approved.body.status, 'active');
    assert.equal(approved.body.approvedByName, DEMO.admin.name);

    const approvedAgain = await sendJson(
      app,
      cookies.admin,
      'POST',
      `/api/governance/jit/${grant.body.id}/approve`,
      {},
    );
    assert.equal(approvedAgain.status, 400);

    const pmGrants = await getJson<JitGrant[]>(app, cookies.pm, '/api/governance/jit');
    assert.ok(pmGrants.every((item) => item.userId === DEMO.pm.id));
    assert.ok(pmGrants.some((item) => item.id === grant.body.id));

    const adminGrants = await getJson<JitGrant[]>(app, cookies.admin, '/api/governance/jit');
    assert.ok(adminGrants.some((item) => item.id === grant.body.id));

    const selfRequest = await sendJson<JitGrant>(app, cookies.pm, 'POST', '/api/governance/jit', {
      permissions: ['projects.create'],
      resourceType: 'workspace',
      reason: '临时建项目',
      durationMinutes: 10,
    });
    assert.equal(selfRequest.status, 201);
    assert.equal(selfRequest.body.userId, DEMO.pm.id);

    const impersonation = await sendJson(app, cookies.pm, 'POST', '/api/governance/jit', {
      userId: DEMO.viewer.id,
      permissions: ['projects.create'],
      resourceType: 'workspace',
      reason: '越权申请',
      durationMinutes: 10,
    });
    assert.equal(impersonation.status, 403);

    const deniedApproval = await sendJson(
      app,
      cookies.pm,
      'POST',
      `/api/governance/jit/${grant.body.id}/revoke`,
      {},
    );
    assert.equal(deniedApproval.status, 403);

    const revoked = await sendJson<JitGrant>(
      app,
      cookies.admin,
      'POST',
      `/api/governance/jit/${grant.body.id}/revoke`,
      {},
    );
    assert.equal(revoked.status, 200);
    assert.equal(revoked.body.status, 'revoked');
  } finally {
    store.close();
  }
});

test('enterprise reads never leak hidden projects', async () => {
  const { store, app, cookies } = await setup();
  try {
    const privateProject = await createProject(app, cookies.admin, '完全隐藏项目', {
      visibility: 'private',
    });
    const task = await createTask(app, cookies.admin, privateProject.id, { title: '隐藏任务' });

    const paths = [
      `/api/projects/${privateProject.id}/dependencies`,
      `/api/projects/${privateProject.id}/critical-path`,
      `/api/projects/${privateProject.id}/blockers`,
      `/api/projects/${privateProject.id}/blockers/report`,
      `/api/projects/${privateProject.id}/recurrences`,
      `/api/projects/${privateProject.id}/documents`,
      `/api/projects/${privateProject.id}/budget`,
      `/api/goals?projectId=${privateProject.id}`,
      `/api/decisions?projectId=${privateProject.id}`,
      `/api/time-logs?projectId=${privateProject.id}`,
      `/api/tasks/${task.id}/time-logs/summary`,
    ];
    for (const path of paths) {
      const res = await app.request(path, { headers: { cookie: cookies.pm } });
      assert.equal(res.status, 404, `${path} should hide the private project`);
    }

    const privateDocument = await sendJson<ProjectDocument>(
      app,
      cookies.admin,
      'POST',
      `/api/projects/${privateProject.id}/documents`,
      { title: '隐藏文档' },
    );
    const documentVersions = await app.request(
      `/api/documents/${privateDocument.body.id}/versions`,
      { headers: { cookie: cookies.pm } },
    );
    assert.equal(documentVersions.status, 404);

    const privateMetric = await sendJson<MetricDefinition>(
      app,
      cookies.admin,
      'POST',
      '/api/metrics',
      {
        name: '隐藏指标',
        formula: 'visitors',
      },
    );
    assert.equal(privateMetric.status, 201);
    const viewerMetrics = await getJson<MetricDefinition[]>(app, cookies.viewer, '/api/metrics');
    assert.ok(
      viewerMetrics.some((metric) => metric.id === privateMetric.body.id),
      'workspace level metrics are visible to members',
    );

    const viewerWrite = await sendJson(app, cookies.viewer, 'POST', '/api/automation/rules', {
      name: '只读成员规则',
      trigger: 'task.created',
      actions: [{ type: 'notify', value: '你好' }],
    });
    assert.equal(viewerWrite.status, 403);
  } finally {
    store.close();
  }
});
