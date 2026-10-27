import { connect as netConnect, type Socket } from 'node:net';
import { connect as tlsConnect } from 'node:tls';

export type MailMessage = {
  to: string;
  subject: string;
  text: string;
};

export type Mailer = {
  send(message: MailMessage): Promise<void>;
};

export type SmtpConfig = {
  host: string;
  port: number;
  secure: boolean;
  from: string;
  user?: string;
  pass?: string;
  helo: string;
  allowInsecureAuth: boolean;
};

type SmtpResponse = { code: number; lines: string[] };

const TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const ADDRESS_PATTERN = /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/;

function assertAddress(value: string, label: string): string {
  const address = value.trim();
  if (!ADDRESS_PATTERN.test(address) || /[\r\n]/.test(address)) {
    throw new Error(`${label}地址无效`);
  }
  return address;
}

function encodeHeader(value: string): string {
  const safe = value.replace(/[\r\n]+/g, ' ').trim();
  if (safe.length === 0) return '';
  if (/^[\x20-\x7e]+$/.test(safe) && safe.length < 60) return safe;
  const words: string[] = [];
  let chunk = '';
  for (const char of safe) {
    if (Buffer.byteLength(chunk + char, 'utf8') > 45) {
      words.push(chunk);
      chunk = '';
    }
    chunk += char;
  }
  if (chunk) words.push(chunk);
  return words
    .map((word) => `=?UTF-8?B?${Buffer.from(word, 'utf8').toString('base64')}?=`)
    .join('\r\n ');
}

function wrapBase64(value: string): string {
  return value.replace(/.{1,76}/g, (line) => `${line}\r\n`).trimEnd();
}

function buildMessage(message: MailMessage, from: string, to: string): string {
  return [
    `Date: ${new Date().toUTCString()}`,
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${encodeHeader(message.subject)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    wrapBase64(Buffer.from(message.text, 'utf8').toString('base64')),
  ].join('\r\n');
}

class SmtpSession {
  readonly #socket: Socket;
  readonly #timeoutMs: number;
  #buffer = '';
  #lines: string[] = [];
  #pending: {
    resolve: (response: SmtpResponse) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  } | null = null;
  #failure: Error | null = null;

  constructor(socket: Socket, timeoutMs = TIMEOUT_MS) {
    this.#socket = socket;
    this.#timeoutMs = timeoutMs;
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => this.#onData(chunk));
    socket.on('error', (error: Error) => this.#fail(error));
    socket.on('close', () => this.#fail(new Error('SMTP 连接已关闭')));
  }

  #onData(chunk: string): void {
    this.#buffer += chunk;
    if (this.#buffer.length > MAX_RESPONSE_BYTES) {
      this.#fail(new Error('SMTP 响应过大'));
      return;
    }
    let index = this.#buffer.indexOf('\n');
    while (index !== -1) {
      const line = this.#buffer.slice(0, index).replace(/\r$/, '');
      this.#buffer = this.#buffer.slice(index + 1);
      this.#lines.push(line);
      index = this.#buffer.indexOf('\n');
    }
    this.#flush();
  }

  #flush(): void {
    if (!this.#pending) return;
    const end = this.#lines.findIndex((line) => /^\d{3} /.test(line));
    if (end === -1) return;
    const lines = this.#lines.slice(0, end + 1);
    this.#lines = this.#lines.slice(end + 1);
    const pending = this.#pending;
    this.#pending = null;
    clearTimeout(pending.timer);
    pending.resolve({ code: Number(lines[end]?.slice(0, 3)), lines });
  }

  #fail(error: Error): void {
    this.#failure ??= error;
    if (!this.#pending) return;
    const pending = this.#pending;
    this.#pending = null;
    clearTimeout(pending.timer);
    pending.reject(error);
    this.#socket.destroy();
  }

  next(): Promise<SmtpResponse> {
    if (this.#failure) return Promise.reject(this.#failure);
    return new Promise<SmtpResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#fail(new Error('SMTP 响应超时'));
      }, this.#timeoutMs);
      this.#pending = { resolve, reject, timer };
      this.#flush();
    });
  }

  write(line: string): void {
    this.#socket.write(`${line}\r\n`);
  }

  async command(line: string, expected: readonly number[]): Promise<SmtpResponse> {
    this.write(line);
    const response = await this.next();
    if (!expected.includes(response.code)) {
      throw new Error(`SMTP 命令被拒绝（${response.code}）：${response.lines.at(-1) ?? ''}`);
    }
    return response;
  }

  close(): void {
    this.#socket.destroy();
  }
}

async function sendSmtp(config: SmtpConfig, message: MailMessage): Promise<void> {
  const from = assertAddress(config.from, '发件人');
  const to = assertAddress(message.to, '收件人');
  const socket = config.secure
    ? tlsConnect({ host: config.host, port: config.port, servername: config.host })
    : netConnect({ host: config.host, port: config.port });
  const session = new SmtpSession(socket);
  try {
    const greeting = await session.next();
    if (greeting.code !== 220) throw new Error(`SMTP 服务未就绪（${greeting.code}）`);
    await session.command(`EHLO ${config.helo}`, [250]);
    if (config.user) {
      if (!config.secure && !config.allowInsecureAuth) {
        throw new Error('SMTP 认证需要 TLS（设置 SMTP_SECURE=1）');
      }
      const token = Buffer.from(`\0${config.user}\0${config.pass ?? ''}`, 'utf8').toString(
        'base64',
      );
      await session.command(`AUTH PLAIN ${token}`, [235]);
    }
    await session.command(`MAIL FROM:<${from}>`, [250]);
    await session.command(`RCPT TO:<${to}>`, [250, 251]);
    await session.command('DATA', [354]);
    const payload = buildMessage(message, from, to).replace(/\r\n\./g, '\r\n..');
    session.write(`${payload}\r\n.`);
    const stored = await session.next();
    if (stored.code !== 250) {
      throw new Error(`SMTP 拒收邮件（${stored.code}）`);
    }
    await session.command('QUIT', [221]).catch(() => undefined);
  } finally {
    session.close();
  }
}

export function smtpConfigFromEnv(env: NodeJS.ProcessEnv = process.env): SmtpConfig | null {
  const host = env.SMTP_HOST?.trim();
  const from = env.SMTP_FROM?.trim();
  if (!host || !from) return null;
  const secure = /^(1|true|yes)$/i.test(env.SMTP_SECURE ?? '');
  const rawPort = env.SMTP_PORT?.trim();
  const port = rawPort ? Number(rawPort) : secure ? 465 : 25;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('SMTP_PORT 无效');
  }
  const user = env.SMTP_USER?.trim() || undefined;
  const pass = env.SMTP_PASS;
  return {
    host,
    port,
    secure,
    from,
    user,
    pass,
    helo: env.SMTP_HELO?.trim() || 'localhost',
    allowInsecureAuth: /^(1|true|yes)$/i.test(env.SMTP_ALLOW_INSECURE_AUTH ?? ''),
  };
}

export function createMailer(env: NodeJS.ProcessEnv = process.env): Mailer | null {
  let config: SmtpConfig | null;
  try {
    config = smtpConfigFromEnv(env);
  } catch {
    return null;
  }
  if (!config) return null;
  return { send: (message) => sendSmtp(config as SmtpConfig, message) };
}

export const mailerInternals = { buildMessage, encodeHeader };
