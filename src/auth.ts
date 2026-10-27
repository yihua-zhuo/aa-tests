import {
  createHash,
  randomBytes,
  type ScryptOptions,
  scrypt as scryptCallback,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';

const SCRYPT = { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;

export const SESSION_COOKIE = 'np_session';
export const SESSION_COOKIE_HOST = '__Host-np_session';
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const SESSION_MAX_AGE = Math.floor(SESSION_TTL_MS / 1000);

const idleHours = Number(process.env.SESSION_IDLE_HOURS);
export const SESSION_IDLE_MS =
  (Number.isFinite(idleHours) && idleHours > 0 ? Math.min(idleHours, 24 * 7) : 12) * 60 * 60 * 1000;

function derive(
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, keylen, options, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

function encode(key: Buffer, salt: Buffer, params: typeof SCRYPT): string {
  return [
    'scrypt',
    params.N,
    params.r,
    params.p,
    salt.toString('base64url'),
    key.toString('base64url'),
  ].join('$');
}

export function hashPasswordSync(password: string): string {
  const salt = randomBytes(SALT_LENGTH);
  return encode(scryptSync(password, salt, KEY_LENGTH, SCRYPT), salt, SCRYPT);
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  return encode(await derive(password, salt, KEY_LENGTH, SCRYPT), salt, SCRYPT);
}

function parse(stored: string): { params: ScryptOptions; salt: Buffer; expected: Buffer } | null {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return null;

  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return null;
  if (N < 4096 || N > 1_048_576 || r < 1 || r > 32 || p < 1 || p > 8) return null;

  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[4] ?? '', 'base64url');
    expected = Buffer.from(parts[5] ?? '', 'base64url');
  } catch {
    return null;
  }
  if (salt.length < 8 || expected.length < 16) return null;
  return { params: { N, r, p, maxmem: SCRYPT.maxmem }, salt, expected };
}

export function verifyPasswordSync(password: string, stored: string): boolean {
  const parsed = parse(stored);
  if (!parsed) return false;
  try {
    const actual = scryptSync(password, parsed.salt, parsed.expected.length, parsed.params);
    return actual.length === parsed.expected.length && timingSafeEqual(actual, parsed.expected);
  } catch {
    return false;
  }
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parsed = parse(stored);
  if (!parsed) return false;
  try {
    const actual = await derive(password, parsed.salt, parsed.expected.length, parsed.params);
    return actual.length === parsed.expected.length && timingSafeEqual(actual, parsed.expected);
  } catch {
    return false;
  }
}

// Hashing once at startup keeps unknown-email logins on the same async code path.
const DUMMY_PASSWORD_HASH = hashPasswordSync('pulse-dummy-password');

/** A valid hash used to equalize timing when the email is unknown. */
export function dummyHash(): string {
  return DUMMY_PASSWORD_HASH;
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function createSessionToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, tokenHash: hashToken(token) };
}

export function sessionCookieName(secure: boolean): string {
  return secure ? SESSION_COOKIE_HOST : SESSION_COOKIE;
}

export function cookieOptions(secure: boolean) {
  return {
    httpOnly: true,
    sameSite: 'Lax' as const,
    path: '/',
    maxAge: SESSION_MAX_AGE,
    secure,
  };
}
