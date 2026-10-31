import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  amountWordsCheck,
  ibanValid,
  idCardValid,
  identifierValid,
  invalidIdentifiers,
  isbnValid,
  luhnValid,
  parseChineseMoney,
  usccValid,
  vinValid,
} from '../src/ocr-field-validation.ts';

describe('field checksums', () => {
  test('accepts real identifiers and rejects one changed digit', () => {
    assert.equal(usccValid('91350100M000100Y43'), true);
    assert.equal(usccValid('91350100M000100Y44'), false);
    assert.equal(idCardValid('11010519491231002X'), true);
    assert.equal(idCardValid('110105194912310021'), false);
    assert.equal(luhnValid('4111111111111111'), true);
    assert.equal(luhnValid('4111111111111112'), false);
    assert.equal(ibanValid('GB82WEST12345698765432'), true);
    assert.equal(ibanValid('GB82WEST12345698765431'), false);
    assert.equal(isbnValid('0306406152'), true);
    assert.equal(isbnValid('9780306406157'), true);
    assert.equal(isbnValid('9780306406158'), false);
    assert.equal(vinValid('1M8GDM9AXKP042788'), true);
    assert.equal(vinValid('1M8GDM9AYKP042788'), false);
  });

  test('dispatches by kind and never guesses on malformed input', () => {
    assert.equal(identifierValid('bank_card', '4111 1111 1111 1111'), true);
    assert.equal(identifierValid('bank_card', 'abc'), false);
    assert.equal(identifierValid('vin', 'x'), false);
  });
});

describe('labeled identifier scanning', () => {
  test('ignores unlabeled numbers and reports labeled bad checksums', () => {
    assert.deepEqual(invalidIdentifiers('订单号 1234567890123456'), []);
    assert.deepEqual(invalidIdentifiers('统一社会信用代码：91350100M000100Y43'), []);
    assert.deepEqual(invalidIdentifiers('统一社会信用代码：91350100M000100Y44'), [
      { kind: 'uscc', value: '91350100M000100Y44' },
    ]);
    assert.deepEqual(invalidIdentifiers('身份证号码 110105194912310021'), [
      { kind: 'id_card', value: '110105194912310021' },
    ]);
  });

  test('deduplicates repeated identifiers', () => {
    const text = '卡号：4111111111111112\n卡号：4111111111111112';
    assert.equal(invalidIdentifiers(text).length, 1);
  });
});

describe('uppercase amount crosscheck', () => {
  test('parses jiao and fen', () => {
    assert.equal(parseChineseMoney('壹万贰仟元伍角'), 12000.5);
    assert.equal(parseChineseMoney('壹佰元零伍分'), 100.05);
    assert.equal(parseChineseMoney('人民币叁仟元整'), 3000);
    assert.equal(parseChineseMoney('不是金额'), null);
  });

  test('compares uppercase and lowercase amounts', () => {
    assert.deepEqual(amountWordsCheck('合计金额：¥12,800.00（大写：壹万贰仟捌佰元整）'), {
      uppercase: 12800,
      matched: true,
    });
    assert.deepEqual(amountWordsCheck('合计金额：¥12,800.00（大写：壹万贰仟元整）'), {
      uppercase: 12000,
      matched: false,
    });
    assert.deepEqual(amountWordsCheck('大写：壹万贰仟元整'), {
      uppercase: 12000,
      matched: null,
    });
    assert.deepEqual(amountWordsCheck('没有大写金额'), { uppercase: null, matched: null });
  });

  test('tolerates 万元 table scales', () => {
    assert.deepEqual(amountWordsCheck('万元 1.2（大写：壹万贰仟元整）'), {
      uppercase: 12000,
      matched: true,
    });
  });
});
