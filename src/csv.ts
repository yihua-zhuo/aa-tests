import { PROJECT_STATUS_LABELS, PROJECT_STATUSES } from '../shared/permissions.ts';
import { isCalendarDate } from '../shared/ranges.ts';
import type { ProjectStatus } from '../shared/types.ts';
import type { ImportProjectItem } from './stores/projects.ts';

export const MAX_IMPORT_ROWS = 5_000;
export const MAX_IMPORT_BYTES = 2_000_000;

export function csvCell(value: string): string {
  // Neutralize spreadsheet formula injection before quoting.
  const cell = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  if (!/[",\r\n]/.test(cell)) return cell;
  return `"${cell.replace(/"/g, '""')}"`;
}

export function parseCsvRows(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index++;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (char !== '\r') {
      field += char;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  const header = rows[0]?.map((name) => name.replace(/^\uFEFF/, '').trim());
  if (!header) return [];

  return rows
    .slice(1)
    .filter((cells) => cells.some((cell) => cell.trim() !== ''))
    .map((cells) =>
      Object.fromEntries(header.map((name, index) => [name, (cells[index] ?? '').trim()])),
    );
}

const STATUS_ALIASES: Record<string, ProjectStatus> = {
  planning: 'planning',
  规划中: 'planning',
  active: 'active',
  进行中: 'active',
  on_hold: 'on_hold',
  'on hold': 'on_hold',
  暂停: 'on_hold',
  completed: 'completed',
  已完成: 'completed',
  archived: 'archived',
  已归档: 'archived',
};

function parseStatus(value: unknown): ProjectStatus | null {
  if (value === undefined || value === null || value === '') return 'planning';
  if (typeof value !== 'string') return null;
  return STATUS_ALIASES[value.trim().toLowerCase()] ?? null;
}

function parseDate(value: unknown): string | null | undefined {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !isCalendarDate(value.trim())) return undefined;
  return value.trim();
}

function parseProgress(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return 0;
  const number = typeof value === 'number' ? value : Number(String(value).replace('%', '').trim());
  if (!Number.isFinite(number) || number < 0 || number > 100) return null;
  return Math.round(number);
}

export type ImportRowIssue = { row: number; message: string };

export type NormalizedImportItem = ImportProjectItem & {
  row: number;
  ownerEmail: string | null;
  memberEmails: string[];
};

export type NormalizedImport = {
  items: NormalizedImportItem[];
  errors: ImportRowIssue[];
  skipped: number;
};

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function text(value: unknown): string {
  return value === undefined || value === null ? '' : String(value).trim();
}

export function normalizeProjectRows(rows: Record<string, unknown>[]): NormalizedImport {
  const items: NormalizedImportItem[] = [];
  const errors: ImportRowIssue[] = [];

  for (const [index, row] of rows.entries()) {
    const rowNumber = index + 2;
    const fail = (message: string) => {
      errors.push({ row: rowNumber, message });
    };

    const name = text(row.name ?? row.title);
    const description = text(row.description ?? row.desc).slice(0, 2000);
    const status = parseStatus(row.status);
    const progress = parseProgress(row.progress);
    const startDate = parseDate(row.startDate ?? row.start_date);
    const dueDate = parseDate(row.dueDate ?? row.due_date);
    const ownerEmail = text(row.ownerEmail ?? row.owner_email ?? row.owner).toLowerCase();
    const rawMembers = text(row.members ?? row.memberEmails ?? row.member_emails);
    const memberEmails = rawMembers
      ? [
          ...new Set(
            rawMembers
              .split(/[;,]/)
              .map((email) => email.trim().toLowerCase())
              .filter(Boolean),
          ),
        ]
      : [];

    if (name.length === 0) {
      fail('名称不能为空');
      continue;
    }
    if (name.length > 120) {
      fail('名称超过 120 字');
      continue;
    }
    if (!status) {
      fail('状态值无效');
      continue;
    }
    if (progress === null) {
      fail('进度需为 0-100 之间的数字');
      continue;
    }
    if (startDate === undefined) {
      fail('开始日期格式无效');
      continue;
    }
    if (dueDate === undefined) {
      fail('截止日期格式无效');
      continue;
    }
    if (startDate && dueDate && startDate > dueDate) {
      fail('开始日期不能晚于截止日期');
      continue;
    }
    if (ownerEmail && !EMAIL_PATTERN.test(ownerEmail)) {
      fail('负责人邮箱格式无效');
      continue;
    }
    if (memberEmails.some((email) => !EMAIL_PATTERN.test(email))) {
      fail('成员邮箱格式无效');
      continue;
    }

    items.push({
      row: rowNumber,
      name,
      description,
      status,
      progress,
      startDate,
      dueDate,
      ownerEmail: ownerEmail || null,
      memberEmails,
    });
  }

  return { items, errors, skipped: errors.length };
}

export function projectStatusValues(): readonly ProjectStatus[] {
  return PROJECT_STATUSES;
}

export { PROJECT_STATUS_LABELS };
