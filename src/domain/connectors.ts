import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { isPrivateHost, webhookUrlIssue } from '../../shared/webhooks.ts';
import type { Database } from '../db.ts';

const KEY_SETTING = 'connector.encryption_key';
const KEY_VERSION = 'v1';
const MAX_ENVELOPE_LENGTH = 20_000;

type KeyRow = { value: string };

function masterKey(db: Database): Buffer {
  const env = process.env.CONNECTOR_ENCRYPTION_KEY?.trim();
  if (env) {
    const key = Buffer.from(env, 'base64');
    if (key.length !== 32) {
      throw new Error('CONNECTOR_ENCRYPTION_KEY 必须是 32 字节的 base64 字符串');
    }
    return key;
  }
  const select = db.stmt('SELECT value FROM app_settings WHERE key = ?');
  const existing = select.get(KEY_SETTING) as unknown as KeyRow | undefined;
  if (existing?.value) return Buffer.from(existing.value, 'base64');
  const generated = randomBytes(32).toString('base64');
  db.stmt('INSERT OR IGNORE INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)').run(
    KEY_SETTING,
    generated,
    new Date().toISOString(),
  );
  const stored = select.get(KEY_SETTING) as unknown as KeyRow;
  return Buffer.from(stored.value, 'base64');
}

/** AES-256-GCM envelope: v1:<keyId>:<iv>:<tag>:<ciphertext> (base64url parts). */
export function encryptConnectorSecret(db: Database, plaintext: string): string {
  const key = masterKey(db);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const keyId = createHash('sha256').update(key).digest('hex').slice(0, 12);
  return [
    KEY_VERSION,
    keyId,
    iv.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
    ciphertext.toString('base64url'),
  ].join(':');
}

export function decryptConnectorSecret(db: Database, envelope: string): string | null {
  if (!envelope || envelope.length > MAX_ENVELOPE_LENGTH) return null;
  const [version, , ivPart, tagPart, dataPart] = envelope.split(':');
  if (version !== KEY_VERSION || !ivPart || !tagPart || !dataPart) return null;
  try {
    const decipher = createDecipheriv(
      'aes-256-gcm',
      masterKey(db),
      Buffer.from(ivPart, 'base64url'),
    );
    decipher.setAuthTag(Buffer.from(tagPart, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(dataPart, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    return null;
  }
}

export function connectorCapabilities(kind: string, scopes: string[]): string[] {
  const base =
    kind === 'oauth'
      ? ['oauth2', 'http', 'refresh']
      : kind === 'webhook'
        ? ['http', 'webhook']
        : kind === 'service_account'
          ? ['service_account', 'http']
          : ['http', 'api_key'];
  return [...new Set([...base, ...scopes.map((scope) => scope.trim()).filter(Boolean)])];
}

export function connectorEgressIssue(raw: string, allowedDomains: string[]): string | null {
  const issue = webhookUrlIssue(raw);
  if (issue) return issue;
  const url = new URL(raw);
  const allow = allowedDomains
    .map((domain) => domain.trim().toLowerCase().replace(/^\*\./, ''))
    .filter(Boolean);
  if (allow.length === 0) return null;
  const host = url.hostname.toLowerCase();
  const permitted = allow.some((domain) => host === domain || host.endsWith(`.${domain}`));
  return permitted ? null : `域 ${host} 不在连接器的允许列表内`;
}

export async function safeConnectorTarget(
  raw: string,
  allowedDomains: string[],
): Promise<{ url: URL } | { issue: string }> {
  const issue = connectorEgressIssue(raw, allowedDomains);
  if (issue) return { issue };
  const url = new URL(raw);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host)) {
    return isPrivateHost(host) ? { issue: '不能指向本机或内网地址' } : { url };
  }
  try {
    const addresses = await lookup(host, { all: true, verbatim: true });
    if (addresses.length === 0) return { issue: '域名无法解析' };
    if (addresses.some((entry) => isPrivateHost(entry.address))) {
      return { issue: '不能指向本机或内网地址' };
    }
  } catch {
    return { issue: '域名无法解析' };
  }
  return { url };
}

export function connectorRateIssue(
  db: Database,
  connectorId: string,
  rateLimit: number,
  now: string,
): string | null {
  const since = new Date(Date.parse(now) - 3_600_000).toISOString();
  const row = db
    .stmt(
      `SELECT COUNT(*) AS count FROM connector_calls
       WHERE connector_id = ? AND created_at >= ?`,
    )
    .get(connectorId, since) as unknown as { count: number };
  return Number(row.count) >= rateLimit ? `连接器已达到每小时 ${rateLimit} 次调用上限` : null;
}

export type ConnectorCallLog = {
  connectorId: string;
  workspaceId: string;
  method: string;
  url: string;
  status: number | null;
  ok: boolean;
  error: string | null;
  durationMs: number;
  userId: string | null;
  now: string;
};

export function logConnectorCall(db: Database, log: ConnectorCallLog): void {
  db.stmt(
    `INSERT INTO connector_calls
       (id, connector_id, workspace_id, method, url, status, ok, error, duration_ms,
        created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    cryptoId(),
    log.connectorId,
    log.workspaceId,
    log.method,
    log.url,
    log.status,
    log.ok ? 1 : 0,
    log.error,
    log.durationMs,
    log.userId,
    log.now,
  );
  db.stmt('UPDATE connectors SET last_call_at = ?, updated_at = ? WHERE id = ?').run(
    log.now,
    log.now,
    log.connectorId,
  );
}

function cryptoId(): string {
  return randomBytes(16).toString('hex');
}

/** Removes secret material before records leave the server. */
export function connectorView<T extends Record<string, unknown>>(record: T): T {
  const view: Record<string, unknown> = { ...record };
  const secretRef = typeof view.secretRef === 'string' ? view.secretRef : '';
  const clientSecretRef = typeof view.clientSecretRef === 'string' ? view.clientSecretRef : '';
  delete view.secretRef;
  delete view.clientSecretRef;
  if (Array.isArray(view.scopesJson)) view.scopes = view.scopesJson;
  if (Array.isArray(view.allowedDomainsJson)) view.allowedDomains = view.allowedDomainsJson;
  if (Array.isArray(view.capabilitiesJson)) view.capabilities = view.capabilitiesJson;
  view.hasSecret = secretRef !== '';
  view.hasClientSecret = clientSecretRef !== '';
  view.secretStatus = secretRef === '' ? 'missing' : 'configured';
  return view as T;
}
