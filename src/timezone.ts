import { DEFAULT_TIME_ZONE, isValidTimeZone } from '../shared/ranges.ts';

export function workspaceTimeZone(): string {
  const raw = process.env.WORKSPACE_TIMEZONE?.trim();
  return raw && isValidTimeZone(raw) ? raw : DEFAULT_TIME_ZONE;
}
