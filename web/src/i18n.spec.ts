import { beforeEach, describe, expect, it } from 'vitest';
import { ACTIVITY_TYPES } from '../../shared/activity.ts';
import { formatCurrency, formatDate, timeAgo } from './format.ts';
import { activityLabel, getLocale, setLocale, t } from './i18n.ts';

describe('i18n', () => {
  beforeEach(() => {
    setLocale('zh-CN');
  });

  it('interpolates placeholders in both locales', () => {
    expect(t('live.connected', { count: 3 })).toBe('实时协作 · 3 人在线');
    setLocale('en');
    expect(getLocale()).toBe('en');
    expect(t('live.connected', { count: 2 })).toBe('Live · 2 online');
    expect(t('activity.all')).toBe('All');
  });

  it('persists the locale and labels every activity type', () => {
    setLocale('en');
    expect(window.localStorage.getItem('pulse.locale')).toBe('en');
    expect(document.documentElement.lang).toBe('en');
    for (const type of ACTIVITY_TYPES) {
      expect(activityLabel(type)).not.toBe(type);
    }
    expect(activityLabel('project.archived')).toBe('Archived');
    setLocale('zh-CN');
    expect(activityLabel('user.password_changed')).toBe('密码变更');
  });

  it('formats currencies and dates with the active locale', () => {
    setLocale('en');
    expect(formatCurrency(12000)).toBe('$12,000');
    expect(formatDate('2026-01-05')).toContain('Jan');
    expect(timeAgo(new Date().toISOString())).toBe('just now');

    setLocale('zh-CN');
    expect(formatCurrency(12000)).toContain('12,000');
    expect(formatDate('2026-01-05')).toContain('1月');
    expect(timeAgo(new Date().toISOString())).toBe('刚刚');
  });
});
