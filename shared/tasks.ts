import type { TaskPriority, TaskStatus } from './types.ts';

export const TASK_STATUSES: readonly TaskStatus[] = ['todo', 'in_progress', 'review', 'done'];

export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  todo: '待办',
  in_progress: '进行中',
  review: '待验收',
  done: '已完成',
};

export const TASK_PRIORITIES: readonly TaskPriority[] = ['low', 'medium', 'high', 'urgent'];

export const TASK_PRIORITY_LABELS: Record<TaskPriority, string> = {
  low: '低',
  medium: '中',
  high: '高',
  urgent: '紧急',
};
