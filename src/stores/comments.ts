import type { Comment, CommentList, UserOption } from '../../shared/types.ts';
import type { Database } from '../db.ts';
import type { ActivitiesStore } from './activities.ts';
import { excerpt, type NotificationsStore } from './notifications.ts';

type CommentRow = {
  id: string;
  project_id: string;
  task_id: string | null;
  task_title: string | null;
  author_id: string | null;
  author_name: string | null;
  body: string;
  created_at: string;
};

export type CommentCreateInput = {
  body: string;
  taskId?: string | null;
  mentions?: string[];
};

export type CommentTarget = {
  project: { id: string; name: string };
  task: { id: string; title: string; assigneeId: string | null } | null;
};

const SELECT = `SELECT c.id, c.project_id, c.task_id, c.author_id, c.body, c.created_at,
  t.title AS task_title, u.name AS author_name
  FROM comments c
  LEFT JOIN project_tasks t ON t.id = c.task_id
  LEFT JOIN users u ON u.id = c.author_id`;

function toComment(row: CommentRow, mentions: UserOption[]): Comment {
  return {
    id: row.id,
    projectId: row.project_id,
    taskId: row.task_id,
    taskTitle: row.task_title,
    author: row.author_id && row.author_name ? { id: row.author_id, name: row.author_name } : null,
    body: row.body,
    mentions,
    createdAt: row.created_at,
  };
}

export class CommentsStore {
  readonly #db: Database;
  readonly #activities: ActivitiesStore;
  readonly #notifications: NotificationsStore;

  constructor(db: Database, activities: ActivitiesStore, notifications: NotificationsStore) {
    this.#db = db;
    this.#activities = activities;
    this.#notifications = notifications;
  }

  #mentionsByComment(commentIds: string[]): Map<string, UserOption[]> {
    const map = new Map<string, UserOption[]>();
    if (commentIds.length === 0) return map;
    const placeholders = commentIds.map(() => '?').join(', ');
    const rows = this.#db
      .stmt(
        `SELECT m.comment_id, u.id, u.name FROM comment_mentions m
         JOIN users u ON u.id = m.user_id
         WHERE m.comment_id IN (${placeholders})
         ORDER BY u.name COLLATE NOCASE`,
      )
      .all(...commentIds) as unknown as { comment_id: string; id: string; name: string }[];
    for (const row of rows) {
      const list = map.get(row.comment_id) ?? [];
      list.push({ id: row.id, name: row.name });
      map.set(row.comment_id, list);
    }
    return map;
  }

  list(projectId: string, taskId?: string): CommentList {
    const rows = this.#db
      .stmt(
        `${SELECT}
         WHERE c.project_id = ?${taskId ? ' AND c.task_id = ?' : ''}
         ORDER BY c.created_at ASC, c.rowid ASC`,
      )
      .all(...(taskId ? [projectId, taskId] : [projectId])) as unknown as CommentRow[];
    const mentions = this.#mentionsByComment(rows.map((row) => row.id));
    return {
      comments: rows.map((row) => toComment(row, mentions.get(row.id) ?? [])),
      total: rows.length,
    };
  }

  find(
    id: string,
  ): { id: string; projectId: string; taskId: string | null; authorId: string | null } | null {
    const row = this.#db
      .stmt('SELECT id, project_id, task_id, author_id FROM comments WHERE id = ?')
      .get(id) as unknown as
      | { id: string; project_id: string; task_id: string | null; author_id: string | null }
      | undefined;
    if (!row) return null;
    return {
      id: row.id,
      projectId: row.project_id,
      taskId: row.task_id,
      authorId: row.author_id,
    };
  }

  #notify(
    target: CommentTarget,
    commentId: string,
    body: string,
    actor: UserOption,
    recipientIds: readonly string[],
  ): void {
    const scope = target.task ? `任务「${target.task.title}」` : `项目「${target.project.name}」`;
    const link = target.task
      ? `/projects/${target.project.id}?task=${target.task.id}`
      : `/projects/${target.project.id}`;
    const title = `${actor.name} 在${scope}中提到了你`;
    const snippet = excerpt(body);
    for (const userId of recipientIds) {
      this.#notifications.create({
        userId,
        type: 'mention',
        title,
        body: snippet,
        link,
        actorId: actor.id,
        projectId: target.project.id,
        taskId: target.task?.id ?? null,
        commentId,
      });
      this.#notifications.enqueueMail({
        userId,
        subject: title,
        body: `${actor.name} 写道：\n\n${body}\n\n打开 Clay Dashboard 查看：${link}`,
        dedupeKey: `mention:${commentId}:${userId}`,
      });
    }
  }

  create(target: CommentTarget, input: CommentCreateInput, actor: UserOption): Comment {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const mentioned = [...new Set(input.mentions ?? [])].filter((userId) => userId !== actor.id);
    const taskAssignee = target.task?.assigneeId ?? null;

    this.#db.transaction(() => {
      this.#db
        .stmt(
          `INSERT INTO comments
             (id, project_id, task_id, author_id, body, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, target.project.id, target.task?.id ?? null, actor.id, input.body, now, now);

      const insertMention = this.#db.stmt(
        'INSERT OR IGNORE INTO comment_mentions (comment_id, user_id) VALUES (?, ?)',
      );
      for (const userId of mentioned) insertMention.run(id, userId);

      this.#activities.record({
        type: 'comment.created',
        actor,
        project: target.project,
        message: `${actor.name} 评论了${
          target.task ? `任务「${target.task.title}」` : `项目「${target.project.name}」`
        }`,
        meta: {
          commentId: id,
          taskId: target.task?.id ?? null,
          excerpt: excerpt(input.body),
        },
        createdAt: now,
      });

      this.#notify(target, id, input.body, actor, mentioned);

      if (
        target.task &&
        taskAssignee &&
        taskAssignee !== actor.id &&
        !mentioned.includes(taskAssignee)
      ) {
        const title = `${actor.name} 评论了你负责的任务「${target.task.title}」`;
        this.#notifications.create({
          userId: taskAssignee,
          type: 'comment',
          title,
          body: excerpt(input.body),
          link: `/projects/${target.project.id}?task=${target.task.id}`,
          actorId: actor.id,
          projectId: target.project.id,
          taskId: target.task.id,
          commentId: id,
        });
        this.#notifications.enqueueMail({
          userId: taskAssignee,
          subject: title,
          body: `${actor.name} 写道：\n\n${input.body}\n\n打开 Clay Dashboard 查看：/projects/${target.project.id}?task=${target.task.id}`,
          dedupeKey: `comment:${id}:${taskAssignee}`,
        });
      }
    });

    const row = this.#db.stmt(`${SELECT} WHERE c.id = ?`).get(id) as unknown as CommentRow;
    return toComment(row, this.#mentionsByComment([id]).get(id) ?? []);
  }

  remove(id: string, target: CommentTarget, actor: UserOption): boolean {
    const now = new Date().toISOString();
    return this.#db.transaction(() => {
      const result = this.#db.stmt('DELETE FROM comments WHERE id = ?').run(id);
      if (Number(result.changes) === 0) return false;
      this.#db.stmt('DELETE FROM notifications WHERE comment_id = ?').run(id);
      this.#activities.record({
        type: 'comment.deleted',
        actor,
        project: target.project,
        message: `${actor.name} 删除了${
          target.task ? `任务「${target.task.title}」` : `项目「${target.project.name}」`
        }的评论`,
        meta: { commentId: id, taskId: target.task?.id ?? null },
        createdAt: now,
      });
      return true;
    });
  }
}
