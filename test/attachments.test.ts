import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import type { Attachment, AttachmentList, Profile } from '../shared/types.ts';
import { Store } from '../src/store.ts';
import { authHeaders, DEMO, login, multipart, sendJson, TEST_NOW, testApp } from './helpers.ts';

const PNG = new Uint8Array(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lY5P3wAAAABJRU5ErkJggg==',
    'base64',
  ),
);

describe('attachments and avatars', () => {
  const dir = mkdtempSync(join(tmpdir(), 'clay-uploads-'));
  const store = new Store(':memory:', {
    demo: true,
    demoAccounts: true,
    now: TEST_NOW,
    uploadDir: dir,
  });
  const { app } = testApp(store);

  after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function createProject(name: string, memberIds: string[] = []) {
    const cookie = await login(app);
    const created = await sendJson<{ id: string }>(app, cookie, 'POST', '/api/projects', {
      name,
      memberIds,
    });
    assert.equal(created.status, 201);
    return { cookie, id: created.body.id };
  }

  async function upload(
    cookie: string,
    projectId: string,
    file: File,
  ): Promise<{ status: number; body: { attachment?: Attachment; message?: string } }> {
    const res = await app.request(`/api/projects/${projectId}/attachments`, {
      method: 'POST',
      headers: authHeaders(cookie),
      body: multipart(file),
    });
    return { status: res.status, body: (await res.json()) as never };
  }

  test('uploads validate, store, list and serve signed downloads', async () => {
    const { cookie, id } = await createProject('附件项目');
    const file = new File(['会议纪要\n第二行'], '会议纪要.txt', { type: 'text/plain' });
    const uploaded = await upload(cookie, id, file);
    assert.equal(uploaded.status, 201);
    const attachment = uploaded.body.attachment;
    assert.ok(attachment);
    assert.equal(attachment.name, '会议纪要.txt');
    assert.equal(attachment.mime, 'text/plain');
    assert.equal(attachment.size, file.size);
    assert.match(attachment.downloadUrl, /^\/files\/attachments\//);
    assert.ok(Date.parse(attachment.downloadExpiresAt) > Date.now());

    const listRes = await app.request(`/api/projects/${id}/attachments`, {
      headers: authHeaders(cookie),
    });
    assert.equal(listRes.status, 200);
    const list = (await listRes.json()) as AttachmentList;
    assert.equal(list.attachments.length, 1);
    assert.deepEqual(list.usage, { count: 1, totalBytes: file.size });
    assert.equal(list.limits.maxCount, 50);

    const download = await app.request(attachment.downloadUrl);
    assert.equal(download.status, 200);
    assert.equal(download.headers.get('content-type'), 'text/plain');
    assert.equal(download.headers.get('x-content-type-options'), 'nosniff');
    assert.match(download.headers.get('content-disposition') ?? '', /attachment;/);
    assert.equal(await download.text(), '会议纪要\n第二行');

    const tampered = attachment.downloadUrl.replace(/sig=[0-9a-f]+/, `sig=${'0'.repeat(64)}`);
    assert.equal((await app.request(tampered)).status, 403);
    assert.equal((await app.request(attachment.downloadUrl.split('?')[0]!)).status, 403);

    const audit = store.audit.page({ page: 1, pageSize: 10 });
    assert.ok(audit.entries.some((entry) => entry.action === 'project.attachment_added'));
  });

  test('rejects unsafe, mismatched and unsupported files', async () => {
    const { cookie, id } = await createProject('不安全附件');
    const eicar = await upload(
      cookie,
      id,
      new File(
        ['X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*'],
        'virus.txt',
        { type: 'text/plain' },
      ),
    );
    assert.equal(eicar.status, 400);
    assert.match(eicar.body.message ?? '', /安全扫描/);

    const executable = await upload(cookie, id, new File(['MZ\x90\x00binary'], 'tool.exe'));
    assert.equal(executable.status, 400);

    const disguised = await upload(
      cookie,
      id,
      new File(['not really a png'], 'fake.png', { type: 'image/png' }),
    );
    assert.equal(disguised.status, 400);
    assert.match(disguised.body.message ?? '', /不匹配/);

    const wrongMime = await upload(
      cookie,
      id,
      new File(['plain text'], 'notes.txt', { type: 'image/png' }),
    );
    assert.equal(wrongMime.status, 400);

    const empty = await upload(cookie, id, new File([], 'empty.txt', { type: 'text/plain' }));
    assert.equal(empty.status, 400);
  });

  test('sanitizes names and enforces project membership on upload', async () => {
    const viewer = store.users.authByEmail(DEMO.viewer.email);
    assert.ok(viewer);
    const { cookie, id } = await createProject('成员权限', [viewer.id]);

    const traversal = await upload(
      cookie,
      id,
      new File(['safe'], '../../etc/passwd.txt', { type: 'text/plain' }),
    );
    assert.equal(traversal.status, 201);
    assert.equal(traversal.body.attachment?.name, 'passwd.txt');

    const viewerCookie = await login(app, DEMO.viewer.email);
    const denied = await upload(
      viewerCookie,
      id,
      new File(['viewer'], 'viewer.txt', { type: 'text/plain' }),
    );
    assert.equal(denied.status, 403);

    const list = await app.request(`/api/projects/${id}/attachments`, {
      headers: authHeaders(viewerCookie),
    });
    assert.equal(list.status, 200);

    const outsider = await createProject('外部项目');
    const outsiderList = await app.request(`/api/projects/${outsider.id}/attachments`, {
      headers: authHeaders(viewerCookie),
    });
    assert.equal(outsiderList.status, 404);
  });

  test('deletes attachments with uploader or manager rights and removes files', async () => {
    const { cookie, id } = await createProject('删除附件');
    const uploaded = await upload(
      cookie,
      id,
      new File(['delete me'], 'delete.txt', { type: 'text/plain' }),
    );
    assert.equal(uploaded.status, 201);
    const attachment = uploaded.body.attachment;
    assert.ok(attachment);
    const stored = store.attachments.find(attachment.id);
    assert.ok(stored);
    const path = store.uploads.resolvePath(stored.storedName);
    assert.ok(existsSync(path));

    const deleted = await app.request(`/api/projects/${id}/attachments/${attachment.id}`, {
      method: 'DELETE',
      headers: authHeaders(cookie),
    });
    assert.equal(deleted.status, 204);
    assert.equal(existsSync(path), false);
    assert.equal((await app.request(attachment.downloadUrl)).status, 404);

    const audit = store.audit.page({ page: 1, pageSize: 10 });
    assert.ok(audit.entries.some((entry) => entry.action === 'project.attachment_removed'));
  });

  test('uploads, serves and removes a cropped avatar', async () => {
    const cookie = await login(app);
    const profileBefore = (await (
      await app.request('/api/profile', {
        headers: authHeaders(cookie),
      })
    ).json()) as Profile;
    assert.equal(profileBefore.avatarUrl, null);

    const uploaded = await app.request('/api/profile/avatar', {
      method: 'POST',
      headers: authHeaders(cookie),
      body: multipart(new File([PNG], 'avatar.png', { type: 'image/png' })),
    });
    assert.equal(uploaded.status, 200);
    const { avatarUrl } = (await uploaded.json()) as { avatarUrl: string };
    assert.match(avatarUrl, /^\/api\/users\/.+\/avatar\?v=\d+$/);

    const image = await app.request(avatarUrl, { headers: authHeaders(cookie) });
    assert.equal(image.status, 200);
    assert.equal(image.headers.get('content-type'), 'image/png');
    assert.deepEqual(new Uint8Array(await image.arrayBuffer()), PNG);

    const me = (await (
      await app.request('/api/auth/me', {
        headers: authHeaders(cookie),
      })
    ).json()) as { user: { avatarUrl: string } };
    assert.equal(me.user.avatarUrl, avatarUrl);

    const directory = (await (
      await app.request('/api/users', {
        headers: authHeaders(cookie),
      })
    ).json()) as { users: { avatarUrl: string | null }[] };
    assert.ok(directory.users.some((user) => user.avatarUrl === avatarUrl));

    const invalid = await app.request('/api/profile/avatar', {
      method: 'POST',
      headers: authHeaders(cookie),
      body: multipart(new File(['nope'], 'avatar.png', { type: 'image/png' })),
    });
    assert.equal(invalid.status, 400);

    const removed = await app.request('/api/profile/avatar', {
      method: 'DELETE',
      headers: authHeaders(cookie),
    });
    assert.equal(removed.status, 204);
    assert.equal((await app.request(avatarUrl, { headers: authHeaders(cookie) })).status, 404);

    const profileAfter = (await (
      await app.request('/api/profile', {
        headers: authHeaders(cookie),
      })
    ).json()) as Profile;
    assert.equal(profileAfter.avatarUrl, null);
  });
});
