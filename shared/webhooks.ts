import type { WebhookEvent } from './types.ts';

export const WEBHOOK_EVENT_LABELS: Record<WebhookEvent, string> = {
  'project.created': '创建项目',
  'project.updated': '更新项目',
  'project.archived': '归档项目',
  'project.restored': '恢复项目',
  'project.deleted': '删除项目',
  'task.created': '创建任务',
  'task.completed': '完成任务',
  'comment.created': '新增评论',
  'user.created': '创建成员',
  'user.disabled': '停用成员',
};

export const WEBHOOK_MAX_ATTEMPTS = 6;

const RETRY_DELAYS_MS = [30_000, 120_000, 600_000, 3_600_000, 21_600_000];

export function webhookRetryDelay(attempt: number): number {
  return RETRY_DELAYS_MS[Math.min(Math.max(attempt - 1, 0), RETRY_DELAYS_MS.length - 1)] ?? 0;
}

export function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host === '::1' || host === '0.0.0.0') return true;
  if (host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    return true;
  }
  if (host.endsWith('.svc') || host.endsWith('.cluster.local')) return true;
  if (/^f[cd][0-9a-f]{2}:/i.test(host) || /^fe80:/i.test(host)) return true;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    const [a = 0, b = 0] = host.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127 || a === 169) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
  }
  return false;
}

/** Returns a user-facing issue when a webhook URL must not be called. */
export function webhookUrlIssue(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'Webhook 地址无效';
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return '仅支持 http 或 https 地址';
  if (url.username || url.password) return '地址不能包含用户名或密码';
  if (isPrivateHost(url.hostname)) return '不能指向本机或内网地址';
  if (!url.hostname.includes('.')) return '不能使用内部主机名';
  if (raw.length > 500) return '地址最多 500 个字符';
  return null;
}
