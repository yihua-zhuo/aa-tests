import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, describe, test } from 'node:test';
import type {
  DocumentFieldEvidence,
  DocumentIr,
  OcrFieldList,
  OcrFieldRevision,
} from '../shared/types.ts';
import { deriveFieldProvenance } from '../src/ocr-provenance.ts';
import { Store } from '../src/store.ts';
import { authHeaders, DEMO, login, sendJson, TEST_NOW, testApp } from './helpers.ts';

function documentWithFields(amountText: string): DocumentIr {
  const evidence: DocumentFieldEvidence = {
    kind: 'amount',
    page: 1,
    blockId: 't1',
    bbox: { x: 120, y: 200, width: 80, height: 20 },
    text: '1280.00',
    confidence: null,
    source: { engine: 'paddle', model: 'pp-structure', stage: 'visual' },
    candidates: [
      {
        text: '1280.00',
        confidence: 0.93,
        model: 'alt-a',
        source: 'region',
        bbox: { x: 120, y: 200, width: 80, height: 20 },
        pass: 1,
        agreesWithInitial: true,
      },
    ],
    selected: 'initial',
    agreement: 'confirmed_independent',
    passes: 1,
    failed: [],
    cell: { row: 1, column: 1, header: '金额', bboxEstimated: false },
    reason: 'initial_confirmed',
  };
  return {
    version: 1,
    route: 'visual',
    readingOrder: ['b1', 't1'],
    meta: { fieldEvidence: [evidence] },
    pages: [
      {
        number: 1,
        width: 800,
        height: 1000,
        source: { engine: 'paddle', model: 'pp-structure', stage: 'visual' },
        blocks: [
          {
            id: 'b1',
            type: 'paragraph',
            text: amountText,
            bbox: { x: 40, y: 40, width: 300, height: 24 },
            confidence: 0.72,
            source: { engine: 'paddle', model: 'pp-structure', stage: 'visual' },
            validation: null,
            order: 0,
          },
          {
            id: 't1',
            type: 'table',
            text: '项目 金额 日期\n服务费 1280.00 2026-01-05',
            bbox: { x: 40, y: 180, width: 600, height: 120 },
            confidence: 0.88,
            source: { engine: 'paddle', model: 'pp-structure', stage: 'visual' },
            validation: null,
            order: 1,
            rows: [
              ['项目', '金额', '日期'],
              ['服务费', '1280.00', '2026-01-05'],
            ],
          },
        ],
      },
    ],
  };
}

describe('OCR field provenance', () => {
  test('locates block fields by page, bbox, model and validation result', () => {
    const fields = deriveFieldProvenance(documentWithFields('合计金额：¥1,280.00'));
    const block = fields.find((field) => field.id === 'p1:b1');
    assert.ok(block);
    assert.equal(block.kind, 'amount');
    assert.equal(block.page, 1);
    assert.deepEqual(block.crop, {
      page: 1,
      bbox: { x: 40, y: 40, width: 300, height: 24 },
    });
    assert.equal(block.source.model, 'pp-structure');
    assert.equal(block.confidence, 0.72);
    assert.deepEqual(block.validation.rules, ['金额格式与币种一致性']);
    assert.deepEqual(block.validation.numeric, { canonical: '1280.00', valid: true });
    assert.equal(block.validation.status, 'passed');
    assert.equal(block.text, '合计金额：¥1,280.00');
    assert.equal(block.revisions.length, 0);
  });

  test('derives typed table cells with evidence and keeps raw text', () => {
    const fields = deriveFieldProvenance(documentWithFields('合计金额：¥1,280.00'));
    const amount = fields.find((field) => field.id === 'p1:t1:r1:c1');
    assert.ok(amount);
    assert.equal(amount.kind, 'amount');
    assert.deepEqual(amount.cell, { row: 1, column: 1, header: '金额' });
    assert.deepEqual(amount.bbox, { x: 240, y: 240, width: 200, height: 60 });
    assert.equal(amount.text, '1280.00');
    assert.deepEqual(amount.validation.numeric, { canonical: '1280.00', valid: true });
    assert.equal(amount.evidence?.agreement, 'confirmed_independent');
    assert.equal(amount.evidence?.candidates[0]?.model, 'alt-a');

    const date = fields.find((field) => field.id === 'p1:t1:r1:c2');
    assert.ok(date);
    assert.equal(date.kind, 'date');
    assert.deepEqual(date.validation.numeric, { canonical: '2026-01-05', valid: true });
    assert.equal(date.evidence, null);
  });

  test('flags unparsable key fields instead of rewriting their text', () => {
    const fields = deriveFieldProvenance(documentWithFields('合计金额：待定'));
    const block = fields.find((field) => field.id === 'p1:b1');
    assert.ok(block);
    assert.equal(block.text, '合计金额：待定');
    assert.equal(block.validation.status, 'flagged');
    assert.equal(block.validation.numeric?.valid, false);
    assert.ok(block.validation.issues.some((issue) => issue.includes('无法')));
  });
});

describe('OCR field revisions', () => {
  const store = new Store(':memory:', {
    demo: true,
    demoAccounts: true,
    now: TEST_NOW,
  });
  const { app } = testApp(store);

  after(() => store.close());

  async function seedAttachment() {
    const cookie = await login(app);
    const viewer = store.users.authByEmail(DEMO.viewer.email);
    assert.ok(viewer);
    const created = await sendJson<{ id: string }>(app, cookie, 'POST', '/api/projects', {
      name: 'OCR 复核项目',
      memberIds: [viewer.id],
    });
    assert.equal(created.status, 201);
    const user = store.users.authByEmail(DEMO.admin.email);
    assert.ok(user);
    const attachment = store.attachments.create({
      id: randomUUID(),
      projectId: created.body.id,
      uploaderId: user.id,
      name: 'invoice.png',
      mime: 'image/png',
      size: 1024,
      storedName: 'stored-invoice.png',
      sha256: 'a'.repeat(64),
      createdAt: TEST_NOW.toISOString(),
      ocrTarget: 'paddle',
    });
    store.attachments.completeOcr(
      attachment.id,
      {
        text: '合计金额：¥1,280.00',
        confidence: 0.88,
        model: 'pp-ocr',
        engineModel: 'PP-OCRv5',
        configHash: null,
        seconds: 1.2,
        pages: 1,
        truncated: false,
        route: 'visual',
        quality: null,
        stages: [],
        document: documentWithFields('合计金额：¥1,280.00'),
      },
      TEST_NOW.toISOString(),
    );
    return { cookie, projectId: created.body.id, attachmentId: attachment.id };
  }

  test('lists locatable fields and records revisions without overwriting OCR', async () => {
    const { cookie, projectId, attachmentId } = await seedAttachment();
    const base = `/api/projects/${projectId}/attachments/${attachmentId}/ocr/fields`;

    const listed = await app.request(base, { headers: authHeaders(cookie) });
    assert.equal(listed.status, 200);
    const { fields } = (await listed.json()) as OcrFieldList;
    assert.ok(fields.some((field) => field.id === 'p1:b1'));
    assert.ok(fields.some((field) => field.id === 'p1:t1:r1:c1'));

    const saved = await sendJson<{ revision: OcrFieldRevision }>(
      app,
      cookie,
      'POST',
      `${base}/${encodeURIComponent('p1:b1')}/revisions`,
      { revisedText: '合计金额：¥1,280.00（已核对）', reason: '人工核对发票原件' },
    );
    assert.equal(saved.status, 201);
    assert.equal(saved.body.revision.originalText, '合计金额：¥1,280.00');
    assert.equal(saved.body.revision.revisedText, '合计金额：¥1,280.00（已核对）');
    assert.equal(saved.body.revision.reason, '人工核对发票原件');
    assert.equal(saved.body.revision.fieldKind, 'amount');
    assert.ok(saved.body.revision.revisedBy?.name);
    assert.ok(saved.body.revision.createdAt);

    const after = await app.request(base, { headers: authHeaders(cookie) });
    const refreshed = (await after.json()) as OcrFieldList;
    const field = refreshed.fields.find((item) => item.id === 'p1:b1');
    assert.ok(field);
    assert.equal(field.text, '合计金额：¥1,280.00');
    assert.equal(field.revisions.length, 1);
    assert.equal(field.revisions[0]?.revisedText, '合计金额：¥1,280.00（已核对）');

    const ocr = store.attachments.findOcr(attachmentId);
    assert.equal(ocr?.text, '合计金额：¥1,280.00');
    assert.equal(
      store.audit
        .page({ page: 1, pageSize: 20 })
        .entries.some((entry) => entry.action === 'project.attachment_ocr_field_revised'),
      true,
    );
  });

  test('validates revision input and field ids', async () => {
    const { cookie, projectId, attachmentId } = await seedAttachment();
    const base = `/api/projects/${projectId}/attachments/${attachmentId}/ocr/fields`;

    const emptyText = await sendJson(app, cookie, 'POST', `${base}/p1%3Ab1/revisions`, {
      revisedText: '   ',
      reason: '核对',
    });
    assert.equal(emptyText.status, 400);

    const missingReason = await sendJson(app, cookie, 'POST', `${base}/p1%3Ab1/revisions`, {
      revisedText: '1280.00',
    });
    assert.equal(missingReason.status, 400);

    const unknownField = await sendJson(app, cookie, 'POST', `${base}/p9%3Anope/revisions`, {
      revisedText: '1280.00',
      reason: '核对',
    });
    assert.equal(unknownField.status, 404);

    const viewer = await login(app, DEMO.viewer.email);
    const denied = await sendJson(app, viewer, 'POST', `${base}/p1%3Ab1/revisions`, {
      revisedText: '1280.00',
      reason: '核对了',
    });
    assert.equal(denied.status, 403);
  });
});
