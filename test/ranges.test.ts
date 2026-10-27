import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dayKeyInTimeZone, isValidTimeZone, resolveRange } from '../shared/ranges.ts';

const evening = new Date('2026-06-15T20:30:00.000Z');

test('day keys follow the supplied time zone', () => {
  assert.equal(dayKeyInTimeZone(evening, 'UTC'), '2026-06-15');
  assert.equal(dayKeyInTimeZone(evening, 'Asia/Shanghai'), '2026-06-16');
  assert.equal(dayKeyInTimeZone(evening, 'America/New_York'), '2026-06-15');
  assert.equal(dayKeyInTimeZone(evening, 'Mars/Olympus'), '2026-06-15');
  assert.equal(isValidTimeZone('Asia/Shanghai'), true);
  assert.equal(isValidTimeZone('Mars/Olympus'), false);
});

test('resolveRange anchors today to the workspace time zone', () => {
  const shanghai = resolveRange({ range: 'today' }, evening, 'Asia/Shanghai');
  assert.ok(shanghai.ok);
  assert.equal(shanghai.range.from, '2026-06-16');
  assert.equal(shanghai.range.to, '2026-06-16');
  assert.equal(shanghai.range.timezone, 'Asia/Shanghai');

  const utc = resolveRange({ range: 'today' }, evening, 'UTC');
  assert.ok(utc.ok);
  assert.equal(utc.range.to, '2026-06-15');

  const week = resolveRange({ range: '7d' }, evening, 'Asia/Shanghai');
  assert.ok(week.ok);
  assert.equal(week.range.from, '2026-06-10');
  assert.equal(week.range.to, '2026-06-16');
  assert.equal(week.range.previous.from, '2026-06-03');
  assert.equal(week.range.previous.to, '2026-06-09');
});

test('resolveRange crosses month boundaries in the workspace time zone', () => {
  const instant = new Date('2026-06-30T20:00:00.000Z');
  const month = resolveRange({ range: 'month' }, instant, 'Asia/Shanghai');
  assert.ok(month.ok);
  assert.equal(month.range.from, '2026-07-01');
  assert.equal(month.range.to, '2026-07-01');

  const lastMonth = resolveRange({ range: 'last_month' }, instant, 'Asia/Shanghai');
  assert.ok(lastMonth.ok);
  assert.equal(lastMonth.range.from, '2026-06-01');
  assert.equal(lastMonth.range.to, '2026-06-30');
});

test('resolveRange falls back to UTC for an invalid time zone', () => {
  const fallback = resolveRange({ range: 'today' }, evening, 'Mars/Olympus');
  assert.ok(fallback.ok);
  assert.equal(fallback.range.timezone, 'UTC');
  assert.equal(fallback.range.to, '2026-06-15');
});
