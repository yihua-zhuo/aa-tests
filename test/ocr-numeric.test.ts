import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  isNumericField,
  numericCandidate,
  numericEquivalent,
  sanitizeNumericText,
} from '../src/ocr-numeric.ts';

describe('numeric constrained candidate', () => {
  test('classifies business fields, never generic text', () => {
    assert.equal(isNumericField('amount'), true);
    assert.equal(isNumericField('date'), true);
    assert.equal(isNumericField('identifier'), true);
    assert.equal(isNumericField('text'), false);
  });

  test('repairs digit confusables for amounts but leaves letters in identifiers', () => {
    assert.equal(sanitizeNumericText('1O,OOO.5O', 'amount'), '10,000.50');
    assert.equal(sanitizeNumericText('INV-2O26', 'identifier'), 'INV-2026');
    assert.equal(sanitizeNumericText('ABC123', 'identifier'), 'ABC123');
  });

  test('canonicalizes currency, thousands and decimals', () => {
    const candidate = numericCandidate('¥ 1,200.00', 'amount');
    assert.equal(candidate.canonical, '1200.00');
    assert.equal(candidate.valid, true);
    assert.equal(numericCandidate('-1,200', 'amount').canonical, '-1200');
    assert.equal(numericCandidate('1O,OOO.5O', 'amount').canonical, '10000.50');
  });

  test('reads Chinese numerals and rejects text that is not a pure numeral', () => {
    const chinese = numericCandidate('壹仟贰佰', 'amount');
    assert.equal(chinese.valid, true);
    assert.equal(chinese.canonical, '1200');
    assert.equal(numericCandidate('约壹仟贰佰', 'amount').valid, false);
    assert.equal(numericCandidate('150%', 'percentage').valid, false);
    assert.equal(numericCandidate('12%', 'percentage').canonical, '12');
  });

  test('accepts only well-formed dates under the date constraint', () => {
    assert.equal(numericCandidate('2024O1O2', 'date').canonical, '2024-01-02');
    assert.equal(numericCandidate('2024-01-02', 'date').canonical, '2024-01-02');
    assert.equal(numericCandidate('2024-13-02', 'date').valid, false);
    assert.equal(numericCandidate('202401', 'date').valid, false);
  });

  test('constrains account numbers to digit groups', () => {
    const candidate = numericCandidate('6222 O2O1 1234 5678', 'account');
    assert.equal(candidate.valid, true);
    assert.equal(candidate.canonical, '6222020112345678');
  });

  test('numeric equivalence only holds for two valid constrained values', () => {
    assert.equal(numericEquivalent('amount', '1,200', '1200'), true);
    assert.equal(numericEquivalent('amount', '1,2O0', '1,200'), true);
    assert.equal(numericEquivalent('amount', '1,200', '1200.01'), false);
    assert.equal(numericEquivalent('date', '2024-01-02', '2024-02-03'), false);
    assert.equal(numericEquivalent('text', '1,200', '1200'), false);
    assert.equal(numericEquivalent('amount', '壹仟贰佰', '1200'), true);
    assert.equal(numericEquivalent('amount', '壹仟贰佰', '1300'), false);
  });
});
