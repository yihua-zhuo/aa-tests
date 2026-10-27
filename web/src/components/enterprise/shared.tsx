import type { ReactNode } from 'react';
import type { Project, UserOption } from '../../../../shared/types.ts';
import { cx } from '../ui.tsx';

export type EnterpriseTabProps = {
  projects: Project[];
  people: UserOption[];
};

export function ProjectPicker({
  projects,
  value,
  onChange,
  label = '选择项目',
  allowEmpty = false,
}: {
  projects: Project[];
  value: string;
  onChange: (value: string) => void;
  label?: string;
  allowEmpty?: boolean;
}) {
  return (
    <label className="enterprise-picker">
      <span>{label}</span>
      <select
        className="input input-sm"
        value={value}
        aria-label={label}
        onChange={(event) => onChange(event.target.value)}
      >
        {allowEmpty ? <option value="">全部项目</option> : null}
        {projects.map((project) => (
          <option key={project.id} value={project.id}>
            {project.name}
          </option>
        ))}
      </select>
    </label>
  );
}

export function PeoplePicker({
  people,
  value,
  onChange,
  label = '成员',
}: {
  people: UserOption[];
  value: string;
  onChange: (value: string) => void;
  label?: string;
}) {
  return (
    <label className="enterprise-picker">
      <span>{label}</span>
      <select
        className="input input-sm"
        value={value}
        aria-label={label}
        onChange={(event) => onChange(event.target.value)}
      >
        {people.map((person) => (
          <option key={person.id} value={person.id}>
            {person.name}
          </option>
        ))}
      </select>
    </label>
  );
}

export function ToneBadge({
  tone,
  children,
}: {
  tone: 'success' | 'danger' | 'muted' | 'active' | 'warning';
  children: ReactNode;
}) {
  return (
    <span className="badge" data-tone={tone === 'warning' ? 'muted' : tone}>
      {children}
    </span>
  );
}

export function EnterpriseToolbar({ children }: { children: ReactNode }) {
  return <div className="enterprise-toolbar">{children}</div>;
}

export function EnterpriseEmpty({ children }: { children: ReactNode }) {
  return <p className="enterprise-empty">{children}</p>;
}

export function EnterpriseStat({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string | number;
  hint?: string;
  tone?: 'lilac' | 'mint' | 'peach' | 'sky';
}) {
  return (
    <article className={cx('card stat-tile', tone && `is-${tone}`)}>
      <span className="stat-label">{label}</span>
      <strong className="stat-value">{value}</strong>
      {hint ? <span className="stat-hint">{hint}</span> : null}
    </article>
  );
}

export function minutesLabel(minutes: number): string {
  const hours = minutes / 60;
  if (hours >= 1) return `${formatHours(hours)} 小时`;
  return `${minutes} 分钟`;
}

function formatHours(hours: number): string {
  return Number.isInteger(hours) ? String(hours) : hours.toFixed(1);
}

export function textOf(
  record: Record<string, unknown> | null | undefined,
  key: string,
  fallback = '',
): string {
  const value = record?.[key];
  if (value === null || value === undefined) return fallback;
  return String(value);
}

export function numberOf(
  record: Record<string, unknown> | null | undefined,
  key: string,
  fallback = 0,
): number {
  const value = Number(record?.[key]);
  return Number.isFinite(value) ? value : fallback;
}

export function listOf<T = Record<string, unknown>>(
  record: Record<string, unknown> | null | undefined,
  key: string,
): T[] {
  const value = record?.[key];
  return Array.isArray(value) ? (value as T[]) : [];
}

export function objectOf(
  record: Record<string, unknown> | null | undefined,
  key: string,
): Record<string, unknown> {
  const value = record?.[key];
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function splitItems(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}
