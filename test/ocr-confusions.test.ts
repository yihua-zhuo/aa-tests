import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  confusionClasses,
  confusionMatrix,
  diagnoseErrors,
  diagnoseQuality,
  mergeConfusions,
  normalizeConfusionText,
} from '../src/ocr-confusions.ts';

describe('confusion matrix', () => {
  test('classifies digit/letter and full-width substitutions', () => {
    const report = confusionMatrix('0O1I5S8B2Z，。', 'OO1l5S8B2Z,.');
    assert.equal(report.substitutions, 4);
    const pairs = new Map(report.matrix.map((item) => [item.pair, item]));
    assert.equal(pairs.get('0→o')?.kind, 'digit');
    assert.equal(pairs.get('i→l')?.kind, 'letter');
    assert.equal(report.widthErrors, 2);
  });

  test('keeps full-width characters so width errors remain visible', () => {
    assert.equal(normalizeConfusionText('ＡＢ１２，'), 'ａｂ１２，');
    const report = confusionMatrix('ＡＢ１２，', 'AB12,');
    assert.equal(report.widthErrors, 5);
  });

  test('separates numeric digit edits from text substitutions', () => {
    const report = confusionMatrix('金额 1,234.50', '金额 7,234.5O');
    assert.equal(report.numeric.expectedDigits, 6);
    assert.equal(report.numeric.substituted, 1);
    assert.equal(report.numeric.deleted, 1);
    assert.ok(report.matrix.some((item) => item.pair === '0→o'));
  });

  test('merges per-file matrices and keeps the largest pairs', () => {
    const first = confusionMatrix('00', '0O');
    const second = confusionMatrix('00', '0O');
    const merged = mergeConfusions([first, second, null]);
    const pair = merged.matrix.find((item) => item.pair === '0→o');
    assert.equal(pair?.count, 2);
    assert.equal(merged.numeric.expectedDigits, 4);
    assert.deepEqual(merged.spans, []);
  });

  test('localizes substitutions with normalized offsets and context', () => {
    const report = confusionMatrix('合同编号 HT-2026', '合同编号 HT-2O26');
    const span = report.spans?.find((item) => item.expected === '0');
    assert.equal(span?.type, 'sub');
    assert.equal(span?.expectedOffset, 8);
    assert.equal(span?.observedOffset, 8);
    assert.equal(span?.expected, '0');
    assert.equal(span?.observed, 'o');
    assert.equal(span?.expectedContext, '合同编号ht-2026');
    assert.equal(span?.observedContext, '合同编号ht-2o26');
  });

  test('localizes insertions and deletions', () => {
    const insertion = confusionMatrix('abc', 'abxc').spans?.[0];
    assert.equal(insertion?.type, 'insert');
    assert.equal(insertion?.expectedOffset, null);
    assert.equal(insertion?.observedOffset, 2);
    assert.equal(insertion?.expected, '');
    assert.equal(insertion?.observed, 'x');

    const deletion = confusionMatrix('abxc', 'abc').spans?.[0];
    assert.equal(deletion?.type, 'delete');
    assert.equal(deletion?.expectedOffset, 2);
    assert.equal(deletion?.observedOffset, null);
    assert.equal(deletion?.expected, 'x');
    assert.equal(deletion?.observed, '');
  });

  test('adds ellipses to context and caps the span list', () => {
    const long = confusionMatrix('a'.repeat(80), `${'a'.repeat(40)}b${'a'.repeat(39)}`);
    const span = long.spans?.[0];
    assert.equal(span?.expectedOffset, 40);
    assert.match(span?.expectedContext ?? '', /^…a+…$/u);

    const noisy = confusionMatrix('a'.repeat(100), 'b'.repeat(100));
    assert.equal(noisy.spans?.length, 50);
  });

  test('publishes the confusion classes used for targeted sampling', () => {
    const classes = confusionClasses();
    assert.ok(classes.some((group) => group.includes('0') && group.includes('O')));
    assert.ok(classes.some((group) => group.includes('1') && group.includes('I')));
  });
});

describe('error attribution', () => {
  test('attributes a much shorter result to detection or page loss', () => {
    const diagnosis = diagnoseErrors(
      '合同编号 HT-2026-001\n合计金额 1280.00\n签署日期 2026-10-01',
      '合同编号',
    );
    assert.equal(diagnosis.detectionSuspect, true);
    assert.match(diagnosis.reasons.join(' '), /少/);
  });

  test('attributes similar-length digit swaps to recognition', () => {
    const diagnosis = diagnoseErrors('合计金额 1280.00', '合计金额 I28O.OO');
    assert.equal(diagnosis.recognitionSuspect, true);
    assert.equal(diagnosis.detectionSuspect, false);
  });

  test('flags segmented table cells when rows exist but cell text is wrong', () => {
    const diagnosis = diagnoseErrors('合计 100\n税额 13', '合计 1OO\n税额 13', {
      tableCellAccuracy: 0.4,
      tableRowsF1: 0.95,
    });
    assert.equal(diagnosis.segmentationSuspect, true);
  });

  test('empty output is always a detection failure', () => {
    const diagnosis = diagnoseErrors('some text', '', { empty: true });
    assert.equal(diagnosis.detectionSuspect, true);
    assert.match(diagnosis.reasons[0] ?? '', /没有识别出文本/);
  });

  test('identical output reports no obvious problem', () => {
    const diagnosis = diagnoseErrors('金额 100', '金额 100');
    assert.equal(diagnosis.detectionSuspect, false);
    assert.equal(diagnosis.recognitionSuspect, false);
    assert.match(diagnosis.reasons[0] ?? '', /未发现/);
  });
});

describe('runtime stage diagnosis', () => {
  test('empty or low-coverage pages point at detection', () => {
    const empty = diagnoseQuality([], { empty: true });
    assert.equal(empty.stage, 'detection');
    assert.deepEqual(empty.actions, ['rerun_detection', 'rerun_structure']);

    const order = diagnoseQuality(['reading_order', 'low_coverage']);
    assert.equal(order.stage, 'detection');
    assert.ok(order.actions.includes('rerun_detection'));
  });

  test('table and field signals point at segmentation', () => {
    const diagnosis = diagnoseQuality(['table_integrity', 'field_mismatch']);
    assert.equal(diagnosis.stage, 'segmentation');
    assert.ok(diagnosis.actions.includes('rerun_structure'));
    assert.match(diagnosis.reasons.join(' '), /切分/);
  });

  test('confidence and character signals point at recognition', () => {
    const diagnosis = diagnoseQuality(['low_confidence', 'digit_confusion']);
    assert.equal(diagnosis.stage, 'recognition');
    assert.ok(diagnosis.actions.includes('switch_recognizer'));
  });

  test('no issues yields no action', () => {
    const diagnosis = diagnoseQuality([]);
    assert.equal(diagnosis.stage, 'none');
    assert.deepEqual(diagnosis.actions, []);
  });
});
