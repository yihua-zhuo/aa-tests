import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, describe, test } from 'node:test';
import type {
  DocumentBlock,
  DocumentFieldCandidate,
  DocumentFieldEvidence,
  DocumentIr,
  DocumentQuality,
  DocumentQualityIssue,
  OcrDashboardBucket,
  OcrDriftDimension,
  OcrFeedbackSample,
  OcrFieldRevision,
  OcrKnowledgeGraph,
  OcrOptimizationEntry,
  OcrProductionDashboard,
  OcrRecoveryYield,
  OcrStage,
  OcrVersionChain,
} from '../shared/types.ts';
import {
  compareDistributions,
  distributionOf,
  emptyDistribution,
  type OcrDistribution,
} from '../src/ocr-drift.ts';
import {
  businessCategory,
  documentCategory,
  feedbackDrafts,
  feedbackPoolSummary,
  feedbackPriority,
  feedbackSignals,
  selectFeedbackSamples,
  textLanguage,
} from '../src/ocr-feedback.ts';
import {
  buildProductionDashboard,
  buildVersionChain,
  type OcrDashboardRow,
  optimizationScore,
} from '../src/ocr-governance.ts';
import type { Store } from '../src/store.ts';
import { authHeaders, DEMO, getJson, login, sendJson, testApp, testStore } from './helpers.ts';

const SOURCE = { engine: 'paddle' as const, model: 'pp-ocr', stage: 'visual' as const };
const BBOX = { x: 20, y: 30, width: 160, height: 20 };

function candidate(text: string, model: string, agrees: boolean, confidence = 0.9) {
  return {
    text,
    confidence,
    model,
    source: 'region' as const,
    bbox: BBOX,
    pass: 1,
    agreesWithInitial: agrees,
  } satisfies DocumentFieldCandidate;
}

function evidence(overrides: Partial<DocumentFieldEvidence> = {}): DocumentFieldEvidence {
  return {
    kind: 'amount',
    page: 1,
    blockId: 'b1',
    bbox: BBOX,
    text: '1280.00',
    confidence: 0.6,
    source: SOURCE,
    candidates: [candidate('1280.00', 'alt-a', true)],
    selected: 'initial',
    agreement: 'confirmed_independent',
    passes: 1,
    failed: [],
    reason: 'initial_confirmed',
    ...overrides,
  };
}

function document(
  options: {
    amountText?: string;
    evidence?: DocumentFieldEvidence | null;
    width?: number;
    height?: number;
    table?: boolean;
  } = {},
): DocumentIr {
  const text = options.amountText ?? '合计金额：¥1,280.00';
  const blocks: DocumentBlock[] = [
    {
      id: 'b1',
      type: 'paragraph',
      text,
      bbox: { x: 30, y: 40, width: 300, height: 24 },
      confidence: 0.6,
      source: SOURCE,
      validation: null,
      order: 0,
    },
  ];
  if (options.table) {
    blocks.push({
      id: 't1',
      type: 'table',
      text: '项目 金额\n服务费 1280.00',
      bbox: { x: 30, y: 100, width: 600, height: 100 },
      confidence: 0.8,
      source: SOURCE,
      validation: null,
      order: 1,
      rows: [
        ['项目', '金额'],
        ['服务费', '1280.00'],
      ],
    });
  }
  const meta: Record<string, unknown> = {};
  if (options.evidence !== null) {
    meta.fieldEvidence = [options.evidence ?? evidence()];
  }
  return {
    version: 1,
    route: 'visual',
    pages: [
      {
        number: 1,
        width: options.width ?? 1000,
        height: options.height ?? 1200,
        source: SOURCE,
        blocks,
      },
    ],
    readingOrder: blocks.map((block) => block.id),
    meta,
  };
}

function issue(code: DocumentQualityIssue['code']): DocumentQualityIssue {
  return { code, severity: 'warning', message: code, page: 1, blockId: null };
}

function quality(overrides: Partial<DocumentQuality> = {}): DocumentQuality {
  return {
    score: 0.4,
    status: 'review',
    calibrated: false,
    signals: { fieldAccuracy: 0.4 },
    issues: [],
    components: {
      ocrConfidence: 0.6,
      structureConfidence: 0.8,
      fieldValidation: 0.5,
      businessConsistency: 1,
    },
    hardRisks: [],
    ...overrides,
  };
}

function stage(overrides: Partial<OcrStage> = {}): OcrStage {
  return {
    kind: 'visual',
    status: 'done',
    mode: 'auto',
    engine: 'paddle',
    model: 'pp-ocr',
    dpi: 200,
    seconds: 1.2,
    score: 0.7,
    message: null,
    inputSha256: 'b'.repeat(64),
    outputSha256: 'c'.repeat(64),
    params: { mode: 'auto', dpi: 200, page: null, bbox: null, padding: null },
    quality: {
      score: 0.7,
      status: 'review',
      calibrated: false,
      issues: [],
      hardRisks: [],
      signals: {},
    },
    ...overrides,
  };
}

function feedbackSample(
  id: string,
  errorType: OcrFeedbackSample['errorType'],
  category: string,
  priority: number,
  status: OcrFeedbackSample['status'] = 'pool',
): OcrFeedbackSample {
  return {
    id,
    attachmentId: null,
    projectId: null,
    sha256: null,
    errorType,
    category,
    lang: null,
    page: null,
    blockId: null,
    fieldId: null,
    signals: {
      confidence: null,
      uncertainty: priority,
      disagreement: 0,
      fieldFailure: 0,
      novelty: 0,
      revision: 0,
    },
    priority,
    status,
    note: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    sampledAt: null,
    labeledAt: null,
  };
}

function distribution(
  samples: number,
  overrides: Partial<Record<OcrDriftDimension, Record<string, number>>> = {},
): OcrDistribution {
  return { samples, dimensions: { ...emptyDistribution().dimensions, ...overrides } };
}

function dashboardRow(overrides: Partial<OcrDashboardRow> = {}): OcrDashboardRow {
  return {
    id: randomUUID(),
    name: 'invoice.png',
    mime: 'image/png',
    status: 'done',
    engine: 'paddle',
    model: 'pp-ocr',
    pages: 1,
    seconds: 2,
    characters: 100,
    confidence: 0.9,
    truncated: false,
    reviewRequired: false,
    revisions: 0,
    language: 'ch',
    quality: null,
    hasTable: false,
    stages: [],
    updatedAt: '2026-10-20T00:00:00.000Z',
    ...overrides,
  };
}

function bucketValue(buckets: OcrDashboardBucket[], key: string): OcrDashboardBucket | undefined {
  return buckets.find((bucket) => bucket.key === key);
}

describe('OCR feedback signals and active learning', () => {
  test('classifies document categories and dominant languages from metadata/text', () => {
    assert.equal(documentCategory('invoice.pdf', 'application/pdf'), 'pdf');
    assert.equal(documentCategory('scan.PNG', 'image/png'), 'image:png');
    assert.equal(documentCategory('notes', 'text/plain'), 'text/plain');
    assert.equal(businessCategory('2026-10-invoice.pdf', 'application/pdf'), 'invoice');
    assert.equal(businessCategory('合同-甲乙双方.docx', 'application/octet-stream'), 'contract');
    assert.equal(businessCategory('台账.xlsx', 'application/octet-stream'), 'table');
    assert.equal(businessCategory('scan.png', 'image/png'), 'image');
    assert.equal(businessCategory('notes.txt', 'text/plain'), 'other');
    assert.equal(textLanguage('合计金额：¥1,280.00'), 'ch');
    assert.equal(textLanguage('Invoice total 1280.00'), 'en');
    assert.equal(textLanguage('  '), null);
  });

  test('derives uncertainty, disagreement, field failure and revision signals', () => {
    const revision = { reason: '人工核对', fieldId: 'p1:b1' } as OcrFieldRevision;
    const signals = feedbackSignals({
      quality: null,
      document: document(),
      revisions: [revision],
      confidence: 0.55,
    });
    assert.equal(signals.confidence, 0.55);
    assert.ok(signals.uncertainty > 0.85 && signals.uncertainty <= 1);
    assert.equal(signals.disagreement, 0);
    assert.equal(signals.fieldFailure, 0);
    assert.equal(signals.revision, 1);

    const conflict = feedbackSignals({
      quality: quality({
        hardRisks: [
          {
            code: 'field_validation_failed',
            severity: 'error',
            message: '金额未通过校验',
            page: 1,
            blockId: 'b1',
          },
        ],
      }),
      document: document({
        evidence: evidence({
          selected: null,
          agreement: 'conflict',
          candidates: [candidate('1280.00', 'alt-a', true), candidate('1380.00', 'alt-b', false)],
        }),
      }),
      revisions: [],
      confidence: 0.9,
    });
    assert.ok(conflict.disagreement >= 0.5);
    assert.ok(conflict.fieldFailure >= 0.6);
    assert.equal(conflict.revision, 0);
  });

  test('weights uncertainty, disagreement and field failure into priority', () => {
    assert.equal(feedbackPriority(feedbackSample('x', 'low_confidence', 'pdf', 0).signals), 0);
    assert.equal(
      feedbackPriority({
        confidence: null,
        uncertainty: 0.5,
        disagreement: 0,
        fieldFailure: 0,
        novelty: 0,
        revision: 0,
      }),
      0.15,
    );
    assert.equal(
      feedbackPriority({
        confidence: null,
        uncertainty: 1,
        disagreement: 1,
        fieldFailure: 1,
        novelty: 1,
        revision: 1,
      }),
      1,
    );
  });

  test('emits one draft per error type without rewriting OCR text', () => {
    const revision = {
      id: 'r1',
      attachmentId: 'a1',
      projectId: 'p1',
      fieldId: 'p1:b1',
      fieldKind: 'amount',
      page: 1,
      blockId: 'b1',
      bbox: BBOX,
      originalText: '1280.00',
      revisedText: '1380.00',
      reason: '对照纸质发票后修正',
      revisedBy: null,
      createdAt: '2026-10-20T00:00:00.000Z',
    } satisfies OcrFieldRevision;
    const source = {
      attachment: {
        id: 'a1',
        projectId: 'p1',
        sha256: 'a'.repeat(64),
        name: 'invoice.pdf',
        mime: 'application/pdf',
        ocrText: '合计金额：¥1,280.00',
        confidence: null,
      },
      quality: quality({ hardRisks: [], signals: { fieldAccuracy: 1 } }),
      document: document(),
      revisions: [revision],
      complaint: '金额识别错误',
    };
    const drafts = feedbackDrafts(source);
    const types = drafts.map((draft) => draft.errorType).sort();
    assert.deepEqual(types, ['human_revision', 'low_confidence', 'user_complaint']);
    const low = drafts.find((draft) => draft.errorType === 'low_confidence');
    assert.equal(low?.page, 1);
    assert.equal(low?.blockId, 'b1');
    assert.equal(low?.category, 'pdf');
    assert.equal(low?.lang, 'ch');
    assert.ok(low?.note);
    const complaint = drafts.find((draft) => draft.errorType === 'user_complaint');
    assert.equal(complaint?.note, '金额识别错误');
    assert.equal(drafts.filter((draft) => draft.errorType === 'low_confidence').length, 1);
  });

  test('flags model disagreement and validation failures with field references', () => {
    const drafts = feedbackDrafts({
      attachment: {
        id: 'a2',
        projectId: 'p1',
        sha256: null,
        name: 'scan.png',
        mime: 'image/png',
        ocrText: 'Invoice total 1280.00',
        confidence: 0.9,
      },
      quality: quality({
        hardRisks: [
          {
            code: 'field_validation_failed',
            severity: 'error',
            message: '金额未通过校验',
            page: 1,
            blockId: 'b1',
          },
        ],
      }),
      document: document({
        amountText: '合计金额：待定',
        evidence: evidence({
          selected: null,
          agreement: 'conflict',
          candidates: [candidate('1280.00', 'alt-a', true), candidate('1380.00', 'alt-b', false)],
        }),
      }),
      revisions: [],
    });
    const disagreement = drafts.find((draft) => draft.errorType === 'model_disagreement');
    assert.equal(disagreement?.fieldId, 'p1:b1');
    assert.equal(disagreement?.page, 1);
    const field = drafts.find((draft) => draft.errorType === 'field_validation');
    assert.ok(field);
    assert.equal(field?.fieldId, 'p1:b1');
    assert.equal(drafts.filter((draft) => draft.errorType === 'model_disagreement').length, 1);
  });

  test('selects samples round-robin across strata with a budget', () => {
    const samples = [
      feedbackSample('fv1', 'field_validation', 'pdf', 0.95),
      feedbackSample('lc1', 'low_confidence', 'pdf', 0.9),
      feedbackSample('li1', 'low_confidence', 'image:png', 0.85),
      feedbackSample('fv2', 'field_validation', 'pdf', 0.5),
      feedbackSample('lc2', 'low_confidence', 'pdf', 0.8),
      feedbackSample('li2', 'low_confidence', 'image:png', 0.6),
      feedbackSample('lc3', 'low_confidence', 'pdf', 0.7),
      feedbackSample('done', 'low_confidence', 'pdf', 1, 'labeled'),
    ];
    const selection = selectFeedbackSamples(samples, { perStratum: 2, total: 5 });
    assert.deepEqual(
      selection.samples.map((sample) => sample.id),
      ['fv1', 'lc1', 'li1', 'lc2', 'fv2'],
    );
    const byStratum = new Map(
      selection.strata.map((stratum) => [`${stratum.errorType}/${stratum.category}`, stratum]),
    );
    assert.deepEqual(byStratum.get('field_validation/pdf'), {
      errorType: 'field_validation',
      category: 'pdf',
      available: 2,
      selected: 2,
    });
    assert.equal(byStratum.get('low_confidence/pdf')?.selected, 2);
    assert.equal(byStratum.get('low_confidence/image:png')?.selected, 1);
    assert.ok(!selection.samples.some((sample) => sample.id === 'done'));

    const capped = selectFeedbackSamples(samples, { perStratum: 3, total: 4 });
    assert.equal(capped.samples.length, 4);
  });

  test('optimizes the annotation budget by value per cost', () => {
    const samples = [
      feedbackSample('fv1', 'field_validation', 'pdf', 0.95),
      feedbackSample('fv2', 'field_validation', 'pdf', 0.9),
      feedbackSample('lc1', 'low_confidence', 'pdf', 0.9),
      feedbackSample('lc2', 'low_confidence', 'pdf', 0.8),
    ];
    const selection = selectFeedbackSamples(samples, {
      perStratum: 3,
      total: 10,
      budget: 2.5,
    });
    assert.deepEqual(
      selection.samples.map((sample) => sample.id),
      ['fv1', 'lc1'],
    );
    assert.deepEqual(selection.budget, { limit: 2.5, used: 2.2, remaining: 0.3 });
    assert.equal(selection.skipped, 2);
    assert.deepEqual(selection.coverage, {
      categories: 1,
      errorTypes: 2,
      poolCategories: 1,
      poolErrorTypes: 2,
    });

    const unbounded = selectFeedbackSamples(samples, { perStratum: 3, total: 10 });
    assert.equal(unbounded.samples.length, 4);
    assert.deepEqual(unbounded.budget, { limit: null, used: 4.4, remaining: null });
    assert.equal(unbounded.skipped, 0);
  });

  test('summarizes the pool by status, error type and category', () => {
    const pool = feedbackPoolSummary([
      feedbackSample('a', 'low_confidence', 'pdf', 0.4),
      feedbackSample('b', 'low_confidence', 'pdf', 0.3, 'sampled'),
      feedbackSample('c', 'human_revision', 'image:png', 0.8, 'labeled'),
    ]);
    assert.equal(pool.total, 3);
    assert.deepEqual(pool.byErrorType, {
      low_confidence: 2,
      model_disagreement: 0,
      field_validation: 0,
      human_revision: 1,
      user_complaint: 0,
    });
    assert.deepEqual(pool.byStatus, { pool: 1, sampled: 1, labeled: 1, dismissed: 0 });
    assert.deepEqual(pool.byCategory, [
      { category: 'pdf', count: 2 },
      { category: 'image:png', count: 1 },
    ]);
    assert.equal(pool.unlabeled, 2);
  });
});

describe('OCR drift detection', () => {
  test('buckets production metadata without reading document text', () => {
    const distribution = distributionOf([
      {
        name: 'scan.png',
        mime: 'image/png',
        text: '合计金额：¥1,280.00',
        pageCount: 1,
        pageSizes: [{ width: 1000, height: 1200 }],
        blocksPerPage: [2],
        hasTable: false,
        quality: quality({ issues: [issue('image_blurry')] }),
      },
      {
        name: 'table.pdf',
        mime: 'application/pdf',
        text: 'Invoice total 1280.00',
        pageCount: 3,
        pageSizes: [{ width: 3000, height: 3000 }],
        blocksPerPage: [30],
        hasTable: true,
        quality: null,
      },
    ]);
    assert.equal(distribution.samples, 2);
    assert.deepEqual(distribution.dimensions.file_type, { 'image:png': 1, pdf: 1 });
    assert.deepEqual(distribution.dimensions.resolution, { standard: 1, very_high: 1 });
    assert.deepEqual(distribution.dimensions.page_size, { portrait: 1, square: 1 });
    assert.deepEqual(distribution.dimensions.noise, { blur: 1, unknown: 1 });
    assert.deepEqual(distribution.dimensions.layout, { sparse: 1, table: 1 });
    assert.deepEqual(distribution.dimensions.language, { ch: 1, en: 1 });
  });

  test('reports stable, drifted and insufficient dimensions', () => {
    const stable = compareDistributions(
      distribution(20, { file_type: { pdf: 20 } }),
      distribution(20, { file_type: { pdf: 20 } }),
    );
    assert.ok(stable.dimensions.every((report) => report.status === 'stable'));
    assert.deepEqual(stable.alerts, []);
    assert.equal(stable.recommendation, null);

    const drift = compareDistributions(
      distribution(20, { file_type: { pdf: 20 } }),
      distribution(20, { file_type: { 'image:png': 20 } }),
    );
    const fileType = drift.dimensions.find((report) => report.dimension === 'file_type');
    assert.equal(fileType?.status, 'drift');
    assert.equal(fileType?.totalVariation, 1);
    assert.equal(drift.alerts.length, 1);
    assert.equal(drift.alerts[0]?.dimension, 'file_type');
    assert.equal(drift.alerts[0]?.severity, 'critical');
    assert.ok(drift.alerts[0]?.message.includes('file_type'));
    assert.ok(drift.recommendation?.includes('file_type'));
    assert.deepEqual(drift.alerts[0]?.buckets.map((bucket) => bucket.key).sort(), [
      'image:png',
      'pdf',
    ]);

    const insufficient = compareDistributions(
      distribution(5, { file_type: { pdf: 5 } }),
      distribution(5, { file_type: { pdf: 5 } }),
    );
    assert.ok(insufficient.dimensions.every((report) => report.status === 'insufficient'));
    assert.deepEqual(insufficient.alerts, []);
  });

  test('uses total variation distance against the configured threshold', () => {
    const report = compareDistributions(
      distribution(20, { language: { ch: 15, en: 5 } }),
      distribution(20, { language: { ch: 5, en: 15 } }),
      { threshold: 0.5, generatedAt: '2026-10-20T00:00:00.000Z' },
    );
    const language = report.dimensions.find((item) => item.dimension === 'language');
    assert.equal(language?.totalVariation, 0.5);
    assert.equal(language?.status, 'drift');
    assert.equal(report.generatedAt, '2026-10-20T00:00:00.000Z');
  });
});

describe('OCR production dashboard and version chain', () => {
  test('aggregates rates, latency, throughput and breakdowns', () => {
    const rows = [
      dashboardRow({
        revisions: 1,
        stages: [stage({ seconds: 1.2 })],
        workspaceId: 'w1',
        workspaceName: '客户 A',
      }),
      dashboardRow({
        confidence: 0.7,
        seconds: 4,
        characters: 50,
        pages: 2,
        reviewRequired: true,
        truncated: true,
        stages: [stage({ kind: 'recovery_region', status: 'failed', seconds: 1.2 })],
        workspaceId: 'w1',
        workspaceName: '客户 A',
      }),
      dashboardRow({ status: 'failed', seconds: null, pages: 0, characters: 0, confidence: null }),
      dashboardRow({ status: 'pending', seconds: null, pages: 0, characters: 0, confidence: null }),
      dashboardRow({
        status: 'processing',
        seconds: null,
        pages: 0,
        characters: 0,
        confidence: null,
      }),
    ];
    const dashboard: OcrProductionDashboard = buildProductionDashboard(rows, {
      windowDays: 30,
      generatedAt: '2026-10-20T00:00:00.000Z',
      feedback: feedbackPoolSummary([]),
      drift: compareDistributions(emptyDistribution(), emptyDistribution()),
    });
    assert.equal(dashboard.documents, 5);
    assert.equal(dashboard.done, 2);
    assert.equal(dashboard.failed, 1);
    assert.equal(dashboard.pending, 1);
    assert.equal(dashboard.processing, 1);
    assert.ok(Math.abs(dashboard.failureRate - 1 / 3) < 1e-9);
    assert.equal(dashboard.reviewRate, 0.5);
    assert.equal(dashboard.truncationRate, 0.5);
    assert.equal(dashboard.revisionObservedRate, 0.5);
    assert.equal(dashboard.revisions, 1);
    assert.ok(Math.abs((dashboard.confidenceRiskProxy ?? 0) - 0.2) < 1e-9);
    assert.equal(dashboard.latency.averageSeconds, 3);
    assert.equal(dashboard.latency.p95Seconds, 4);
    assert.equal(dashboard.throughput.pages, 3);
    assert.equal(dashboard.throughput.characters, 150);
    assert.equal(dashboard.throughput.charactersPerSecond, 25);
    assert.equal(bucketValue(dashboard.byModel, 'paddle:pp-ocr')?.documents, 5);
    assert.equal(bucketValue(dashboard.byLanguage, 'ch')?.done, 2);
    assert.equal(bucketValue(dashboard.byFileType, 'image:png')?.documents, 5);
    assert.equal(bucketValue(dashboard.byBusinessType, 'invoice')?.documents, 5);
    assert.equal(bucketValue(dashboard.byWorkspace, '客户 A')?.documents, 2);
    assert.equal(bucketValue(dashboard.byWorkspace, '未归属')?.documents, 3);
    assert.equal(bucketValue(dashboard.byPageBucket, '1')?.documents, 4);
    assert.equal(bucketValue(dashboard.byPageBucket, '2-3')?.documents, 1);
    assert.deepEqual(
      dashboard.byStage.map((item) => [item.stage, item.runs, item.failed]),
      [
        ['visual', 1, 0],
        ['recovery_region', 1, 1],
      ],
    );
  });

  test('assembles lineage from original through stages, selections and revisions', () => {
    const revision = {
      id: 'rev-1',
      attachmentId: 'att-1',
      projectId: 'proj-1',
      fieldId: 'p1:b1',
      fieldKind: 'amount',
      page: 1,
      blockId: 'b1',
      bbox: BBOX,
      originalText: '1280.00',
      revisedText: '1380.00',
      reason: '人工核对',
      revisedBy: { id: 'u1', name: '审核员' },
      createdAt: '2026-10-20T03:00:00.000Z',
    } satisfies OcrFieldRevision;
    const chain: OcrVersionChain = buildVersionChain(
      {
        id: 'att-1',
        projectId: 'proj-1',
        status: 'done',
        text: '合计金额：¥1,280.00',
        engine: 'paddle',
        model: 'pp-ocr',
        engineModel: 'PP-OCRv5',
        confidence: 0.6,
        truncated: false,
        route: 'visual',
        mode: 'auto',
        dpi: 200,
        updatedAt: '2026-10-20T01:00:00.000Z',
        quality: quality(),
        stages: [
          stage(),
          stage({ kind: 'recovery_region', trigger: 'key_field', model: 'pp-ocr-region' }),
        ],
        document: {
          meta: document({
            evidence: evidence({
              selected: 'candidate',
              candidates: [
                candidate('1380.00', 'alt-a', false, 0.98),
                candidate('1280.00', 'alt-b', true, 0.9),
              ],
            }),
          }).meta,
        },
      },
      [revision],
    );
    assert.equal(chain.attachmentId, 'att-1');
    assert.deepEqual(
      chain.nodes.map((node) => node.id),
      [
        'original',
        'stage:1:visual',
        'stage:2:recovery_region',
        'selection:p1:b1',
        'revision:rev-1',
      ],
    );
    const original = chain.nodes[0];
    assert.equal(original?.kind, 'original');
    assert.equal(original?.text, null);
    assert.deepEqual(original?.parents, []);
    assert.equal(original?.model, 'PP-OCRv5');
    assert.equal(original?.detail.characters, '合计金额：¥1,280.00'.length);
    const firstStage = chain.nodes[1];
    assert.deepEqual(firstStage?.parents, ['original']);
    assert.equal(firstStage?.sha256, 'c'.repeat(64));
    const secondStage = chain.nodes[2];
    assert.deepEqual(secondStage?.parents, ['stage:1:visual']);
    assert.equal(secondStage?.detail.trigger, 'key_field');
    const selection = chain.nodes[3];
    assert.equal(selection?.kind, 'selection');
    assert.deepEqual(selection?.parents, ['stage:2:recovery_region']);
    assert.equal(selection?.text, '1380.00');
    assert.equal(selection?.engine, 'paddle');
    assert.equal(selection?.detail.originalText, '1280.00');
    const human = chain.nodes[4];
    assert.equal(human?.kind, 'revision');
    assert.deepEqual(human?.parents, ['selection:p1:b1']);
    assert.equal(human?.text, '1380.00');
    assert.equal(chain.revisions.length, 1);
  });

  test('ranks optimizations by expected gain per unit cost and keeps costs positive', () => {
    assert.equal(
      optimizationScore({ expectedGain: 0.3, implementationCost: 0.2, inferenceCost: 0.1 }),
      1,
    );
    assert.equal(
      optimizationScore({ expectedGain: 0.2, implementationCost: 0, inferenceCost: 0 }),
      2,
    );
    assert.equal(
      optimizationScore({ expectedGain: 0, implementationCost: 0, inferenceCost: 0 }),
      0,
    );
  });
});

type ProjectResponse = { id: string };

function seedDone(
  store: Store,
  projectId: string,
  uploaderId: string,
  options: {
    name?: string;
    mime?: string;
    text?: string;
    confidence?: number | null;
    quality?: DocumentQuality | null;
    document?: DocumentIr | null;
    stages?: OcrStage[];
    seconds?: number;
  } = {},
): string {
  const id = randomUUID();
  const updatedAt = new Date().toISOString();
  const sha256 = randomUUID().replaceAll('-', '').padEnd(64, '0');
  store.attachments.create({
    id,
    projectId,
    uploaderId,
    name: options.name ?? 'invoice.png',
    mime: options.mime ?? 'image/png',
    size: 1024,
    storedName: `stored-${id}.bin`,
    sha256,
    createdAt: updatedAt,
    ocrTarget: 'paddle',
  });
  store.attachments.completeOcr(
    id,
    {
      text: options.text ?? '合计金额：¥1,280.00',
      confidence: options.confidence === undefined ? 0.9 : options.confidence,
      model: 'pp-ocr',
      engineModel: 'PP-OCRv5',
      configHash: null,
      seconds: options.seconds ?? 1.2,
      pages: 1,
      truncated: false,
      route: 'visual',
      quality: options.quality ?? null,
      stages: options.stages ?? [],
      document: options.document === undefined ? document() : options.document,
    },
    updatedAt,
  );
  return id;
}

async function createProject(
  app: ReturnType<typeof testApp>['app'],
  cookie: string,
  memberIds: string[],
  name = 'OCR 治理项目',
): Promise<string> {
  const created = await sendJson<ProjectResponse>(app, cookie, 'POST', '/api/projects', {
    name,
    memberIds,
  });
  assert.equal(created.status, 201);
  return created.body.id;
}

function adminUser(store: Store) {
  const user = store.users.authByEmail(DEMO.admin.email);
  assert.ok(user);
  return user;
}

function viewerUser(store: Store) {
  const user = store.users.authByEmail(DEMO.viewer.email);
  assert.ok(user);
  return user;
}

describe('OCR feedback pool API', () => {
  const store = testStore();
  const { app } = testApp(store);
  const admin = adminUser(store);
  const viewer = viewerUser(store);

  after(() => store.close());

  test('exposes recovery yields to admins only', async () => {
    const cookie = await login(app);
    const viewerCookie = await login(app, DEMO.viewer.email);
    store.ocrYields.record(
      [{ kind: 'recovery_dpi', attempts: 3, successes: 2 }],
      '2026-10-31T00:00:00.000Z',
    );
    const forbidden = await app.request('/api/ocr/recovery-yields', {
      headers: authHeaders(viewerCookie),
    });
    assert.equal(forbidden.status, 403);
    const result = await getJson<{ yields: OcrRecoveryYield[]; minSamples: number }>(
      app,
      cookie,
      '/api/ocr/recovery-yields',
    );
    assert.equal(result.minSamples, 5);
    assert.equal(result.yields[0]?.stage, 'recovery_dpi');
    assert.equal(result.yields[0]?.attempts, 3);
    assert.equal(result.yields[0]?.successes, 2);
    assert.equal(result.yields[0]?.updatedAt, '2026-10-31T00:00:00.000Z');
  });

  test('returns samples automatically and dedupes repeated syncs', async () => {
    const cookie = await login(app);
    const viewerCookie = await login(app, DEMO.viewer.email);
    const projectId = await createProject(app, cookie, [viewer.id], 'OCR 回流项目');
    const attachmentId = seedDone(store, projectId, admin.id, {
      confidence: 0.55,
      quality: quality({ issues: [issue('low_confidence')], signals: { fieldAccuracy: 1 } }),
    });
    store.ocrFieldRevisions.create({
      attachmentId,
      projectId,
      fieldId: 'p1:b1',
      fieldKind: 'amount',
      page: 1,
      blockId: 'b1',
      bbox: BBOX,
      originalText: '1280.00',
      revisedText: '1380.00',
      reason: '人工核对发票',
      revisedBy: { id: admin.id, name: admin.name },
      createdAt: new Date().toISOString(),
    });

    const forbidden = await app.request('/api/ocr/feedback', {
      headers: authHeaders(viewerCookie),
    });
    assert.equal(forbidden.status, 403);

    const first = await sendJson<{
      scanned: number;
      inserted: number;
      pool: { byErrorType: Record<string, number>; total: number };
    }>(app, cookie, 'POST', '/api/ocr/feedback/sync', { days: 30 });
    assert.equal(first.status, 200);
    assert.equal(first.body.scanned, 1);
    assert.equal(first.body.inserted, 2);
    assert.equal(first.body.pool.byErrorType.low_confidence, 1);
    assert.equal(first.body.pool.byErrorType.human_revision, 1);

    const second = await sendJson<{ inserted: number }>(
      app,
      cookie,
      'POST',
      '/api/ocr/feedback/sync',
      { days: 30 },
    );
    assert.equal(second.status, 200);
    assert.equal(second.body.inserted, 0);

    const listed = await getJson<{
      pool: { total: number; unlabeled: number };
      samples: OcrFeedbackSample[];
    }>(app, cookie, '/api/ocr/feedback?status=pool');
    assert.equal(listed.pool.total, 2);
    assert.equal(listed.pool.unlabeled, 2);
    assert.ok(listed.samples.every((sample) => sample.status === 'pool'));

    const filtered = await getJson<{ samples: OcrFeedbackSample[] }>(
      app,
      cookie,
      '/api/ocr/feedback?errorType=human_revision',
    );
    assert.equal(filtered.samples.length, 1);
    assert.equal(filtered.samples[0]?.sha256?.length, 64);

    const invalid = await app.request('/api/ocr/feedback?status=nope', {
      headers: authHeaders(cookie),
    });
    assert.equal(invalid.status, 400);
  });

  test('samples with a budget and records annotation status', async () => {
    const cookie = await login(app);
    const selection = await sendJson<{
      samples: OcrFeedbackSample[];
      strata: { errorType: string; category: string; available: number; selected: number }[];
    }>(app, cookie, 'POST', '/api/ocr/feedback/sample', { perStratum: 2, total: 1 });
    assert.equal(selection.status, 200);
    assert.equal(selection.body.samples.length, 1);
    const sample = selection.body.samples[0];
    assert.ok(sample);
    assert.equal(sample.status, 'sampled');
    assert.ok(sample.sampledAt);

    const invalid = await sendJson(app, cookie, 'POST', '/api/ocr/feedback/sample', {
      total: 0,
    });
    assert.equal(invalid.status, 400);

    const labeled = await sendJson<{ sample: OcrFeedbackSample }>(
      app,
      cookie,
      'POST',
      `/api/ocr/feedback/${sample.id}/status`,
      { status: 'labeled', note: '已标注为金额字段错误' },
    );
    assert.equal(labeled.status, 200);
    assert.equal(labeled.body.sample.status, 'labeled');
    assert.ok(labeled.body.sample.labeledAt);
    assert.equal(labeled.body.sample.note, '已标注为金额字段错误');

    const badStatus = await sendJson(app, cookie, 'POST', `/api/ocr/feedback/${sample.id}/status`, {
      status: 'sampled',
    });
    assert.equal(badStatus.status, 400);

    const missing = await sendJson(app, cookie, 'POST', '/api/ocr/feedback/nope/status', {
      status: 'dismissed',
    });
    assert.equal(missing.status, 404);
  });

  test('builds a read-only cross-document knowledge graph', async () => {
    const cookie = await login(app);
    const viewerCookie = await login(app, DEMO.viewer.email);
    const projectId = await createProject(app, cookie, [viewer.id], '知识图谱项目');
    seedDone(store, projectId, admin.id, { name: 'invoice-a.png' });
    seedDone(store, projectId, admin.id, { name: 'invoice-b.png' });

    const response = await getJson<{ graph: OcrKnowledgeGraph }>(
      app,
      cookie,
      `/api/ocr/knowledge?projectId=${projectId}`,
    );
    assert.equal(response.graph.documents, 2);
    const amount = response.graph.entities.find((entity) => entity.id === 'amount:CNY:1280.00');
    assert.ok(amount);
    assert.equal(amount.documents, 2);
    assert.equal(response.graph.relations.length, 1);
    assert.equal(
      response.graph.metrics.find((metric) => metric.key.startsWith('amount:CNY:'))?.value,
      2560,
    );

    const forbidden = await app.request(`/api/ocr/knowledge?projectId=${projectId}`, {
      headers: authHeaders(viewerCookie),
    });
    assert.equal(forbidden.status, 403);

    const invalid = await app.request('/api/ocr/knowledge?limit=0', {
      headers: authHeaders(cookie),
    });
    assert.equal(invalid.status, 400);
  });
});

describe('OCR dashboard and drift API', () => {
  const store = testStore();
  const { app } = testApp(store);
  const admin = adminUser(store);
  const viewer = viewerUser(store);

  after(() => store.close());

  test('requires a baseline with enough documents, then persists deduped drift alerts', async () => {
    const cookie = await login(app);
    const viewerCookie = await login(app, DEMO.viewer.email);
    const projectId = await createProject(app, cookie, [viewer.id], 'OCR 漂移项目');

    const empty = await sendJson<{ baseline?: { samples: number } }>(
      app,
      cookie,
      'POST',
      '/api/ocr/drift/baseline',
      { days: 365 },
    );
    assert.equal(empty.status, 422);

    for (let index = 0; index < 20; index += 1) {
      seedDone(store, projectId, admin.id, {
        document: document({ table: false }),
        confidence: 0.9,
      });
    }
    const saved = await sendJson<{ baseline: { samples: number; createdAt: string } }>(
      app,
      cookie,
      'POST',
      '/api/ocr/drift/baseline',
      { days: 365 },
    );
    assert.equal(saved.status, 200);
    assert.equal(saved.body.baseline.samples, 20);

    for (let index = 0; index < 12; index += 1) {
      seedDone(store, projectId, admin.id, {
        name: 'invoice.pdf',
        mime: 'application/pdf',
        text: 'Invoice total 1280.00',
        confidence: 0.7,
        quality: quality({ issues: [issue('image_blurry')] }),
        document: document({
          amountText: 'Invoice total 1280.00',
          width: 3000,
          height: 3000,
          table: true,
        }),
      });
    }

    const forbidden = await app.request('/api/ocr/drift?days=365', {
      headers: authHeaders(viewerCookie),
    });
    assert.equal(forbidden.status, 403);

    const check = await sendJson<{
      inserted: number;
      drift: {
        baselineSamples: number;
        currentSamples: number;
        dimensions: { dimension: string; status: string }[];
        alerts: { dimension: string }[];
        recommendation: string | null;
      };
      alerts: { status: string }[];
    }>(app, cookie, 'POST', '/api/ocr/drift/check', { days: 365 });
    assert.equal(check.status, 200);
    assert.equal(check.body.drift.baselineSamples, 20);
    assert.equal(check.body.drift.currentSamples, 32);
    assert.ok(check.body.inserted > 0);
    const fileType = check.body.drift.dimensions.find((item) => item.dimension === 'file_type');
    assert.equal(fileType?.status, 'drift');
    assert.ok(check.body.drift.alerts.some((alert) => alert.dimension === 'file_type'));
    assert.ok(check.body.drift.recommendation);
    assert.ok(check.body.alerts.every((alert) => alert.status === 'open'));

    const repeated = await sendJson<{ inserted: number }>(
      app,
      cookie,
      'POST',
      '/api/ocr/drift/check',
      { days: 365 },
    );
    assert.equal(repeated.status, 200);
    assert.equal(repeated.body.inserted, 0);

    const drift = await getJson<{
      drift: { currentSamples: number };
      alerts: { dimension: string }[];
    }>(app, cookie, '/api/ocr/drift?days=365');
    assert.equal(drift.drift.currentSamples, 32);
    assert.ok(drift.alerts.length > 0);

    const dashboard = await getJson<{
      dashboard: {
        documents: number;
        done: number;
        failureRate: number;
        revisionObservedRate: number | null;
        byFileType: { key: string }[];
        byBusinessType: { key: string }[];
        byLanguage: { key: string }[];
        byWorkspace: { key: string }[];
        workspaceThresholds: unknown[];
        feedback: { total: number };
        drift: { baselineSamples: number };
      };
      alerts: unknown[];
    }>(app, cookie, '/api/ocr/quality/dashboard?days=365');
    assert.equal(dashboard.dashboard.documents, 32);
    assert.equal(dashboard.dashboard.done, 32);
    assert.equal(dashboard.dashboard.failureRate, 0);
    assert.equal(dashboard.dashboard.revisionObservedRate, 0);
    assert.ok(dashboard.dashboard.byFileType.some((bucket) => bucket.key === 'pdf'));
    assert.ok(dashboard.dashboard.byFileType.some((bucket) => bucket.key === 'image:png'));
    assert.ok(dashboard.dashboard.byBusinessType.length > 0);
    assert.ok(dashboard.dashboard.byWorkspace.length > 0);
    assert.ok(Array.isArray(dashboard.dashboard.workspaceThresholds));
    assert.ok(dashboard.dashboard.byLanguage.some((bucket) => bucket.key === 'ch'));
    assert.ok(dashboard.dashboard.byLanguage.some((bucket) => bucket.key === 'en'));
    assert.equal(dashboard.dashboard.feedback.total, 0);
    assert.equal(dashboard.dashboard.drift.baselineSamples, 20);
  });
});

describe('OCR optimization ledger API', () => {
  const store = testStore();
  const { app } = testApp(store);

  after(() => store.close());

  test('validates entries and ranks them by gain per cost', async () => {
    const cookie = await login(app);
    const viewerCookie = await login(app, DEMO.viewer.email);

    const forbidden = await app.request('/api/ocr/optimizations', {
      headers: authHeaders(viewerCookie),
    });
    assert.equal(forbidden.status, 403);

    const empty = await getJson<{ entries: OcrOptimizationEntry[] }>(
      app,
      cookie,
      '/api/ocr/optimizations',
    );
    assert.deepEqual(empty.entries, []);

    const missingGain = await sendJson(app, cookie, 'POST', '/api/ocr/optimizations', {
      title: '区域重识别',
      targetError: '金额混淆',
    });
    assert.equal(missingGain.status, 400);

    const badGain = await sendJson(app, cookie, 'POST', '/api/ocr/optimizations', {
      title: '区域重识别',
      targetError: '金额混淆',
      expectedGain: 2,
    });
    assert.equal(badGain.status, 400);

    const first = await sendJson<{ entry: OcrOptimizationEntry }>(
      app,
      cookie,
      'POST',
      '/api/ocr/optimizations',
      {
        title: '扩大区域重识别',
        targetError: '金额混淆',
        expectedGain: 0.3,
        implementationCost: 0.2,
        inferenceCost: 0.1,
        risk: 'low',
        benchmarkResult: 'CER 4.1% → 3.6%',
      },
    );
    assert.equal(first.status, 201);
    assert.equal(first.body.entry.score, 1);
    assert.equal(first.body.entry.status, 'proposed');
    assert.equal(first.body.entry.createdBy?.name, DEMO.admin.name);

    const second = await sendJson<{ entry: OcrOptimizationEntry }>(
      app,
      cookie,
      'POST',
      '/api/ocr/optimizations',
      {
        title: '数字混淆映射',
        targetError: '数字混淆',
        expectedGain: 0.2,
        implementationCost: 0,
        inferenceCost: 0,
      },
    );
    assert.equal(second.status, 201);
    assert.equal(second.body.entry.score, 2);

    const listed = await getJson<{ entries: OcrOptimizationEntry[] }>(
      app,
      cookie,
      '/api/ocr/optimizations',
    );
    assert.deepEqual(
      listed.entries.map((entry) => entry.id),
      [second.body.entry.id, first.body.entry.id],
    );

    const patched = await sendJson<{ entry: OcrOptimizationEntry }>(
      app,
      cookie,
      'PATCH',
      `/api/ocr/optimizations/${second.body.entry.id}`,
      {
        status: 'measured',
        productionResult: '线上字段错误率 2.1% → 1.6%',
      },
    );
    assert.equal(patched.status, 200);
    assert.equal(patched.body.entry.status, 'measured');
    assert.equal(patched.body.entry.productionResult, '线上字段错误率 2.1% → 1.6%');

    const missing = await sendJson(app, cookie, 'PATCH', '/api/ocr/optimizations/nope', {
      status: 'implemented',
    });
    assert.equal(missing.status, 404);
  });
});

describe('OCR version chain and complaint API', () => {
  const store = testStore();
  const { app } = testApp(store);
  const admin = adminUser(store);
  const viewer = viewerUser(store);

  after(() => store.close());

  test('traces original, stages, selections and revisions and accepts complaints', async () => {
    const cookie = await login(app);
    const viewerCookie = await login(app, DEMO.viewer.email);
    const projectId = await createProject(app, cookie, [viewer.id], 'OCR 版本项目');
    const attachmentId = seedDone(store, projectId, admin.id, {
      confidence: 0.58,
      stages: [stage()],
      document: document({
        evidence: evidence({
          selected: 'candidate',
          candidates: [
            candidate('1380.00', 'alt-a', false, 0.98),
            candidate('1280.00', 'alt-b', true, 0.9),
          ],
        }),
      }),
    });
    const revision = store.ocrFieldRevisions.create({
      attachmentId,
      projectId,
      fieldId: 'p1:b1',
      fieldKind: 'amount',
      page: 1,
      blockId: 'b1',
      bbox: BBOX,
      originalText: '1280.00',
      revisedText: '1380.00',
      reason: '人工核对纸质发票',
      revisedBy: { id: admin.id, name: admin.name },
      createdAt: new Date().toISOString(),
    });

    const base = `/api/projects/${projectId}/attachments/${attachmentId}/ocr`;
    const versions = await app.request(`${base}/versions`, { headers: authHeaders(viewerCookie) });
    assert.equal(versions.status, 200);
    const { chain } = (await versions.json()) as { chain: OcrVersionChain };
    assert.deepEqual(
      chain.nodes.map((node) => node.id),
      ['original', 'stage:1:visual', 'selection:p1:b1', `revision:${revision.id}`],
    );
    assert.equal(chain.revisions.length, 1);
    const selection = chain.nodes.find((node) => node.kind === 'selection');
    assert.equal(selection?.text, '1380.00');
    const human = chain.nodes.find((node) => node.kind === 'revision');
    assert.deepEqual(human?.parents, ['selection:p1:b1']);

    const complaint = await sendJson<{ sample: OcrFeedbackSample }>(
      app,
      viewerCookie,
      'POST',
      `${base}/complaints`,
      { note: '金额一行识别错了，请复核' },
    );
    assert.equal(complaint.status, 201);
    assert.equal(complaint.body.sample.errorType, 'user_complaint');
    assert.equal(complaint.body.sample.sha256?.length, 64);
    assert.equal(complaint.body.sample.note, '金额一行识别错了，请复核');
    const ocr = store.attachments.findOcr(attachmentId);
    assert.equal(ocr?.text, '合计金额：¥1,280.00');

    const repeated = await sendJson<{ sample: OcrFeedbackSample }>(
      app,
      viewerCookie,
      'POST',
      `${base}/complaints`,
      { note: '同类问题再次反馈' },
    );
    assert.equal(repeated.status, 201);
    assert.equal(repeated.body.sample.id, complaint.body.sample.id);

    const tooShort = await sendJson(app, viewerCookie, 'POST', `${base}/complaints`, {
      note: '错',
    });
    assert.equal(tooShort.status, 400);

    const missing = await app.request(`/api/projects/${projectId}/attachments/nope/ocr/versions`, {
      headers: authHeaders(cookie),
    });
    assert.equal(missing.status, 404);
  });
});
