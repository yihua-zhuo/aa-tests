import assert from 'node:assert/strict';
import { test } from 'node:test';
import { csvCell, normalizeProjectRows, parseCsvRows } from '../src/csv.ts';

test('CSV parser handles BOM, CRLF, quoted commas and escaped quotes', () => {
  const text = '\uFEFF name , description \r\n"a, b","say ""hi"""\r\nc,d\r\n\r\n';
  const rows = parseCsvRows(text);
  assert.deepEqual(rows, [
    { name: 'a, b', description: 'say "hi"' },
    { name: 'c', description: 'd' },
  ]);
});

test('CSV parser keeps newlines inside quoted fields', () => {
  const rows = parseCsvRows('name,description\n"multi\nline",ok\n');
  assert.deepEqual(rows, [{ name: 'multi\nline', description: 'ok' }]);
});

test('CSV export cells are quoted and formula-prefixed', () => {
  assert.equal(csvCell('plain'), 'plain');
  assert.equal(csvCell('a,b'), '"a,b"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell('line\nbreak'), '"line\nbreak"');
  assert.equal(csvCell('=1+1'), "'=1+1");
  assert.equal(csvCell('+SUM(A1)'), "'+SUM(A1)");
  assert.equal(csvCell('@cmd'), "'@cmd");
});

test('normalizeProjectRows validates aliases, progress and dates', () => {
  const { items, errors, skipped } = normalizeProjectRows([
    {
      title: 'Alias',
      desc: 'x',
      status: '进行中',
      progress: '35%',
      startDate: '2026-01-31',
      dueDate: '2026-02-01',
    },
    { name: 'bad date', status: 'active', progress: 20, startDate: '2026-02-30' },
    {
      name: 'reversed',
      status: 'active',
      progress: 20,
      startDate: '2026-03-02',
      dueDate: '2026-03-01',
    },
    { name: 'bad progress', status: 'active', progress: 120 },
    { name: 'bad status', status: 'archived?!', progress: 10 },
  ]);

  assert.equal(items.length, 1);
  assert.deepEqual(items[0], {
    row: 2,
    name: 'Alias',
    description: 'x',
    status: 'active',
    progress: 35,
    startDate: '2026-01-31',
    dueDate: '2026-02-01',
    ownerEmail: null,
    memberEmails: [],
  });
  assert.equal(skipped, 4);
  assert.deepEqual(
    errors.map((issue) => issue.row),
    [3, 4, 5, 6],
  );
  assert.match(errors[0]?.message ?? '', /日期/);
});

test('normalizeProjectRows maps owner and member emails and reports row issues', () => {
  const { items, errors } = normalizeProjectRows([
    {
      name: '成员项目',
      status: 'active',
      owner: 'Owner@Example.com',
      members: 'a@example.com; b@example.com,a@example.com',
    },
    { name: '坏负责人', owner_email: 'not-an-email' },
    { name: '坏成员', members: 'ok@example.com, broken' },
    { name: '这一行名称很长'.repeat(20) },
  ]);

  assert.equal(items.length, 1);
  assert.equal(items[0]?.ownerEmail, 'owner@example.com');
  assert.deepEqual(items[0]?.memberEmails, ['a@example.com', 'b@example.com']);
  assert.deepEqual(
    errors.map((issue) => issue.row),
    [3, 4, 5],
  );
  assert.match(errors[0]?.message ?? '', /负责人/);
  assert.match(errors[1]?.message ?? '', /成员/);
  assert.match(errors[2]?.message ?? '', /名称/);
});
