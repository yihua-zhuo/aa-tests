import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, test } from 'node:test';
import type { DocumentQuality } from '../shared/types.ts';
import { OcrPassAuditStore } from '../src/stores/ocr-audits.ts';
import { authHeaders, DEMO, getJson, login, sendJson, testApp, testStore } from './helpers.ts';

const PASS_QUALITY: DocumentQuality = {
  score: 0.93,
  status: 'pass',
  issues: [],
  signals: {
    confidence: 0.96,
    agreement: 1,
    keyFieldConfidence: 0.95,
    textDensity: 0.4,
    emptyPages: 0,
    duplicateRatio: 0,
    readingOrder: 1,
    tableIntegrity: 1,
    fieldValidation: 1,
  },
  reviewRequired: false,
} as unknown as DocumentQuality;

function seedDocument(
  store: ReturnType<typeof testStore>,
  input: {
    name: string;
    projectId: string;
    uploaderId: string;
    confidence?: number;
    quality?: DocumentQuality | null;
    truncated?: boolean;
  },
) {
  const id = randomUUID();
  store.attachments.create({
    id,
    projectId: input.projectId,
    uploaderId: input.uploaderId,
    name: input.name,
    mime: 'image/png',
    size: 2048,
    storedName: `stored-${id}.bin`,
    sha256: randomUUID().replace(/-/g, ''),
    createdAt: new Date().toISOString(),
    ocrTarget: 'paddle',
  });
  store.attachments.completeOcr(
    id,
    {
      text: '金额 1,280.00',
      confidence: input.confidence ?? 0.95,
      model: 'PP-OCRv6-medium',
      engineModel: 'pp-ocr-v6',
      configHash: 'config-hash',
      seconds: 1,
      pages: 1,
      truncated: input.truncated ?? false,
      route: 'visual',
      quality: input.quality === undefined ? PASS_QUALITY : input.quality,
      stages: [],
      document: null,
    },
    new Date().toISOString(),
  );
  return id;
}

describe('passed-document audit', () => {
  test('samples a reproducible strata-based subset of passed documents', (t) => {
    const store = testStore();
    t.after(() => store.close());
    const user = store.users.authByEmail(DEMO.admin.email);
    assert.ok(user);
    const project = store.projects.create({ name: '审计语料' }, { id: user.id, name: user.name });
    for (let index = 0; index < 40; index += 1) {
      seedDocument(store, {
        name: `invoice-${index}.png`,
        projectId: project.id,
        uploaderId: user.id,
      });
    }
    for (let index = 0; index < 6; index += 1) {
      seedDocument(store, {
        name: `report-${index}.pdf`,
        projectId: project.id,
        uploaderId: user.id,
      });
    }
    // Never audited: failed quality, truncated and non-done documents.
    seedDocument(store, {
      name: 'review.png',
      projectId: project.id,
      uploaderId: user.id,
      quality: { ...PASS_QUALITY, status: 'review', reviewRequired: true } as DocumentQuality,
    });
    seedDocument(store, {
      name: 'partial.pdf',
      projectId: project.id,
      uploaderId: user.id,
      truncated: true,
    });

    const audit = store.ocrPassAudits;
    assert.equal(audit.passPopulation(), 46);
    const first = audit.sample({
      fraction: 0.1,
      perType: 5,
      period: '2026-W44',
      now: '2026-10-31T00:00:00Z',
    });
    assert.equal(first.period, '2026-W44');
    assert.deepEqual(
      first.strata.map((stratum) => [stratum.docType, stratum.population, stratum.picked]),
      [
        ['pdf', 6, 1],
        ['png', 40, 4],
      ],
    );
    assert.equal(first.created.length, 5);
    assert.deepEqual(
      audit.stats().byDocType.map((entry) => [entry.docType, entry.sampled]),
      [
        ['pdf', 1],
        ['png', 4],
      ],
    );
    // Same period, same salt: the ordering is reproducible, and a document that
    // is already under audit is never picked again.
    const deterministic = audit.sample({
      fraction: 0.1,
      perType: 5,
      period: '2026-W44',
      now: '2026-10-31T00:00:00Z',
    });
    const firstIds = new Set(first.created.map((item) => item.attachmentId));
    assert.equal(deterministic.created.filter((item) => firstIds.has(item.attachmentId)).length, 0);
    assert.equal(deterministic.created.length, 5);
    const otherWeek = audit.sample({
      fraction: 0.1,
      perType: 5,
      period: '2026-W45',
      now: '2026-11-06T00:00:00Z',
    });
    assert.equal(otherWeek.created.length, 5);
    const all = [...first.created, ...deterministic.created, ...otherWeek.created];
    assert.equal(new Set(all.map((item) => item.attachmentId)).size, 15);
    assert.equal(
      OcrPassAuditStore.orderKey('2026-W44', 'att', 'v1'),
      OcrPassAuditStore.orderKey('2026-W44', 'att', 'v1'),
    );
    assert.notEqual(
      OcrPassAuditStore.orderKey('2026-W44', 'att', 'v1'),
      OcrPassAuditStore.orderKey('2026-W45', 'att', 'v1'),
    );
    assert.deepEqual(
      audit.list({ status: 'pending' }).map((item) => item.status),
      audit.list({ status: 'pending' }).map(() => 'pending'),
    );
    assert.equal(audit.list({ status: 'audited' }).length, 0);
  });

  test('requires two independent reviewers before counting an audit', (t) => {
    const store = testStore();
    t.after(() => store.close());
    const user = store.users.authByEmail(DEMO.admin.email);
    assert.ok(user);
    const project = store.projects.create({ name: '双人标注' }, { id: user.id, name: user.name });
    seedDocument(store, { name: 'a.png', projectId: project.id, uploaderId: user.id });
    const created = store.ocrPassAudits.sample({ period: '2026-W44', now: '2026-10-31T00:00:00Z' });
    const id = created.created[0]?.id;
    assert.ok(id);
    const reviewerB = store.users.authByEmail(DEMO.manager.email);
    assert.ok(reviewerB);

    const firstPass = store.ocrPassAudits.verdict(
      id,
      'clean',
      { id: user.id, name: user.name },
      '2026-10-31T01:00:00Z',
    );
    assert.notEqual(firstPass, 'conflict');
    assert.equal((firstPass as { status: string }).status, 'pending');
    assert.equal(store.ocrPassAudits.stats().audited, 0);
    assert.equal(store.ocrPassAudits.stats().pending, 1);

    // The same reviewer cannot supply the second opinion.
    const duplicate = store.ocrPassAudits.verdict(
      id,
      'error',
      { id: user.id, name: user.name },
      '2026-10-31T01:05:00Z',
    );
    assert.notEqual(duplicate, 'conflict');
    assert.equal((duplicate as { firstVerdict: string }).firstVerdict, 'error');
    assert.equal((duplicate as { status: string }).status, 'pending');

    const agreed = store.ocrPassAudits.verdict(
      id,
      'error',
      { id: reviewerB.id, name: reviewerB.name },
      '2026-10-31T02:00:00Z',
    );
    assert.notEqual(agreed, 'conflict');
    assert.equal((agreed as { status: string }).status, 'error');
    const stats = store.ocrPassAudits.stats();
    assert.equal(stats.audited, 1);
    assert.equal(stats.error, 1);
    assert.equal(stats.silentErrorRate, 1);

    const third = store.users.authByEmail(DEMO.pm.email);
    assert.ok(third);
    assert.equal(
      store.ocrPassAudits.verdict(id, 'clean', { id: third.id, name: third.name }, 'now'),
      'conflict',
    );
  });

  test('reports the silent error rate with a Wilson interval', (t) => {
    const store = testStore();
    t.after(() => store.close());
    const user = store.users.authByEmail(DEMO.admin.email);
    assert.ok(user);
    const project = store.projects.create({ name: '静默错误率' }, { id: user.id, name: user.name });
    for (let index = 0; index < 20; index += 1) {
      seedDocument(store, {
        name: `doc-${index}.png`,
        projectId: project.id,
        uploaderId: user.id,
        confidence: 0.9,
      });
    }
    const audit = store.ocrPassAudits;
    const created = audit.sample({
      fraction: 0.2,
      perType: 20,
      period: '2026-W44',
      now: '2026-10-31T00:00:00Z',
    });
    assert.equal(created.created.length, 4);
    const reviewerA = { id: user.id, name: user.name };
    const reviewerBUser = store.users.authByEmail(DEMO.manager.email);
    assert.ok(reviewerBUser);
    const reviewerB = { id: reviewerBUser.id, name: reviewerBUser.name };
    created.created.forEach((item, index) => {
      audit.verdict(item.id, index === 0 ? 'error' : 'clean', reviewerA, '2026-10-31T01:00:00Z');
      audit.verdict(item.id, index === 0 ? 'error' : 'clean', reviewerB, '2026-10-31T01:10:00Z');
    });
    const stats = audit.stats();
    assert.equal(stats.sampled, 4);
    assert.equal(stats.audited, 4);
    assert.equal(stats.error, 1);
    assert.equal(stats.clean, 3);
    assert.equal(stats.silentErrorRate, 0.25);
    assert.ok(stats.interval[0] < 0.25 && stats.interval[1] > 0.25);
    assert.equal(stats.coverage, 0.2);
    assert.equal(stats.disagreementRate, 0);
    assert.equal(stats.byDocType[0]?.docType, 'png');

    // A disputed pair keeps the estimate conservative and shows up as disagreement.
    const extra = audit.sample({ period: '2026-W45', now: '2026-11-06T00:00:00Z' });
    const item = extra.created[0];
    assert.ok(item);
    audit.verdict(item.id, 'error', reviewerA, '2026-11-06T01:00:00Z');
    audit.verdict(item.id, 'clean', reviewerB, '2026-11-06T01:20:00Z');
    const after = audit.stats({ period: '2026-W45' });
    assert.equal(after.disputed, 1);
    assert.equal(after.silentErrorRate, 1);
    assert.equal(after.disagreementRate, 1);
  });

  test('feeds audited documents into the calibration sample set', (t) => {
    const store = testStore();
    t.after(() => store.close());
    const user = store.users.authByEmail(DEMO.admin.email);
    assert.ok(user);
    const project = store.projects.create({ name: '校准回流' }, { id: user.id, name: user.name });
    seedDocument(store, {
      name: 'a.png',
      projectId: project.id,
      uploaderId: user.id,
      confidence: 0.91,
    });
    const created = store.ocrPassAudits.sample({
      period: '2026-W44',
      now: '2026-10-31T00:00:00Z',
    });
    const id = created.created[0]?.id;
    assert.ok(id);
    // Only consensus verdicts qualify; a single reviewer is not evidence.
    const reviewerB = store.users.authByEmail(DEMO.manager.email);
    assert.ok(reviewerB);
    store.ocrPassAudits.verdict(
      id,
      'clean',
      { id: user.id, name: user.name },
      '2026-10-31T01:00:00Z',
    );
    assert.deepEqual(store.ocrPassAudits.calibrationSamples(), []);
    store.ocrPassAudits.verdict(
      id,
      'error',
      { id: reviewerB.id, name: reviewerB.name },
      '2026-10-31T01:10:00Z',
    );
    const samples = store.ocrPassAudits.calibrationSamples();
    assert.equal(samples.length, 1);
    assert.equal(samples[0]?.confidence, 0.91);
    assert.equal(samples[0]?.correct, false);
    assert.equal(samples[0]?.severe, true);
    assert.equal(samples[0]?.fileType, 'png');
    assert.ok(OcrPassAuditStore.periodOf(new Date('2026-11-01T12:00:00Z')).startsWith('2026-W'));
  });

  test('exposes the audit queue over the governance API', async (t) => {
    const store = testStore();
    const { app } = testApp(store);
    t.after(() => store.close());
    const cookie = await login(app, DEMO.admin.email);
    const user = store.users.authByEmail(DEMO.admin.email);
    assert.ok(user);
    const project = store.projects.create({ name: '接口审计' }, { id: user.id, name: user.name });
    for (let index = 0; index < 12; index += 1) {
      seedDocument(store, {
        name: `scan-${index}.png`,
        projectId: project.id,
        uploaderId: user.id,
      });
    }

    const listed = await getJson<{
      audits: unknown[];
      stats: { sampled: number };
      period: string;
    }>(app, cookie, '/api/ocr/pass-audits');
    assert.equal(listed.audits.length, 0);
    assert.equal(listed.stats.sampled, 0);
    assert.match(listed.period, /^\d{4}-W\d{2}$/);

    const sampled = await sendJson(app, cookie, 'POST', '/api/ocr/pass-audits/sample', {
      fraction: 0.2,
      perType: 3,
    });
    assert.equal(sampled.status, 200, JSON.stringify(sampled.body));
    const created = sampled.body.created as { id: string }[];
    assert.equal(created.length, 3);

    const invalid = await sendJson(app, cookie, 'POST', '/api/ocr/pass-audits/sample', {
      fraction: 5,
    });
    assert.equal(invalid.status, 400);

    const badVerdict = await sendJson(
      app,
      cookie,
      'POST',
      `/api/ocr/pass-audits/${created[0]?.id}/verdict`,
      { verdict: 'maybe' },
    );
    assert.equal(badVerdict.status, 400);

    const verdict = await sendJson(
      app,
      cookie,
      'POST',
      `/api/ocr/pass-audits/${created[0]?.id}/verdict`,
      {
        verdict: 'error',
        note: '金额小数点错位',
      },
    );
    assert.equal(verdict.status, 200);
    assert.equal((verdict.body.audit as { status: string }).status, 'pending');
    assert.equal((verdict.body.audit as { note: string | null }).note, '金额小数点错位');

    const missing = await sendJson(app, cookie, 'POST', '/api/ocr/pass-audits/nope/verdict', {
      verdict: 'clean',
    });
    assert.equal(missing.status, 404);

    const viewer = await login(app, DEMO.viewer.email);
    const denied = await app.request('/api/ocr/pass-audits', {
      headers: authHeaders(viewer),
    });
    assert.equal(denied.status, 403);
  });
});
