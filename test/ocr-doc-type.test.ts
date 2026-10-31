import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { DocumentBlock } from '../shared/types.ts';
import { classifyDocument } from '../src/ocr-doc-type.ts';

function block(id: string, type: DocumentBlock['type'], text: string): DocumentBlock {
  return {
    id,
    type,
    text,
    bbox: null,
    confidence: 0.95,
    source: { engine: 'test', model: null, stage: 'native' },
    validation: null,
    order: 0,
  };
}

describe('document classification and schema', () => {
  test('classifies an invoice and extracts its required fields', () => {
    const result = classifyDocument({
      text: [
        '增值税专用发票',
        '发票号码：12345678',
        '开票日期：2026年03月05日',
        '价税合计：￥1,234.56',
        '税额：￥123.45',
      ].join('\n'),
      blocks: [block('t1', 'table', '项目 | 金额\n服务 | 1234.56')],
    });
    assert.equal(result.type, 'invoice');
    assert.ok(result.confidence >= 0.7);
    assert.deepEqual(result.schema.missing, []);
    assert.deepEqual(result.schema.invalid, []);
    assert.equal(result.schema.coverage, 1);
    const total = result.schema.fields.find((field) => field.key === 'total');
    assert.equal(total?.value, '1,234.56');
  });

  test('flags missing schema fields and cross-field conflicts', () => {
    const result = classifyDocument({
      text: ['合同', '甲方：甲公司', '乙方：乙公司', '签订日期：2026-03-05', '合同金额：100'].join(
        '\n',
      ),
    });
    assert.equal(result.type, 'contract');
    assert.deepEqual(result.schema.missing, []);
    const invoice = classifyDocument({
      text: ['增值税发票', '价税合计：100.00', '税额：120.00'].join('\n'),
    });
    assert.equal(invoice.type, 'invoice');
    assert.ok(invoice.schema.conflicts.some((item) => item.includes('小于税额')));
  });

  test('validates Chinese ID checksums instead of accepting the format alone', () => {
    const valid = classifyDocument({
      text: ['居民身份证', '姓名：张三', '公民身份号码：11010519491231002X'].join('\n'),
    });
    assert.equal(valid.type, 'id_document');
    assert.deepEqual(valid.schema.invalid, []);
    const invalid = classifyDocument({
      text: ['居民身份证', '姓名：张三', '公民身份号码：110105194912310021'].join('\n'),
    });
    assert.equal(invalid.type, 'id_document');
    assert.deepEqual(invalid.schema.invalid, ['证件号码']);
  });

  test('keeps ambiguous documents generic without inventing a schema', () => {
    const result = classifyDocument({ text: '会议纪要\n下次讨论预算' });
    assert.equal(result.type, 'generic');
    assert.equal(result.schema.fields.length, 0);
    assert.equal(result.schema.coverage, null);
  });
});
