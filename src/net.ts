import { createHash, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import type { Context } from 'hono';

type ConnEnv = { incoming?: { socket?: { remoteAddress?: string | null } } };

function normalizeIp(value: string | null | undefined): string {
  if (!value) return 'local';
  const ip = value.startsWith('::ffff:') ? value.slice(7) : value;
  return ip.slice(0, 64);
}

export function requestIp(env: unknown, headers: Headers, trustProxy: boolean): string {
  const socketIp = (env as ConnEnv | undefined)?.incoming?.socket?.remoteAddress;
  if (!trustProxy) return normalizeIp(socketIp);
  const forwarded = headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  return normalizeIp(forwarded || headers.get('cf-connecting-ip') || socketIp);
}

export function contextIp(c: Context, trustProxy: boolean): string {
  return requestIp(c.env, c.req.raw.headers, trustProxy);
}

export function parseOrigins(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function parseHosts(value: string | undefined): string[] {
  return parseOrigins(value).map((entry) => entry.toLowerCase());
}

function hostnameOf(hostHeader: string): string | null {
  try {
    return new URL(`http://${hostHeader}`).hostname.toLowerCase();
  } catch {
    return null;
  }
}

// Browsers cannot forge Host, so rejecting unknown DNS names blocks DNS
// rebinding while keeping localhost and direct IP access working.
export function hostAllowed(hostHeader: string | undefined, allowed: readonly string[]): boolean {
  if (!hostHeader) return true;
  const hostname = hostnameOf(hostHeader);
  if (!hostname) return false;
  if (allowed.includes('*')) return true;

  const bare = hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (bare === 'localhost' || bare.endsWith('.localhost')) return true;
  if (isIP(bare) !== 0) return true;
  return allowed.some((entry) => entry.replace(/\.$/, '') === bare);
}

export function originAllowed(
  origin: string | undefined,
  host: string | undefined,
  allowed: readonly string[],
): boolean {
  if (!origin) return true;
  if (origin === 'null') return false;

  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  if (host && url.host.toLowerCase() === host.toLowerCase()) return true;

  const normalized = `${url.protocol}//${url.host}`;
  return allowed.some((entry) => entry.replace(/\/+$/, '') === normalized);
}

// Compares digests so the comparison time does not reveal the token length.
export function safeEqual(provided: string, expected: string): boolean {
  const a = createHash('sha256').update(provided).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}
