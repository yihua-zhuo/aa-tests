import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import type { PushStatus } from '../shared/types.ts';
import { PushSender } from '../src/push.ts';
import { PushWorker } from '../src/push-worker.ts';
import { Store } from '../src/store.ts';
import { DEMO, getJson, login, sendJson, TEST_NOW, testApp } from './helpers.ts';

const encoder = new TextEncoder();

function source(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function b64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

function fromB64url(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, 'base64url'));
}

async function userAgentKeys() {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
    'deriveBits',
  ])) as { publicKey: CryptoKey; privateKey: CryptoKey };
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  const publicRaw = concat(new Uint8Array([0x04]), fromB64url(jwk.x!), fromB64url(jwk.y!));
  const authRaw = crypto.getRandomValues(new Uint8Array(16));
  return {
    privateKey: pair.privateKey,
    publicRaw,
    publicKey: b64url(publicRaw),
    auth: b64url(authRaw),
    authRaw,
  };
}

async function hmac(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    source(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, source(data)));
}

async function hkdf(
  salt: Uint8Array,
  ikm: Uint8Array,
  info: Uint8Array,
  length: number,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', source(ikm), 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: source(salt), info: source(info) },
    key,
    length * 8,
  );
  return new Uint8Array(bits);
}

/** Independent RFC 8291 decryption to prove the sender interoperates. */
async function decryptPush(
  body: Uint8Array,
  ua: Awaited<ReturnType<typeof userAgentKeys>>,
): Promise<{ recordSize: number; payload: Record<string, unknown> }> {
  const salt = body.slice(0, 16);
  const recordSize = new DataView(body.buffer, body.byteOffset + 16, 4).getUint32(0);
  const idLength = body[20]!;
  const ephemeralPublic = body.slice(21, 21 + idLength);
  const ciphertext = body.slice(21 + idLength);

  const ephemeralKey = await crypto.subtle.importKey(
    'raw',
    source(ephemeralPublic),
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  );
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'ECDH', public: ephemeralKey }, ua.privateKey, 256),
  );
  const keyInfo = concat(
    encoder.encode('WebPush: info'),
    new Uint8Array([0]),
    ua.publicRaw,
    new Uint8Array([0]),
    ephemeralPublic,
  );
  const prk = await hmac(ua.authRaw, shared);
  const ikm = await hmac(prk, keyInfo);
  const cek = await hkdf(salt, ikm, encoder.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, encoder.encode('Content-Encoding: nonce\0'), 12);
  const aesKey = await crypto.subtle.importKey('raw', source(cek), { name: 'AES-GCM' }, false, [
    'decrypt',
  ]);
  const plain = new Uint8Array(
    await crypto.subtle.decrypt({ name: 'AES-GCM', iv: source(nonce) }, aesKey, source(ciphertext)),
  );
  let end = plain.length - 1;
  while (end >= 0 && plain[end] === 0) end--;
  assert.equal(plain[end], 0x02, 'payload must end with the 0x02 delimiter');
  return {
    recordSize,
    payload: JSON.parse(new TextDecoder().decode(plain.slice(0, end))) as Record<string, unknown>,
  };
}

describe('web push', () => {
  const store = new Store(':memory:', { demo: true, demoAccounts: true, now: TEST_NOW });
  after(() => store.close());

  test('reports status and validates subscriptions', async () => {
    const sender = new PushSender(store.push);
    const { app } = testApp(store, { push: sender });
    const cookie = await login(app);

    const status = await getJson<PushStatus>(app, cookie, '/api/push');
    assert.equal(status.enabled, true);
    assert.ok(status.publicKey);
    assert.equal(fromB64url(status.publicKey!).length, 65);
    assert.equal(status.subscriptions, 0);

    const ua = await userAgentKeys();
    const insecure = await sendJson(app, cookie, 'POST', '/api/push/subscribe', {
      endpoint: 'http://push.example.com/sub',
      keys: { p256dh: ua.publicKey, auth: ua.auth },
    });
    assert.equal(insecure.status, 400);
    const internal = await sendJson(app, cookie, 'POST', '/api/push/subscribe', {
      endpoint: 'https://10.0.0.8/sub',
      keys: { p256dh: ua.publicKey, auth: ua.auth },
    });
    assert.equal(internal.status, 400);

    const endpoint = 'https://push.example.com/sub/one';
    const created = await sendJson<{ id: string; endpoint: string }>(
      app,
      cookie,
      'POST',
      '/api/push/subscribe',
      { endpoint, keys: { p256dh: ua.publicKey, auth: ua.auth } },
    );
    assert.equal(created.status, 201);
    assert.equal(created.body.endpoint, endpoint);

    const repeated = await sendJson<{ id: string }>(app, cookie, 'POST', '/api/push/subscribe', {
      endpoint,
      keys: { p256dh: ua.publicKey, auth: ua.auth },
    });
    assert.equal(repeated.status, 201);
    assert.equal(repeated.body.id, created.body.id, 'endpoint upserts instead of duplicating');
    assert.equal((await getJson<PushStatus>(app, cookie, '/api/push')).subscriptions, 1);

    const removed = await sendJson(app, cookie, 'DELETE', '/api/push/subscribe', { endpoint });
    assert.equal(removed.status, 204);
    assert.equal((await getJson<PushStatus>(app, cookie, '/api/push')).subscriptions, 0);

    const disabled = new PushSender(store.push, { enabled: false });
    const { app: disabledApp } = testApp(store, { push: disabled });
    const disabledCookie = await login(disabledApp);
    const offline = await getJson<PushStatus>(disabledApp, disabledCookie, '/api/push');
    assert.equal(offline.enabled, false);
    assert.equal(offline.publicKey, null);
    const rejected = await sendJson(disabledApp, disabledCookie, 'POST', '/api/push/subscribe', {
      endpoint,
      keys: { p256dh: ua.publicKey, auth: ua.auth },
    });
    assert.equal(rejected.status, 404);
  });

  test('worker encrypts a decryptable payload and marks notifications pushed', async () => {
    const admin = store.users.authByEmail(DEMO.admin.email);
    assert.ok(admin);
    const ua = await userAgentKeys();
    const endpoint = 'https://push.example.com/sub/worker';
    store.push.subscribe(
      admin.id,
      { endpoint, p256dh: ua.publicKey, auth: ua.auth },
      'node-test',
      TEST_NOW,
    );

    let captured: { url: string; init: RequestInit } | null = null;
    const sender = new PushSender(store.push, {
      fetchImpl: async (input, init) => {
        captured = { url: String(input), init: init ?? {} };
        return new Response(null, { status: 201 });
      },
    });
    await sender.init();
    assert.ok(sender.publicKey);

    const notificationId = store.notifications.create({
      userId: admin.id,
      type: 'task_assigned',
      title: '新的任务指派',
      body: '请查看任务详情',
      link: '/projects/00000000-0000-4000-8000-000000000000',
      createdAt: TEST_NOW.toISOString(),
    });
    const worker = new PushWorker(store, sender);
    const result = await worker.tick(TEST_NOW);
    assert.deepEqual(result, { pending: 1, delivered: 1, failed: 0, gone: 0 });
    assert.ok(captured);
    const request = captured as { url: string; init: RequestInit };
    assert.equal(request.url, endpoint);
    const headers = new Headers(request.init.headers);
    assert.match(headers.get('authorization') ?? '', /^vapid t=[^,]+, k=[A-Za-z0-9_-]+$/);
    assert.equal(headers.get('content-encoding'), 'aes128gcm');
    assert.equal(headers.get('ttl'), '3600');

    const jwt = (headers.get('authorization') ?? '').slice('vapid t='.length).split(',')[0]!;
    const claims = JSON.parse(Buffer.from(jwt.split('.')[1]!, 'base64url').toString('utf8')) as {
      aud: string;
      sub: string;
      exp: number;
    };
    assert.equal(claims.aud, 'https://push.example.com');
    assert.match(claims.sub, /^mailto:/);
    assert.ok(claims.exp > Math.floor(TEST_NOW.getTime() / 1000));

    const body = new Uint8Array(Buffer.from(request.init.body as Uint8Array));
    const { recordSize, payload } = await decryptPush(body, ua);
    assert.equal(recordSize, 4096);
    assert.equal(payload.title, '新的任务指派');
    assert.equal(payload.body, '请查看任务详情');
    assert.equal(payload.link, '/projects/00000000-0000-4000-8000-000000000000');
    assert.equal(payload.tag, notificationId);
    assert.equal(payload.icon, '/icons/icon-192.png');

    const subscription = store.push.list(admin.id)[0];
    assert.equal(subscription?.lastUsedAt, TEST_NOW.toISOString());
    assert.equal(store.notifications.pendingPush(TEST_NOW).length, 0);
  });

  test('drops subscriptions that respond 410', async () => {
    const admin = store.users.authByEmail(DEMO.admin.email);
    assert.ok(admin);
    const ua = await userAgentKeys();
    store.push.subscribe(
      admin.id,
      {
        endpoint: 'https://push.example.com/sub/gone',
        p256dh: ua.publicKey,
        auth: ua.auth,
      },
      null,
    );
    const sender = new PushSender(store.push, {
      fetchImpl: async () => new Response(null, { status: 410 }),
    });
    await sender.init();
    store.notifications.create({
      userId: admin.id,
      type: 'comment',
      title: '新评论',
      createdAt: TEST_NOW.toISOString(),
    });
    const worker = new PushWorker(store, sender);
    const result = await worker.tick(TEST_NOW);
    assert.deepEqual(result, { pending: 1, delivered: 0, failed: 0, gone: 2 });
    assert.equal(store.push.count(admin.id), 0);
  });
});
