import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type {
  DocumentBlock,
  DocumentBlockType,
  DocumentIr,
  DocumentPage,
} from '../shared/types.ts';
import type { OcrExtraction } from '../src/ocr.ts';
import { assessQuality, textLayerCrosscheckOf } from '../src/ocr-quality.ts';

function makeBlock(
  id: string,
  overrides: Partial<DocumentBlock> & { type?: DocumentBlockType } = {},
): DocumentBlock {
  return {
    id,
    type: 'paragraph',
    text: `文本 ${id}`,
    bbox: null,
    confidence: 0.95,
    source: { engine: 'paddle', model: 'PP-OCRv6-medium', stage: 'native' },
    validation: null,
    order: 0,
    ...overrides,
  };
}

function makeDocument(
  blocks: DocumentBlock[],
  options: { pages?: number; route?: DocumentIr['route']; readingOrder?: string[] } = {},
): DocumentIr {
  const pages: DocumentPage[] = Array.from({ length: options.pages ?? 1 }, (_, index) => ({
    number: index + 1,
    width: null,
    height: null,
    blocks: index === 0 ? blocks : [],
    source: null,
  }));
  return {
    version: 1,
    route: options.route ?? 'native',
    pages,
    readingOrder: options.readingOrder ?? blocks.map((block) => block.id),
    meta: {},
  };
}

function makeExtraction(overrides: Partial<OcrExtraction> = {}): OcrExtraction {
  return {
    text: '正常文本',
    engine: 'test-engine',
    model: null,
    confidence: null,
    pages: 1,
    truncated: false,
    route: 'native',
    document: makeDocument([makeBlock('b1', { text: '正常文本' })]),
    ...overrides,
  };
}

function codes(result: ReturnType<typeof assessQuality>): string[] {
  return result.issues.map((issue) => issue.code);
}

describe('OCR quality assessment', () => {
  test('passes a complete, high-confidence document', () => {
    const result = assessQuality(makeExtraction({ confidence: 0.95 }));
    assert.equal(result.status, 'pass');
    assert.equal(result.calibrated, false);
    assert.ok(result.score >= 0.9);
    assert.deepEqual(result.issues, []);
    assert.equal(result.signals.coverage, 1);
  });

  test('applies the fitted confidence map before scoring', () => {
    const extraction = makeExtraction({ confidence: 0.95 });
    const raw = assessQuality(extraction, { reviewThreshold: 0.7 });
    const calibrated = assessQuality(extraction, {
      reviewThreshold: 0.7,
      confidenceMap: [
        { raw: 0.6, calibrated: 0.3 },
        { raw: 1, calibrated: 0.8 },
      ],
    });
    assert.ok(calibrated.score < raw.score);
    assert.equal(calibrated.calibrated, true);
    assert.equal(calibrated.signals.rawConfidence, 0.95);
    assert.ok((calibrated.signals.confidence ?? 1) <= 0.8);
    assert.ok((calibrated.components.ocrConfidence ?? 1) <= 0.8);
  });

  test('fails empty text and reports it', () => {
    const result = assessQuality(makeExtraction({ text: '', confidence: null, document: null }));
    assert.equal(result.status, 'fail');
    assert.equal(result.score, 0);
    assert.ok(codes(result).includes('empty_text'));
  });

  test('downgrades truncated results to review', () => {
    const result = assessQuality(makeExtraction({ confidence: 0.99, truncated: true }));
    assert.equal(result.status, 'review');
    assert.ok(codes(result).includes('truncated'));
  });

  test('flags low-confidence blocks', () => {
    const document = makeDocument([makeBlock('b1', { confidence: 0.4 })]);
    const result = assessQuality(makeExtraction({ document, confidence: null }));
    assert.equal(result.status, 'review');
    assert.ok(codes(result).includes('low_confidence'));
    assert.equal(result.signals.confidence, 0.4);
  });

  test('folds per-cell confidence into the low-confidence ratio', () => {
    const table = makeBlock('t1', {
      type: 'table',
      text: 'A B\n1 2',
      confidence: 0.95,
      rows: [
        ['A', 'B'],
        ['1', '2'],
      ],
      cells: [
        { row: 0, column: 0, text: 'A', confidence: 0.95 },
        { row: 0, column: 1, text: 'B', confidence: 0.4 },
        { row: 1, column: 0, text: '1', confidence: 0.42 },
        { row: 1, column: 1, text: '2', confidence: 0.45 },
      ],
    });
    const result = assessQuality(
      makeExtraction({ document: makeDocument([table]), confidence: null }),
    );
    assert.ok(codes(result).includes('low_confidence'), codes(result).join(','));
    assert.equal(result.signals.lowConfidence, 0.4);
  });

  test('checks table arithmetic and flags mismatched totals', () => {
    const table = makeBlock('t1', {
      type: 'table',
      text: '产品 数量 单价 合计',
      confidence: 0.5,
      rows: [
        ['产品', '数量', '单价', '合计'],
        ['A', '2', '3', '6'],
        ['B', '1', '2', '3'],
      ],
    });
    const result = assessQuality(
      makeExtraction({
        text: '产品 数量 单价 合计',
        confidence: 0.5,
        document: makeDocument([table]),
      }),
    );
    assert.ok(codes(result).includes('field_mismatch'));
    assert.equal(result.signals.fieldAccuracy, 0.5);
    assert.equal(result.status, 'review');
  });

  test('does not treat identifier or quantity-price tables as additive sums', () => {
    const highlighted = makeBlock('t1', {
      type: 'table',
      text: '序号 数量 单价 合计',
      confidence: 0.9,
      rows: [
        ['序号', '数量', '单价', '合计'],
        ['1', '2', '3', '6'],
        ['2', '4', '5', '20'],
      ],
    });
    const result = assessQuality(
      makeExtraction({
        text: '序号 数量 单价 合计',
        confidence: 0.9,
        document: makeDocument([highlighted]),
      }),
    );
    assert.ok(!codes(result).includes('field_mismatch'));
    assert.equal(result.signals.fieldAccuracy, 1);

    const additive = makeBlock('t2', {
      type: 'table',
      text: '编号 金额A 金额B 合计',
      confidence: 0.9,
      rows: [
        ['编号', '金额A', '金额B', '合计'],
        ['100', '10', '20', '30'],
        ['200', '5', '6', '11'],
      ],
    });
    const additiveResult = assessQuality(
      makeExtraction({
        text: '编号 金额A 金额B 合计',
        confidence: 0.9,
        document: makeDocument([additive]),
      }),
    );
    assert.ok(!codes(additiveResult).includes('field_mismatch'));
    assert.equal(additiveResult.signals.fieldAccuracy, 1);

    const summary = makeBlock('t3', {
      type: 'table',
      text: 'Summary A B',
      rows: [
        ['Summary', 'A', 'B'],
        ['10', '1', '2'],
      ],
    });
    const summaryResult = assessQuality(
      makeExtraction({ text: 'Summary A B', document: makeDocument([summary]) }),
    );
    assert.equal(summaryResult.signals.fieldAccuracy, null);
    assert.ok(!codes(summaryResult).includes('field_mismatch'));
  });

  test('accepts formatted amounts, dates and percentages in typed columns', () => {
    const table = makeBlock('t1', {
      type: 'table',
      text: '项目 金额 日期 比例',
      confidence: 0.95,
      rows: [
        ['项目', '金额', '日期', '比例'],
        ['A', '¥1,280.00', '2024-01-02', '13%'],
        ['B', '1.280,00', '2024年1月3日', '0.5'],
      ],
    });
    const result = assessQuality(
      makeExtraction({
        text: '项目 金额 日期 比例',
        confidence: 0.95,
        document: makeDocument([table]),
      }),
    );
    assert.ok(!codes(result).includes('cell_type_mismatch'));
    assert.equal(result.signals.columnTypes, 1);
  });

  test('flags OCR-corrupted numeric cells and forces review', () => {
    const table = makeBlock('t1', {
      type: 'table',
      text: '项目 金额',
      confidence: 0.9,
      rows: [
        ['项目', '金额'],
        ['A', '1O0'],
        ['B', '2O0'],
        ['C', '3,000'],
      ],
    });
    const result = assessQuality(
      makeExtraction({
        text: '项目 金额',
        confidence: 0.9,
        document: makeDocument([table]),
      }),
    );
    assert.ok(codes(result).includes('cell_type_mismatch'));
    assert.ok(result.hardRisks.some((risk) => risk.code === 'field_validation_failed'));
    assert.equal(result.signals.columnTypes, 1 / 3);
    const issue = result.issues.find((item) => item.code === 'cell_type_mismatch');
    assert.equal(issue?.blockId, 't1');
    assert.equal(issue?.page, 1);
    assert.equal(result.status, 'review');
  });

  test('flags dates that do not match the date column', () => {
    const table = makeBlock('t1', {
      type: 'table',
      text: '日期 备注',
      confidence: 0.95,
      rows: [
        ['日期', '备注'],
        ['2024-1O-02', 'A'],
        ['2024-01-03', 'B'],
      ],
    });
    const result = assessQuality(
      makeExtraction({
        text: '日期 备注',
        confidence: 0.95,
        document: makeDocument([table]),
      }),
    );
    assert.ok(codes(result).includes('cell_type_mismatch'));
    assert.ok(!result.hardRisks.some((risk) => risk.code === 'field_validation_failed'));
    assert.equal(result.signals.columnTypes, 0.5);
  });

  test('ignores placeholder-only typed columns', () => {
    const table = makeBlock('t1', {
      type: 'table',
      text: '项目 金额',
      rows: [
        ['项目', '金额'],
        ['A', '待定'],
        ['B', '-'],
        ['C', '1,280'],
      ],
    });
    const result = assessQuality(
      makeExtraction({ text: '项目 金额', document: makeDocument([table]) }),
    );
    assert.ok(!codes(result).includes('cell_type_mismatch'));
    assert.equal(result.signals.columnTypes, null);
  });

  test('reports ragged tables', () => {
    const table = makeBlock('t1', {
      type: 'table',
      text: 'a b c d',
      rows: [
        ['a', 'b', 'c', 'd'],
        ['1', '2'],
      ],
    });
    const result = assessQuality(
      makeExtraction({ text: 'a b c d', document: makeDocument([table]) }),
    );
    assert.ok(codes(result).includes('table_integrity'));
    assert.ok((result.signals.tableIntegrity ?? 1) < 0.85);
  });

  test('flags unbalanced debit-credit tables as a hard risk', () => {
    const unbalanced = makeBlock('t1', {
      type: 'table',
      text: '摘要 借方 贷方',
      confidence: 0.95,
      rows: [
        ['摘要', '借方', '贷方'],
        ['收入', '100.00', '90.00'],
      ],
    });
    const result = assessQuality(
      makeExtraction({
        text: '摘要 借方 贷方',
        confidence: 0.95,
        document: makeDocument([unbalanced]),
      }),
    );
    assert.equal(result.signals.businessConstraints, 0);
    assert.ok(codes(result).includes('business_constraint'));
    assert.ok(result.hardRisks.some((risk) => risk.code === 'field_validation_failed'));
    assert.equal(result.status, 'review');

    const balanced = makeBlock('t1', {
      type: 'table',
      text: '摘要 借方 贷方',
      confidence: 0.95,
      rows: [
        ['摘要', '借方', '贷方'],
        ['收入', '100.00', '100.00'],
      ],
    });
    const passed = assessQuality(
      makeExtraction({
        text: '摘要 借方 贷方',
        confidence: 0.95,
        document: makeDocument([balanced]),
      }),
    );
    assert.equal(passed.signals.businessConstraints, 1);
    assert.ok(!codes(passed).includes('business_constraint'));
    assert.equal(passed.status, 'pass');
  });

  test('forces review when a re-read table cell conflicts with the original', () => {
    const table = makeBlock('t1', {
      type: 'table',
      text: '项目 金额',
      confidence: 0.95,
      rows: [
        ['项目', '金额'],
        ['A', '1O0'],
      ],
    });
    const document = makeDocument([table]);
    document.meta.fieldEvidence = [
      {
        kind: 'amount',
        page: 1,
        blockId: 't1',
        bbox: { x: 10, y: 20, width: 50, height: 20 },
        text: '1O0',
        confidence: null,
        source: { engine: 'paddle', model: 'model-a', stage: 'visual' },
        candidates: [
          {
            text: '100',
            confidence: 0.95,
            model: 'model-a',
            source: 'region',
            bbox: { x: 10, y: 20, width: 50, height: 20 },
            pass: 1,
            agreesWithInitial: false,
          },
        ],
        selected: 'candidate',
        agreement: 'conflict',
        passes: 1,
        failed: [],
        cell: { row: 1, column: 1, header: '金额', bboxEstimated: false },
        reason: 'candidate_selected',
      },
    ];
    const result = assessQuality(
      makeExtraction({
        text: '项目 金额',
        confidence: 0.95,
        document,
      }),
    );
    assert.equal(result.signals.cellRecovery, 0);
    assert.ok(codes(result).includes('cell_recovery_conflict'));
    assert.ok(result.hardRisks.some((risk) => risk.code === 'field_validation_failed'));
    assert.equal(result.status, 'review');
  });

  test('flags key regions whose value did not survive OCR', () => {
    const labelOnly = assessQuality(
      makeExtraction({
        confidence: 0.95,
        text: '报告\n合计',
        document: makeDocument([
          makeBlock('b1', { text: '报告' }),
          makeBlock('b2', { text: '合计' }),
        ]),
      }),
    );
    assert.equal(labelOnly.signals.keyRegionCoverage, 0);
    assert.ok(codes(labelOnly).includes('key_region_missing'));
    assert.ok(labelOnly.hardRisks.some((risk) => risk.code === 'key_region_missing'));
    assert.equal(labelOnly.status, 'review');

    const withValue = assessQuality(
      makeExtraction({
        confidence: 0.95,
        text: '报告\n合计 1,280 元',
        document: makeDocument([
          makeBlock('b1', { text: '报告' }),
          makeBlock('b2', { text: '合计 1,280 元' }),
        ]),
      }),
    );
    assert.equal(withValue.signals.keyRegionCoverage, 1);
    assert.ok(!codes(withValue).includes('key_region_missing'));
    assert.equal(withValue.status, 'pass');
  });

  function inkGap(kind: 'region' | 'cell', id: string) {
    return {
      id,
      kind,
      blockId: kind === 'cell' ? 'b1' : null,
      bbox: { x: 0, y: 200, width: 200, height: 24 },
      pixels: 400,
      density: 0.2,
    };
  }

  function gapDocument(gaps: ReturnType<typeof inkGap>[]): DocumentIr {
    const document = makeDocument([makeBlock('b1', { confidence: 0.95 })]);
    document.pages[0] = { ...document.pages[0], meta: { inkGaps: gaps } };
    return document;
  }

  test('reports ink no recognition box covers, independently of confidence', () => {
    const clean = assessQuality(makeExtraction({ confidence: 0.95, document: gapDocument([]) }));
    assert.equal(clean.signals.inkCoverage, 1, 'checked page with nothing left over');
    assert.ok(!codes(clean).includes('ink_without_text'));

    const notAnalyzed = assessQuality(makeExtraction({ confidence: 0.95 }));
    assert.equal(notAnalyzed.signals.inkCoverage, null, 'no analysis is not a clean page');

    const single = assessQuality(
      makeExtraction({ confidence: 0.95, document: gapDocument([inkGap('region', 'p1-g0')]) }),
    );
    const issue = single.issues.find((item) => item.code === 'ink_without_text');
    assert.equal(issue?.message, '1 处墨迹没有任何识别框覆盖');
    assert.equal(issue?.page, 1);
    assert.equal(issue?.blockId, null);
    assert.equal(single.signals.inkCoverage, 0.75);
    assert.equal(
      single.hardRisks.some((risk) => risk.code === 'ink_without_text'),
      false,
    );

    const cell = assessQuality(
      makeExtraction({ confidence: 0.95, document: gapDocument([inkGap('cell', 'p1-g0')]) }),
    );
    assert.equal(
      cell.issues.find((item) => item.code === 'ink_without_text')?.message,
      '1 处墨迹没有任何识别框覆盖（其中 1 处在表格空白单元格内）',
    );
    assert.equal(cell.issues.find((item) => item.code === 'ink_without_text')?.blockId, 'b1');
    assert.equal(
      cell.hardRisks.some((risk) => risk.code === 'ink_without_text'),
      true,
    );

    const many = assessQuality(
      makeExtraction({
        confidence: 0.95,
        document: gapDocument([
          inkGap('region', 'p1-g0'),
          inkGap('region', 'p1-g1'),
          inkGap('region', 'p1-g2'),
          inkGap('region', 'p1-g3'),
        ]),
      }),
    );
    assert.equal(many.signals.inkCoverage, 0);
    assert.equal(
      many.hardRisks.some((risk) => risk.code === 'ink_without_text'),
      true,
    );
  });

  test('counts gaps that could not be parsed against coverage', () => {
    // A dropped entry is "we could not read this", not "there was nothing": losing
    // it silently would turn a skipped region into a clean page.
    const document = gapDocument([]);
    document.pages[0] = { ...document.pages[0], meta: { inkGaps: [], inkGapsDropped: 2 } };
    const result = assessQuality(makeExtraction({ confidence: 0.95, document }));
    assert.equal(result.signals.inkCoverage, 0.5);
    const issue = result.issues.find((item) => item.code === 'ink_without_text');
    assert.equal(
      issue?.message,
      '2 处墨迹没有任何识别框覆盖（另有 2 处墨迹无法解析或超出上报上限，未能核对）',
    );
    assert.equal(issue?.blockId, null);
    assert.equal(
      result.hardRisks.some((risk) => risk.code === 'ink_without_text'),
      true,
      '无法核对的墨迹不能当作没有问题',
    );
    assert.equal(
      result.hardRisks.find((risk) => risk.code === 'ink_without_text')?.message,
      '存在无法解析的墨迹区域，无法确认是否漏识别',
    );
  });

  test('reports missing reading order entries', () => {
    const document = makeDocument([makeBlock('b1'), makeBlock('b2')], {
      readingOrder: ['b1'],
    });
    const result = assessQuality(makeExtraction({ document }));
    assert.ok(codes(result).includes('reading_order'));
    assert.equal(result.signals.readingOrder, 0.5);
  });

  test('reports duplicate blocks and empty pages', () => {
    const repeated = '这是重复出现的长文本内容';
    const blocks = ['b1', 'b2', 'b3', 'b4'].map((id) => makeBlock(id, { text: repeated }));
    const duplicates = assessQuality(
      makeExtraction({ text: repeated, document: makeDocument(blocks) }),
    );
    assert.ok(codes(duplicates).includes('duplicate_content'));
    assert.equal(duplicates.signals.duplicates, 0.25);

    const emptyPage = assessQuality(
      makeExtraction({ document: makeDocument([makeBlock('b1')], { pages: 2 }) }),
    );
    assert.ok(codes(emptyPage).includes('low_coverage'));
    assert.ok(codes(emptyPage).includes('empty_page'));
    const issue = emptyPage.issues.find((item) => item.code === 'empty_page');
    assert.equal(issue?.page, 2);
  });

  test('keeps legacy results usable without a DIR', () => {
    const withConfidence = assessQuality(makeExtraction({ document: null, confidence: 0.9 }));
    assert.equal(withConfidence.status, 'pass');
    assert.equal(withConfidence.score, 0.9);

    const withoutConfidence = assessQuality(makeExtraction({ document: null, confidence: null }));
    assert.equal(withoutConfidence.status, 'review');
    assert.equal(withoutConfidence.score, 0.5);
    assert.ok(codes(withoutConfidence).includes('confidence_unknown'));

    const weak = assessQuality(makeExtraction({ document: null, confidence: 0.4 }));
    assert.equal(weak.status, 'fail');
  });

  test('flags a mismatched uppercase amount as a hard risk', () => {
    const text = '合计金额：¥12,800.00\n大写：壹万贰仟元整';
    const block = makeBlock('b1', { text, confidence: 0.98 });
    const result = assessQuality(
      makeExtraction({ text, confidence: 0.98, document: makeDocument([block]) }),
    );
    assert.ok(codes(result).includes('amount_words_mismatch'));
    assert.ok(result.hardRisks.some((risk) => risk.code === 'field_validation_failed'));
    assert.equal(result.status, 'review');

    const matching = '合计金额：¥12,800.00\n大写：壹万贰仟捌佰元整';
    const okBlock = makeBlock('b1', { text: matching, confidence: 0.98 });
    const ok = assessQuality(
      makeExtraction({ text: matching, confidence: 0.98, document: makeDocument([okBlock]) }),
    );
    assert.ok(!codes(ok).includes('amount_words_mismatch'));
    assert.ok(!ok.hardRisks.some((risk) => risk.code === 'field_validation_failed'));
  });

  test('flags a labeled identifier with a bad checksum', () => {
    const text = '统一社会信用代码：91350100M000100Y44';
    const block = makeBlock('b1', { text, confidence: 0.98 });
    const result = assessQuality(
      makeExtraction({ text, confidence: 0.98, document: makeDocument([block]) }),
    );
    assert.ok(codes(result).includes('identifier_checksum'));
    assert.ok(result.hardRisks.some((risk) => risk.code === 'field_validation_failed'));
    assert.equal(result.status, 'review');

    const validText = '统一社会信用代码：91350100M000100Y43';
    const validBlock = makeBlock('b1', { text: validText, confidence: 0.98 });
    const valid = assessQuality(
      makeExtraction({
        text: validText,
        confidence: 0.98,
        document: makeDocument([validBlock]),
      }),
    );
    assert.ok(!codes(valid).includes('identifier_checksum'));
  });

  test('flags numeric tokens that differ even when page similarity passes', () => {
    const document = makeDocument([makeBlock('b1', { text: '营业收入 18.5%' })]);
    document.meta.textLayer = {
      crosscheck: {
        sampled: 1,
        planned: 1,
        matched: 1,
        mismatched: 0,
        numericMismatched: 1,
        threshold: 0.85,
        minSimilarity: 0.99,
        budgetExceeded: false,
        pages: [{ page: 1, similarity: 0.99, matched: true, numericMismatch: true }],
      },
    };
    const result = assessQuality(
      makeExtraction({ text: '营业收入 18.5%', document, confidence: 0.98 }),
    );
    assert.ok(codes(result).includes('text_layer_mismatch'));
    assert.ok(result.hardRisks.some((risk) => risk.code === 'text_layer_mismatch'));
    assert.equal(result.status, 'review');
  });

  test('downgrades blocks that failed structure validation', () => {
    const block = makeBlock('b1', {
      validation: { status: 'flagged', issues: ['bbox outside page'] },
    });
    const result = assessQuality(
      makeExtraction({ document: makeDocument([block]), confidence: 0.95 }),
    );
    assert.equal(result.status, 'review');
    assert.equal(result.signals.validation, 0);
    const issue = result.issues.find((item) => item.code === 'block_validation');
    assert.equal(issue?.blockId, 'b1');
    assert.equal(issue?.page, 1);
  });

  test('flags blurry, dark and low-resolution images as hard risks', () => {
    const result = assessQuality(
      makeExtraction({
        confidence: 0.99,
        preflight: {
          width: 400,
          height: 400,
          sharpness: 0.05,
          brightness: 0.1,
          contrast: 0.03,
          dpi: 200,
        },
      }),
    );
    assert.equal(result.status, 'review');
    assert.ok(codes(result).includes('image_blurry'));
    assert.ok(codes(result).includes('image_exposure'));
    assert.ok(codes(result).includes('image_low_resolution'));
    assert.ok(result.hardRisks.some((risk) => risk.code === 'image_quality'));
    assert.ok((result.signals.imageQuality ?? 1) < 0.5);
  });

  test('flags glare, shadow, noise and skew with targeted issue codes', () => {
    const result = assessQuality(
      makeExtraction({
        confidence: 0.99,
        preflight: {
          width: 1600,
          height: 2200,
          sharpness: 0.6,
          brightness: 0.55,
          contrast: 0.4,
          dpi: 300,
          glare: 0.05,
          shadow: 0.5,
          noise: 0.14,
          skew: -6.5,
        },
      }),
    );
    assert.ok(codes(result).includes('image_glare'));
    assert.ok(codes(result).includes('image_shadow'));
    assert.ok(codes(result).includes('image_noise'));
    assert.ok(codes(result).includes('image_skew'));
    assert.ok(result.hardRisks.some((risk) => risk.code === 'image_quality'));
    assert.equal(result.status, 'review');
  });

  test('flags EXIF-rotated pages and advises a retake for severe glare', () => {
    const result = assessQuality(
      makeExtraction({
        confidence: 0.99,
        preflight: {
          width: 1600,
          height: 2200,
          sharpness: 0.6,
          brightness: 0.55,
          contrast: 0.4,
          dpi: 300,
          glare: 0.12,
          orientation: { exif: 6, applied: 90, aspect: 0.73, uncertain: false },
          retake: { required: true, reasons: ['glare', 'resolution'] },
        },
      }),
    );
    assert.ok(codes(result).includes('image_orientation'));
    assert.ok(codes(result).includes('image_retake'));
    const retake = result.hardRisks.find((risk) => risk.code === 'image_retake');
    assert.equal(retake?.severity, 'error');
    assert.match(retake?.message ?? '', /镜面反光/);
    assert.equal(result.status, 'review');
  });

  test('keeps clean preflight metrics free of image issues', () => {
    const result = assessQuality(
      makeExtraction({
        confidence: 0.99,
        preflight: {
          width: 1600,
          height: 2200,
          sharpness: 0.6,
          brightness: 0.55,
          contrast: 0.4,
          dpi: 300,
          glare: 0,
          shadow: 0.1,
          noise: 0.02,
          skew: 0.2,
          orientation: { exif: 1, applied: 0, aspect: 0.73, uncertain: false },
          retake: { required: false, reasons: [] },
        },
      }),
    );
    for (const code of [
      'image_glare',
      'image_shadow',
      'image_noise',
      'image_skew',
      'image_orientation',
    ]) {
      assert.ok(!codes(result).includes(code), code);
    }
    assert.equal(result.status, 'pass');
  });

  test('flags very small text as a hard risk', () => {
    const document = makeDocument([makeBlock('b1')]);
    document.meta.textHeight = 6;
    const result = assessQuality(makeExtraction({ document, confidence: 0.95 }));
    assert.ok(codes(result).includes('small_text'));
    assert.ok(result.hardRisks.some((risk) => risk.code === 'small_text'));
    assert.equal(result.status, 'review');
  });

  test('treats low-confidence key fields as non-compensating risks', () => {
    const amount = makeBlock('b2', {
      text: '合计 1,280 元',
      confidence: 0.4,
      bbox: { x: 10, y: 40, width: 200, height: 30 },
    });
    const document = makeDocument([
      makeBlock('b1', { text: '季度报告', confidence: 0.98 }),
      amount,
    ]);

    const result = assessQuality(makeExtraction({ document, confidence: 0.9 }));
    assert.ok(codes(result).includes('key_field_low_confidence'));
    assert.ok(result.hardRisks.some((risk) => risk.code === 'key_field_low_confidence'));
    assert.equal(result.signals.keyFieldCoverage, 0);
    assert.equal(result.status, 'review');

    // An independent recognizer that agrees corroborates the value without
    // rewriting it, so the low confidence no longer forces review.
    amount.meta = { regionAgreement: 'confirmed_independent' };
    const confirmed = assessQuality(makeExtraction({ document, confidence: 0.9 }));
    assert.ok(!codes(confirmed).includes('key_field_low_confidence'));
    assert.ok(!confirmed.hardRisks.some((risk) => risk.code === 'key_field_low_confidence'));
    assert.equal(confirmed.signals.keyFieldCoverage, 1);
    assert.equal(confirmed.status, 'pass');

    // The same model re-reading the same crop only repeats its own errors, so
    // agreement there must not clear the risk.
    amount.meta = { regionAgreement: 'confirmed_same_engine' };
    const sameEngine = assessQuality(makeExtraction({ document, confidence: 0.9 }));
    assert.ok(sameEngine.hardRisks.some((risk) => risk.code === 'key_field_low_confidence'));
    assert.equal(sameEngine.signals.keyFieldCoverage, 0);
    assert.equal(sameEngine.status, 'review');
    assert.ok(codes(sameEngine).includes('key_field_same_engine_confirmation'));
  });

  test('honors explicit thresholds', () => {
    const extraction = makeExtraction({ document: null, confidence: 0.8 });
    assert.equal(assessQuality(extraction).status, 'pass');
    assert.equal(assessQuality(extraction, { reviewThreshold: 0.9 }).status, 'review');
    assert.equal(
      assessQuality(extraction, { reviewThreshold: 0.9, failThreshold: 0.85 }).status,
      'fail',
    );
  });

  test('keeps a review band when thresholds are inverted', () => {
    const extraction = makeExtraction({ document: null, confidence: 0.895 });
    assert.equal(
      assessQuality(extraction, { reviewThreshold: 0.9, failThreshold: 0.95 }).status,
      'review',
    );
  });

  test('parses text-layer crosscheck metadata defensively', () => {
    const document = makeDocument([makeBlock('b1', { text: '季度报告' })]);
    assert.equal(textLayerCrosscheckOf(document), null);

    document.meta.textLayer = {
      crosscheck: {
        sampled: 2,
        planned: 2,
        matched: 1,
        mismatched: 1,
        threshold: 0.85,
        minSimilarity: 0.42,
        budgetExceeded: false,
        pages: [
          { page: 1, similarity: 1, matched: true },
          { page: 3, similarity: 0.42, matched: false },
          { page: 'broken', similarity: 'x', matched: false },
        ],
      },
    };
    const crosscheck = textLayerCrosscheckOf(document);
    assert.ok(crosscheck);
    assert.equal(crosscheck.sampled, 2);
    assert.equal(crosscheck.mismatched, 1);
    assert.equal(crosscheck.minSimilarity, 0.42);
    assert.deepEqual(crosscheck.pages, [
      { page: 1, similarity: 1, matched: true, numericMismatch: false },
      { page: 3, similarity: 0.42, matched: false, numericMismatch: false },
    ]);
  });

  test('flags a mismatched sampled text layer for review', () => {
    const document = makeDocument([makeBlock('b1', { text: '季度报告' })]);
    document.meta.textLayer = {
      pages: 4,
      trusted: 4,
      threshold: 0.6,
      crosscheck: {
        sampled: 2,
        planned: 2,
        matched: 1,
        mismatched: 1,
        threshold: 0.85,
        minSimilarity: 0.42,
        budgetExceeded: false,
        pages: [
          { page: 1, similarity: 1, matched: true },
          { page: 3, similarity: 0.42, matched: false },
        ],
      },
    };
    const result = assessQuality(makeExtraction({ document, confidence: 0.95 }));
    assert.ok(codes(result).includes('text_layer_mismatch'));
    assert.ok(result.hardRisks.some((risk) => risk.code === 'text_layer_mismatch'));
    const issue = result.issues.find((item) => item.code === 'text_layer_mismatch');
    assert.equal(issue?.page, 3);
    assert.match(issue?.message ?? '', /其中 1 页/);
    assert.equal(result.status, 'review');
  });

  test('accepts a matched text layer and ignores budget-only samples', () => {
    const document = makeDocument([makeBlock('b1', { text: '季度报告' })]);
    document.meta.textLayer = {
      pages: 4,
      trusted: 4,
      threshold: 0.6,
      crosscheck: {
        sampled: 1,
        planned: 2,
        matched: 1,
        mismatched: 0,
        threshold: 0.85,
        minSimilarity: 0.97,
        budgetExceeded: true,
        pages: [{ page: 2, similarity: 0.97, matched: true }],
      },
    };
    const result = assessQuality(makeExtraction({ document, confidence: 0.95 }));
    assert.ok(!codes(result).includes('text_layer_mismatch'));
    assert.equal(result.status, 'pass');
  });

  test('confirms a low-confidence key field from independently decoded QR data', () => {
    const block = makeBlock('b1', {
      text: '订单号 INV-2024-001 金额 1,234.56 日期 2024-01-01',
      confidence: 0.3,
    });
    const document = makeDocument([block]);
    document.pages[0].meta = {
      machineReadable: [
        {
          format: 'qr',
          text: 'INV-2024-001|2024-01-01|1234.56',
          page: 1,
        },
      ],
    };
    const result = assessQuality(makeExtraction({ document, confidence: 0.95 }));
    assert.ok(codes(result).includes('machine_readable_confirmed'));
    assert.equal(block.meta?.regionAgreement, 'confirmed_independent');
    assert.equal(result.signals.machineReadable, 1);
    assert.ok(!result.hardRisks.some((risk) => risk.code === 'key_field_low_confidence'));
  });

  test('flags QR tokens missing from the recognized text', () => {
    const document = makeDocument([makeBlock('b1', { text: '订单号 INV-2024-001' })]);
    document.pages[0].meta = {
      machineReadable: [{ format: 'barcode', text: 'INV-2024-001|ZZ-9999', page: 1 }],
    };
    const result = assessQuality(makeExtraction({ document, confidence: 0.95 }));
    assert.ok(codes(result).includes('machine_readable_partial'));
    assert.ok(result.hardRisks.some((risk) => risk.code === 'machine_readable_conflict'));
    assert.equal(result.signals.machineReadable, 0.5);
  });

  test('forces review when MRZ check digits fail', () => {
    const document = makeDocument([makeBlock('b1', { text: '护照资料页' })]);
    document.pages[0].meta = {
      machineReadable: [
        {
          format: 'mrz',
          text: 'P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<\nL898902C36UTO7408122F1204159ZE184226B<<<<<10',
          page: 1,
          fields: { documentNumber: 'L898902C3' },
          checks: { valid: false, failed: ['documentNumber'] },
        },
      ],
    };
    const result = assessQuality(makeExtraction({ document, confidence: 0.95 }));
    assert.ok(codes(result).includes('machine_readable_mismatch'));
    assert.ok(result.hardRisks.some((risk) => risk.code === 'machine_readable_conflict'));
    assert.equal(result.status, 'review');
  });

  test('marks MRZ fields found outside the MRZ band as same-engine agreement', () => {
    const block = makeBlock('b1', { text: '证件号 L898902C3', confidence: 0.4 });
    const document = makeDocument([block]);
    document.pages[0].meta = {
      machineReadable: [
        {
          format: 'mrz',
          text: 'P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<\nL898902C36UTO7408122F1204159ZE184226B<<<<<10',
          page: 1,
          fields: { documentNumber: 'L898902C3' },
          checks: { valid: true, failed: [] },
        },
      ],
    };
    const result = assessQuality(makeExtraction({ document, confidence: 0.95 }));
    assert.equal(block.meta?.regionAgreement, 'confirmed_same_engine');
    assert.ok(codes(result).includes('machine_readable_confirmed'));
    assert.ok(result.hardRisks.some((risk) => risk.code === 'key_field_low_confidence'));
  });

  test('flags an enhanced reading that dropped numeric tokens', () => {
    const document = makeDocument([makeBlock('b1', { text: '合计 100' })]);
    document.meta.preprocess = {
      pages: [
        {
          page: 1,
          ocrSelection: {
            selected: 'original',
            basis: 'numeric_conflict',
            conflict: true,
            agreement: 0.5,
            enhanced: { missingTokens: 2, addedTokens: 0 },
          },
        },
      ],
    };
    const result = assessQuality(makeExtraction({ document, confidence: 0.95 }));
    assert.ok(codes(result).includes('preprocess_conflict'));
    assert.ok(result.hardRisks.some((risk) => risk.code === 'preprocess_conflict'));
    assert.equal(result.signals.preprocessSelection, 0);
    assert.equal(result.status, 'review');
  });

  test('accepts a corroborated enhanced reading without a conflict', () => {
    const document = makeDocument([makeBlock('b1', { text: '合计 100' })]);
    document.meta.preprocess = {
      pages: [
        {
          page: 1,
          ocrSelection: {
            selected: 'enhanced',
            basis: 'tokens',
            conflict: false,
            agreement: 1,
            enhanced: { missingTokens: 0, addedTokens: 1 },
          },
        },
      ],
    };
    const result = assessQuality(makeExtraction({ document, confidence: 0.95 }));
    assert.ok(!codes(result).includes('preprocess_conflict'));
    assert.equal(result.signals.preprocessSelection, 1);
  });

  test('scores Office coverage and reports unread embedded objects', () => {
    const document = makeDocument([makeBlock('b1', { text: '合同正文' })]);
    document.meta.office = {
      objects: 4,
      unrendered: 2,
      deletedText: 8,
      insertedText: 12,
      hiddenSlides: 1,
      comments: 1,
    };
    const result = assessQuality(makeExtraction({ document, confidence: 0.95 }));
    assert.equal(result.signals.officeCoverage, 0.5);
    assert.ok(codes(result).includes('embedded_object_unread'));
    assert.ok(codes(result).includes('tracked_changes_excluded'));
    assert.ok(codes(result).includes('hidden_content'));
  });
});
