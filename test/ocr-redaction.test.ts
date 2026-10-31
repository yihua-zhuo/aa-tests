import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { redactionTotal, redactOcrText } from '../src/ocr-redaction.ts';

describe('OCR redaction', () => {
  test('replaces identity and contact fields without touching business numbers', () => {
    const text = [
      '发票号 INV-2026-0001',
      '日期 2026-11-01',
      '手机 +86 138-0013-8000',
      '座机 010-12345678',
      '邮箱 finance@example.com',
      '身份证 11010519491231002X',
      '卡号 6222 0202 0011 2233 445',
      `P<CHNZSAN${'<'.repeat(35)}`,
    ].join('\n');
    const result = redactOcrText(text);
    assert.ok(!result.text.includes('138-0013-8000'));
    assert.ok(!result.text.includes('010-12345678'));
    assert.ok(!result.text.includes('finance@example.com'));
    assert.ok(!result.text.includes('11010519491231002X'));
    assert.ok(!result.text.includes('6222 0202'));
    assert.ok(!result.text.includes('P<CHNZSAN'));
    assert.match(result.text, /\[手机号\]/);
    assert.match(result.text, /\[电话\]/);
    assert.match(result.text, /\[邮箱\]/);
    assert.match(result.text, /\[身份证\]/);
    assert.match(result.text, /\[银行卡\]/);
    assert.match(result.text, /\[MRZ\]/);
    assert.match(result.text, /INV-2026-0001/);
    assert.match(result.text, /2026-11-01/);
    assert.equal(redactionTotal(result.redactions), 6);
  });

  test('leaves clean text untouched', () => {
    const result = redactOcrText('项目周报\n本周完成 12 项任务，进度 80%。');
    assert.equal(result.text, '项目周报\n本周完成 12 项任务，进度 80%。');
    assert.equal(redactionTotal(result.redactions), 0);
  });
});
