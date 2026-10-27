import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { Hono } from 'hono';
import type { AppEnv } from '../src/app-env.ts';
import type { Store } from '../src/store.ts';
import { DEMO, login, TEST_NOW, testApp, testStore } from './helpers.ts';

type Json = Record<string, unknown>;
type CallResult<T> = { status: number; body: T };

function obj(value: unknown): Json {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Json)
    : {};
}

function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function num(value: unknown): number {
  return Number(value ?? 0);
}

function items(body: unknown): Json[] {
  return arr(obj(body).items).map(obj);
}

async function call<T = Json>(
  app: Hono<AppEnv>,
  cookie: string | null,
  method: string,
  path: string,
  body?: unknown,
): Promise<CallResult<T>> {
  const res = await app.request(path, {
    method,
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : null) as T };
}

function expectStatus<T>(result: CallResult<T>, status: number, label: string): T {
  assert.equal(
    result.status,
    status,
    `${label}: expected ${status}, got ${result.status} ${JSON.stringify(result.body)}`,
  );
  return result.body;
}

type Setup = {
  store: Store;
  app: Hono<AppEnv>;
  cookies: { admin: string; manager: string; pm: string; viewer: string };
};

async function setup(): Promise<Setup> {
  const store = testStore();
  const { app } = testApp(store);
  return {
    store,
    app,
    cookies: {
      admin: await login(app, DEMO.admin.email),
      manager: await login(app, DEMO.manager.email),
      pm: await login(app, DEMO.pm.email),
      viewer: await login(app, DEMO.viewer.email),
    },
  };
}

async function createProject(
  app: Hono<AppEnv>,
  cookie: string,
  name: string,
  extra: Json = {},
): Promise<Json> {
  const result = await call(app, cookie, 'POST', '/api/projects', { name, ...extra });
  return expectStatus(result, 201, `create project ${name}`);
}

async function createTask(
  app: Hono<AppEnv>,
  cookie: string,
  projectId: string,
  title: string,
): Promise<Json> {
  const result = await call(app, cookie, 'POST', `/api/projects/${projectId}/tasks`, { title });
  return expectStatus(result, 201, `create task ${title}`);
}

async function createWorkflow(
  app: Hono<AppEnv>,
  cookie: string,
  name: string,
  definition?: Json,
): Promise<Json> {
  const result = await call(app, cookie, 'POST', '/api/workbench/workflows', {
    name,
    definition: definition ?? {
      nodes: [
        { id: 'start', type: 'start' },
        { id: 'end', type: 'end' },
      ],
      edges: [{ from: 'start', to: 'end' }],
    },
  });
  return expectStatus(result, 201, `create workflow ${name}`);
}

function auditRows(store: Store, action: string, target: string): Json[] {
  return store.db
    .stmt('SELECT * FROM audit_log WHERE action = ? AND target = ? ORDER BY seq')
    .all(action, target) as unknown as Json[];
}

describe('workbench scopes, visibility and concurrency', () => {
  test('project-scoped resources hide from outsiders and reject stale versions', async () => {
    const { app, cookies } = await setup();
    const project = await createProject(app, cookies.admin, '范围验证项目', {
      memberIds: [DEMO.pm.id],
    });
    const projectId = str(project.id);

    const created = await call(
      app,
      cookies.admin,
      'POST',
      `/api/workbench/stage-gates?projectId=${projectId}`,
      {
        name: 'G1 评审',
        approverIds: [DEMO.pm.id],
      },
    );
    const gate = expectStatus(created, 201, 'create gate');
    assert.equal(num(gate.version), 1);

    const pmList = await call(
      app,
      cookies.pm,
      'GET',
      `/api/workbench/stage-gates?projectId=${projectId}`,
    );
    expectStatus(pmList, 200, 'pm list gates');
    assert.equal(items(pmList.body).length, 1);

    const outsiderList = await call(
      app,
      cookies.viewer,
      'GET',
      `/api/workbench/stage-gates?projectId=${projectId}`,
    );
    expectStatus(outsiderList, 404, 'viewer list gates');

    const outsiderGet = await call(
      app,
      cookies.viewer,
      'GET',
      `/api/workbench/stage-gates/${str(gate.id)}`,
    );
    expectStatus(outsiderGet, 404, 'viewer get gate');

    const outsiderCreate = await call(
      app,
      cookies.viewer,
      'POST',
      `/api/workbench/stage-gates?projectId=${projectId}`,
      { name: '越权创建' },
    );
    expectStatus(outsiderCreate, 404, 'viewer create gate');

    const updated = await call(
      app,
      cookies.admin,
      'PATCH',
      `/api/workbench/stage-gates/${str(gate.id)}`,
      {
        name: 'G1 评审（更新）',
        version: 1,
      },
    );
    const after = expectStatus(updated, 200, 'update gate');
    assert.equal(num(after.version), 2);

    const stale = await call(
      app,
      cookies.admin,
      'PATCH',
      `/api/workbench/stage-gates/${str(gate.id)}`,
      {
        name: 'G1 评审（过期写入）',
        version: 1,
      },
    );
    expectStatus(stale, 409, 'stale update');
    assert.equal(num(obj(stale.body).current && obj(obj(stale.body).current).version), 2);

    const deleteDenied = await call(
      app,
      cookies.admin,
      'DELETE',
      `/api/workbench/stage-gates/${str(gate.id)}`,
    );
    expectStatus(deleteDenied, 403, 'delete unsupported resource');
  });
});

describe('stage gates, audit trail and baselines', () => {
  test('gate decisions enforce approver rights and preserve before/after audit data', async () => {
    const { app, store, cookies } = await setup();
    const project = await createProject(app, cookies.admin, '阶段门项目', {
      memberIds: [DEMO.pm.id, DEMO.viewer.id],
    });
    const projectId = str(project.id);
    const gateResult = await call(
      app,
      cookies.admin,
      'POST',
      `/api/workbench/stage-gates?projectId=${projectId}`,
      {
        name: '里程碑门',
        approverIds: [DEMO.pm.id],
      },
    );
    const gate = expectStatus(gateResult, 201, 'create gate');
    const gateId = str(gate.id);

    const viewerDecision = await call(
      app,
      cookies.viewer,
      'POST',
      `/api/gates/${gateId}/decisions`,
      {
        action: 'approve',
        version: 1,
      },
    );
    expectStatus(viewerDecision, 403, 'non-approver decision');

    const stale = await call(app, cookies.pm, 'POST', `/api/gates/${gateId}/decisions`, {
      action: 'approve',
      version: 99,
    });
    expectStatus(stale, 409, 'stale gate decision');
    assert.ok(obj(stale.body).current);

    const approved = await call(app, cookies.pm, 'POST', `/api/gates/${gateId}/decisions`, {
      action: 'approve',
      note: '材料齐全',
      version: 1,
    });
    const approvedGate = expectStatus(approved, 200, 'approve gate');
    assert.equal(str(approvedGate.status), 'approved');
    assert.equal(num(approvedGate.version), 2);

    const repeat = await call(app, cookies.pm, 'POST', `/api/gates/${gateId}/decisions`, {
      action: 'approve',
      version: 2,
    });
    expectStatus(repeat, 409, 'already decided gate');

    const events = await call(
      app,
      cookies.admin,
      'GET',
      `/api/workbench/stage-gate-events?gateId=${gateId}`,
    );
    const eventRows = expectStatus(events, 200, 'gate events');
    assert.equal(items(eventRows).length, 1);
    const event = items(eventRows)[0] ?? {};
    assert.equal(str(event.action), 'approve');
    const before = obj(event.beforeJson);
    const after = obj(event.afterJson);
    assert.equal(str(before.status), 'pending');
    assert.equal(str(after.status), 'approved');

    const audits = auditRows(store, 'stage_gate.decide', gateId);
    assert.equal(audits.length, 1);
    const detail = JSON.parse(str(audits[0]?.detail)) as Json;
    assert.equal(str(detail.action), 'approve');
    assert.equal(str(detail.reason), '材料齐全');
    assert.ok(detail.before);
    assert.ok(detail.after);
  });

  test('baselines capture snapshots, variance and health', async () => {
    const { app, cookies } = await setup();
    const project = await createProject(app, cookies.admin, '基线项目');
    const projectId = str(project.id);
    await createTask(app, cookies.admin, projectId, '既有任务');

    const created = await call(app, cookies.admin, 'POST', `/api/projects/${projectId}/baselines`, {
      label: '初始基线',
      reason: '项目启动基线',
    });
    const baseline = expectStatus(created, 201, 'create baseline');
    assert.equal(num(baseline.version_no), 1);
    assert.equal(str(baseline.status), 'pending');

    const approved = await call(
      app,
      cookies.admin,
      'POST',
      `/api/baselines/${str(baseline.id)}/decisions`,
      {
        action: 'approve',
      },
    );
    assert.equal(str(expectStatus(approved, 200, 'approve baseline').status), 'active');

    await createTask(app, cookies.admin, projectId, '基线后新增任务');
    const variance = await call(
      app,
      cookies.admin,
      'GET',
      `/api/baselines/${str(baseline.id)}/variance`,
    );
    const diff = expectStatus(variance, 200, 'baseline variance');
    assert.equal(arr(diff.added).length, 1);
    assert.equal(arr(diff.removed).length, 0);

    const computed = await call(app, cookies.admin, 'POST', `/api/projects/${projectId}/health`);
    const snapshot = expectStatus(computed, 200, 'compute health');
    assert.ok(num(snapshot.score) >= 0);
    assert.ok(arr(JSON.parse(str(snapshot.missing_json))).length >= 1);

    const latest = await call(app, cookies.admin, 'GET', `/api/projects/${projectId}/health`);
    assert.equal(str(expectStatus(latest, 200, 'latest health').id), str(snapshot.id));

    for (const method of ['GET', 'POST'] as const) {
      const denied = await call(app, cookies.viewer, method, `/api/projects/${projectId}/health`);
      expectStatus(denied, 404, `outsider health ${method}`);
    }
    const deniedBaseline = await call(
      app,
      cookies.viewer,
      'POST',
      `/api/projects/${projectId}/baselines`,
      {
        reason: '越权基线',
      },
    );
    expectStatus(deniedBaseline, 404, 'outsider baseline');
  });
});

describe('collaboration features', () => {
  test('knowledge links, document suggestions, channels and retrospectives', async () => {
    const { app, cookies } = await setup();
    const project = await createProject(app, cookies.admin, '协作项目', {
      memberIds: [DEMO.pm.id],
    });
    const projectId = str(project.id);
    const task = await createTask(app, cookies.admin, projectId, '整理规范');

    const docResult = await call(
      app,
      cookies.admin,
      'POST',
      `/api/projects/${projectId}/documents`,
      {
        title: '质量手册',
        content: '旧文案是这里。其余内容保持不变。',
      },
    );
    const doc = expectStatus(docResult, 201, 'create document');
    const docId = str(doc.id);

    const link = await call(app, cookies.admin, 'POST', '/api/knowledge/links', {
      fromType: 'document',
      fromId: docId,
      toType: 'task',
      toId: str(task.id),
      label: '来源',
    });
    expectStatus(link, 201, 'create knowledge link');

    const graph = await call(
      app,
      cookies.admin,
      'GET',
      `/api/knowledge/graph?projectId=${projectId}`,
    );
    const graphBody = expectStatus(graph, 200, 'knowledge graph');
    assert.ok(arr(graphBody.nodes).length >= 2);
    assert.equal(arr(graphBody.edges).length, 1);

    const search = await call(app, cookies.admin, 'GET', '/api/knowledge/search?q=质量');
    const searchBody = expectStatus(search, 200, 'knowledge search');
    assert.ok(arr(searchBody.results).some((entry) => str(obj(entry).type) === 'document'));

    const commentResult = await call(
      app,
      cookies.admin,
      'POST',
      `/api/documents/${docId}/comments`,
      {
        body: '建议改写开头',
        anchor: { start: 0, end: 7, quote: '旧文案是这里。' },
        suggestion: { replacement: '新文案在这里。' },
      },
    );
    const comment = expectStatus(commentResult, 201, 'create comment');
    assert.equal(str(comment.status), 'open');

    const outsider = await call(
      app,
      cookies.viewer,
      'POST',
      `/api/document-comments/${str(comment.id)}/decisions`,
      { action: 'accept', version: 1 },
    );
    expectStatus(outsider, 404, 'outsider comment resolve');

    const accepted = await call(
      app,
      cookies.admin,
      'POST',
      `/api/document-comments/${str(comment.id)}/decisions`,
      {
        action: 'accept',
        version: 1,
      },
    );
    assert.equal(str(expectStatus(accepted, 200, 'accept suggestion').status), 'resolved');
    const updatedDoc = await call(app, cookies.admin, 'GET', `/api/documents/${docId}`);
    const docAfter = expectStatus(updatedDoc, 200, 'document after suggestion');
    assert.match(str(docAfter.content), /新文案在这里。/);
    assert.equal(num(docAfter.version), 2);

    const diff = await call(app, cookies.admin, 'GET', `/api/documents/${docId}/diff`);
    const diffBody = expectStatus(diff, 200, 'document diff');
    assert.ok(arr(diffBody.lines).some((line) => str(obj(line).type) === 'added'));
    assert.ok(num(obj(diffBody.stats).added) > 0);

    const docComments = await call(app, cookies.admin, 'GET', `/api/documents/${docId}/comments`);
    const docCommentsBody = expectStatus(docComments, 200, 'document comments');
    assert.ok(arr(docCommentsBody.items).some((entry) => str(obj(entry).status) === 'resolved'));

    const focusGraph = await call(app, cookies.admin, 'GET', `/api/knowledge/graph?focus=${docId}`);
    const focusBody = expectStatus(focusGraph, 200, 'focused knowledge graph');
    assert.ok(arr(focusBody.nodes).length >= 2);
    assert.equal(arr(focusBody.edges).length, 1);

    const synonym = await call(app, cookies.admin, 'POST', '/api/knowledge/synonyms', {
      term: '质量',
      synonyms: ['品质'],
    });
    expectStatus(synonym, 201, 'create synonym');
    const synonymList = await call(app, cookies.admin, 'GET', '/api/knowledge/synonyms');
    assert.ok(
      arr(expectStatus(synonymList, 200, 'list synonyms').items).some(
        (entry) => str(obj(entry).term) === '质量',
      ),
    );
    const synonymSearch = await call(
      app,
      cookies.admin,
      'GET',
      '/api/knowledge/search?q=品质&types=document',
    );
    assert.ok(
      arr(expectStatus(synonymSearch, 200, 'synonym search').results).some(
        (entry) => str(obj(entry).id) === docId,
      ),
    );
    const forbiddenSynonym = await call(app, cookies.viewer, 'POST', '/api/knowledge/synonyms', {
      term: '越权',
      synonyms: ['测试'],
    });
    expectStatus(forbiddenSynonym, 403, 'outsider synonym');

    const channelResult = await call(
      app,
      cookies.admin,
      'POST',
      `/api/workbench/channels?projectId=${projectId}`,
      { name: '项目频道', memberIds: [DEMO.pm.id] },
    );
    const channel = expectStatus(channelResult, 201, 'create channel');
    const channelId = str(channel.id);

    const subscribe = await call(
      app,
      cookies.pm,
      'POST',
      `/api/channels/${channelId}/subscription`,
    );
    expectStatus(subscribe, 200, 'subscribe channel');
    const unsubscribe = await call(
      app,
      cookies.pm,
      'DELETE',
      `/api/channels/${channelId}/subscription`,
    );
    expectStatus(unsubscribe, 200, 'unsubscribe channel');

    const messageResult = await call(
      app,
      cookies.admin,
      'POST',
      `/api/channels/${channelId}/messages`,
      {
        body: '请同步交付计划',
      },
    );
    const message = expectStatus(messageResult, 201, 'post message');
    const messageId = str(message.id);

    const pmEdit = await call(app, cookies.pm, 'PATCH', `/api/channel-messages/${messageId}`, {
      body: '越权编辑',
    });
    expectStatus(pmEdit, 403, 'non-author edit');

    const ownerEdit = await call(
      app,
      cookies.admin,
      'PATCH',
      `/api/channel-messages/${messageId}`,
      {
        body: '请同步最新交付计划',
      },
    );
    expectStatus(ownerEdit, 200, 'author edit');

    const converted = await call(
      app,
      cookies.admin,
      'POST',
      `/api/channel-messages/${messageId}/task?projectId=${projectId}`,
    );
    const conversion = expectStatus(converted, 201, 'message to task');
    assert.ok(str(obj(conversion.task).id).length > 0);

    const channelSearch = await call(
      app,
      cookies.admin,
      'GET',
      `/api/channels/${channelId}/messages/search?q=交付`,
    );
    const searchResults = expectStatus(channelSearch, 200, 'channel message search');
    assert.ok(arr(searchResults.messages).some((entry) => str(obj(entry).id) === messageId));

    const retroResult = await call(
      app,
      cookies.admin,
      'POST',
      `/api/workbench/retrospectives?projectId=${projectId}`,
      {
        title: '迭代复盘',
        lessons: ['提前沟通接口变更'],
        improvements: ['增加联调评审'],
      },
    );
    const retro = expectStatus(retroResult, 201, 'create retrospective');
    const published = await call(
      app,
      cookies.admin,
      'POST',
      `/api/retrospectives/${str(retro.id)}/publish`,
    );
    const publishedBody = expectStatus(published, 200, 'publish retrospective');
    const playbookId = str(publishedBody.playbookId);
    assert.ok(playbookId.length > 0);

    const feedback = await call(app, cookies.pm, 'POST', `/api/playbooks/${playbookId}/feedback`, {
      useful: true,
      note: '可直接复用',
    });
    const playbook = expectStatus(feedback, 200, 'playbook feedback');
    assert.equal(arr(JSON.parse(str(playbook.feedback_json))).length, 1);

    const playbookSearch = await call(
      app,
      cookies.admin,
      'GET',
      '/api/knowledge/search?q=迭代复盘&types=playbook',
    );
    const playbookBody = expectStatus(playbookSearch, 200, 'playbook search');
    assert.ok(arr(playbookBody.results).some((entry) => str(obj(entry).type) === 'playbook'));
  });
});

describe('customer portal', () => {
  test('token access is public, scoped and revocable by project visibility', async () => {
    const { app, cookies } = await setup();
    const project = await createProject(app, cookies.admin, '门户项目');
    const projectId = str(project.id);

    const created = await call(app, cookies.admin, 'POST', `/api/projects/${projectId}/portals`, {
      name: '客户反馈门户',
      accountEmail: 'client@example.com',
      accountName: '客户代表',
    });
    const portal = expectStatus(created, 201, 'create portal');
    const token = str(portal.token);
    assert.match(token, /^np_/);

    const duplicate = await call(app, cookies.admin, 'POST', `/api/projects/${projectId}/portals`, {
      name: '重复门户',
    });
    expectStatus(duplicate, 409, 'duplicate portal');

    const outsider = await call(app, cookies.viewer, 'POST', `/api/projects/${projectId}/portals`, {
      name: '越权门户',
    });
    expectStatus(outsider, 404, 'outsider portal');

    const publicView = await call(app, null, 'GET', `/api/portal/${token}`);
    const view = expectStatus(publicView, 200, 'portal view');
    assert.equal(str(obj(view.project).id), projectId);
    assert.deepEqual(arr(view.requests), []);

    const submitted = await call(app, null, 'POST', `/api/portal/${token}/requests`, {
      title: '希望增加导出',
      body: '需要 CSV 导出',
    });
    const request = obj(expectStatus(submitted, 201, 'portal submit').request);
    assert.equal(str(request.status), 'submitted');

    const triaged = await call(
      app,
      null,
      'PATCH',
      `/api/portal/${token}/requests/${str(request.id)}`,
      {
        status: 'triaged',
        progressNote: '已进入评估',
      },
    );
    assert.equal(str(expectStatus(triaged, 200, 'portal update').status), 'triaged');

    const customerComment = await call(
      app,
      null,
      'POST',
      `/api/portal/${token}/requests/${str(request.id)}/comments`,
      { body: '请尽快评估' },
    );
    const comment = expectStatus(customerComment, 201, 'customer portal comment');
    assert.equal(str(comment.authorKind), 'customer');
    const customerComments = await call(
      app,
      null,
      'GET',
      `/api/portal/${token}/requests/${str(request.id)}/comments`,
    );
    assert.equal(
      arr(expectStatus(customerComments, 200, 'customer portal comments').comments).length,
      1,
    );

    const staffComments = await call(
      app,
      cookies.admin,
      'GET',
      `/api/portal-requests/${str(request.id)}/comments`,
    );
    assert.equal(arr(expectStatus(staffComments, 200, 'staff portal comments').comments).length, 1);
    const outsiderComments = await call(
      app,
      cookies.viewer,
      'GET',
      `/api/portal-requests/${str(request.id)}/comments`,
    );
    expectStatus(outsiderComments, 404, 'outsider portal comments');

    const internal = await call(
      app,
      cookies.admin,
      'POST',
      `/api/portal-requests/${str(request.id)}/comments`,
      { body: '内部评估中', internal: true },
    );
    assert.equal(obj(expectStatus(internal, 201, 'internal portal comment')).internal, true);

    const viewWithComments = await call(app, null, 'GET', `/api/portal/${token}`);
    const visible = expectStatus(viewWithComments, 200, 'portal view comments');
    assert.equal(arr(visible.comments).length, 1);
    const requestRow = obj(arr(visible.requests)[0]);
    assert.equal(num(requestRow.comment_count), 1);

    const delivered = await call(
      app,
      cookies.admin,
      'POST',
      `/api/portal-requests/${str(request.id)}/deliver`,
      { note: '已上线 CSV 导出' },
    );
    const deliveredRequest = obj(expectStatus(delivered, 200, 'confirm portal delivery').request);
    assert.equal(str(deliveredRequest.status), 'delivered');
    const repeated = await call(
      app,
      cookies.admin,
      'POST',
      `/api/portal-requests/${str(request.id)}/deliver`,
      {},
    );
    expectStatus(repeated, 409, 'repeat portal delivery');
    const outsiderDeliver = await call(
      app,
      cookies.viewer,
      'POST',
      `/api/portal-requests/${str(request.id)}/deliver`,
      {},
    );
    expectStatus(outsiderDeliver, 404, 'outsider portal delivery');

    const invalid = await call(app, null, 'GET', '/api/portal/np_missing');
    expectStatus(invalid, 404, 'invalid portal token');

    const accountResult = await call(
      app,
      cookies.admin,
      'POST',
      `/api/portals/${str(obj(portal.portal).id)}/accounts`,
      {
        email: 'second@example.com',
        name: '第二位客户',
      },
    );
    const account = expectStatus(accountResult, 201, 'second portal account');
    const secondView = await call(app, null, 'GET', `/api/portal/${str(account.token)}`);
    const secondBody = expectStatus(secondView, 200, 'second account view');
    assert.equal(arr(secondBody.requests).length, 1);
  });
});

describe('workflow engine', () => {
  test('sandbox runs, publishing, idempotent live runs and rollback', async () => {
    const { app, cookies } = await setup();
    const workflow = await createWorkflow(app, cookies.admin, '发布流程');
    const workflowId = str(workflow.id);

    const early = await call(app, cookies.admin, 'POST', `/api/workflows/${workflowId}/runs`, {});
    expectStatus(early, 409, 'run before publish');

    const testRun = await call(app, cookies.admin, 'POST', `/api/workflows/${workflowId}/test`, {});
    assert.equal(str(expectStatus(testRun, 201, 'sandbox run').status), 'completed');

    const published = await call(
      app,
      cookies.admin,
      'POST',
      `/api/workflows/${workflowId}/publish`,
      {
        changeSummary: '首个版本',
      },
    );
    const publishedWorkflow = expectStatus(published, 200, 'publish workflow');
    assert.equal(str(publishedWorkflow.status), 'published');
    assert.equal(num(publishedWorkflow.version), 2);

    const live = await call(app, cookies.admin, 'POST', `/api/workflows/${workflowId}/runs`, {
      idempotencyKey: 'idem-live-1',
    });
    const run = expectStatus(live, 201, 'live run');
    assert.equal(str(run.status), 'completed');
    assert.equal(num(run.workflow_version), 2);

    const replay = await call(app, cookies.admin, 'POST', `/api/workflows/${workflowId}/runs`, {
      idempotencyKey: 'idem-live-1',
    });
    assert.equal(str(expectStatus(replay, 201, 'idempotent replay').id), str(run.id));

    const runs = await call(
      app,
      cookies.admin,
      'GET',
      `/api/workbench/workflow-runs?workflowId=${workflowId}`,
    );
    assert.ok(items(expectStatus(runs, 200, 'workflow runs')).length >= 2);

    const events = await call(
      app,
      cookies.admin,
      'GET',
      `/api/workbench/workflow-events?runId=${str(run.id)}`,
    );
    assert.equal(items(expectStatus(events, 200, 'workflow events')).length, 2);

    const rollback = await call(
      app,
      cookies.admin,
      'POST',
      `/api/workflows/${workflowId}/rollback`,
      {
        version: 2,
      },
    );
    const rolled = expectStatus(rollback, 200, 'rollback workflow');
    assert.equal(str(rolled.status), 'draft');
    assert.equal(num(rolled.version), 3);

    const viewerPublish = await call(
      app,
      cookies.viewer,
      'POST',
      `/api/workflows/${workflowId}/publish`,
      {},
    );
    expectStatus(viewerPublish, 403, 'viewer publish');

    const cyclic = await createWorkflow(app, cookies.admin, '循环流程', {
      nodes: [
        { id: 'start', type: 'start' },
        { id: 'end', type: 'end' },
      ],
      edges: [
        { from: 'start', to: 'end' },
        { from: 'end', to: 'start' },
      ],
    });
    const cyclePublish = await call(
      app,
      cookies.admin,
      'POST',
      `/api/workflows/${str(cyclic.id)}/publish`,
      {},
    );
    expectStatus(cyclePublish, 400, 'cyclic publish');
  });
});

describe('approvals', () => {
  test('multi-step decisions, stale versions, withdraw and metrics', async () => {
    const { app, cookies } = await setup();
    const create = async (title: string): Promise<Json> => {
      const result = await call(app, cookies.pm, 'POST', '/api/approvals', {
        title,
        kind: 'budget',
        amountCents: 500_000,
        steps: [
          {
            name: '经理审批',
            approverIds: [DEMO.pm.id],
            mode: 'any',
          },
        ],
      });
      return expectStatus(result, 201, `create approval ${title}`);
    };

    const approval = await create('采购审批');
    const approvalId = str(approval.id);

    const viewerDecision = await call(
      app,
      cookies.viewer,
      'POST',
      `/api/approvals/${approvalId}/decisions`,
      {
        action: 'approve',
        version: 1,
      },
    );
    expectStatus(viewerDecision, 403, 'viewer approval decision');

    const stale = await call(app, cookies.pm, 'POST', `/api/approvals/${approvalId}/decisions`, {
      action: 'approve',
      version: 2,
    });
    expectStatus(stale, 409, 'stale approval decision');
    assert.ok(obj(stale.body).current);

    const approved = await call(app, cookies.pm, 'POST', `/api/approvals/${approvalId}/decisions`, {
      action: 'approve',
      note: '预算可接受',
      version: 1,
    });
    const approvedBody = expectStatus(approved, 200, 'approve request');
    assert.equal(str(approvedBody.status), 'approved');
    assert.equal(num(approvedBody.version), 2);

    const withdrawnApproval = await create('撤回审批');
    const withdrawn = await call(
      app,
      cookies.pm,
      'POST',
      `/api/approvals/${str(withdrawnApproval.id)}/withdraw`,
      { note: '需求取消', version: 1 },
    );
    assert.equal(str(expectStatus(withdrawn, 200, 'withdraw approval').status), 'withdrawn');

    const metrics = await call(app, cookies.admin, 'GET', '/api/approvals/metrics');
    const metricBody = expectStatus(metrics, 200, 'approval metrics');
    const statuses = arr(metricBody.byStatus).map((row) => str(obj(row).status));
    assert.ok(statuses.includes('approved'));
    assert.ok(statuses.includes('withdrawn'));
    assert.ok(Array.isArray(metricBody.byRisk));
    assert.ok(num(metricBody.total) >= 2);
    assert.ok(num(metricBody.averageHours) >= 0);
    assert.ok(num(metricBody.overdueRate) >= 0);
    assert.ok(num(metricBody.returnRate) >= 0);
    assert.equal(metricBody.lowSample, true);
    assert.ok(arr(metricBody.byStep).length >= 1);
  });
});

describe('automation infrastructure', () => {
  test('triggers, connectors, event delivery and background jobs', async () => {
    const { app, store, cookies } = await setup();
    const workflow = await createWorkflow(app, cookies.admin, '触发器流程');
    const workflowId = str(workflow.id);

    const triggerResult = await call(app, cookies.admin, 'POST', '/api/workbench/triggers', {
      name: '定时触发',
      type: 'schedule',
      workflowId,
      config: { everyMinutes: 15 },
      dedupeWindowSeconds: 60,
      maxPerHour: 5,
    });
    const trigger = expectStatus(triggerResult, 201, 'create trigger');
    const triggerId = str(trigger.id);

    const viewerFire = await call(
      app,
      cookies.viewer,
      'POST',
      `/api/triggers/${triggerId}/fire`,
      {},
    );
    expectStatus(viewerFire, 403, 'viewer fire trigger');

    const dryRun = await call(app, cookies.admin, 'POST', `/api/triggers/${triggerId}/fire`, {
      dryRun: true,
    });
    assert.equal(expectStatus(dryRun, 200, 'dry run trigger').dryRun, true);

    const fired = await call(app, cookies.admin, 'POST', `/api/triggers/${triggerId}/fire`, {
      eventKey: 'A',
    });
    const firedBody = expectStatus(fired, 200, 'fire trigger');
    assert.ok(firedBody.run);

    const deduped = await call(app, cookies.admin, 'POST', `/api/triggers/${triggerId}/fire`, {
      eventKey: 'B',
    });
    expectStatus(deduped, 409, 'trigger dedupe');

    const scheduled = await call(app, cookies.admin, 'POST', '/api/workbench/triggers', {
      name: '无工作流定时',
      type: 'schedule',
      config: { everyMinutes: 15 },
    });
    const scheduledId = str(expectStatus(scheduled, 201, 'create scheduled trigger').id);
    const tick = await call(app, cookies.admin, 'POST', '/api/triggers/tick');
    const tickBody = expectStatus(tick, 200, 'trigger tick');
    assert.ok(arr(tickBody.fired).map(String).includes(scheduledId));

    const quietResult = await call(app, cookies.admin, 'POST', '/api/workbench/triggers', {
      name: '静默触发',
      type: 'event',
      quietHours: [{ start: '00:00', end: '23:59' }],
    });
    const quiet = expectStatus(quietResult, 201, 'create quiet trigger');
    const quietFire = await call(
      app,
      cookies.admin,
      'POST',
      `/api/triggers/${str(quiet.id)}/fire`,
      {},
    );
    expectStatus(quietFire, 409, 'quiet hours');

    const connectorResult = await call(app, cookies.admin, 'POST', '/api/workbench/connectors', {
      name: 'CRM 连接器',
      kind: 'api_key',
    });
    const connector = expectStatus(connectorResult, 201, 'create connector');
    const connectorId = str(connector.id);
    const degraded = await call(app, cookies.admin, 'GET', `/api/connectors/${connectorId}/health`);
    assert.equal(str(expectStatus(degraded, 200, 'connector health degraded').health), 'degraded');

    const rotated = await call(
      app,
      cookies.admin,
      'POST',
      `/api/connectors/${connectorId}/rotate`,
      {
        secret: 'long-secret-value',
      },
    );
    assert.equal(str(expectStatus(rotated, 200, 'rotate connector').health), 'ok');
    const viewerRotate = await call(
      app,
      cookies.viewer,
      'POST',
      `/api/connectors/${connectorId}/rotate`,
      {
        secret: 'viewer-secret',
      },
    );
    expectStatus(viewerRotate, 403, 'viewer rotate connector');

    const securedResult = await call(app, cookies.admin, 'POST', '/api/workbench/connectors', {
      name: '受保护连接器',
      kind: 'api_key',
      secret: 'very-secret-value',
      scopes: ['crm.read'],
      allowedDomains: ['api.example.com'],
    });
    const secured = expectStatus(securedResult, 201, 'create secured connector');
    assert.equal(secured.hasSecret, true);
    assert.equal(secured.secretRef, undefined);
    assert.equal(secured.health, 'ok');
    assert.ok(arr(secured.capabilities).includes('crm.read'));

    const securedList = await call(app, cookies.admin, 'GET', '/api/workbench/connectors');
    const listed = items(expectStatus(securedList, 200, 'connector list')).find(
      (item) => str(item.id) === str(secured.id),
    );
    assert.equal(listed?.secretRef, undefined);
    assert.equal(listed?.hasSecret, true);

    const blockedDomain = await call(
      app,
      cookies.admin,
      'POST',
      `/api/connectors/${str(secured.id)}/call`,
      { url: 'https://evil.example.com/data' },
    );
    expectStatus(blockedDomain, 400, 'connector domain allowlist');

    const unconfirmedWrite = await call(
      app,
      cookies.admin,
      'POST',
      `/api/connectors/${str(secured.id)}/call`,
      { url: 'https://api.example.com/data', method: 'POST', body: { value: 1 } },
    );
    expectStatus(unconfirmedWrite, 400, 'connector write confirmation');

    const oauthResult = await call(app, cookies.admin, 'POST', '/api/workbench/connectors', {
      name: 'OAuth 连接器',
      kind: 'oauth',
      authUrl: 'https://auth.example.com/authorize',
      tokenUrl: 'https://auth.example.com/token',
      clientId: 'client-id',
      clientSecret: 'client-secret',
      scopes: ['read'],
    });
    const oauth = expectStatus(oauthResult, 201, 'create oauth connector');
    const started = await call(
      app,
      cookies.admin,
      'POST',
      `/api/connectors/${str(oauth.id)}/oauth/start`,
      { redirectUri: 'https://app.example.com/oauth/callback' },
    );
    const authorizeUrl = new URL(str(expectStatus(started, 200, 'oauth start').authorizeUrl));
    assert.equal(authorizeUrl.searchParams.get('code_challenge_method'), 'S256');
    assert.ok((authorizeUrl.searchParams.get('state') ?? '').length >= 16);
    const badCallback = await call(
      app,
      cookies.admin,
      'POST',
      `/api/connectors/${str(oauth.id)}/oauth/callback`,
      { state: 'x'.repeat(24), code: 'abc' },
    );
    expectStatus(badCallback, 400, 'oauth state rejected');
    const viewerOauth = await call(
      app,
      cookies.viewer,
      'POST',
      `/api/connectors/${str(oauth.id)}/oauth/start`,
      { redirectUri: 'https://app.example.com/oauth/callback' },
    );
    expectStatus(viewerOauth, 403, 'viewer oauth start');

    const subResult = await call(app, cookies.admin, 'POST', '/api/event-subscriptions', {
      eventType: 'order.created',
      endpoint: 'https://hooks.test/ok',
    });
    expectStatus(subResult, 201, 'create subscription');
    const failSub = await call(app, cookies.admin, 'POST', '/api/event-subscriptions', {
      eventType: 'order.fail',
      endpoint: 'https://fail.test/hook',
    });
    expectStatus(failSub, 201, 'create failing subscription');

    const first = await call(app, cookies.admin, 'POST', '/api/events', {
      type: 'order.created',
      payload: { orderId: 'o-1' },
      dedupeKey: 'evt-1',
    });
    expectStatus(first, 201, 'publish event');
    const duplicate = await call(app, cookies.admin, 'POST', '/api/events', {
      type: 'order.created',
      payload: { orderId: 'o-1' },
      dedupeKey: 'evt-1',
    });
    assert.equal(expectStatus(duplicate, 200, 'duplicate event').duplicate, true);

    const delivered = await call(app, cookies.admin, 'POST', '/api/events/tick');
    const deliveryBody = expectStatus(delivered, 200, 'event tick');
    assert.equal(num(deliveryBody.delivered), 1);

    const failing = await call(app, cookies.admin, 'POST', '/api/events', {
      type: 'order.fail',
      payload: { orderId: 'o-2' },
      dedupeKey: 'fail-1',
    });
    const failEvent = expectStatus(failing, 201, 'publish failing event');
    const failedTick = await call(app, cookies.admin, 'POST', '/api/events/tick');
    assert.equal(num(expectStatus(failedTick, 200, 'failing event tick').failed), 1);

    const deliveryRows = await call(
      app,
      cookies.admin,
      'GET',
      `/api/workbench/event-deliveries?eventId=${str(failEvent.id)}`,
    );
    const failedDelivery = items(expectStatus(deliveryRows, 200, 'event deliveries'))[0] ?? {};
    const retried = await call(
      app,
      cookies.admin,
      'POST',
      `/api/event-deliveries/${str(failedDelivery.id)}/retry`,
    );
    assert.equal(str(expectStatus(retried, 200, 'retry delivery').status), 'pending');
    const retriedTick = await call(app, cookies.admin, 'POST', '/api/events/tick');
    assert.equal(num(expectStatus(retriedTick, 200, 'retried tick').failed), 1);

    await call(app, cookies.admin, 'POST', '/api/event-subscriptions', {
      eventType: 'order.paid',
      endpoint: 'https://hooks.test/paid',
      filter: {
        'order.status': 'paid',
        'order.total': { operator: 'gte', value: 100 },
      },
    });
    const lowValue = await call(app, cookies.admin, 'POST', '/api/events', {
      type: 'order.paid',
      payload: { order: { status: 'paid', total: 40 } },
      dedupeKey: 'paid-low',
    });
    expectStatus(lowValue, 201, 'publish low value event');
    const lowTick = await call(app, cookies.admin, 'POST', '/api/events/tick');
    assert.equal(num(expectStatus(lowTick, 200, 'filtered tick').delivered), 0);
    const highValue = await call(app, cookies.admin, 'POST', '/api/events', {
      type: 'order.paid',
      payload: { order: { status: 'paid', total: 120 } },
      dedupeKey: 'paid-high',
    });
    expectStatus(highValue, 201, 'publish high value event');
    const highTick = await call(app, cookies.admin, 'POST', '/api/events/tick');
    assert.equal(num(expectStatus(highTick, 200, 'matched tick').delivered), 1);

    const jobResult = await call(app, cookies.admin, 'POST', '/api/jobs', {
      kind: 'reindex',
      idempotencyKey: 'job-1',
    });
    const job = expectStatus(jobResult, 201, 'create job');
    const jobReplay = await call(app, cookies.admin, 'POST', '/api/jobs', {
      kind: 'reindex',
      idempotencyKey: 'job-1',
    });
    assert.equal(str(expectStatus(jobReplay, 201, 'replay job').id), str(job.id));

    const jobTick = await call(app, cookies.admin, 'POST', '/api/jobs/tick', { limit: 10 });
    const processed = arr(expectStatus(jobTick, 200, 'job tick').processed).map(obj);
    assert.equal(str(processed[0]?.status), 'succeeded');

    const retryJob = await call(app, cookies.admin, 'POST', `/api/jobs/${str(job.id)}/retry`);
    assert.equal(str(expectStatus(retryJob, 200, 'retry job').status), 'pending');

    const viewerTick = await call(app, cookies.viewer, 'POST', '/api/jobs/tick', {});
    expectStatus(viewerTick, 403, 'viewer job tick');

    const sandbox = await call(app, cookies.admin, 'POST', '/api/sandbox/run', {
      actions: [
        { type: 'read', fields: ['name'] },
        { type: 'write', value: 'x' },
      ],
      limits: { maxActions: 2 },
    });
    assert.equal(arr(expectStatus(sandbox, 200, 'sandbox ok').results).length, 2);
    const tooMany = await call(app, cookies.admin, 'POST', '/api/sandbox/run', {
      actions: [{ type: 'a' }, { type: 'b' }, { type: 'c' }],
      limits: { maxActions: 2 },
    });
    expectStatus(tooMany, 400, 'sandbox action limit');
    const blocked = await call(app, cookies.admin, 'POST', '/api/sandbox/run', {
      actions: [{ type: 'network', value: 'https://evil.test/x' }],
      limits: { network: ['example.com'] },
    });
    expectStatus(blocked, 400, 'sandbox network guard');
    const viewerSandbox = await call(app, cookies.viewer, 'POST', '/api/sandbox/run', {
      actions: [{ type: 'read' }],
    });
    expectStatus(viewerSandbox, 403, 'viewer sandbox');
    const implicitNetwork = await call(app, cookies.admin, 'POST', '/api/sandbox/run', {
      actions: [{ type: 'network', value: 'https://example.com/x' }],
    });
    expectStatus(implicitNetwork, 400, 'sandbox network deny by default');
    const actionBlocked = await call(app, cookies.admin, 'POST', '/api/sandbox/run', {
      actions: [{ type: 'delete' }],
      limits: { allowedActions: ['read'] },
    });
    expectStatus(actionBlocked, 400, 'sandbox action allowlist');
    const firstRun = await call(app, cookies.admin, 'POST', '/api/sandbox/run', {
      actions: [{ type: 'read' }],
    });
    const checkpoint = str(expectStatus(firstRun, 200, 'sandbox checkpoint').checkpoint);
    assert.ok(checkpoint.length > 0);
    const resumed = await call(app, cookies.admin, 'POST', '/api/sandbox/run', {
      actions: [{ type: 'read' }],
      resumeFrom: checkpoint,
    });
    const resumedBody = expectStatus(resumed, 200, 'sandbox resume');
    assert.equal(str(resumedBody.resumedFrom), checkpoint);
    assert.equal(arr(resumedBody.results).length, 1);
    const mismatchedResume = await call(app, cookies.admin, 'POST', '/api/sandbox/run', {
      actions: [{ type: 'write', value: 'x' }],
      resumeFrom: checkpoint,
    });
    expectStatus(mismatchedResume, 400, 'sandbox checkpoint mismatch');

    const usageAudit = store.db
      .stmt("SELECT COUNT(*) AS count FROM audit_log WHERE action LIKE 'trigger.%'")
      .get() as unknown as { count: number };
    assert.ok(num(usageAudit.count) >= 1);
  });

  test('sustained condition triggers wait out the grace period', async () => {
    const { app, store, cookies } = await setup();
    const created = await call(app, cookies.admin, 'POST', '/api/workbench/triggers', {
      name: '持续条件触发',
      type: 'condition',
      config: {
        mode: 'level',
        sustainedSeconds: 60,
        conditions: [{ field: 'overdueTasks', operator: 'gte', value: 0 }],
      },
    });
    const trigger = expectStatus(created, 201, 'create sustained trigger');
    const triggerId = str(trigger.id);

    const first = await call(app, cookies.admin, 'POST', '/api/triggers/tick');
    assert.ok(
      !arr(expectStatus(first, 200, 'first sustained tick').fired)
        .map(String)
        .includes(triggerId),
      'must not fire before the sustained window elapses',
    );
    const since = store.db
      .stmt('SELECT value FROM app_settings WHERE key = ?')
      .get(`trigger:since:${triggerId}`) as unknown as { value?: string } | undefined;
    assert.ok(num(since?.value) > 0);

    store.db
      .stmt('UPDATE app_settings SET value = ? WHERE key = ?')
      .run(String(Date.now() - 120_000), `trigger:since:${triggerId}`);
    const second = await call(app, cookies.admin, 'POST', '/api/triggers/tick');
    assert.ok(
      arr(expectStatus(second, 200, 'second sustained tick').fired)
        .map(String)
        .includes(triggerId),
      'fires once the condition stayed true past the grace period',
    );
  });

  test('automation dead letters replay, retry single actions and prune by age', async () => {
    const { app, store, cookies } = await setup();
    const project = await createProject(app, cookies.admin, '自动化重放项目');
    const ruleRes = await call(app, cookies.admin, 'POST', '/api/automation/rules', {
      name: '重放规则',
      projectId: str(project.id),
      trigger: 'task.created',
      actions: [{ type: 'create_task', title: '重放生成任务' }],
    });
    const rule = expectStatus(ruleRes, 201, 'create replay rule');
    store.db
      .stmt(
        `INSERT INTO automation_runs
           (id, rule_id, event_key, mode, trigger_event, input_json, status, output_json,
            error, duration_ms, created_at)
         VALUES ('run-failed-1', ?, 'live-1', 'live', 'task.created', ?, 'failed', '{}',
           'boom', 2, ?)`,
      )
      .run(
        str(rule.id),
        JSON.stringify({ projectId: str(project.id), title: '失败任务' }),
        TEST_NOW.toISOString(),
      );

    const dead = await call(app, cookies.admin, 'GET', '/api/automation/runs/dead-letter');
    assert.ok(
      arr(expectStatus(dead, 200, 'dead letters')).some(
        (row) => str(obj(row).id) === 'run-failed-1',
      ),
    );

    expectStatus(
      await call(app, cookies.viewer, 'POST', '/api/automation/runs/run-failed-1/replay'),
      403,
      'viewer replay',
    );
    const replay = await call(
      app,
      cookies.admin,
      'POST',
      '/api/automation/runs/run-failed-1/replay',
    );
    const replayed = expectStatus(replay, 201, 'replay run');
    assert.equal(str(replayed.mode), 'replay');
    assert.equal(str(replayed.replayOf), 'run-failed-1');
    assert.equal(str(replayed.status), 'ok');

    const retried = await call(
      app,
      cookies.admin,
      'POST',
      '/api/automation/runs/run-failed-1/actions/0/retry',
    );
    const retriedBody = expectStatus(retried, 201, 'retry single action');
    assert.equal(num(obj(retriedBody.output).retriedAction), 0);
    expectStatus(
      await call(app, cookies.admin, 'POST', '/api/automation/runs/run-failed-1/actions/9/retry'),
      400,
      'invalid action index',
    );

    const clearedDead = await call(app, cookies.admin, 'GET', '/api/automation/runs/dead-letter');
    assert.ok(
      !arr(expectStatus(clearedDead, 200, 'dead letters after replay')).some(
        (row) => str(obj(row).id) === 'run-failed-1',
      ),
      'replayed runs drop out of the dead-letter queue',
    );

    const pruned = await call(app, cookies.admin, 'POST', '/api/automation/runs/prune', {
      olderThanDays: 1,
    });
    assert.ok(num(expectStatus(pruned, 200, 'prune runs').removed) >= 1);
    const remaining = await call(
      app,
      cookies.admin,
      'GET',
      `/api/automation/runs?ruleId=${str(rule.id)}`,
    );
    assert.equal(arr(expectStatus(remaining, 200, 'runs after prune')).length, 2);
  });
});

describe('data quality remediation', () => {
  test('scan creates issues and fixes preserve original, fixed and reason', async () => {
    const { app, cookies } = await setup();
    const project = await createProject(app, cookies.admin, '缺截止日期项目');

    const ruleResult = await call(app, cookies.admin, 'POST', '/api/workbench/quality-rules', {
      name: '项目完整性',
      dataset: 'projects',
      ruleType: 'completeness',
    });
    const rule = expectStatus(ruleResult, 201, 'create quality rule');
    const ruleId = str(rule.id);

    const scan = await call(app, cookies.admin, 'POST', '/api/quality/scan', { ruleId });
    const scanBody = expectStatus(scan, 200, 'quality scan');
    assert.ok(num(scanBody.created) >= 1);
    assert.ok(num(scanBody.open) >= 1);

    const viewerScan = await call(app, cookies.viewer, 'POST', '/api/quality/scan', {});
    expectStatus(viewerScan, 403, 'viewer scan');

    const issues = await call(
      app,
      cookies.admin,
      'GET',
      `/api/workbench/quality-issues?ruleId=${ruleId}`,
    );
    const issueRows = items(expectStatus(issues, 200, 'quality issues'));
    const issue = issueRows.find((row) => str(obj(row.detailsJson).recordId) === str(project.id));
    assert.ok(issue, 'issue for created project');
    const issueId = str(issue?.id);
    assert.equal(str(issue?.status), 'open');

    const preview = await call(app, cookies.admin, 'POST', `/api/quality/issues/${issueId}/fix`, {
      fixed: { due_date: '2026-12-31' },
      reason: '补齐截止日期',
      preview: true,
    });
    const previewBody = expectStatus(preview, 200, 'quality fix preview');
    assert.equal(str(obj(previewBody.changes).due_date), '2026-12-31');

    const fixed = await call(app, cookies.admin, 'POST', `/api/quality/issues/${issueId}/fix`, {
      fixed: { due_date: '2026-12-31' },
      reason: '补齐截止日期',
    });
    const fixedIssue = expectStatus(fixed, 200, 'quality fix');
    assert.equal(str(fixedIssue.status), 'fixed');
    assert.equal(str(fixedIssue.fix_reason), '补齐截止日期');
    assert.equal(str(fixedIssue.resolved_by), DEMO.admin.id);
    const original = JSON.parse(str(fixedIssue.original_json)) as Json;
    const fixedJson = JSON.parse(str(fixedIssue.fixed_json)) as Json;
    assert.equal(original.due_date, null);
    assert.equal(str(fixedJson.due_date), '2026-12-31');

    const second = await createProject(app, cookies.admin, '第二个缺截止日期项目');
    const secondScan = await call(app, cookies.admin, 'POST', '/api/quality/scan', { ruleId });
    expectStatus(secondScan, 200, 'second scan');
    const secondIssues = await call(
      app,
      cookies.admin,
      'GET',
      `/api/workbench/quality-issues?ruleId=${ruleId}`,
    );
    const secondIssue = items(expectStatus(secondIssues, 200, 'second issues')).find(
      (row) => str(obj(row.detailsJson).recordId) === str(second.id),
    );
    assert.ok(secondIssue);

    const batchPreview = await call(app, cookies.admin, 'POST', '/api/quality/issues/batch-fix', {
      issueIds: [str(secondIssue?.id)],
      fixed: { due_date: '2027-01-31' },
      reason: '批量补齐',
      preview: true,
    });
    assert.equal(num(expectStatus(batchPreview, 200, 'batch preview').fixed), 1);
    const batch = await call(app, cookies.admin, 'POST', '/api/quality/issues/batch-fix', {
      issueIds: [str(secondIssue?.id)],
      fixed: { due_date: '2027-01-31' },
      reason: '批量补齐',
    });
    const batchBody = expectStatus(batch, 200, 'batch apply');
    assert.equal(num(batchBody.fixed), 1);
    assert.deepEqual(batchBody.skipped, []);
  });
});

describe('analytics and forecasting', () => {
  test('anomalies, scenarios, funnel, queries, subscriptions, budgets and lineage', async () => {
    const { app, store, cookies } = await setup();
    const metricIds: string[] = [];
    for (const name of ['收入', '收入衍生', '收入下游']) {
      const result = await call(app, cookies.admin, 'POST', '/api/metrics', {
        name,
        formula: 'revenue_cents',
        unit: 'USD',
      });
      metricIds.push(str(expectStatus(result, 201, `create metric ${name}`).id));
    }
    const [metricA, metricB, metricC] = metricIds as [string, string, string];

    store.db
      .stmt('UPDATE daily_metrics SET revenue_cents = ? WHERE date = ?')
      .run(50_000_000, '2026-06-10');

    const detected = await call(app, cookies.admin, 'POST', '/api/anomalies/detect', {
      metricId: metricA,
      from: '2026-06-01',
      to: '2026-06-15',
      threshold: 2,
    });
    const anomalyBody = expectStatus(detected, 200, 'detect anomalies');
    assert.ok(arr(anomalyBody.anomalies).length >= 1);
    const anomaly = obj(arr(anomalyBody.anomalies)[0]);
    assert.ok(num(anomaly.value) > 0);

    const anomalyList = await call(
      app,
      cookies.admin,
      'GET',
      `/api/workbench/anomalies?metricId=${metricA}`,
    );
    assert.ok(items(expectStatus(anomalyList, 200, 'anomaly list')).length >= 1);

    const dismissed = await call(
      app,
      cookies.admin,
      'POST',
      `/api/anomalies/${str(anomaly.id)}/dismiss`,
      {
        note: '已确认营销活动',
      },
    );
    assert.equal(str(expectStatus(dismissed, 200, 'dismiss anomaly').status), 'dismissed');

    const scenarios: string[] = [];
    for (const [name, growth] of [
      ['乐观情景', 20],
      ['保守情景', -10],
    ] as const) {
      const result = await call(app, cookies.admin, 'POST', '/api/workbench/scenarios', {
        name,
        assumptions: { revenueGrowthPct: growth, costGrowthPct: 5 },
        baseDate: '2026-06-15',
      });
      scenarios.push(str(expectStatus(result, 201, `create scenario ${name}`).id));
    }
    const evaluated = await call(
      app,
      cookies.admin,
      'POST',
      `/api/scenarios/${scenarios[0]}/evaluate`,
    );
    const evaluatedBody = expectStatus(evaluated, 200, 'evaluate scenario');
    assert.ok(num(obj(obj(evaluatedBody.result).projected).revenueCents) > 0);
    const compared = await call(app, cookies.admin, 'POST', '/api/scenarios/compare', {
      ids: scenarios,
    });
    const compareBody = expectStatus(compared, 200, 'compare scenarios');
    assert.equal(arr(compareBody.ranked).length, 2);

    for (const [index, stage] of ['lead', 'opportunity', 'contract', 'churned'].entries()) {
      const result = await call(app, cookies.admin, 'POST', '/api/workbench/opportunities', {
        customerName: `客户 ${index + 1}`,
        customerEmail: `customer${index + 1}@example.com`,
        stage,
        amountCents: 100_000 * (index + 1),
      });
      expectStatus(result, 201, `create opportunity ${stage}`);
    }
    const funnel = await call(app, cookies.admin, 'GET', '/api/crm/funnel');
    const funnelBody = expectStatus(funnel, 200, 'funnel');
    assert.equal(arr(funnelBody.steps).length, 4);
    assert.ok(num(obj(arr(funnelBody.steps)[0]).count) >= 1);

    const preview = await call(app, cookies.admin, 'POST', '/api/query/preview', {
      config: {
        dataset: 'daily_metrics',
        fields: ['date', 'revenue_cents'],
        limit: 5,
      },
    });
    const previewBody = expectStatus(preview, 200, 'query preview');
    assert.equal(num(previewBody.rowCount), 5);
    assert.deepEqual(arr(previewBody.columns), ['date', 'revenue_cents']);

    const invalidQuery = await call(app, cookies.admin, 'POST', '/api/query/preview', {
      config: { dataset: 'secret_table', fields: ['id'] },
    });
    expectStatus(invalidQuery, 400, 'invalid query');

    const reportResult = await call(app, cookies.admin, 'POST', '/api/workbench/query-reports', {
      name: '收入日报',
      config: { dataset: 'daily_metrics', fields: ['date', 'revenue_cents'], limit: 3 },
      shared: true,
    });
    const report = expectStatus(reportResult, 201, 'create query report');
    const run = await call(
      app,
      cookies.manager,
      'POST',
      `/api/query-reports/${str(report.id)}/run`,
    );
    assert.equal(num(expectStatus(run, 200, 'run shared report').rowCount), 3);
    const ownerRun = await call(
      app,
      cookies.admin,
      'POST',
      `/api/query-reports/${str(report.id)}/run`,
    );
    expectStatus(ownerRun, 200, 'owner run report');
    const viewerRun = await call(
      app,
      cookies.viewer,
      'POST',
      `/api/query-reports/${str(report.id)}/run`,
    );
    expectStatus(viewerRun, 200, 'viewer run shared report');

    const privateReport = expectStatus(
      await call(app, cookies.admin, 'POST', '/api/workbench/query-reports', {
        name: '私有收入报表',
        config: { dataset: 'daily_metrics', fields: ['date', 'revenue_cents'] },
        shared: false,
      }),
      201,
      'create private report',
    );
    const privateRun = await call(
      app,
      cookies.viewer,
      'POST',
      `/api/query-reports/${str(privateReport.id)}/run`,
    );
    expectStatus(privateRun, 403, 'viewer run private report');

    const secretProject = await createProject(app, cookies.admin, '机密查询项目');
    const sharedProjects = expectStatus(
      await call(app, cookies.admin, 'POST', '/api/workbench/query-reports', {
        name: '项目清单',
        config: {
          dataset: 'projects',
          fields: ['id', 'name'],
          filters: [{ field: 'name', operator: 'contains', value: '机密查询' }],
        },
        shared: true,
      }),
      201,
      'create shared project report',
    );
    const adminSharedRun = await call(
      app,
      cookies.admin,
      'POST',
      `/api/query-reports/${str(sharedProjects.id)}/run`,
    );
    assert.equal(num(expectStatus(adminSharedRun, 200, 'admin shared run').rowCount), 1);
    const viewerSharedRun = await call(
      app,
      cookies.viewer,
      'POST',
      `/api/query-reports/${str(sharedProjects.id)}/run`,
    );
    assert.equal(
      num(expectStatus(viewerSharedRun, 200, 'viewer shared run').rowCount),
      0,
      'shared report must not exceed viewer project visibility',
    );
    assert.ok(str(secretProject.id).length > 0);

    const subscriptionResult = await call(app, cookies.admin, 'POST', '/api/report-subscriptions', {
      reportId: str(report.id),
      reportKind: 'query',
      recipients: ['ops@example.com'],
      nextRunAt: TEST_NOW.toISOString(),
    });
    const subscription = expectStatus(subscriptionResult, 201, 'create report subscription');
    const subscriptionRun = await call(app, cookies.admin, 'POST', '/api/report-subscriptions/run');
    const subscriptionBody = expectStatus(subscriptionRun, 200, 'run subscriptions');
    assert.equal(arr(subscriptionBody.deliveries).length, 1);
    const replay = await call(app, cookies.admin, 'POST', '/api/report-subscriptions/run');
    assert.equal(num(expectStatus(replay, 200, 'replay subscriptions').processed), 0);
    const deliveries = await call(
      app,
      cookies.admin,
      'GET',
      `/api/workbench/report-deliveries?subscriptionId=${str(subscription.id)}`,
    );
    assert.equal(items(expectStatus(deliveries, 200, 'report deliveries')).length, 1);

    const weeklyResult = await call(app, cookies.admin, 'POST', '/api/report-subscriptions', {
      reportId: str(report.id),
      reportKind: 'query',
      recipients: ['ops@example.com'],
      cadence: 'weekly',
      nextRunAt: TEST_NOW.toISOString(),
    });
    const weekly = expectStatus(weeklyResult, 201, 'create weekly subscription');
    assert.equal(str(weekly.cadence), 'weekly');
    const weeklyRun = await call(app, cookies.admin, 'POST', '/api/report-subscriptions/run');
    const weeklyDeliveries = arr(
      expectStatus(weeklyRun, 200, 'run weekly subscription').deliveries,
    ).map(obj);
    const weeklyDelivery = weeklyDeliveries.find(
      (row) => str(row.subscription_id) === str(weekly.id),
    );
    assert.ok(weeklyDelivery, 'weekly subscription delivered');
    assert.match(str(weeklyDelivery?.period_key), /^\d{4}-W\d{2}$/);

    const budget = await call(
      app,
      cookies.admin,
      'PUT',
      `/api/projects/${str(report.id)}/budget`,
      {},
    );
    expectStatus(budget, 404, 'budget for non-project');

    const project = await createProject(app, cookies.admin, '预算项目');
    const projectId = str(project.id);
    const upsert = await call(app, cookies.admin, 'PUT', `/api/projects/${projectId}/budget`, {
      costCenter: '增长中心',
      budgetCents: 1_000_000,
      forecastCents: 200_000,
      thresholdPct: 80,
    });
    const budgetBody = expectStatus(upsert, 200, 'upsert budget');
    const budgetId = str(obj(budgetBody.budget).id);
    assert.equal(num(obj(budgetBody.budget).version), 1);

    const categoryResult = await call(
      app,
      cookies.admin,
      'POST',
      `/api/budgets/${budgetId}/categories`,
      {
        name: '广告投放',
        plannedCents: 100_000,
        actualCents: 200_000,
      },
    );
    const category = expectStatus(categoryResult, 201, 'create budget category');
    const categoryId = str(category.id);

    const categoryUpdate = await call(
      app,
      cookies.admin,
      'PATCH',
      `/api/budget-categories/${categoryId}`,
      {
        name: '广告投放（更新）',
        version: 1,
      },
    );
    assert.equal(num(expectStatus(categoryUpdate, 200, 'update category').version), 2);
    const categoryStale = await call(
      app,
      cookies.admin,
      'PATCH',
      `/api/budget-categories/${categoryId}`,
      {
        name: '过期写入',
        version: 1,
      },
    );
    expectStatus(categoryStale, 409, 'stale category update');

    const alerts = await call(
      app,
      cookies.admin,
      'GET',
      `/api/projects/${projectId}/budget-alerts`,
    );
    const alertBody = expectStatus(alerts, 200, 'budget alerts');
    assert.ok(arr(alertBody.alerts).some((entry) => str(obj(entry).scope) === 'category'));

    const now = TEST_NOW.toISOString();
    const lineage = [
      [metricA, 'table', 'daily_metrics', 'derives'],
      [metricB, 'metric', metricA, 'derives'],
      [metricC, 'metric', metricB, 'derives'],
    ] as const;
    for (const [metricId, sourceType, sourceId, relation] of lineage) {
      store.db
        .stmt(
          `INSERT INTO metric_lineage (id, metric_id, source_type, source_id, relation, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(crypto.randomUUID(), metricId, sourceType, sourceId, relation, now);
    }
    const impact = await call(app, cookies.admin, 'GET', `/api/metrics/${metricA}/impact`);
    const impactBody = expectStatus(impact, 200, 'lineage impact');
    assert.equal(arr(impactBody.upstream).length, 1);
    assert.equal(str(obj(arr(impactBody.upstream)[0]).source_type), 'table');
    const downstreamIds = arr(impactBody.downstream).map((entry) => str(obj(entry).id));
    assert.ok(downstreamIds.includes(metricB));
    assert.ok(downstreamIds.includes(metricC));
    assert.equal(obj(impactBody.lineage).complete, true);
    assert.equal(str(obj(arr(impactBody.upstream)[0]).source_id), 'daily_metrics');

    const cycle = await call(app, cookies.admin, 'POST', `/api/metrics/${metricA}/lineage`, {
      sourceType: 'metric',
      sourceId: metricC,
    });
    expectStatus(cycle, 400, 'lineage cycle');

    const viewerLineage = await call(
      app,
      cookies.viewer,
      'POST',
      `/api/metrics/${metricA}/lineage`,
      { sourceType: 'table', sourceId: 'orders' },
    );
    expectStatus(viewerLineage, 403, 'viewer lineage write');

    const detailMetric = expectStatus(
      await call(app, cookies.admin, 'POST', '/api/metrics', {
        name: '收入实验',
        formula: 'revenue_cents',
      }),
      201,
      'create detail metric',
    );
    const detailId = str(detailMetric.id);
    expectStatus(
      await call(app, cookies.admin, 'POST', `/api/metrics/${detailId}/lineage`, {
        sourceType: 'table',
        sourceId: 'orders',
      }),
      201,
      'table lineage',
    );
    expectStatus(
      await call(app, cookies.admin, 'POST', `/api/metrics/${detailId}/lineage`, {
        sourceType: 'filter',
        sourceId: 'region=EU',
        sensitive: true,
      }),
      201,
      'sensitive filter lineage',
    );
    const replayLineage = await call(
      app,
      cookies.admin,
      'POST',
      `/api/metrics/${detailId}/lineage`,
      { sourceType: 'table', sourceId: 'orders' },
    );
    assert.equal(expectStatus(replayLineage, 200, 'lineage replay').duplicate, true);

    const adminDetail = expectStatus(
      await call(app, cookies.admin, 'GET', `/api/metrics/${detailId}/impact`),
      200,
      'admin detail impact',
    );
    assert.equal(obj(adminDetail.lineage).complete, true);
    assert.equal(arr(adminDetail.upstream).length, 2);
    assert.ok(arr(adminDetail.catalog && obj(adminDetail.catalog).tables).includes('orders'));
    assert.equal(adminDetail.trimmed, false);

    const viewerDetail = expectStatus(
      await call(app, cookies.viewer, 'GET', `/api/metrics/${detailId}/impact`),
      200,
      'viewer detail impact',
    );
    assert.equal(arr(viewerDetail.upstream).length, 1, 'sensitive lineage trimmed');
    assert.equal(viewerDetail.trimmed, true);

    const lineages = auditRows(store, 'metric.lineage.create', detailId);
    assert.equal(lineages.length, 2);

    const bareMetric = expectStatus(
      await call(app, cookies.admin, 'POST', '/api/metrics', {
        name: '无来源指标',
        formula: 'customers',
      }),
      201,
      'create bare metric',
    );
    const bareImpact = expectStatus(
      await call(app, cookies.admin, 'GET', `/api/metrics/${str(bareMetric.id)}/impact`),
      200,
      'bare impact',
    );
    assert.equal(obj(bareImpact.lineage).complete, false);
    assert.ok(arr(obj(bareImpact.lineage).missing).includes('all'));

    const chart = expectStatus(
      await call(app, cookies.admin, 'POST', '/api/workbench/query-reports', {
        name: '收入趋势图',
        config: {
          dataset: 'daily_metrics',
          fields: ['date', 'revenue_cents'],
          metricId: metricA,
          visualization: 'line',
        },
        shared: true,
      }),
      201,
      'create chart report',
    );
    assert.ok(str(chart.id).length > 0);
    const rule = await call(app, cookies.admin, 'POST', '/api/automation/rules', {
      name: '指标异常通知',
      trigger: 'task.updated',
      conditions: [{ field: 'metricId', operator: 'eq', value: metricA }],
      actions: [{ type: 'notify', value: 'admin' }],
    });
    expectStatus(rule, 201, 'create metric automation rule');
    const affectedImpact = expectStatus(
      await call(app, cookies.admin, 'GET', `/api/metrics/${metricA}/impact`),
      200,
      'affected impact',
    );
    const affected = obj(affectedImpact.affected);
    assert.ok(arr(affected.charts).some((entry) => str(obj(entry).id) === str(chart.id)));
    assert.ok(
      arr(affected.automationRules).some((entry) => str(obj(entry).name) === '指标异常通知'),
    );
  });
});

describe('organization, workspaces and JIT governance', () => {
  test('organizations, workspace switching, permission samples and JIT review', async () => {
    const { app, store, cookies } = await setup();

    const orgResult = await call(app, cookies.admin, 'POST', '/api/organizations', {
      name: 'Pulse 集团',
      slug: 'pulse-group',
    });
    const org = expectStatus(orgResult, 201, 'create organization');
    expectStatus(
      await call(app, cookies.admin, 'POST', '/api/organizations', {
        name: '重复组织',
        slug: 'pulse-group',
      }),
      409,
      'duplicate organization',
    );
    expectStatus(
      await call(app, cookies.manager, 'POST', '/api/organizations', {
        name: '越权组织',
        slug: 'unauthorized',
      }),
      403,
      'manager organization',
    );

    const deptResult = await call(
      app,
      cookies.admin,
      'POST',
      `/api/organizations/${str(org.id)}/departments`,
      {
        name: '增长部',
      },
    );
    const department = expectStatus(deptResult, 201, 'create department');
    const memberResult = await call(
      app,
      cookies.admin,
      'POST',
      `/api/organizations/${str(org.id)}/members`,
      {
        userId: DEMO.pm.id,
        departmentId: str(department.id),
        title: '项目经理',
      },
    );
    expectStatus(memberResult, 201, 'add organization membership');

    const workspaceMember = await call(app, cookies.admin, 'POST', '/api/workspace/members', {
      userId: DEMO.pm.id,
      role: 'manager',
    });
    expectStatus(workspaceMember, 201, 'upsert workspace member');
    expectStatus(
      await call(app, cookies.pm, 'POST', '/api/workspace/members', {
        userId: DEMO.viewer.id,
        role: 'viewer',
      }),
      403,
      'pm workspace member',
    );

    const secondWorkspaceId = '99999999-9999-4999-8999-999999999999';
    const now = TEST_NOW.toISOString();
    store.db
      .stmt(
        'INSERT INTO workspaces (id, name, slug, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(secondWorkspaceId, '第二工作区', 'second-space', now, now);

    const switched = await call(app, cookies.admin, 'POST', '/api/workspace/switch', {
      workspaceId: secondWorkspaceId,
    });
    expectStatus(switched, 200, 'admin switch workspace');
    const me = await call(app, cookies.admin, 'GET', '/api/auth/me');
    assert.equal(
      str(obj(expectStatus(me, 200, 'me after switch').user).workspaceId),
      secondWorkspaceId,
    );
    const pmSwitch = await call(app, cookies.pm, 'POST', '/api/workspace/switch', {
      workspaceId: secondWorkspaceId,
    });
    expectStatus(pmSwitch, 403, 'pm switch workspace');
    expectStatus(
      await call(app, cookies.admin, 'POST', '/api/workspace/switch', {
        workspaceId: 'ws_default',
      }),
      200,
      'admin switch back',
    );

    const sampleProject = await createProject(app, cookies.admin, '权限样例项目', {
      memberIds: [DEMO.viewer.id],
    });
    for (const [name, action, expectedAllow] of [
      ['只读成员查看项目', 'view', true],
      ['只读成员管理项目', 'manage', true],
    ] as const) {
      const result = await call(app, cookies.admin, 'POST', '/api/workbench/permission-samples', {
        name,
        userId: DEMO.viewer.id,
        resourceType: 'project',
        resourceId: str(sampleProject.id),
        action,
        expectedAllow,
      });
      expectStatus(result, 201, `create sample ${name}`);
    }
    const samplesRun = await call(app, cookies.admin, 'POST', '/api/permission-samples/run', {});
    const samplesBody = expectStatus(samplesRun, 200, 'run permission samples');
    assert.equal(num(samplesBody.total), 2);
    assert.equal(num(samplesBody.passed), 1);
    assert.equal(num(samplesBody.failed), 1);
    expectStatus(
      await call(app, cookies.viewer, 'POST', '/api/permission-samples/run', {}),
      403,
      'viewer run samples',
    );

    const grantId = crypto.randomUUID();
    const startsAt = new Date(TEST_NOW.getTime() - 3_600_000).toISOString();
    const expiresAt = new Date(TEST_NOW.getTime() + 3_600_000).toISOString();
    store.db
      .stmt(
        `INSERT INTO jit_grants
           (id, workspace_id, user_id, resource_type, resource_id, action, permissions_json,
            reason, status, requested_by, approved_by, starts_at, expires_at, created_at, updated_at)
         VALUES (?, 'ws_default', ?, 'project', ?, 'manage', '[]', '紧急排障', 'active', ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        grantId,
        DEMO.viewer.id,
        str(sampleProject.id),
        DEMO.viewer.id,
        DEMO.admin.id,
        startsAt,
        expiresAt,
        now,
        now,
      );

    const used = await call(app, cookies.viewer, 'POST', '/api/governance/jit/use', {
      note: '排障使用',
    });
    const usedGrant = expectStatus(used, 200, 'use jit grant');
    assert.equal(num(usedGrant.used_count), 1);
    expectStatus(
      await call(app, cookies.viewer, 'POST', `/api/governance/jit/${grantId}/post-review`, {
        approved: false,
      }),
      403,
      'viewer post-review',
    );
    expectStatus(
      await call(app, cookies.manager, 'POST', `/api/governance/jit/${grantId}/post-review`, {
        approved: false,
      }),
      403,
      'manager post-review',
    );
    const reviewed = await call(
      app,
      cookies.admin,
      'POST',
      `/api/governance/jit/${grantId}/post-review`,
      {
        approved: false,
        note: '使用范围超出申请',
      },
    );
    assert.equal(str(expectStatus(reviewed, 200, 'post-review grant').status), 'revoked');
    expectStatus(
      await call(app, cookies.viewer, 'POST', '/api/governance/jit/use', {}),
      404,
      'use revoked grant automatically',
    );
    expectStatus(
      await call(app, cookies.viewer, 'POST', `/api/governance/jit/${grantId}/use`, {}),
      409,
      'use revoked grant explicitly',
    );
  });
});

describe('capacity, change, closure and execution controls', () => {
  async function listTasks(app: Hono<AppEnv>, cookie: string, projectId: string): Promise<Json[]> {
    const result = await call(app, cookie, 'GET', `/api/projects/${projectId}/tasks`);
    expectStatus(result, 200, 'list tasks');
    return arr(obj(result.body).tasks).map(obj);
  }

  test('capacity profiles, allocations and what-if scenarios', async () => {
    const { app, cookies } = await setup();
    const project = await createProject(app, cookies.admin, '容量项目');

    const own = await call(app, cookies.pm, 'PUT', `/api/capacity/profiles/${DEMO.pm.id}`, {
      weeklyHours: 32,
      fte: 0.8,
      skills: ['设计'],
    });
    const profile = expectStatus(own, 200, 'pm update own profile');
    assert.equal(num(profile.weekly_hours), 32);
    assert.equal(num(profile.fte), 0.8);

    expectStatus(
      await call(app, cookies.pm, 'PUT', `/api/capacity/profiles/${DEMO.viewer.id}`, {
        weeklyHours: 30,
      }),
      403,
      'pm update other profile',
    );
    expectStatus(
      await call(app, cookies.manager, 'GET', '/api/capacity'),
      403,
      'manager cannot read capacity',
    );

    expectStatus(
      await call(app, cookies.admin, 'POST', '/api/workbench/capacity-allocations', {
        userId: DEMO.pm.id,
        projectId: str(project.id),
        role: '设计',
        weeklyHours: 12,
        startDate: '2026-06-01',
        endDate: '2026-06-30',
        kind: 'allocation',
      }),
      201,
      'create capacity allocation',
    );

    const capacity = await call(
      app,
      cookies.admin,
      'GET',
      '/api/capacity?from=2026-06-01&to=2026-06-30',
    );
    expectStatus(capacity, 200, 'read capacity');
    const pmRow = arr(capacity.body)
      .map(obj)
      .find((row) => str(row.userId) === DEMO.pm.id);
    assert.ok(pmRow);
    assert.equal(num(pmRow.allocatedHours), 12);
    assert.equal(num(pmRow.supplyHours), 25.6);
    assert.deepEqual(pmRow.skills, ['设计']);

    const scenario = await call(app, cookies.admin, 'POST', '/api/capacity/scenarios', {
      adjustments: [{ userId: DEMO.pm.id, weeklyHours: 20 }],
      from: '2026-06-01',
      to: '2026-06-30',
    });
    const scenarioBody = expectStatus(scenario, 200, 'capacity scenario');
    const scenarioRow = arr(scenarioBody.items)
      .map(obj)
      .find((row) => str(row.userId) === DEMO.pm.id);
    assert.ok(scenarioRow);
    assert.equal(num(scenarioRow.proposedWeeklyHours), 20);
    assert.equal(num(scenarioRow.proposedSupplyHours), 16);
    assert.equal(num(scenarioRow.deltaHours), -9.6);
  });

  test('change requests enforce versioning and implementation order', async () => {
    const { app, store, cookies } = await setup();
    const project = await createProject(app, cookies.admin, '变更项目', {
      memberIds: [DEMO.viewer.id],
    });
    const projectId = str(project.id);

    expectStatus(
      await call(
        app,
        cookies.viewer,
        'POST',
        `/api/workbench/change-requests?projectId=${projectId}`,
        {
          title: '越权变更',
        },
      ),
      403,
      'viewer create change',
    );

    const created = await call(
      app,
      cookies.admin,
      'POST',
      `/api/workbench/change-requests?projectId=${projectId}`,
      {
        title: '扩大交付范围',
        kind: 'scope',
        reason: '客户新增需求',
        proposed: { scope: '增加报表' },
        impact: { hours: 16 },
      },
    );
    const change = expectStatus(created, 201, 'create change');
    const changeId = str(change.id);
    assert.equal(str(change.status), 'draft');

    const stale = await call(app, cookies.admin, 'POST', `/api/changes/${changeId}/decisions`, {
      action: 'approve',
      note: '同意',
      version: 5,
    });
    expectStatus(stale, 409, 'stale change decision');
    assert.ok(obj(stale.body).current);

    const approved = await call(app, cookies.admin, 'POST', `/api/changes/${changeId}/decisions`, {
      action: 'approve',
      note: '同意',
      version: 1,
    });
    const approvedBody = expectStatus(approved, 200, 'approve change');
    assert.equal(str(approvedBody.status), 'approved');
    assert.equal(num(approvedBody.version), 2);

    const implemented = await call(
      app,
      cookies.admin,
      'POST',
      `/api/changes/${changeId}/decisions`,
      { action: 'implement', note: '实施', version: 2 },
    );
    const implementedBody = expectStatus(implemented, 200, 'implement change');
    assert.equal(str(implementedBody.status), 'implemented');

    expectStatus(
      await call(app, cookies.admin, 'POST', `/api/changes/${changeId}/decisions`, {
        action: 'implement',
        note: '重复实施',
        version: 3,
      }),
      409,
      'repeat implement',
    );

    const audits = auditRows(store, 'change_request.decide', changeId);
    assert.equal(audits.length, 2);
    const detail = JSON.parse(str(audits[1]?.detail)) as Json;
    assert.equal(str(detail.action), 'implement');
    assert.ok(detail.before);
    assert.equal(str(obj(detail.after).status), 'implemented');
  });

  test('project closure, benefit records and reopen', async () => {
    const { app, cookies } = await setup();
    const project = await createProject(app, cookies.admin, '结项项目', {
      memberIds: [DEMO.viewer.id],
    });
    const projectId = str(project.id);
    await createTask(app, cookies.admin, projectId, '遗留任务');

    const closed = await call(app, cookies.admin, 'POST', `/api/projects/${projectId}/closure`, {
      acceptance: [{ item: '验收报告', accepted: true }],
      actualCostCents: 128_000,
      openItems: ['遗留巡检'],
      feedback: '按期交付',
      benefitPlan: [{ label: '效率提升', targetValue: 20, dueOn: '2026-09-15' }],
    });
    const closure = expectStatus(closed, 201, 'close project');
    assert.equal(str(closure.status), 'closed');
    assert.equal(num(closure.actual_cost_cents), 128_000);

    const readClosure = await call(
      app,
      cookies.viewer,
      'GET',
      `/api/projects/${projectId}/closure`,
    );
    const closureBody = expectStatus(readClosure, 200, 'read project closure');
    assert.equal(str(obj(closureBody.closure).id), str(closure.id));
    assert.equal(arr(closureBody.benefits).length, 1);
    expectStatus(
      await call(
        app,
        cookies.admin,
        'GET',
        '/api/projects/00000000-0000-4000-8000-000000000000/closure',
      ),
      404,
      'read missing project closure',
    );

    expectStatus(
      await call(app, cookies.admin, 'POST', `/api/projects/${projectId}/closure`, {
        acceptance: [],
      }),
      409,
      'close project twice',
    );

    const reviews = await call(
      app,
      cookies.admin,
      'GET',
      `/api/workbench/benefit-reviews?closureId=${str(closure.id)}`,
    );
    expectStatus(reviews, 200, 'list benefit reviews');
    const reviewRows = items(reviews.body);
    assert.equal(reviewRows.length, 1);
    assert.equal(str(reviewRows[0]?.status), 'pending');
    const reviewId = str(reviewRows[0]?.id);

    expectStatus(
      await call(app, cookies.viewer, 'POST', `/api/benefit-reviews/${reviewId}/records`, {
        actual: { value: 12 },
        note: '越权',
      }),
      403,
      'viewer record benefit',
    );

    const recorded = await call(
      app,
      cookies.admin,
      'POST',
      `/api/benefit-reviews/${reviewId}/records`,
      { actual: { value: 12 }, note: '首季复盘' },
    );
    const benefit = expectStatus(recorded, 200, 'record benefit');
    assert.equal(str(benefit.status), 'completed');
    assert.equal(num(benefit.version), 2);

    expectStatus(
      await call(app, cookies.admin, 'POST', `/api/benefit-reviews/${reviewId}/records`, {
        actual: { value: 13 },
        note: '重复复盘',
      }),
      409,
      'record benefit twice',
    );

    const reopened = await call(
      app,
      cookies.admin,
      'POST',
      `/api/closures/${str(closure.id)}/reopen`,
      { reason: '客户追加需求' },
    );
    const reopenedBody = expectStatus(reopened, 200, 'reopen closure');
    assert.equal(str(reopenedBody.status), 'reopened');

    const projectAfter = await call(app, cookies.admin, 'GET', `/api/projects/${projectId}`);
    expectStatus(projectAfter, 200, 'read project after reopen');
    assert.equal(str(obj(projectAfter.body).status), 'active');

    expectStatus(
      await call(app, cookies.admin, 'POST', `/api/closures/${str(closure.id)}/reopen`, {
        reason: '重复重开',
      }),
      409,
      'reopen twice',
    );
  });

  test('SLA policies attach, pause, resume and escalate', async () => {
    const { app, store, cookies } = await setup();
    const policyRes = await call(app, cookies.admin, 'POST', '/api/workbench/sla-policies', {
      name: 'P1 响应策略',
      responseMinutes: 60,
      resolveMinutes: 480,
      active: true,
    });
    const policy = expectStatus(policyRes, 201, 'create sla policy');

    const project = await createProject(app, cookies.admin, 'SLA 项目', {
      memberIds: [DEMO.viewer.id],
    });
    const task = await createTask(app, cookies.admin, str(project.id), 'SLA 任务');
    const taskId = str(task.id);

    expectStatus(
      await call(app, cookies.viewer, 'POST', `/api/tasks/${taskId}/sla`, {
        policyId: str(policy.id),
      }),
      403,
      'viewer attach sla',
    );

    const attached = await call(app, cookies.admin, 'POST', `/api/tasks/${taskId}/sla`, {
      policyId: str(policy.id),
    });
    const instance = expectStatus(attached, 201, 'attach sla');
    assert.equal(str(instance.state), 'running');
    assert.ok(str(instance.response_due_at));
    assert.equal(num(instance.version), 1);

    expectStatus(
      await call(app, cookies.admin, 'POST', `/api/tasks/${taskId}/sla`, {
        policyId: str(policy.id),
      }),
      409,
      'attach sla twice',
    );

    const paused = expectStatus(
      await call(app, cookies.admin, 'POST', `/api/tasks/${taskId}/sla/pause`, {
        reason: '等待客户确认',
      }),
      200,
      'pause sla',
    );
    assert.equal(str(paused.state), 'paused');
    assert.equal(str(paused.pause_reason), '等待客户确认');

    const responded = expectStatus(
      await call(app, cookies.admin, 'POST', `/api/tasks/${taskId}/sla/respond`, {}),
      200,
      'respond sla',
    );
    assert.ok(str(responded.response_at));
    const reviewed = expectStatus(
      await call(app, cookies.admin, 'POST', `/api/tasks/${taskId}/sla/review`, {}),
      200,
      'review sla',
    );
    assert.ok(str(reviewed.reviewed_at));

    const secondTask = await createTask(app, cookies.admin, str(project.id), '自动匹配任务');
    const autoAttached = await call(
      app,
      cookies.admin,
      'POST',
      `/api/tasks/${str(secondTask.id)}/sla`,
      {
        auto: true,
      },
    );
    const autoInstance = expectStatus(autoAttached, 201, 'auto attach sla');
    assert.equal(str(autoInstance.policy_id), str(policy.id));
    const noReason = await call(
      app,
      cookies.admin,
      'POST',
      `/api/tasks/${str(secondTask.id)}/sla/pause`,
      {},
    );
    expectStatus(noReason, 400, 'pause requires reason');

    const resumed = expectStatus(
      await call(app, cookies.admin, 'POST', `/api/tasks/${taskId}/sla/resume`, {}),
      200,
      'resume sla',
    );
    assert.equal(str(resumed.state), 'running');
    assert.ok(num(resumed.paused_minutes) >= 0);

    const escalated = expectStatus(
      await call(app, cookies.admin, 'POST', `/api/tasks/${taskId}/sla/escalate`, {
        reason: '超时风险',
      }),
      200,
      'escalate sla',
    );
    assert.equal(num(escalated.escalated_level), 1);
    assert.equal(auditRows(store, 'task.sla.escalate', taskId).length, 1);
  });

  test('dispatch recommendations, handoffs and deliverable reviews', async () => {
    const { app, store, cookies } = await setup();
    const project = await createProject(app, cookies.admin, '执行项目', {
      memberIds: [DEMO.pm.id, DEMO.viewer.id],
    });
    const projectId = str(project.id);

    const ruleRes = await call(app, cookies.admin, 'POST', '/api/workbench/dispatch-rules', {
      name: '均衡分派',
      strategy: 'balanced',
      maxLoadHours: 40,
      active: true,
    });
    const rule = expectStatus(ruleRes, 201, 'create dispatch rule');

    const task = await createTask(app, cookies.admin, projectId, '待分派任务');
    const recommended = await call(app, cookies.admin, 'POST', '/api/dispatch/recommend', {
      taskId: str(task.id),
      ruleId: str(rule.id),
    });
    const recs = arr(expectStatus(recommended, 201, 'recommend dispatch')).map(obj);
    assert.ok(recs.length > 0);
    const rec = recs[0] ?? {};

    const accepted = await call(app, cookies.admin, 'POST', '/api/dispatch/decision', {
      recommendationId: str(rec.id),
      mode: 'assign',
    });
    const acceptedBody = expectStatus(accepted, 200, 'accept dispatch');
    assert.equal(str(acceptedBody.status), 'accepted');
    assert.equal(auditRows(store, 'task.dispatch.decide', str(task.id)).length, 1);

    expectStatus(
      await call(app, cookies.admin, 'POST', '/api/dispatch/decision', {
        recommendationId: str(rec.id),
        mode: 'assign',
      }),
      409,
      'decide dispatch twice',
    );

    const assigned = (await listTasks(app, cookies.admin, projectId)).find(
      (row) => str(row.id) === str(task.id),
    );
    assert.equal(str(assigned?.assigneeId), str(rec.candidate_id));

    const handoffTask = await createTask(app, cookies.admin, projectId, '交接任务');
    const handoffRes = await call(
      app,
      cookies.admin,
      'POST',
      `/api/tasks/${str(handoffTask.id)}/handoffs`,
      {
        toUserId: DEMO.pm.id,
        note: '请接手',
        includeComments: true,
        includeAttachments: true,
      },
    );
    const handoff = expectStatus(handoffRes, 201, 'create handoff');
    assert.equal(str(handoff.status), 'pending');

    expectStatus(
      await call(app, cookies.viewer, 'POST', `/api/handoffs/${str(handoff.id)}/decision`, {
        action: 'accept',
        note: '越权',
      }),
      403,
      'viewer decide handoff',
    );

    const handoffDone = await call(
      app,
      cookies.pm,
      'POST',
      `/api/handoffs/${str(handoff.id)}/decision`,
      { action: 'accept', note: '收到' },
    );
    assert.equal(str(expectStatus(handoffDone, 200, 'accept handoff').status), 'accepted');

    expectStatus(
      await call(app, cookies.pm, 'POST', `/api/handoffs/${str(handoff.id)}/decision`, {
        action: 'accept',
        note: '重复确认',
      }),
      409,
      'accept handoff twice',
    );

    const deliverableRes = await call(
      app,
      cookies.admin,
      'POST',
      `/api/workbench/deliverables?taskId=${str(handoffTask.id)}`,
      { name: '验收文档', required: true },
    );
    const deliverable = expectStatus(deliverableRes, 201, 'create deliverable');
    const deliverableId = str(deliverable.id);

    const version1 = expectStatus(
      await call(app, cookies.admin, 'POST', `/api/deliverables/${deliverableId}/versions`, {
        filename: 'v1.pdf',
        checksum: 'sha256-abc',
        note: '初稿',
      }),
      201,
      'add deliverable version',
    );
    assert.equal(num(version1.version), 1);
    assert.equal(str(version1.status), 'submitted');

    expectStatus(
      await call(app, cookies.viewer, 'POST', `/api/deliverables/${deliverableId}/reviews`, {
        action: 'approve',
      }),
      403,
      'viewer review deliverable',
    );

    const approved = await call(
      app,
      cookies.admin,
      'POST',
      `/api/deliverables/${deliverableId}/reviews`,
      { action: 'approve', note: '通过' },
    );
    assert.equal(str(expectStatus(approved, 200, 'approve deliverable').status), 'approved');

    expectStatus(
      await call(app, cookies.admin, 'POST', `/api/deliverables/${deliverableId}/versions`, {
        filename: 'v2.pdf',
      }),
      201,
      'add second deliverable version',
    );
    const rejected = await call(
      app,
      cookies.admin,
      'POST',
      `/api/deliverables/${deliverableId}/reviews`,
      { action: 'reject', note: '页码错误' },
    );
    assert.equal(str(expectStatus(rejected, 200, 'reject deliverable').status), 'rejected');

    const versions = await call(
      app,
      cookies.admin,
      'GET',
      `/api/workbench/deliverable-versions?deliverableId=${deliverableId}`,
    );
    expectStatus(versions, 200, 'list deliverable versions');
    assert.equal(items(versions.body).length, 2);
    assert.equal(auditRows(store, 'deliverable.review', deliverableId).length, 2);
  });

  test('task tree, estimates, meetings, forms and checklists', async () => {
    const { app, store, cookies } = await setup();
    const project = await createProject(app, cookies.admin, '树形项目');
    const projectId = str(project.id);
    const parent = await createTask(app, cookies.admin, projectId, '父任务');
    const child = await createTask(app, cookies.admin, projectId, '子任务');

    const stale = await call(app, cookies.admin, 'POST', '/api/tasks/tree/bulk', {
      projectId,
      action: 'status',
      taskIds: [str(child.id)],
      parentId: null,
      status: 'done',
      version: 99,
    });
    expectStatus(stale, 409, 'stale bulk update');

    const bulk = await call(app, cookies.admin, 'POST', '/api/tasks/tree/bulk', {
      projectId,
      action: 'status',
      taskIds: [str(child.id)],
      parentId: null,
      status: 'done',
      version: 1,
    });
    assert.equal(num(expectStatus(bulk, 200, 'bulk status').count), 1);

    const moved = await call(app, cookies.admin, 'POST', '/api/tasks/tree/bulk', {
      projectId,
      action: 'move',
      taskIds: [str(child.id)],
      parentId: str(parent.id),
    });
    const movedBody = expectStatus(moved, 200, 'bulk move');
    assert.equal(str(obj(arr(movedBody.affected)[0]).parent_id), str(parent.id));

    const estimated = await call(
      app,
      cookies.admin,
      'PATCH',
      `/api/tasks/${str(parent.id)}/estimate`,
      { estimatePoints: 5, estimateHours: 12.5, estimateSize: 'M' },
    );
    const estimateBody = expectStatus(estimated, 200, 'update estimate');
    assert.equal(num(estimateBody.estimate_points), 5);
    assert.equal(num(estimateBody.estimate_hours), 12.5);
    assert.equal(str(estimateBody.estimate_size), 'M');
    assert.equal(auditRows(store, 'task.estimate.update', str(parent.id)).length, 1);

    expectStatus(
      await call(app, cookies.admin, 'POST', '/api/tasks/tree/bulk', {
        projectId,
        action: 'delete',
        taskIds: [str(child.id)],
        parentId: null,
      }),
      200,
      'bulk delete',
    );
    const remaining = await listTasks(app, cookies.admin, projectId);
    assert.ok(!remaining.some((row) => str(row.id) === str(child.id)));

    const meetingRes = await call(
      app,
      cookies.admin,
      'POST',
      `/api/workbench/meetings?projectId=${projectId}`,
      {
        title: '周会',
        startsAt: '2026-06-16T01:00:00.000Z',
        agenda: ['进度', '风险'],
      },
    );
    const meeting = expectStatus(meetingRes, 201, 'create meeting');
    assert.equal(num(meeting.version), 1);

    expectStatus(
      await call(app, cookies.admin, 'POST', `/api/meetings/${str(meeting.id)}/complete`, {
        minutes: '过期纪要',
        version: 9,
      }),
      409,
      'stale meeting completion',
    );

    const completed = await call(
      app,
      cookies.admin,
      'POST',
      `/api/meetings/${str(meeting.id)}/complete`,
      {
        minutes: '确认两周内交付',
        decisions: ['按原计划推进'],
        actions: [{ title: '补充风险清单', assigneeId: DEMO.pm.id, dueOn: '2026-06-20' }],
        version: 1,
      },
    );
    const completedBody = expectStatus(completed, 200, 'complete meeting');
    assert.equal(str(obj(completedBody.meeting).status), 'completed');
    const actionRow = obj(arr(completedBody.actions)[0]);
    assert.equal(str(actionRow.title), '补充风险清单');

    const converted = await call(
      app,
      cookies.admin,
      'POST',
      `/api/meeting-actions/${str(actionRow.id)}/convert`,
      {},
    );
    assert.ok(str(expectStatus(converted, 201, 'convert meeting action').task_id));
    expectStatus(
      await call(
        app,
        cookies.admin,
        'POST',
        `/api/meeting-actions/${str(actionRow.id)}/convert`,
        {},
      ),
      409,
      'convert meeting action twice',
    );

    const formRes = await call(app, cookies.admin, 'POST', '/api/workbench/task-forms', {
      name: '验收表单',
      fields: [
        { key: 'score', label: '评分', type: 'number', required: true },
        { key: 'comment', label: '备注', type: 'textarea' },
      ],
      active: true,
    });
    const form = expectStatus(formRes, 201, 'create task form');

    const itemRes = await call(
      app,
      cookies.admin,
      'POST',
      `/api/workbench/checklist-items?taskId=${str(parent.id)}`,
      { label: '提交验收材料', formId: str(form.id), required: true, sortOrder: 1 },
    );
    const item = expectStatus(itemRes, 201, 'create checklist item');
    assert.equal(item.required, true);

    expectStatus(
      await call(app, cookies.admin, 'PUT', `/api/tasks/${str(parent.id)}/forms/${str(form.id)}`, {
        values: {},
        completed: true,
      }),
      400,
      'form missing required value',
    );

    expectStatus(
      await call(app, cookies.admin, 'PUT', `/api/tasks/${str(parent.id)}/forms/${str(form.id)}`, {
        values: { score: 5 },
        completed: true,
      }),
      400,
      'form checklist pending',
    );

    const checked = await call(
      app,
      cookies.admin,
      'PATCH',
      `/api/workbench/checklist-items/${str(item.id)}`,
      { done: true },
    );
    assert.equal(expectStatus(checked, 200, 'complete checklist item').done, true);

    const submitted = await call(
      app,
      cookies.admin,
      'PUT',
      `/api/tasks/${str(parent.id)}/forms/${str(form.id)}`,
      { values: { score: 5, comment: '良好' }, completed: true, signature: '林晓' },
    );
    const submittedBody = expectStatus(submitted, 200, 'submit form values');
    assert.ok(str(submittedBody.completed_at));
    assert.equal(num(submittedBody.form_version), 1);
  });
});

describe('enterprise analytics extensions', () => {
  test('health config, factor explanations and snapshot trend', async () => {
    const { app, store, cookies } = await setup();
    const project = await createProject(app, cookies.admin, '健康度扩展项目', {
      dueDate: '2026-08-01',
      memberIds: [DEMO.viewer.id],
    });
    const projectId = str(project.id);
    const tasks = [
      ['已完成任务', { status: 'done', dueDate: '2026-06-01' }],
      ['逾期任务', { status: 'todo', dueDate: '2026-06-01' }],
      ['未来任务', { status: 'todo', dueDate: '2026-08-01' }],
    ] as const;
    for (const [title, extra] of tasks) {
      expectStatus(
        await call(app, cookies.admin, 'POST', `/api/projects/${projectId}/tasks`, {
          title,
          ...extra,
        }),
        201,
        `create health task ${title}`,
      );
    }

    const defaults = expectStatus(
      await call(app, cookies.admin, 'GET', `/api/projects/${projectId}/health/config`),
      200,
      'health config defaults',
    );
    assert.equal(str(defaults.source), 'default');
    assert.equal(num(obj(defaults.thresholds).progress), 60);

    expectStatus(
      await call(app, cookies.viewer, 'PUT', `/api/projects/${projectId}/health/config`, {
        thresholds: { progress: 50 },
      }),
      403,
      'viewer health config',
    );
    const configured = expectStatus(
      await call(app, cookies.admin, 'PUT', `/api/projects/${projectId}/health/config`, {
        thresholds: { progress: 50, workload: 0.8 },
        weights: { progress: 0.5, workload: 9 },
      }),
      200,
      'update health config',
    );
    assert.equal(str(configured.source), 'project');
    assert.equal(num(obj(configured.thresholds).progress), 50);
    assert.equal(num(obj(configured.weights).workload), 9);

    const first = expectStatus(
      await call(app, cookies.admin, 'POST', `/api/projects/${projectId}/health`),
      200,
      'compute health',
    );
    const factors = JSON.parse(str(first.factors_json)) as Json;
    const missing = JSON.parse(str(first.missing_json)) as unknown[];
    assert.equal(num(obj(factors.thresholds).progress), 50);
    assert.equal(num(obj(factors.weights).workload), 9);
    assert.equal(str(factors.predictionSource), 'heuristic');
    assert.ok(arr(factors.explanations).length >= 6);
    assert.ok(!missing.includes('tasks'));
    assert.ok(!missing.includes('dueDate'));
    assert.ok(num(first.score) >= 0 && num(first.score) <= 100);
    assert.ok(num(first.confidence) > 0 && num(first.confidence) <= 1);

    const latest = expectStatus(
      await call(app, cookies.admin, 'GET', `/api/projects/${projectId}/health`),
      200,
      'latest health',
    );
    assert.equal(str(latest.id), str(first.id));

    const second = expectStatus(
      await call(app, cookies.admin, 'POST', `/api/projects/${projectId}/health`),
      200,
      'second health snapshot',
    );
    assert.ok(str(second.id) !== str(first.id));
    const trend = expectStatus(
      await call(app, cookies.admin, 'GET', `/api/projects/${projectId}/health/trend?limit=10`),
      200,
      'health trend',
    );
    assert.equal(arr(trend.snapshots).length, 2);
    const snapshots = arr(trend.snapshots).map(obj);
    assert.equal(str(snapshots[0].predictionSource), 'heuristic');
    assert.ok(['improving', 'stable', 'declining'].includes(str(trend.trend)));
    assert.equal(auditRows(store, 'project.health.config', projectId).length, 1);
  });

  test('capacity plan prorates buckets, filters and flags conflicts', async () => {
    const { app, cookies } = await setup();
    const project = await createProject(app, cookies.admin, '容量规划项目');
    const projectId = str(project.id);

    expectStatus(
      await call(app, cookies.pm, 'PUT', `/api/capacity/profiles/${DEMO.pm.id}`, {
        weeklyHours: 32,
        fte: 0.8,
        skills: ['设计'],
      }),
      200,
      'pm profile for plan',
    );
    const assign = async (
      weeklyHours: number,
      startDate: string,
      endDate: string,
      kind: 'allocation' | 'leave' = 'allocation',
    ) =>
      expectStatus(
        await call(app, cookies.admin, 'POST', '/api/workbench/capacity-allocations', {
          userId: DEMO.pm.id,
          projectId,
          role: '设计',
          weeklyHours,
          startDate,
          endDate,
          kind,
        }),
        201,
        `create capacity allocation ${weeklyHours}`,
      );
    await assign(12, '2026-06-01', '2026-06-30');
    await assign(30, '2026-06-01', '2026-06-14');
    await assign(4, '2026-06-01', '2026-06-07', 'leave');

    const weekly = expectStatus(
      await call(
        app,
        cookies.admin,
        'GET',
        '/api/capacity/plan?from=2026-06-01&to=2026-06-14&bucket=week',
      ),
      200,
      'weekly capacity plan',
    );
    assert.equal(str(weekly.bucket), 'week');
    const pmRow = arr(weekly.users)
      .map(obj)
      .find((row) => str(row.userId) === DEMO.pm.id);
    assert.ok(pmRow);
    const buckets = arr(pmRow.buckets).map(obj);
    assert.equal(buckets.length, 2);
    assert.equal(str(buckets[0].bucket), '2026-06-01');
    assert.equal(num(buckets[0].supplyHours), 25.6);
    assert.equal(num(buckets[0].allocatedHours), 42);
    assert.equal(num(buckets[0].leaveHours), 4);
    assert.equal(num(buckets[0].gapHours), -20.4);
    assert.equal(buckets[0].overloaded, true);
    assert.equal(num(obj(pmRow.totals).allocatedHours), 84);
    const pmConflict = arr(weekly.conflicts)
      .map(obj)
      .find((row) => str(row.userId) === DEMO.pm.id);
    assert.ok(pmConflict);
    assert.equal(str(pmConflict.bucket), '2026-06-01');
    assert.ok(num(pmConflict.overHours) > 0);
    assert.equal(num(obj(weekly.totals).members), arr(weekly.users).length);
    const monthly = expectStatus(
      await call(
        app,
        cookies.admin,
        'GET',
        '/api/capacity/plan?from=2026-06-01&to=2026-06-30&bucket=month',
      ),
      200,
      'monthly capacity plan',
    );
    const monthlyPm = arr(monthly.users)
      .map(obj)
      .find((row) => str(row.userId) === DEMO.pm.id);
    assert.ok(monthlyPm);
    const monthlyBuckets = arr(monthlyPm.buckets).map(obj);
    assert.equal(monthlyBuckets.length, 1);
    assert.equal(str(monthlyBuckets[0].bucket), '2026-06-01');
    assert.equal(num(monthlyBuckets[0].days), 30);
    assert.ok(num(monthlyBuckets[0].supplyHours) > 100);

    const skilled = expectStatus(
      await call(
        app,
        cookies.admin,
        'GET',
        '/api/capacity/plan?from=2026-06-01&to=2026-06-07&skill=设计',
      ),
      200,
      'skill filtered capacity plan',
    );
    assert.equal(arr(skilled.users).length, 1);
    assert.equal(str(obj(arr(skilled.users)[0]).userId), DEMO.pm.id);

    const self = expectStatus(
      await call(app, cookies.pm, 'GET', '/api/capacity/plan?from=2026-06-01&to=2026-06-07'),
      200,
      'pm self capacity plan',
    );
    assert.equal(arr(self.users).length, 1);
    assert.equal(str(obj(arr(self.users)[0]).userId), DEMO.pm.id);
    expectStatus(
      await call(
        app,
        cookies.pm,
        'GET',
        `/api/capacity/plan?from=2026-06-01&to=2026-06-07&userId=${DEMO.viewer.id}`,
      ),
      403,
      'pm other capacity plan',
    );
  });

  test('approval metrics break down dimensions with anonymized drill-down', async () => {
    const { app, cookies } = await setup();
    const create = (amountCents: number, dueAt?: string) =>
      call(app, cookies.admin, 'POST', '/api/approvals', {
        title: `预算审批-${amountCents}`,
        kind: 'budget',
        amountCents,
        ...(dueAt ? { dueAt } : {}),
        steps: [{ name: '经理审批', approverIds: [DEMO.manager.id], mode: 'any' }],
      });
    const pending = expectStatus(
      await create(500_000, '2026-06-01T00:00:00.000Z'),
      201,
      'create overdue approval',
    );
    const decided = expectStatus(await create(2_000_000), 201, 'create decided approval');
    expectStatus(
      await call(app, cookies.manager, 'POST', `/api/approvals/${str(decided.id)}/decisions`, {
        action: 'approve',
        note: '同意思',
        version: 1,
      }),
      200,
      'manager decision for metrics',
    );

    const adminMetrics = expectStatus(
      await call(app, cookies.admin, 'GET', '/api/approvals/metrics'),
      200,
      'admin approval metrics',
    );
    assert.equal(adminMetrics.anonymized, false);
    assert.equal(str(adminMetrics.drillDownScope), 'workspace');
    assert.ok(arr(adminMetrics.drillDown).some((row) => str(obj(row).id) === str(pending.id)));
    assert.ok(arr(adminMetrics.byDepartment).length >= 1);
    assert.ok(arr(adminMetrics.byKind).some((row) => str(obj(row).kind) === 'budget'));
    const bands = arr(adminMetrics.amountBands).map((row) => str(obj(row).band));
    assert.ok(bands.includes('0-10k'));
    assert.ok(bands.includes('10k-100k'));
    assert.ok(
      arr(adminMetrics.byApprover).some((row) => str(obj(row).approverId) === DEMO.manager.id),
    );
    assert.ok(num(adminMetrics.overdueRate) > 0);
    assert.ok(num(adminMetrics.slaBreaches) >= 1);
    assert.equal(adminMetrics.lowSample, true);

    const managerMetrics = expectStatus(
      await call(app, cookies.manager, 'GET', '/api/approvals/metrics'),
      200,
      'manager approval metrics',
    );
    assert.equal(managerMetrics.anonymized, true);
    assert.equal(str(managerMetrics.drillDownScope), 'own');
    assert.equal(arr(managerMetrics.drillDown).length, 0);
    const anonymous = obj(arr(managerMetrics.byApprover)[0]);
    assert.equal(anonymous.approverId, null);
    assert.match(str(anonymous.approver), /^审批人/);
  });

  test('anomaly detection supports seasonality, comparison clues and quiet windows', async () => {
    const { app, store, cookies } = await setup();
    const metric = expectStatus(
      await call(app, cookies.admin, 'POST', '/api/metrics', {
        name: '异常扩展收入',
        formula: 'revenue_cents',
      }),
      201,
      'create anomaly metric',
    );
    const metricId = str(metric.id);
    store.db
      .stmt('UPDATE daily_metrics SET revenue_cents = ? WHERE date = ?')
      .run(50_000_000, '2026-06-10');
    store.db.stmt("UPDATE channel_daily SET sessions = 999999 WHERE date = '2026-06-10'").run();

    const detected = expectStatus(
      await call(app, cookies.admin, 'POST', '/api/anomalies/detect', {
        metricId,
        from: '2026-06-01',
        to: '2026-06-15',
        threshold: 2,
        seasonal: true,
        window: 21,
        compare: 'mom',
      }),
      200,
      'seasonal anomaly detection',
    );
    assert.equal(str(obj(detected.baseline).method), 'weekday');
    assert.equal(str(detected.comparison), 'mom');
    assert.equal(typeof detected.lowSample, 'boolean');
    const spike = arr(detected.anomalies)
      .map(obj)
      .find((row) => str(row.period) === '2026-06-10');
    assert.ok(spike);
    const dimensions = obj(spike.dimensions);
    assert.equal(str(dimensions.baselineMethod), 'weekday');
    assert.ok(arr(dimensions.clues).length >= 1);
    assert.ok('changePct' in obj(dimensions.comparison));

    const quiet = expectStatus(
      await call(app, cookies.admin, 'POST', '/api/anomalies/detect', {
        metricId,
        from: '2026-06-01',
        to: '2026-06-15',
        threshold: 2,
        seasonal: true,
        window: 21,
        compare: 'mom',
        quietWindowHours: 24,
      }),
      200,
      'quiet anomaly detection',
    );
    assert.equal(quiet.quieted, true);
    assert.equal(arr(quiet.anomalies).length, 0);
    assert.ok(str(quiet.lastDetectedAt).length > 0);
  });

  test('quality consistency rules support preview rollback and revert', async () => {
    const { app, store, cookies } = await setup();
    const rule = expectStatus(
      await call(app, cookies.admin, 'POST', '/api/workbench/quality-rules', {
        name: '跨字段一致性',
        dataset: 'daily_metrics',
        ruleType: 'consistency',
        config: { left: 'visitors', operator: 'gte', right: 'conversions' },
      }),
      201,
      'create consistency rule',
    );
    const ruleId = str(rule.id);
    store.db
      .stmt('UPDATE daily_metrics SET visitors = 10, conversions = 20 WHERE date = ?')
      .run('2026-06-10');

    expectStatus(
      await call(app, cookies.admin, 'POST', '/api/quality/scan', { ruleId }),
      200,
      'consistency scan',
    );
    const issues = items(
      expectStatus(
        await call(app, cookies.admin, 'GET', `/api/workbench/quality-issues?ruleId=${ruleId}`),
        200,
        'consistency issues',
      ),
    );
    const issue = issues.find((row) => str(obj(row.detailsJson).date) === '2026-06-10');
    assert.ok(issue);
    const issueId = str(issue?.id);

    const preview = expectStatus(
      await call(app, cookies.admin, 'POST', `/api/quality/issues/${issueId}/fix`, {
        fixed: { visitors: 25 },
        reason: '修正访客数',
        preview: true,
      }),
      200,
      'quality rollback preview',
    );
    assert.equal(num(obj(preview.changes).visitors), 25);
    assert.equal(num(obj(preview.rollback).visitors), 10);

    expectStatus(
      await call(app, cookies.admin, 'POST', `/api/quality/issues/${issueId}/fix`, {
        fixed: { visitors: 25 },
        reason: '修正访客数',
      }),
      200,
      'apply consistency fix',
    );
    const fixedRow = store.db
      .stmt("SELECT visitors FROM daily_metrics WHERE date = '2026-06-10'")
      .get() as unknown as { visitors: number };
    assert.equal(Number(fixedRow.visitors), 25);

    expectStatus(
      await call(app, cookies.viewer, 'POST', `/api/quality/issues/${issueId}/revert`, {
        reason: '越权回滚',
      }),
      403,
      'viewer quality revert',
    );
    const reverted = expectStatus(
      await call(app, cookies.admin, 'POST', `/api/quality/issues/${issueId}/revert`, {
        reason: '修正有误，恢复原值',
      }),
      200,
      'revert quality fix',
    );
    assert.equal(str(reverted.status), 'open');
    assert.ok(obj(JSON.parse(str(reverted.details_json))).rollback);
    const restored = store.db
      .stmt("SELECT visitors FROM daily_metrics WHERE date = '2026-06-10'")
      .get() as unknown as { visitors: number };
    assert.equal(Number(restored.visitors), 10);
    assert.equal(auditRows(store, 'quality.revert', issueId).length, 1);
  });

  test('scenario confidence intervals, sensitivity and funnel cohorts', async () => {
    const { app, cookies } = await setup();
    const scenarioIds: string[] = [];
    for (const [name, growth] of [
      ['敏感性情景', 15],
      ['对照情景', -5],
    ] as const) {
      const created = expectStatus(
        await call(app, cookies.admin, 'POST', '/api/workbench/scenarios', {
          name,
          assumptions: {
            revenueGrowthPct: growth,
            conversionGrowthPct: 4,
            personnelCostPct: 6,
            deliveryShiftDays: 3,
          },
          baseDate: '2026-06-15',
        }),
        201,
        `create scenario ${name}`,
      );
      scenarioIds.push(str(created.id));
    }
    const evaluated = expectStatus(
      await call(app, cookies.admin, 'POST', `/api/scenarios/${scenarioIds[0]}/evaluate`),
      200,
      'evaluate scenario with sensitivity',
    );
    const result = obj(evaluated.result);
    assert.ok(num(obj(result.actual).revenueCents) > 0);
    const forecast = obj(result.forecast);
    assert.ok(num(forecast.revenueLowCents) <= num(forecast.revenueCents));
    assert.ok(num(forecast.revenueHighCents) >= num(forecast.revenueCents));
    assert.equal(num(obj(result.confidenceInterval).level), 0.9);
    assert.equal(str(obj(result.storage).actual), 'daily_metrics');
    const sensitivity = arr(result.sensitivity).map(obj);
    assert.equal(sensitivity.length, 5);
    assert.ok(sensitivity.some((row) => str(row.variable) === 'revenueGrowthPct'));
    for (let index = 1; index < sensitivity.length; index += 1) {
      assert.ok(num(sensitivity[index - 1].impactCents) >= num(sensitivity[index].impactCents));
    }

    const compared = expectStatus(
      await call(app, cookies.admin, 'POST', '/api/scenarios/compare', { ids: scenarioIds }),
      200,
      'compare extended scenarios',
    );
    const ranked = arr(compared.ranked).map(obj);
    assert.deepEqual(
      ranked.map((row) => num(row.rank)),
      [1, 2],
    );

    const stages = ['lead', 'opportunity', 'contract', 'churned'] as const;
    for (const [index, stage] of stages.entries()) {
      expectStatus(
        await call(app, cookies.admin, 'POST', '/api/workbench/opportunities', {
          customerName: `漏斗客户 ${index + 1}`,
          customerEmail: `funnel${index + 1}@example.com`,
          stage,
          amountCents: 100_000 * (index + 1),
        }),
        201,
        `create funnel opportunity ${stage}`,
      );
    }
    const funnel = expectStatus(
      await call(app, cookies.admin, 'GET', '/api/crm/funnel?cohort=week&dedupeBy=customer'),
      200,
      'funnel with cohorts',
    );
    assert.equal(str(funnel.cohortBy), 'week');
    assert.equal(str(funnel.dedupeBy), 'customer');
    assert.equal(arr(funnel.durations).length, 4);
    assert.ok(arr(funnel.cohorts).length >= 1);
    assert.equal(num(obj(arr(funnel.steps)[1]).conversionRate), 1);
    assert.ok(str(funnel.privacy).length > 0);
  });

  test('query previews calculated fields, pivots, charts and field permissions', async () => {
    const { app, cookies } = await setup();
    for (const [index, stage] of ['lead', 'opportunity', 'contract'].entries()) {
      expectStatus(
        await call(app, cookies.admin, 'POST', '/api/workbench/opportunities', {
          customerName: `查询客户 ${index + 1}`,
          customerEmail: `query${index + 1}@example.com`,
          stage,
          amountCents: 50_000 * (index + 1),
        }),
        201,
        `create query opportunity ${stage}`,
      );
    }

    const calculated = expectStatus(
      await call(app, cookies.admin, 'POST', '/api/query/preview', {
        config: {
          dataset: 'daily_metrics',
          fields: ['date', 'revenue_cents', 'visitors'],
          calculated: [
            { key: 'rpm', label: '千次曝光收入', expression: 'revenue_cents / visitors' },
          ],
          limit: 10,
        },
      }),
      200,
      'calculated query',
    );
    assert.ok(arr(calculated.columns).includes('rpm'));
    assert.ok(
      arr(calculated.rows)
        .map(obj)
        .some((row) => typeof row.rpm === 'number'),
    );

    const pivot = expectStatus(
      await call(app, cookies.admin, 'POST', '/api/query/preview', {
        config: {
          dataset: 'opportunities',
          fields: ['stage', 'owner_id', 'amount_cents'],
          pivot: { rows: ['stage'], columns: 'owner_id', values: 'amount_cents' },
        },
      }),
      200,
      'pivot query',
    );
    const pivotBody = obj(pivot.pivot);
    assert.deepEqual(arr(pivotBody.rowFields), ['stage']);
    assert.ok(arr(pivotBody.matrix).length >= 1);
    assert.ok(arr(pivotBody.columnKeys).length >= 1);

    const chart = expectStatus(
      await call(app, cookies.admin, 'POST', '/api/query/preview', {
        config: {
          dataset: 'daily_metrics',
          fields: ['date', 'revenue_cents'],
          limit: 5,
          chart: { type: 'line', x: 'date', y: 'revenue_cents' },
        },
      }),
      200,
      'chart query',
    );
    assert.equal(str(obj(chart.chart).type), 'line');
    assert.equal(arr(obj(chart.chart).points).length, num(chart.rowCount));

    expectStatus(
      await call(app, cookies.viewer, 'POST', '/api/query/preview', {
        config: { dataset: 'opportunities', fields: ['customer_email', 'stage'] },
      }),
      403,
      'viewer sensitive query',
    );
    expectStatus(
      await call(app, cookies.admin, 'POST', '/api/query/preview', {
        config: {
          dataset: 'daily_metrics',
          fields: ['date'],
          chart: { type: 'line', x: 'missing' },
        },
      }),
      400,
      'invalid chart field',
    );
  });

  test('metric refresh cadence and recalculation indicator', async () => {
    const { app, cookies } = await setup();
    const metric = expectStatus(
      await call(app, cookies.admin, 'POST', '/api/metrics', {
        name: '刷新频率指标',
        formula: 'revenue_cents',
        refreshMinutes: 30,
      }),
      201,
      'create refresh metric',
    );
    const metricId = str(metric.id);
    assert.equal(num(metric.refreshMinutes), 30);

    const refreshed = expectStatus(
      await call(app, cookies.admin, 'PATCH', `/api/metrics/${metricId}`, {
        refreshMinutes: 15,
        version: 1,
      }),
      200,
      'update refresh cadence',
    );
    assert.equal(num(refreshed.refreshMinutes), 15);
    assert.equal(refreshed.recalculationRequired, false);

    const evaluation = expectStatus(
      await call(app, cookies.admin, 'POST', `/api/metrics/${metricId}/evaluate`, {
        from: '2026-06-01',
        to: '2026-06-15',
      }),
      200,
      'evaluate refresh metric',
    );
    assert.equal(num(evaluation.refreshMinutes), 15);
    assert.ok(str(evaluation.source).length > 0);

    const formulaChanged = expectStatus(
      await call(app, cookies.admin, 'PATCH', `/api/metrics/${metricId}`, {
        formula: 'customers',
        version: 2,
      }),
      200,
      'update formula for recalculation',
    );
    assert.equal(formulaChanged.recalculationRequired, true);
  });

  test('budget approval linkage, alerts and decision propagation', async () => {
    const { app, cookies } = await setup();
    const project = await createProject(app, cookies.admin, '预算审批项目');
    const projectId = str(project.id);
    expectStatus(
      await call(app, cookies.admin, 'PUT', `/api/projects/${projectId}/budget`, {
        costCenter: '增长中心',
        budgetCents: 1_000_000,
        thresholdPct: 80,
      }),
      200,
      'budget for approval',
    );

    const requested = expectStatus(
      await call(app, cookies.admin, 'POST', `/api/projects/${projectId}/budget/approval`, {
        amountCents: 1_500_000,
        note: '追加预算',
      }),
      201,
      'request budget approval',
    );
    const approval = obj(requested.approval);
    const approvalId = str(approval.id);
    assert.equal(str(approval.kind), 'budget');
    assert.equal(str(approval.resource_type), 'project_budget');
    assert.equal(str(obj(requested.budget).approval_request_id), approvalId);

    const duplicate = await call(
      app,
      cookies.admin,
      'POST',
      `/api/projects/${projectId}/budget/approval`,
      { note: '重复申请' },
    );
    expectStatus(duplicate, 409, 'duplicate budget approval');
    assert.ok(obj(duplicate.body).current);

    const alerts = expectStatus(
      await call(app, cookies.admin, 'GET', `/api/projects/${projectId}/budget-alerts`),
      200,
      'budget alerts with approval',
    );
    assert.equal(str(obj(alerts.approval).id), approvalId);
    assert.equal(str(obj(alerts.approval).status), 'pending');

    expectStatus(
      await call(app, cookies.manager, 'POST', `/api/approvals/${approvalId}/decisions`, {
        action: 'approve',
        note: '预算合理',
        version: 1,
      }),
      200,
      'approve budget request',
    );
    const after = expectStatus(
      await call(app, cookies.admin, 'GET', `/api/projects/${projectId}/budget-alerts`),
      200,
      'budget alerts after approval',
    );
    assert.equal(str(obj(after.approval).status), 'approved');
  });

  test('customer confirms portal delivery with idempotency and audit', async () => {
    const { app, store, cookies } = await setup();
    const project = await createProject(app, cookies.admin, '门户确认项目');
    const projectId = str(project.id);
    const portal = expectStatus(
      await call(app, cookies.admin, 'POST', `/api/projects/${projectId}/portals`, {
        name: '交付确认门户',
        accountEmail: 'confirm@example.com',
        accountName: '客户确认人',
      }),
      201,
      'create confirmation portal',
    );
    const token = str(portal.token);
    const submitted = expectStatus(
      await call(app, null, 'POST', `/api/portal/${token}/requests`, {
        title: '确认交付需求',
        body: '请交付后由客户确认',
      }),
      201,
      'submit confirm request',
    );
    const requestId = str(obj(submitted.request).id);

    const early = await call(
      app,
      null,
      'POST',
      `/api/portal/${token}/requests/${requestId}/confirm`,
      {
        note: '尚未交付',
      },
    );
    expectStatus(early, 409, 'confirm before delivery');

    const delivered = expectStatus(
      await call(app, cookies.admin, 'POST', `/api/portal-requests/${requestId}/deliver`, {
        note: '已上线',
      }),
      200,
      'staff deliver portal request',
    );
    assert.equal(str(obj(delivered.request).status), 'delivered');

    const confirmed = expectStatus(
      await call(app, null, 'POST', `/api/portal/${token}/requests/${requestId}/confirm`, {
        note: '验收通过',
      }),
      200,
      'customer confirm delivery',
    );
    assert.equal(str(obj(confirmed.request).status), 'closed');
    assert.ok(str(obj(confirmed.request).delivery_confirmed_at).length > 0);
    assert.ok(str(obj(confirmed.request).delivery_confirmed_by).length > 0);
    assert.equal(confirmed.replayed, false);

    const replay = expectStatus(
      await call(app, null, 'POST', `/api/portal/${token}/requests/${requestId}/confirm`, {}),
      200,
      'replay customer confirmation',
    );
    assert.equal(replay.replayed, true);
    assert.equal(str(obj(replay.request).status), 'closed');

    const audits = auditRows(store, 'portal.request.confirm', requestId);
    assert.equal(audits.length, 1);
    assert.equal(audits[0]?.actor_id, null);
  });
});

describe('execution governance extensions', () => {
  test('dispatch enforces manage rights, writes batch recommendations atomically and decides in bulk', async () => {
    const { app, store, cookies } = await setup();
    const project = await createProject(app, cookies.admin, '批量分派项目', {
      memberIds: [DEMO.pm.id, DEMO.viewer.id],
    });
    const projectId = str(project.id);
    const rule = expectStatus(
      await call(app, cookies.admin, 'POST', '/api/workbench/dispatch-rules', {
        name: '批量规则',
        strategy: 'balanced',
        maxLoadHours: 40,
        active: true,
      }),
      201,
      'create dispatch rule',
    );
    const first = await createTask(app, cookies.admin, projectId, '批量任务一');
    const second = await createTask(app, cookies.admin, projectId, '批量任务二');

    expectStatus(
      await call(app, cookies.viewer, 'POST', '/api/dispatch/recommend', {
        taskId: str(first.id),
        ruleId: str(rule.id),
      }),
      403,
      'viewer recommend',
    );

    const count = (): number =>
      num(
        obj(store.db.stmt('SELECT COUNT(*) AS total FROM dispatch_recommendations').get() as Json)
          .total,
      );
    const before = count();
    expectStatus(
      await call(app, cookies.admin, 'POST', '/api/dispatch/recommend', {
        taskId: str(first.id),
        taskIds: [str(first.id), '00000000-0000-4000-8000-000000000000'],
        ruleId: str(rule.id),
      }),
      404,
      'batch recommendation with unknown task',
    );
    assert.equal(count(), before, 'invalid batches must not persist partial recommendations');

    const recommended = expectStatus(
      await call(app, cookies.admin, 'POST', '/api/dispatch/recommend', {
        taskId: str(first.id),
        taskIds: [str(first.id), str(second.id)],
        ruleId: str(rule.id),
      }),
      201,
      'batch recommendation',
    );
    const recs = arr(recommended).map(obj);
    const best = new Map<string, Json>();
    for (const rec of recs) {
      const taskId = str(rec.task_id);
      const current = best.get(taskId);
      if (!current || num(rec.score) > num(current.score)) best.set(taskId, rec);
    }
    assert.equal(best.size, 2);

    const batch = expectStatus(
      await call(app, cookies.admin, 'POST', '/api/dispatch/batch', {
        recommendationIds: [...best.values()].map((rec) => str(rec.id)),
        mode: 'assign',
      }),
      200,
      'batch dispatch decision',
    );
    assert.equal(num(batch.count), 2);
    assert.equal(arr(batch.decided).length, 2);

    const tasksBody = expectStatus(
      await call(app, cookies.admin, 'GET', `/api/projects/${projectId}/tasks`),
      200,
      'list tasks after batch assign',
    );
    const assigned = arr(obj(tasksBody).tasks).map(obj);
    for (const [taskId, rec] of best) {
      const task = assigned.find((row) => str(row.id) === taskId);
      assert.equal(str(task?.assigneeId), str(rec.candidate_id));
    }
    assert.equal(auditRows(store, 'task.dispatch.decide', str(first.id)).length, 1);

    expectStatus(
      await call(app, cookies.admin, 'PATCH', `/api/workbench/dispatch-rules/${str(rule.id)}`, {
        name: '批量规则 v2',
        version: 1,
      }),
      200,
      'update dispatch rule',
    );
    expectStatus(
      await call(app, cookies.admin, 'PATCH', `/api/workbench/dispatch-rules/${str(rule.id)}`, {
        name: '过期版本',
        version: 1,
      }),
      409,
      'stale dispatch rule version',
    );
  });

  test('estimate scales validate task units and reject duplicate keys', async () => {
    const { app, cookies } = await setup();
    const project = await createProject(app, cookies.admin, '估算量级项目');
    const task = await createTask(app, cookies.admin, str(project.id), '估算任务');

    expectStatus(
      await call(app, cookies.admin, 'POST', '/api/estimate-scales', {
        name: '重复键',
        values: [
          { key: 'S', label: '小' },
          { key: 's', label: '小写重复' },
        ],
      }),
      400,
      'duplicate scale keys',
    );

    const scale = expectStatus(
      await call(app, cookies.admin, 'POST', '/api/estimate-scales', {
        name: '自定义复杂度',
        values: [
          { key: 'XS2', label: '极小', points: 1 },
          { key: 'XL2', label: '极大', points: 13 },
        ],
      }),
      201,
      'create estimate scale',
    );
    assert.equal(arr(scale.values).length, 2);

    const custom = expectStatus(
      await call(app, cookies.admin, 'PATCH', `/api/tasks/${str(task.id)}/estimate`, {
        estimatePoints: 3,
        estimateHours: 6,
        estimateSize: 'xs2',
      }),
      200,
      'custom scale estimate',
    );
    assert.equal(str(custom.estimate_size), 'xs2');

    expectStatus(
      await call(app, cookies.admin, 'PATCH', `/api/tasks/${str(task.id)}/estimate`, {
        estimateSize: 'giant',
      }),
      400,
      'unknown estimate size',
    );

    const builtIn = expectStatus(
      await call(app, cookies.admin, 'PATCH', `/api/tasks/${str(task.id)}/estimate`, {
        estimateSize: 'M',
      }),
      200,
      'built-in t-shirt estimate',
    );
    assert.equal(str(builtIn.estimate_size), 'M');

    expectStatus(
      await call(app, cookies.pm, 'POST', '/api/estimate-scales', {
        name: '越权量级',
        values: [{ key: 'X', label: 'X' }],
      }),
      403,
      'non-admin scale creation',
    );
  });

  test('task templates bind checklists and forms transactionally', async () => {
    const { app, cookies } = await setup();
    const project = await createProject(app, cookies.admin, '模板绑定项目');
    const projectId = str(project.id);

    const template = expectStatus(
      await call(app, cookies.admin, 'POST', '/api/task-templates', {
        name: '交付模板',
        tasks: [
          {
            title: '交付父任务',
            estimateSize: 'M',
            checklist: [{ label: '准备资料', required: true }],
            form: {
              name: '验收表单',
              fields: [{ key: 'note', label: '备注', type: 'text', required: true }],
            },
          },
          { title: '交付子任务', parentIndex: 0 },
        ],
      }),
      201,
      'create task template',
    );

    const applied = expectStatus(
      await call(app, cookies.admin, 'POST', `/api/task-templates/${str(template.id)}/apply`, {
        projectId,
        startDate: '2026-07-01',
      }),
      201,
      'apply task template',
    );
    const created = arr(obj(applied).tasks).map(obj);
    const parent = created.find((row) => str(row.title) === '交付父任务');
    const child = created.find((row) => str(row.title) === '交付子任务');
    assert.ok(parent && child);
    assert.equal(str(child.parentId), str(parent.id));

    const checklist = items(
      expectStatus(
        await call(
          app,
          cookies.admin,
          'GET',
          `/api/workbench/checklist-items?taskId=${str(parent.id)}`,
        ),
        200,
        'list template checklist',
      ),
    );
    const labels = checklist.map((row) => str(row.label));
    assert.ok(labels.includes('准备资料'));
    assert.ok(labels.includes('填写表单：验收表单'));
    assert.ok(checklist.every((row) => row.required === true || row.required === 1));

    const forms = items(
      expectStatus(
        await call(app, cookies.admin, 'GET', '/api/workbench/task-forms'),
        200,
        'list task forms',
      ),
    );
    const form = forms.find((row) => str(row.name) === '验收表单');
    assert.ok(form);
    const bound = checklist.find((row) => str(row.formId) === str(form.id));
    assert.ok(bound, 'checklist item should reference the inline form');

    const before = arr(
      obj(
        expectStatus(
          await call(app, cookies.admin, 'GET', `/api/projects/${projectId}/tasks`),
          200,
          'count tasks before rollback',
        ),
      ).tasks,
    ).length;
    const broken = expectStatus(
      await call(app, cookies.admin, 'POST', '/api/task-templates', {
        name: '坏引用模板',
        tasks: [
          {
            title: '坏引用任务',
            checklist: [{ label: '引用缺失表单', formId: '00000000-0000-4000-8000-000000000000' }],
          },
        ],
      }),
      201,
      'create template with missing form reference',
    );
    expectStatus(
      await call(app, cookies.admin, 'POST', `/api/task-templates/${str(broken.id)}/apply`, {
        projectId,
      }),
      400,
      'apply template with missing form reference',
    );
    const after = arr(
      obj(
        expectStatus(
          await call(app, cookies.admin, 'GET', `/api/projects/${projectId}/tasks`),
          200,
          'count tasks after rollback',
        ),
      ).tasks,
    ).length;
    assert.equal(after, before, 'failed template application must not create tasks');
  });

  test('handoffs derive context and escalate overdue confirmations', async () => {
    const { app, store, cookies } = await setup();
    const project = await createProject(app, cookies.admin, '交接升级项目', {
      memberIds: [DEMO.pm.id],
    });
    const task = expectStatus(
      await call(app, cookies.admin, 'POST', `/api/projects/${str(project.id)}/tasks`, {
        title: '交接主任务',
        assigneeId: DEMO.admin.id,
        dueDate: '2026-06-10',
      }),
      201,
      'create handoff task',
    );
    expectStatus(
      await call(app, cookies.admin, 'POST', `/api/projects/${str(project.id)}/tasks`, {
        title: '交接子任务',
        parentId: str(task.id),
      }),
      201,
      'create handoff subtask',
    );

    const handoff = expectStatus(
      await call(app, cookies.admin, 'POST', `/api/tasks/${str(task.id)}/handoffs`, {
        toUserId: DEMO.pm.id,
        note: '请接手',
      }),
      201,
      'create handoff',
    );
    const summary = JSON.parse(str(handoff.summary_json)) as Json;
    assert.equal(str(handoff.due_at), '2026-06-10');
    assert.ok(
      arr(summary.checklist).some((entry) => str(obj(entry).item) === '完成子任务：交接子任务'),
      'checklist should be derived from open subtasks',
    );

    expectStatus(
      await call(app, cookies.pm, 'POST', '/api/handoffs/tick', {}),
      403,
      'non-admin handoff tick',
    );
    const ticked = expectStatus(
      await call(app, cookies.admin, 'POST', '/api/handoffs/tick', {}),
      200,
      'handoff tick',
    );
    assert.equal(num(ticked.count), 1);
    assert.deepEqual(arr(ticked.escalated), [str(handoff.id)]);
    assert.equal(auditRows(store, 'task.handoff.escalate', str(task.id)).length, 1);

    expectStatus(
      await call(app, cookies.admin, 'POST', '/api/handoffs/tick', {}),
      200,
      'idempotent handoff tick',
    );
    assert.equal(auditRows(store, 'task.handoff.escalate', str(task.id)).length, 1);

    expectStatus(
      await call(app, cookies.pm, 'POST', `/api/handoffs/${str(handoff.id)}/decision`, {
        action: 'accept',
        note: '太晚',
        confirmChecklist: true,
      }),
      409,
      'accept expired handoff',
    );
  });

  test('time log visibility and audit trail follow workspace settings', async () => {
    const { app, store, cookies } = await setup();
    const project = await createProject(app, cookies.admin, '工时可见项目', {
      memberIds: [DEMO.pm.id],
    });
    const task = await createTask(app, cookies.admin, str(project.id), '工时任务');
    const adminLog = expectStatus(
      await call(app, cookies.admin, 'POST', `/api/tasks/${str(task.id)}/time-logs`, {
        minutes: 60,
        workDate: '2026-06-10',
        note: '管理员工时',
      }),
      201,
      'admin time log',
    );
    const pmLog = expectStatus(
      await call(app, cookies.pm, 'POST', `/api/tasks/${str(task.id)}/time-logs`, {
        minutes: 30,
        workDate: '2026-06-10',
        note: '经理工时',
      }),
      201,
      'pm time log',
    );

    const allForPm = arr(
      expectStatus(
        await call(app, cookies.pm, 'GET', `/api/time-logs?projectId=${str(project.id)}`),
        200,
        'default all visibility',
      ),
    );
    assert.equal(allForPm.length, 2);

    const invalid = await call(app, cookies.admin, 'PATCH', '/api/workspace', {
      timeLogVisibility: 'nobody',
    });
    assert.equal(invalid.status, 400);

    const managers = expectStatus(
      await call(app, cookies.admin, 'PATCH', '/api/workspace', {
        timeLogVisibility: 'managers',
      }),
      200,
      'switch time log visibility',
    );
    assert.equal(str(obj(managers.workspace).timeLogVisibility), 'managers');

    const pmVisible = arr(
      expectStatus(
        await call(app, cookies.pm, 'GET', `/api/time-logs?projectId=${str(project.id)}`),
        200,
        'pm logs under managers visibility',
      ),
    );
    assert.equal(pmVisible.length, 1);
    assert.equal(str(obj(pmVisible[0]).userId), DEMO.pm.id);

    const adminVisible = arr(
      expectStatus(
        await call(app, cookies.admin, 'GET', `/api/time-logs?projectId=${str(project.id)}`),
        200,
        'admin logs under managers visibility',
      ),
    );
    assert.equal(adminVisible.length, 2);

    const pmSummary = expectStatus(
      await call(app, cookies.pm, 'GET', `/api/tasks/${str(task.id)}/time-logs/summary`),
      200,
      'pm time summary',
    );
    assert.equal(num(pmSummary.actualMinutes), 30);
    assert.equal(arr(pmSummary.logs).length, 1);

    const adminSummary = expectStatus(
      await call(app, cookies.admin, 'GET', `/api/tasks/${str(task.id)}/time-logs/summary`),
      200,
      'admin time summary',
    );
    assert.equal(num(adminSummary.actualMinutes), 90);

    expectStatus(
      await call(app, cookies.admin, 'PATCH', '/api/workspace', { timeLogVisibility: 'self' }),
      200,
      'switch time log visibility to self',
    );
    const adminSelf = arr(
      expectStatus(
        await call(app, cookies.admin, 'GET', `/api/time-logs?projectId=${str(project.id)}`),
        200,
        'admin logs under self visibility',
      ),
    );
    assert.equal(adminSelf.length, 1);
    assert.equal(str(obj(adminSelf[0]).userId), DEMO.admin.id);

    expectStatus(
      await call(
        app,
        cookies.admin,
        'PATCH',
        `/api/tasks/${str(task.id)}/time-logs/${str(adminLog.id)}`,
        { minutes: 45, version: 1 },
      ),
      200,
      'update time log',
    );
    expectStatus(
      await call(
        app,
        cookies.pm,
        'DELETE',
        `/api/tasks/${str(task.id)}/time-logs/${str(pmLog.id)}`,
      ),
      204,
      'delete own time log',
    );

    assert.equal(auditRows(store, 'time_log.create', str(adminLog.id)).length, 1);
    assert.equal(auditRows(store, 'time_log.update', str(adminLog.id)).length, 1);
    assert.equal(auditRows(store, 'time_log.delete', str(pmLog.id)).length, 1);
    const workspaceAudits = auditRows(store, 'workspace.updated', 'USD');
    assert.ok(workspaceAudits.length >= 2);
  });

  test('implementing a change request creates tasks atomically', async () => {
    const { app, store, cookies } = await setup();
    const project = await createProject(app, cookies.admin, '变更实施项目', {
      memberIds: [DEMO.pm.id],
    });
    const projectId = str(project.id);
    const change = expectStatus(
      await call(
        app,
        cookies.admin,
        'POST',
        `/api/workbench/change-requests?projectId=${projectId}`,
        {
          title: '新增交付范围',
          kind: 'scope',
          reason: '客户追加需求',
        },
      ),
      201,
      'create change request',
    );
    expectStatus(
      await call(app, cookies.admin, 'POST', `/api/changes/${str(change.id)}/decisions`, {
        action: 'approve',
        note: '同意',
        version: 1,
      }),
      200,
      'approve change request',
    );
    const implemented = expectStatus(
      await call(app, cookies.admin, 'POST', `/api/changes/${str(change.id)}/implement`, {
        action: 'implement',
        note: '拆解实施任务',
        version: 2,
        taskTitles: ['实施接口', '补充验收用例'],
      }),
      200,
      'implement change request',
    );
    assert.equal(str(implemented.status), 'implemented');
    const taskIds = arr(implemented.taskIds).map(str);
    assert.equal(taskIds.length, 2);

    const tasks = arr(
      obj(
        expectStatus(
          await call(app, cookies.admin, 'GET', `/api/projects/${projectId}/tasks`),
          200,
          'list implementation tasks',
        ),
      ).tasks,
    ).map(obj);
    for (const taskId of taskIds) {
      assert.ok(tasks.some((row) => str(row.id) === taskId));
    }
    assert.equal(auditRows(store, 'change_request.implement', str(change.id)).length, 1);

    expectStatus(
      await call(app, cookies.admin, 'POST', `/api/changes/${str(change.id)}/implement`, {
        action: 'implement',
        note: '重复实施',
        version: 2,
        taskTitles: ['重复任务'],
      }),
      409,
      'repeat change implementation',
    );
  });
});
