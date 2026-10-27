import { describe, expect, it } from 'vitest';
import { listOf, minutesLabel, numberOf, objectOf, splitItems, textOf } from './shared.tsx';

describe('enterprise record helpers', () => {
  it('reads decoded workbench fields with safe fallbacks', () => {
    const record = {
      name: '收入日报',
      usagePct: 82.5,
      recipientsJson: ['ops@example.com'],
      configJson: { dataset: 'daily_metrics', fields: ['date'] },
      active: false,
    };

    expect(textOf(record, 'name')).toBe('收入日报');
    expect(textOf(record, 'missing', '未命名')).toBe('未命名');
    expect(numberOf(record, 'usagePct')).toBe(82.5);
    expect(numberOf(record, 'missing', 0)).toBe(0);
    expect(listOf<string>(record, 'recipientsJson')).toEqual(['ops@example.com']);
    expect(listOf(record, 'configJson')).toEqual([]);
    expect(objectOf(record, 'configJson')).toEqual({
      dataset: 'daily_metrics',
      fields: ['date'],
    });
    expect(objectOf(record, 'recipientsJson')).toEqual({});
  });

  it('formats durations and splits comma separated recipients', () => {
    expect(minutesLabel(45)).toBe('45 分钟');
    expect(minutesLabel(120)).toBe('2 小时');
    expect(minutesLabel(90)).toBe('1.5 小时');
    expect(splitItems(' ops@example.com, finance@example.com , ')).toEqual([
      'ops@example.com',
      'finance@example.com',
    ]);
    expect(splitItems('')).toEqual([]);
  });
});
