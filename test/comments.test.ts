import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { test } from 'node:test';
import type { Hono } from 'hono';
import type {
  ActivityPage,
  Comment,
  CommentList,
  NotificationList,
  ProjectDetail,
  ProjectTasks,
  Task,
} from '../shared/types.ts';
import type { AppEnv } from '../src/app-env.ts';
import { createMailer } from '../src/mailer.ts';
import { NotificationWorker } from '../src/notification-worker.ts';
import { DEMO, getJson, login, sendJson, testApp, testStore } from './helpers.ts';

type Setup = {
  store: ReturnType<typeof testStore>;
  app: Hono<AppEnv>;
  admin: string;
  manager: string;
  viewer: string;
  pm: string;
};

async function setup(): Promise<Setup> {
  const store = testStore({ demo: false });
  const { app } = testApp(store);
  const [admin, manager, viewer, pm] = await Promise.all([
    login(app, DEMO.admin.email),
    login(app, DEMO.manager.email),
    login(app, DEMO.viewer.email),
    login(app, DEMO.pm.email),
  ]);
  return { store, app, admin, manager, viewer, pm };
}

async function createProject(
  app: Hono<AppEnv>,
  cookie: string,
  memberIds: string[] = [],
): Promise<ProjectDetail> {
  const result = await sendJson<ProjectDetail>(app, cookie, 'POST', '/api/projects', {
    name: '评论协作',
    memberIds,
  });
  assert.equal(result.status, 201, JSON.stringify(result.body));
  return result.body;
}

async function createTask(
  app: Hono<AppEnv>,
  cookie: string,
  projectId: string,
  body: Record<string, unknown>,
): Promise<Task> {
  const result = await sendJson<Task>(
    app,
    cookie,
    'POST',
    `/api/projects/${projectId}/tasks`,
    body,
  );
  assert.equal(result.status, 201, JSON.stringify(result.body));
  return result.body;
}

function outboxCount(store: Setup['store']): number {
  const row = store.db.raw.prepare('SELECT COUNT(*) AS total FROM mail_outbox').get() as {
    total: number;
  };
  return Number(row.total);
}

test('project comments notify mentions and enforce project roles', async () => {
  const { store, app, admin, manager, viewer, pm } = await setup();
  try {
    const project = await createProject(app, admin, [DEMO.manager.id, DEMO.viewer.id]);

    const posted = await sendJson<Comment>(
      app,
      admin,
      'POST',
      `/api/projects/${project.id}/comments`,
      {
        body: '请 @陈墨 @顾言 一起看一下新版视觉。',
        mentions: [DEMO.manager.id, DEMO.viewer.id],
      },
    );
    assert.equal(posted.status, 201, JSON.stringify(posted.body));
    assert.equal(posted.body.author?.id, DEMO.admin.id);
    assert.deepEqual(
      posted.body.mentions.map((mention) => mention.id).sort(),
      [DEMO.manager.id, DEMO.viewer.id].sort(),
    );

    const listed = await getJson<CommentList>(app, viewer, `/api/projects/${project.id}/comments`);
    assert.equal(listed.total, 1);
    assert.equal(listed.comments[0]?.body, posted.body.body);
    assert.equal(listed.comments[0]?.taskId, null);

    const managerInbox = await getJson<NotificationList>(app, manager, '/api/notifications');
    assert.equal(managerInbox.unread, 1);
    assert.equal(managerInbox.notifications[0]?.type, 'mention');
    assert.equal(managerInbox.notifications[0]?.link, `/projects/${project.id}`);

    const viewerInbox = await getJson<NotificationList>(app, viewer, '/api/notifications');
    assert.equal(viewerInbox.unread, 1);
    assert.equal(outboxCount(store), 2, 'one queued email per mentioned member');

    const activities = await getJson<ActivityPage>(app, admin, '/api/activities?limit=20');
    assert.ok(
      activities.activities.some(
        (activity) => activity.type === 'comment.created' && activity.project?.id === project.id,
      ),
    );

    const viewerPost = await sendJson(app, viewer, 'POST', `/api/projects/${project.id}/comments`, {
      body: '只读成员不应能评论',
    });
    assert.equal(viewerPost.status, 403);

    const outsiderPost = await sendJson(app, pm, 'POST', `/api/projects/${project.id}/comments`, {
      body: '提及非成员',
      mentions: [DEMO.pm.id],
    });
    assert.equal(outsiderPost.status, 404, 'pm cannot see a project they are not part of');
    const outsiderList = await app.request(`/api/projects/${project.id}/comments`, {
      headers: { cookie: pm },
    });
    assert.equal(outsiderList.status, 404);

    const invalidMention = await sendJson(
      app,
      manager,
      'POST',
      `/api/projects/${project.id}/comments`,
      { body: '提及项目外成员', mentions: [DEMO.pm.id] },
    );
    assert.equal(invalidMention.status, 400);

    const managerDelete = await app.request(`/api/comments/${posted.body.id}`, {
      method: 'DELETE',
      headers: { cookie: manager },
    });
    assert.equal(managerDelete.status, 204);

    const empty = await getJson<CommentList>(app, viewer, `/api/projects/${project.id}/comments`);
    assert.equal(empty.total, 0);
    const managerAfter = await getJson<NotificationList>(app, manager, '/api/notifications');
    assert.equal(managerAfter.unread, 0, 'notifications cascade with the deleted comment');
    const outboxAfter = store.db.raw
      .prepare('SELECT COUNT(*) AS total FROM comment_mentions')
      .get() as { total: number };
    assert.equal(Number(outboxAfter.total), 0, 'mentions cascade with the deleted comment');
  } finally {
    store.close();
  }
});

test('task comments count, notify the assignee once and cascade on delete', async () => {
  const { store, app, admin, manager } = await setup();
  try {
    const project = await createProject(app, admin, [DEMO.manager.id]);
    const task = await createTask(app, admin, project.id, {
      title: '整理评审意见',
      assigneeId: DEMO.manager.id,
    });

    const posted = await sendJson<Comment>(
      app,
      admin,
      'POST',
      `/api/projects/${project.id}/comments`,
      {
        body: '这里需要你确认 @陈墨',
        taskId: task.id,
        mentions: [DEMO.manager.id],
      },
    );
    assert.equal(posted.status, 201, JSON.stringify(posted.body));
    assert.equal(posted.body.taskId, task.id);
    assert.equal(posted.body.taskTitle, task.title);

    const tasks = await getJson<ProjectTasks>(app, admin, `/api/projects/${project.id}/tasks`);
    assert.equal(tasks.tasks[0]?.commentCount, 1);

    const inbox = await getJson<NotificationList>(app, manager, '/api/notifications');
    assert.equal(inbox.unread, 1, 'a mention and assignee notice are not duplicated');
    assert.equal(inbox.notifications[0]?.link, `/projects/${project.id}?task=${task.id}`);
    assert.equal(outboxCount(store), 1);

    const filtered = await getJson<CommentList>(
      app,
      manager,
      `/api/projects/${project.id}/comments?taskId=${task.id}`,
    );
    assert.equal(filtered.total, 1);

    const wrongTask = await app.request(
      `/api/projects/${project.id}/comments?taskId=${crypto.randomUUID()}`,
      { headers: { cookie: admin } },
    );
    assert.equal(wrongTask.status, 404);

    const removed = await app.request(`/api/tasks/${task.id}`, {
      method: 'DELETE',
      headers: { cookie: admin },
    });
    assert.equal(removed.status, 204);
    const comments = store.db.raw
      .prepare('SELECT COUNT(*) AS total FROM comments WHERE task_id = ?')
      .get(task.id) as { total: number };
    assert.equal(Number(comments.total), 0, 'task deletion removes its comments');
    const notes = store.db.raw
      .prepare('SELECT COUNT(*) AS total FROM notifications WHERE task_id = ?')
      .get(task.id) as { total: number };
    assert.equal(Number(notes.total), 0, 'task deletion removes related notifications');
  } finally {
    store.close();
  }
});

test('notification read state is per user and validated', async () => {
  const { store, app, admin, manager, viewer } = await setup();
  try {
    const project = await createProject(app, admin, [DEMO.manager.id, DEMO.viewer.id]);
    for (const body of ['第一条', '第二条']) {
      const result = await sendJson(app, admin, 'POST', `/api/projects/${project.id}/comments`, {
        body,
        mentions: [DEMO.manager.id, DEMO.viewer.id],
      });
      assert.equal(result.status, 201);
    }

    const managerInbox = await getJson<NotificationList>(app, manager, '/api/notifications');
    assert.equal(managerInbox.unread, 2);
    const first = managerInbox.notifications[0];
    assert.ok(first);

    const marked = await sendJson<{ unread: number }>(
      app,
      manager,
      'POST',
      '/api/notifications/read',
      { ids: [first.id] },
    );
    assert.equal(marked.status, 200);
    assert.equal(marked.body.unread, 1);

    const viewerInbox = await getJson<NotificationList>(app, viewer, '/api/notifications');
    assert.equal(viewerInbox.unread, 2, 'another user cannot read these notifications');
    const viewerNotification = viewerInbox.notifications[0];
    assert.ok(viewerNotification);

    const foreign = await sendJson<{ unread: number }>(
      app,
      manager,
      'POST',
      '/api/notifications/read',
      { ids: [viewerNotification.id] },
    );
    assert.equal(foreign.body.unread, 1, 'ids are scoped to the signed-in user');

    const cleared = await sendJson<{ unread: number }>(
      app,
      manager,
      'POST',
      '/api/notifications/read',
      { all: true },
    );
    assert.equal(cleared.body.unread, 0);

    const invalid = await sendJson(app, manager, 'POST', '/api/notifications/read', {});
    assert.equal(invalid.status, 400);

    const raw = store.db.raw
      .prepare('SELECT COUNT(*) AS total FROM notifications WHERE read_at IS NOT NULL')
      .get() as { total: number };
    assert.equal(Number(raw.total), 2);
  } finally {
    store.close();
  }
});

type FakeSmtp = {
  port: number;
  messages: string[];
  close: () => Promise<void>;
};

async function startSmtp(): Promise<FakeSmtp> {
  const messages: string[] = [];
  const server = createServer((socket) => {
    let buffer = '';
    let data = '';
    let inData = false;
    socket.setEncoding('utf8');
    socket.write('220 clay.test ESMTP\r\n');

    socket.on('data', (chunk: string) => {
      buffer += chunk;
      let index = buffer.indexOf('\r\n');
      while (index !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        if (inData) {
          if (line === '.') {
            inData = false;
            messages.push(data);
            data = '';
            socket.write('250 queued\r\n');
          } else {
            data += `${line}\r\n`;
          }
        } else if (line.startsWith('EHLO')) {
          socket.write('250-clay.test\r\n250 SIZE 1048576\r\n');
        } else if (line.startsWith('MAIL FROM') || line.startsWith('RCPT TO')) {
          socket.write('250 ok\r\n');
        } else if (line === 'DATA') {
          inData = true;
          socket.write('354 go ahead\r\n');
        } else if (line === 'QUIT') {
          socket.write('221 bye\r\n');
          socket.end();
        } else {
          socket.write('250 ok\r\n');
        }
        index = buffer.indexOf('\r\n');
      }
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return {
    port: address.port,
    messages,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function decodeBody(message: string): string {
  const [, encoded = ''] = message.split('\r\n\r\n');
  return Buffer.from(encoded.replace(/\r\n/g, ''), 'base64').toString('utf8');
}

test('weekly digests are idempotent and the worker delivers mail', async () => {
  const { store, app, admin } = await setup();
  const smtp = await startSmtp();
  try {
    store.preferences.update(DEMO.manager.id, {
      weeklyDigest: true,
      emailNotifications: true,
    });
    store.preferences.update(DEMO.viewer.id, {
      weeklyDigest: true,
      emailNotifications: false,
    });

    const project = await createProject(app, admin, [DEMO.manager.id, DEMO.viewer.id]);
    const posted = await sendJson(app, admin, 'POST', `/api/projects/${project.id}/comments`, {
      body: '本周请关注品牌评审。',
      mentions: [DEMO.manager.id, DEMO.viewer.id],
    });
    assert.equal(posted.status, 201);

    const now = new Date();
    assert.equal(store.notifications.enqueueWeeklyDigests(now), 1, 'only opted-in users');
    assert.equal(store.notifications.enqueueWeeklyDigests(now), 0, 'one digest per user per week');

    const mailer = createMailer({
      SMTP_HOST: '127.0.0.1',
      SMTP_PORT: String(smtp.port),
      SMTP_FROM: 'noreply@clay.test',
      SMTP_HELO: 'clay.test',
    });
    assert.ok(mailer);
    const worker = new NotificationWorker(store, mailer);

    const tick = await worker.tick(now);
    assert.equal(tick.queuedDigests, 0);
    assert.equal(tick.sent, 2, 'the mention and the digest are delivered');
    assert.equal(tick.failed, 0);
    assert.equal(smtp.messages.length, 2);

    const bodies = smtp.messages.map(decodeBody);
    assert.ok(bodies.some((body) => body.includes('本周请关注品牌评审。')));
    assert.ok(bodies.some((body) => body.includes('未读通知')));

    const again = await worker.tick(now);
    assert.equal(again.sent, 0);
    assert.equal(smtp.messages.length, 2);

    const pending = store.db.raw
      .prepare("SELECT COUNT(*) AS total FROM mail_outbox WHERE status = 'pending'")
      .get() as { total: number };
    assert.equal(Number(pending.total), 0);

    const viewerMails = store.db.raw
      .prepare('SELECT COUNT(*) AS total FROM mail_outbox WHERE user_id = ?')
      .get(DEMO.viewer.id) as { total: number };
    assert.equal(Number(viewerMails.total), 0, 'email opt-out suppresses delivery');
  } finally {
    await smtp.close();
    store.close();
  }
});
