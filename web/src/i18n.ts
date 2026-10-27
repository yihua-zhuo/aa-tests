import { useCallback, useEffect, useState } from 'react';
import { ACTIVITY_LABELS } from '../../shared/activity.ts';
import type { ActivityType } from '../../shared/types.ts';

export type Locale = 'zh-CN' | 'en';

const STORAGE_KEY = 'pulse.locale';

const zh = {
  'nav.overview.hint': '总览',
  'nav.analytics.hint': '分析',
  'nav.projects.hint': '项目',
  'nav.activity.hint': '动态',
  'nav.users.hint': '成员',
  'nav.enterprise.hint': '企业套件',
  'nav.audit.hint': '审计',
  'nav.ops.hint': '运维',
  'nav.settings.hint': '设置',
  'activity.all': '全部',
  'activity.title.all': '全部动态',
  'search.recent': '最近搜索',
  'live.connected': '实时协作 · {count} 人在线',
  'live.connecting': '正在连接实时通道…',
  'time.justNow': '刚刚',
  'time.minutes': '{count} 分钟前',
  'time.hours': '{count} 小时前',
  'time.days': '{count} 天前',
  'settings.language': '界面语言',
  'settings.language.hint': '影响界面文案、日期与货币格式',
  'common.language.zh': '简体中文',
  'common.language.en': 'English',
} as const;

type MessageKey = keyof typeof zh;

export type { MessageKey };

const en: Record<MessageKey, string> = {
  'nav.overview.hint': 'Overview',
  'nav.analytics.hint': 'Analytics',
  'nav.projects.hint': 'Projects',
  'nav.activity.hint': 'Activity',
  'nav.users.hint': 'Members',
  'nav.enterprise.hint': 'Enterprise suite',
  'nav.audit.hint': 'Audit',
  'nav.ops.hint': 'Ops',
  'nav.settings.hint': 'Settings',
  'activity.all': 'All',
  'activity.title.all': 'All activity',
  'search.recent': 'Recent searches',
  'live.connected': 'Live · {count} online',
  'live.connecting': 'Connecting to live channel…',
  'time.justNow': 'just now',
  'time.minutes': '{count} min ago',
  'time.hours': '{count} hr ago',
  'time.days': '{count} days ago',
  'settings.language': 'Interface language',
  'settings.language.hint': 'Affects copy, date and currency formats',
  'common.language.zh': '简体中文',
  'common.language.en': 'English',
};

const MESSAGES: Record<Locale, Record<MessageKey, string>> = { 'zh-CN': zh, en };

function detectLocale(): Locale {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored === 'zh-CN' || stored === 'en') return stored;
  } catch {
    // storage can be unavailable in private mode
  }
  return 'zh-CN';
}

let current: Locale = detectLocale();
const listeners = new Set<(locale: Locale) => void>();

if (typeof document !== 'undefined') document.documentElement.lang = current;

export function getLocale(): Locale {
  return current;
}

export function setLocale(next: Locale): void {
  if (next === current) return;
  current = next;
  try {
    window.localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // storage can be unavailable in private mode
  }
  document.documentElement.lang = next;
  for (const listener of listeners) listener(next);
}

function interpolate(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (_, key: string) =>
    key in vars ? String(vars[key]) : `{${key}}`,
  );
}

export function t(key: MessageKey, vars?: Record<string, string | number>): string {
  return interpolate(MESSAGES[current][key] ?? zh[key] ?? key, vars);
}

export function activityLabel(type: ActivityType): string {
  return ACTIVITY_LABELS[type]?.[current === 'en' ? 'en' : 'zh'] ?? type;
}

export function useLocale(): { locale: Locale; setLocale: (next: Locale) => void; t: typeof t } {
  const [locale, setLocaleState] = useState<Locale>(current);

  useEffect(() => {
    listeners.add(setLocaleState);
    return () => {
      listeners.delete(setLocaleState);
    };
  }, []);

  const translate = useCallback<typeof t>(
    (key, vars) => {
      void locale;
      return t(key, vars);
    },
    [locale],
  );

  return { locale, setLocale, t: translate };
}
