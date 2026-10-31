import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, test } from 'node:test';
import type {
  DocumentQuality,
  OcrAnnotationReliability,
  OcrCalibrationSample,
  OcrRevisionQcItem,
  OcrRevisionQcStats,
} from '../shared/types.ts';
import { fitThresholdProfiles } from '../src/ocr-calibration.ts';
import { OcrRevisionReviewStore, reliabilityOf } from '../src/stores/ocr-revision-reviews.ts';
import { authHeaders, DEMO, getJson, login, sendJson, testApp, testStore } from './helpers.ts';

const PASS_QUALITY: DocumentQuality = {
  score: 0.9,
  status: 'pass',
  issues: [],
  signals: {
    confidence: 0.95,
    agreement: 1,
    keyFieldConfidence: 0.9,
    textDensity: 0.4,
    emptyPages: 0,
    duplicateRatio: 0,
    readingOrder: 1,
    tableIntegrity: 1,
    fieldValidation: 1,
  },
  reviewRequired: false,
} as unknown as DocumentQuality;

type Store = ReturnType<typeof testStore>;

function seedDocument(
  store: Store,
  input: { name: string; projectId: string; uploaderId: string; confidence?: number },
): string {
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
      confidence: input.confidence ?? 0.93,
      model: 'PP-OCRv6-medium',
      engineModel: 'pp-ocr-v6',
      configHash: 'config-hash',
      seconds: 1,
      pages: 1,
      truncated: false,
      route: 'visual',
      quality: PASS_QUALITY,
      stages: [],
      document: null,
    },
    new Date().toISOString(),
  );
  return id;
}

function seedRevision(
  store: Store,
  input: {
    attachmentId: string;
    projectId: string;
    fieldId?: string;
    original: string;
    revised: string;
    revisedBy: { id: string; name: string } | null;
    createdAt?: string;
  },
): string {
  return store.ocrFieldRevisions.create({
    attachmentId: input.attachmentId,
    projectId: input.projectId,
    fieldId: input.fieldId ?? 'amount',
    fieldKind: 'amount',
    page: 1,
    blockId: 'b1',
    bbox: null,
    originalText: input.original,
    revisedText: input.revised,
    reason: 'ocr_error',
    revisedBy: input.revisedBy,
    createdAt: input.createdAt ?? '2026-10-30T00:00:00Z',
  }).id;
}

function project(store: Store, name: string) {
  const user = store.users.authByEmail(DEMO.admin.email);
  assert.ok(user);
  return { user, project: store.projects.create({ name }, { id: user.id, name: user.name }) };
}

describe('revision quality control', () => {
  test('grades a revision by the second opinions it collects', (t) => {
    const store = testStore();
    t.after(() => store.close());
    const { user, project: site } = project(store, '修订质检');
    const reviser = store.users.authByEmail(DEMO.pm.email);
    assert.ok(reviser);
    const manager = store.users.authByEmail(DEMO.manager.email);
    assert.ok(manager);
    const document = seedDocument(store, {
      name: 'invoice.png',
      projectId: site.id,
      uploaderId: user.id,
    });
    const qc = store.ocrRevisionReviews;
    const id = seedRevision(store, {
      attachmentId: document,
      projectId: site.id,
      original: '1,280.00',
      revised: '1,286.00',
      revisedBy: { id: reviser.id, name: reviser.name },
    });

    assert.equal(qc.record(id, 'confirm', { id: reviser.id, name: reviser.name }, 'now'), 'self');
    assert.equal(qc.record('nope', 'confirm', { id: user.id, name: user.name }, 'now'), 'missing');
    assert.equal(
      qc.record(id, 'revise', { id: user.id, name: user.name }, 'now', { value: '   ' }),
      'needs_value',
    );

    const single = qc.find(id);
    assert.equal(single?.reliability, 'single_reviewer');
    assert.equal(single?.reviews.length, 0);

    // A dissent without arbitration leaves the label unusable.
    const disputed = qc.record(id, 'revise', { id: user.id, name: user.name }, 'now', {
      value: '1,288.00',
      note: '小数点后第二位仍错',
    });
    assert.equal((disputed as OcrRevisionQcItem).reliability, 'disputed');
    assert.equal((disputed as OcrRevisionQcItem).needsArbitration, true);
    assert.equal(
      qc.record(id, 'revise', { id: user.id, name: user.name }, 'now', { value: '1' }),
      'duplicate',
    );

    const arbitrated = qc.record(id, 'arbitrate', { id: manager.id, name: manager.name }, 'now', {
      value: '1,290.00',
    });
    assert.equal((arbitrated as OcrRevisionQcItem).reliability, 'arbitrated');
    assert.equal((arbitrated as OcrRevisionQcItem).reviews.length, 2);
    // Arbitration outranks everything else, so a later confirmation cannot undo it.
    const third = store.users.authByEmail(DEMO.viewer.email);
    assert.ok(third);
    const settled = qc.record(id, 'confirm', { id: third.id, name: third.name }, 'now');
    assert.equal((settled as OcrRevisionQcItem).reliability, 'arbitrated');
    assert.deepEqual(
      reliabilityOf({ revisedText: '9' }, [
        {
          id: 'r1',
          revisionId: id,
          verdict: 'confirm',
          value: null,
          note: null,
          reviewedBy: { id: user.id, name: user.name },
          createdAt: 'now',
        },
      ]),
      { reliability: 'double_confirmed', value: '9' },
    );
  });

  test('sends disputes to the front of a stable queue', (t) => {
    const store = testStore();
    t.after(() => store.close());
    const { user, project: site } = project(store, '修订队列');
    const reviser = store.users.authByEmail(DEMO.pm.email);
    assert.ok(reviser);
    const qc = store.ocrRevisionReviews;
    const ids = ['a', 'b', 'c', 'd'].map((tag, index) => {
      const document = seedDocument(store, {
        name: `doc-${tag}.png`,
        projectId: site.id,
        uploaderId: user.id,
      });
      return seedRevision(store, {
        attachmentId: document,
        projectId: site.id,
        fieldId: `field-${tag}`,
        original: '0',
        revised: String(index),
        revisedBy: { id: reviser.id, name: reviser.name },
        createdAt: `2026-10-2${index}T00:00:00Z`,
      });
    });
    process.env.OCR_REVISION_QC_SALT = 'queue-test';
    t.after(() => {
      delete process.env.OCR_REVISION_QC_SALT;
    });

    const first = qc.queue({ limit: 10 });
    assert.equal(first.length, 4);
    // Unreviewed revisions come out in salted-hash order, not insertion order.
    assert.deepEqual(
      first.map((item) => item.revision.id),
      [...ids].sort((left, right) =>
        OcrRevisionReviewStore.orderKey(left, 'queue-test').localeCompare(
          OcrRevisionReviewStore.orderKey(right, 'queue-test'),
        ),
      ),
    );

    // A dispute jumps the queue ahead of anything still unreviewed.
    const target = ids[3]!;
    qc.record(target, 'revise', { id: user.id, name: user.name }, '2026-10-31T00:00:00Z', {
      value: 'x',
    });
    const second = qc.queue({ limit: 10 });
    assert.equal(second[0]?.revision.id, target);
    // The disputed revision stays at the front until someone arbitrates.
    assert.equal(second.length, 4);

    // Confirming clears an item from the queue, and reruns stay deterministic.
    const confirmed = ids[0]!;
    qc.record(confirmed, 'confirm', { id: user.id, name: user.name }, '2026-10-31T00:01:00Z');
    const third = qc.queue({ limit: 10 });
    assert.equal(
      third.some((item) => item.revision.id === confirmed),
      false,
    );
    const fourth = qc.queue({ limit: 10 });
    assert.deepEqual(
      third.map((item) => item.revision.id),
      fourth.map((item) => item.revision.id),
    );
    assert.equal(qc.queue({ limit: 1 }).length, 1);
  });

  test('reports reviewer agreement, coverage and the annotation mix', (t) => {
    const store = testStore();
    t.after(() => store.close());
    const { user, project: site } = project(store, '修订统计');
    const reviser = store.users.authByEmail(DEMO.pm.email);
    assert.ok(reviser);
    const other = store.users.authByEmail(DEMO.manager.email);
    assert.ok(other);
    const qc = store.ocrRevisionReviews;
    const ids = [0, 1, 2, 3].map((index) => {
      const document = seedDocument(store, {
        name: `scan-${index}.png`,
        projectId: site.id,
        uploaderId: user.id,
      });
      return seedRevision(store, {
        attachmentId: document,
        projectId: site.id,
        fieldId: `f${index}`,
        original: '1,000',
        revised: index === 3 ? '1,000' : '2,000',
        revisedBy: { id: reviser.id, name: reviser.name },
      });
    });
    for (const id of ids.slice(0, 2)) {
      qc.record(id, 'confirm', { id: user.id, name: user.name }, '2026-10-31T00:00:00Z');
    }
    qc.record(ids[2]!, 'revise', { id: user.id, name: user.name }, '2026-10-31T00:01:00Z', {
      value: '3,000',
    });
    qc.record(ids[2]!, 'confirm', { id: other.id, name: other.name }, '2026-10-31T00:02:00Z');

    const stats = qc.stats();
    assert.equal(stats.revisions, 4);
    assert.equal(stats.reviewed, 3);
    assert.equal(stats.unreviewed, 1);
    assert.equal(stats.doubleConfirmed, 3);
    assert.equal(stats.disputed, 0);
    assert.equal(stats.coverage, 0.75);
    // Four opinions were issued, one of them a dissent.
    assert.equal(stats.disagreementRate, 0.25);
    assert.ok(stats.interval[0] < 0.25 && stats.interval[1] > 0.25);
    assert.deepEqual(
      stats.byReviewer.map((row) => [row.reviewerName, row.reviewed, row.confirmed, row.revised]),
      [
        [user.name, 3, 2, 1],
        [other.name, 1, 1, 0],
      ],
    );
    assert.equal(stats.byReviewer[0]?.agreementRate, 2 / 3);
    assert.deepEqual(stats.annotationMix, {
      doubleConfirmed: 3,
      singleReviewer: 1,
      disputed: 0,
    });
    assert.equal(qc.stats({ projectId: site.id }).revisions, 4);
  });

  test('turns confirmed revisions into weighted calibration samples', (t) => {
    const store = testStore();
    t.after(() => store.close());
    const { user, project: site } = project(store, '修订回流');
    const reviser = store.users.authByEmail(DEMO.pm.email);
    assert.ok(reviser);
    const qc = store.ocrRevisionReviews;
    const documents = [0.9, 0.6, 0.3].map((confidence) =>
      seedDocument(store, {
        name: `doc.png`,
        projectId: site.id,
        uploaderId: user.id,
        confidence,
      }),
    );
    const ids = documents.map((document, index) =>
      seedRevision(store, {
        attachmentId: document,
        projectId: site.id,
        fieldId: `f${index}`,
        original: index === 0 ? '9,999' : '1,000',
        revised: '1,000',
        revisedBy: { id: reviser.id, name: reviser.name },
      }),
    );
    // Only the first label gets a second opinion; the third stays disputed.
    qc.record(ids[0]!, 'confirm', { id: user.id, name: user.name }, '2026-10-31T00:00:00Z');
    qc.record(ids[2]!, 'revise', { id: user.id, name: user.name }, '2026-10-31T00:01:00Z', {
      value: '1,500',
    });

    const samples = qc.calibrationSamples();
    assert.equal(samples.length, 2);
    const graded = new Map<string, OcrAnnotationReliability>(
      samples.map((sample) => [String(sample.confidence), sample.annotation ?? 'single_reviewer']),
    );
    assert.equal(graded.get('0.9'), 'double_confirmed');
    assert.equal(graded.get('0.6'), 'single_reviewer');
    // A revision confirmed against the model's own text proves the pass was right.
    const confirmed = samples.find((sample) => sample.confidence === 0.9);
    assert.equal(confirmed?.correct, false);
    assert.equal(confirmed?.severe, true);
    const untouched = samples.find((sample) => sample.confidence === 0.6);
    assert.equal(untouched?.correct, true);
    assert.equal(untouched?.severe, false);
    assert.equal(
      samples.every((sample) => sample.weight === undefined),
      true,
    );
  });

  test('down-weights single-person labels and drops disputed ones when fitting', () => {
    const label = (
      count: number,
      confidence: number,
      correct: boolean,
      annotation: OcrAnnotationReliability,
      weight?: number,
    ): OcrCalibrationSample[] =>
      Array.from({ length: count }, () => ({
        confidence,
        correct,
        severe: !correct,
        annotation,
        ...(weight === undefined ? {} : { weight }),
      }));
    const samples = [
      ...label(12, 0.9, true, 'double_confirmed'),
      ...label(8, 0.4, false, 'double_confirmed'),
      ...label(10, 0.8, false, 'single_reviewer', 0.4),
      ...label(5, 0.2, false, 'disputed'),
    ];
    const overall = fitThresholdProfiles(samples).find(
      (profile) => profile.dimension === 'overall',
    );
    assert.ok(overall);
    // The five disputed labels never reach the bucket at all.
    assert.equal(overall.samples, 30);
    assert.equal(overall.effectiveSamples, 24);
    assert.equal(overall.positives, 12);
    assert.equal(overall.calibrated, true);

    // Twenty one-person labels are worth eight, which is below the fit floor.
    const thin = fitThresholdProfiles(label(20, 0.5, false, 'single_reviewer', 0.4));
    const thinOverall = thin.find((profile) => profile.dimension === 'overall');
    assert.equal(thinOverall?.samples, 20);
    assert.equal(thinOverall?.effectiveSamples, 8);
    assert.equal(thinOverall?.calibrated, false);

    // Without weights the same corpus would be treated as fully conclusive.
    const unweighted = fitThresholdProfiles(label(20, 0.5, false, 'double_confirmed'));
    assert.equal(unweighted.find((profile) => profile.dimension === 'overall')?.calibrated, true);

    // A bucket made only of disputed labels produces no profile at all.
    assert.deepEqual(fitThresholdProfiles(label(30, 0.5, false, 'disputed')), []);
  });

  test('exposes the revision QC queue over the governance API', async (t) => {
    const store = testStore();
    const { app } = testApp(store);
    t.after(() => store.close());
    const { user, project: site } = project(store, '修订接口');
    const reviser = store.users.authByEmail(DEMO.pm.email);
    assert.ok(reviser);
    const document = seedDocument(store, {
      name: 'bill.png',
      projectId: site.id,
      uploaderId: user.id,
    });
    const mine = seedRevision(store, {
      attachmentId: document,
      projectId: site.id,
      original: '10',
      revised: '11',
      revisedBy: { id: user.id, name: user.name },
    });
    const theirs = seedRevision(store, {
      attachmentId: document,
      projectId: site.id,
      fieldId: 'tax',
      original: '1',
      revised: '2',
      revisedBy: { id: reviser.id, name: reviser.name },
    });

    const cookie = await login(app, DEMO.admin.email);
    const listed = await getJson<{ items: OcrRevisionQcItem[]; stats: OcrRevisionQcStats }>(
      app,
      cookie,
      '/api/ocr/revision-qc',
    );
    assert.deepEqual(listed.items.map((item) => item.revision.id).sort(), [mine, theirs].sort());
    assert.equal(listed.stats.revisions, 2);

    const self = await sendJson(app, cookie, 'POST', `/api/ocr/revision-qc/${mine}/review`, {
      verdict: 'confirm',
    });
    assert.equal(self.status, 400);
    assert.match(String(self.body.message), /不能为自己的修订/);

    const badVerdict = await sendJson(
      app,
      cookie,
      'POST',
      `/api/ocr/revision-qc/${theirs}/review`,
      {
        verdict: 'maybe',
      },
    );
    assert.equal(badVerdict.status, 400);

    const missingValue = await sendJson(
      app,
      cookie,
      'POST',
      `/api/ocr/revision-qc/${theirs}/review`,
      { verdict: 'revise' },
    );
    assert.equal(missingValue.status, 400);

    const unknown = await sendJson(app, cookie, 'POST', '/api/ocr/revision-qc/nope/review', {
      verdict: 'confirm',
    });
    assert.equal(unknown.status, 404);

    const reviewed = await sendJson<{ item: OcrRevisionQcItem; stats: OcrRevisionQcStats }>(
      app,
      cookie,
      'POST',
      `/api/ocr/revision-qc/${theirs}/review`,
      { verdict: 'confirm', note: '与发票号一致' },
    );
    assert.equal(reviewed.status, 200, JSON.stringify(reviewed.body));
    assert.equal(reviewed.body.item.reliability, 'double_confirmed');
    assert.equal(reviewed.body.stats.doubleConfirmed, 1);

    const duplicate = await sendJson(app, cookie, 'POST', `/api/ocr/revision-qc/${theirs}/review`, {
      verdict: 'confirm',
    });
    assert.equal(duplicate.status, 400);

    const after = await getJson<{ items: OcrRevisionQcItem[] }>(
      app,
      cookie,
      '/api/ocr/revision-qc',
    );
    assert.deepEqual(
      after.items.map((item) => item.revision.id),
      [mine],
    );

    const viewer = await login(app, DEMO.viewer.email);
    const denied = await app.request('/api/ocr/revision-qc', { headers: authHeaders(viewer) });
    assert.equal(denied.status, 403);
    const deniedWrite = await app.request(`/api/ocr/revision-qc/${theirs}/review`, {
      method: 'POST',
      headers: authHeaders(viewer, { 'content-type': 'application/json' }),
      body: JSON.stringify({ verdict: 'confirm' }),
    });
    assert.equal(deniedWrite.status, 403);

    const actions = store.audit
      .list(50)
      .filter((entry) => entry.action === 'ocr.revision_reviewed');
    assert.equal(actions.length, 1);
  });
});
