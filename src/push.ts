import type { PushStore, PushSubscriptionRecord, VapidConfig } from './stores/push.ts';

const encoder = new TextEncoder();
const RECORD_SIZE = 4096;
const JWT_TTL_SECONDS = 12 * 60 * 60;
const DEFAULT_TTL_SECONDS = 60 * 60;
const DEFAULT_CONTACT = 'mailto:admin@pulse.local';

export type PushPayload = { title: string; body?: string; link?: string | null; tag?: string };

export type PushSendResult = { sent: number; gone: number; failed: number };

function b64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

function fromB64url(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, 'base64url'));
}

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

async function hmacSha256(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
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

async function generateVapidKeys(now = new Date()): Promise<VapidConfig> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ]);
  const publicJwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  const privateJwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  const publicKey = b64url(
    concat(new Uint8Array([0x04]), fromB64url(publicJwk.x!), fromB64url(publicJwk.y!)),
  );
  void now;
  return { publicKey, privateKey: privateJwk.d! };
}

async function importVapidKey(config: VapidConfig): Promise<CryptoKey> {
  const raw = fromB64url(config.publicKey);
  return crypto.subtle.importKey(
    'jwk',
    {
      kty: 'EC',
      crv: 'P-256',
      x: b64url(raw.slice(1, 33)),
      y: b64url(raw.slice(33, 65)),
      d: config.privateKey,
      ext: true,
    },
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );
}

async function vapidJwt(
  endpoint: string,
  config: VapidConfig,
  contact: string,
  now: Date,
): Promise<string> {
  const header = b64url(encoder.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const payload = b64url(
    encoder.encode(
      JSON.stringify({
        aud: new URL(endpoint).origin,
        exp: Math.floor(now.getTime() / 1000) + JWT_TTL_SECONDS,
        sub: contact,
      }),
    ),
  );
  const key = await importVapidKey(config);
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    encoder.encode(`${header}.${payload}`),
  );
  return `${header}.${payload}.${b64url(new Uint8Array(signature))}`;
}

/** RFC 8291 aes128gcm body for a single record. */
export async function encryptWebPush(
  subscription: Pick<PushSubscriptionRecord, 'p256dh' | 'auth'>,
  plaintext: Uint8Array,
): Promise<Uint8Array> {
  const userAgentPublic = fromB64url(subscription.p256dh);
  const authSecret = fromB64url(subscription.auth);
  const ephemeral = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
    'deriveBits',
  ]);
  const ephemeralJwk = await crypto.subtle.exportKey('jwk', ephemeral.publicKey);
  const ephemeralPublic = concat(
    new Uint8Array([0x04]),
    fromB64url(ephemeralJwk.x!),
    fromB64url(ephemeralJwk.y!),
  );
  const userAgentKey = await crypto.subtle.importKey(
    'raw',
    source(userAgentPublic),
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  );
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: 'ECDH', public: userAgentKey },
      ephemeral.privateKey,
      256,
    ),
  );
  const keyInfo = concat(
    encoder.encode('WebPush: info'),
    new Uint8Array([0x00]),
    userAgentPublic,
    new Uint8Array([0x00]),
    ephemeralPublic,
  );
  const prkKey = await hmacSha256(authSecret, shared);
  const ikm = await hmacSha256(prkKey, keyInfo);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, encoder.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, encoder.encode('Content-Encoding: nonce\0'), 12);

  const padded = concat(plaintext, new Uint8Array([0x02]));
  const aesKey = await crypto.subtle.importKey('raw', source(cek), { name: 'AES-GCM' }, false, [
    'encrypt',
  ]);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: source(nonce) }, aesKey, source(padded)),
  );

  const recordSize = new Uint8Array(4);
  new DataView(recordSize.buffer).setUint32(0, RECORD_SIZE, false);
  return concat(
    salt,
    recordSize,
    new Uint8Array([ephemeralPublic.length]),
    ephemeralPublic,
    ciphertext,
  );
}

export class PushSender {
  readonly #store: Pick<PushStore, 'config' | 'ensureConfig' | 'list' | 'remove' | 'markUsed'>;
  readonly #fetch: typeof fetch;
  readonly #contact: string;
  readonly #timeoutMs: number;
  readonly #envKeys: VapidConfig | null;
  #keys: VapidConfig | null = null;
  #ready: Promise<VapidConfig | null> | null = null;

  constructor(
    store: Pick<PushStore, 'config' | 'ensureConfig' | 'list' | 'remove' | 'markUsed'>,
    options: {
      fetchImpl?: typeof fetch;
      contact?: string;
      timeoutMs?: number;
      enabled?: boolean;
      publicKey?: string;
      privateKey?: string;
    } = {},
  ) {
    this.#store = store;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#contact = options.contact ?? process.env.PUSH_CONTACT ?? DEFAULT_CONTACT;
    this.#timeoutMs = options.timeoutMs ?? 8_000;
    if (options.enabled === false) {
      this.#envKeys = null;
      this.#keys = null;
      this.#ready = Promise.resolve(null);
    } else {
      const publicKey = options.publicKey ?? process.env.VAPID_PUBLIC_KEY?.trim();
      const privateKey = options.privateKey ?? process.env.VAPID_PRIVATE_KEY?.trim();
      this.#envKeys = publicKey && privateKey ? { publicKey, privateKey } : null;
    }
  }

  async init(): Promise<void> {
    await this.#ensureKeys();
  }

  get enabled(): boolean {
    return this.#keys !== null;
  }

  get publicKey(): string | null {
    return this.#keys?.publicKey ?? null;
  }

  async #ensureKeys(): Promise<VapidConfig | null> {
    if (this.#keys) return this.#keys;
    if (!this.#ready) {
      this.#ready = (async () => {
        if (this.#envKeys) {
          this.#keys = this.#envKeys;
        } else {
          const generated = await generateVapidKeys();
          this.#keys = this.#store.ensureConfig(generated.publicKey, generated.privateKey);
        }
        return this.#keys;
      })();
    }
    return this.#ready;
  }

  async sendToUser(
    userId: string,
    payload: PushPayload,
    now = new Date(),
  ): Promise<PushSendResult> {
    const keys = await this.#ensureKeys();
    if (!keys) return { sent: 0, gone: 0, failed: 0 };
    const subscriptions = this.#store.list(userId);
    const result: PushSendResult = { sent: 0, gone: 0, failed: 0 };
    const data = encoder.encode(
      JSON.stringify({
        title: payload.title.slice(0, 120),
        body: (payload.body ?? '').slice(0, 240),
        link: payload.link ?? '/',
        tag: payload.tag,
        icon: '/icons/icon-192.png',
      }),
    );
    for (const subscription of subscriptions) {
      try {
        await this.#sendOne(subscription, keys, data, now);
        this.#store.markUsed(subscription.id, now);
        result.sent++;
      } catch (cause) {
        if (cause instanceof PushGoneError) {
          this.#store.remove(subscription.id);
          result.gone++;
        } else {
          result.failed++;
        }
      }
    }
    return result;
  }

  async #sendOne(
    subscription: PushSubscriptionRecord,
    keys: VapidConfig,
    data: Uint8Array,
    now: Date,
  ): Promise<void> {
    const jwt = await vapidJwt(subscription.endpoint, keys, this.#contact, now);
    const body = await encryptWebPush(subscription, data);
    const response = await this.#fetch(subscription.endpoint, {
      method: 'POST',
      headers: {
        authorization: `vapid t=${jwt}, k=${keys.publicKey}`,
        'content-encoding': 'aes128gcm',
        'content-type': 'application/octet-stream',
        ttl: String(DEFAULT_TTL_SECONDS),
        urgency: 'normal',
      },
      body,
      signal: AbortSignal.timeout(this.#timeoutMs),
    });
    if (response.status === 404 || response.status === 410) throw new PushGoneError();
    if (!response.ok) throw new Error(`push rejected with ${response.status}`);
  }
}

export class PushGoneError extends Error {
  constructor() {
    super('push subscription expired');
    this.name = 'PushGoneError';
  }
}
