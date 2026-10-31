import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, extname, resolve, sep } from 'node:path';

export const MAX_ATTACHMENT_BYTES = 10_000_000;
export const MAX_AVATAR_BYTES = 2_000_000;
export const MAX_ATTACHMENTS_PER_PROJECT = 50;
export const MAX_PROJECT_ATTACHMENT_BYTES = 100_000_000;
export const DOWNLOAD_TTL_MS = 10 * 60_000;

const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

type FileType = { ext: string; mime: string; kind: 'image' | 'document' };

const FILE_TYPES: readonly FileType[] = [
  { ext: '.png', mime: 'image/png', kind: 'image' },
  { ext: '.jpg', mime: 'image/jpeg', kind: 'image' },
  { ext: '.jpeg', mime: 'image/jpeg', kind: 'image' },
  { ext: '.gif', mime: 'image/gif', kind: 'image' },
  { ext: '.webp', mime: 'image/webp', kind: 'image' },
  { ext: '.bmp', mime: 'image/bmp', kind: 'document' },
  { ext: '.tif', mime: 'image/tiff', kind: 'document' },
  { ext: '.tiff', mime: 'image/tiff', kind: 'document' },
  { ext: '.pdf', mime: 'application/pdf', kind: 'document' },
  { ext: '.txt', mime: 'text/plain', kind: 'document' },
  { ext: '.md', mime: 'text/markdown', kind: 'document' },
  { ext: '.csv', mime: 'text/csv', kind: 'document' },
  { ext: '.json', mime: 'application/json', kind: 'document' },
  { ext: '.zip', mime: 'application/zip', kind: 'document' },
  {
    ext: '.docx',
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    kind: 'document',
  },
  {
    ext: '.xlsx',
    mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    kind: 'document',
  },
  {
    ext: '.pptx',
    mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    kind: 'document',
  },
];

export type Inspection = { ok: true; mime: string; sha256: string } | { ok: false; reason: string };

function startsWith(data: Uint8Array, bytes: readonly number[], offset = 0): boolean {
  if (data.length < offset + bytes.length) return false;
  return bytes.every((byte, index) => data[offset + index] === byte);
}

function isText(data: Uint8Array): boolean {
  if (data.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(data);
    return true;
  } catch {
    return false;
  }
}

function isExecutable(data: Uint8Array): boolean {
  return (
    startsWith(data, [0x4d, 0x5a]) || // MZ
    startsWith(data, [0x7f, 0x45, 0x4c, 0x46]) || // ELF
    startsWith(data, [0xca, 0xfe, 0xba, 0xbe]) || // Mach-O fat
    startsWith(data, [0xfe, 0xed, 0xfa, 0xce]) ||
    startsWith(data, [0xfe, 0xed, 0xfa, 0xcf]) ||
    startsWith(data, [0xcf, 0xfa, 0xed, 0xfe]) ||
    startsWith(data, [0x23, 0x21]) // shebang
  );
}

function matchesType(type: FileType, data: Uint8Array): boolean {
  switch (type.ext) {
    case '.png':
      return startsWith(data, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case '.jpg':
    case '.jpeg':
      return startsWith(data, [0xff, 0xd8, 0xff]);
    case '.gif':
      return startsWith(data, [0x47, 0x49, 0x46, 0x38]);
    case '.webp':
      return (
        startsWith(data, [0x52, 0x49, 0x46, 0x46]) && startsWith(data, [0x57, 0x45, 0x42, 0x50], 8)
      );
    case '.bmp':
      return startsWith(data, [0x42, 0x4d]);
    case '.tif':
    case '.tiff':
      return (
        startsWith(data, [0x49, 0x49, 0x2a, 0x00]) || startsWith(data, [0x4d, 0x4d, 0x00, 0x2a])
      );
    case '.pdf':
      return startsWith(data, [0x25, 0x50, 0x44, 0x46, 0x2d]);
    case '.zip':
    case '.docx':
    case '.xlsx':
    case '.pptx':
      return (
        startsWith(data, [0x50, 0x4b, 0x03, 0x04]) || startsWith(data, [0x50, 0x4b, 0x05, 0x06])
      );
    case '.json':
      return isText(data);
    default:
      return isText(data);
  }
}

export function inspectUpload(
  name: string,
  declaredMime: string,
  data: Uint8Array,
  kind: 'attachment' | 'avatar',
): Inspection {
  if (data.byteLength === 0) return { ok: false, reason: '文件内容为空' };
  const buffer = Buffer.from(data);
  if (buffer.toString('latin1').includes(EICAR)) {
    return { ok: false, reason: '文件未通过安全扫描（EICAR 测试特征）' };
  }
  if (isExecutable(data)) {
    return { ok: false, reason: '可执行文件不允许上传' };
  }

  const extension = extname(name).toLowerCase();
  const type = FILE_TYPES.find((item) => item.ext === extension);
  if (!type) {
    return {
      ok: false,
      reason: '不支持该文件类型，请上传图片、PDF、文本、CSV、JSON 或 Office/ZIP 文档',
    };
  }
  if (kind === 'avatar' && type.kind !== 'image') {
    return { ok: false, reason: '头像仅支持 PNG、JPEG、GIF 或 WebP 图片' };
  }
  if (kind === 'avatar' && data.byteLength > MAX_AVATAR_BYTES) {
    return { ok: false, reason: '头像不能超过 2MB' };
  }
  if (declaredMime && declaredMime !== 'application/octet-stream' && declaredMime !== type.mime) {
    return { ok: false, reason: '文件类型与内容不匹配' };
  }
  if (!matchesType(type, data)) {
    return { ok: false, reason: '文件内容与扩展名不匹配' };
  }

  return {
    ok: true,
    mime: type.mime,
    sha256: createHash('sha256').update(buffer).digest('hex'),
  };
}

export function sniffImageMime(data: Uint8Array): string | null {
  if (startsWith(data, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(data, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(data, [0x47, 0x49, 0x46, 0x38])) return 'image/gif';
  if (startsWith(data, [0x52, 0x49, 0x46, 0x46]) && startsWith(data, [0x57, 0x45, 0x42, 0x50], 8)) {
    return 'image/webp';
  }
  return null;
}

export function safeFileName(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? '';
  const cleaned = base
    .replace(/\p{Cc}/gu, '')
    .replace(/[<>:"|?*]/g, '_')
    .trim()
    .slice(0, 160);
  return cleaned || 'file';
}

export class UploadStore {
  readonly root: string;
  readonly #secret: Buffer;

  constructor(root: string, secret?: string) {
    this.root = resolve(root);
    this.#secret = Buffer.from(secret ?? process.env.UPLOAD_SIGNING_SECRET ?? randomBytes(32));
    mkdirSync(this.root, { recursive: true });
    mkdirSync(resolve(this.root, 'attachments'), { recursive: true });
    mkdirSync(resolve(this.root, 'avatars'), { recursive: true });
  }

  resolvePath(storedName: string): string {
    const target = resolve(this.root, storedName);
    if (target !== this.root && !target.startsWith(this.root + sep)) {
      throw new Error('upload path escapes the storage root');
    }
    return target;
  }

  async write(storedName: string, data: Uint8Array): Promise<void> {
    const target = this.resolvePath(storedName);
    mkdirSync(dirname(target), { recursive: true });
    await writeFile(target, data, { mode: 0o600 });
  }

  async read(storedName: string): Promise<Buffer | null> {
    try {
      return await readFile(this.resolvePath(storedName));
    } catch {
      return null;
    }
  }

  async remove(storedName: string): Promise<void> {
    try {
      await rm(this.resolvePath(storedName), { force: true });
    } catch {
      // missing or already removed files are fine
    }
  }

  #signature(id: string, expires: string): string {
    return createHmac('sha256', this.#secret).update(`attachment:${id}:${expires}`).digest('hex');
  }

  signAttachment(id: string, now = Date.now()): { url: string; expiresAt: string } {
    const expires = String(now + DOWNLOAD_TTL_MS);
    const signature = this.#signature(id, expires);
    return {
      url: `/files/attachments/${encodeURIComponent(id)}?expires=${expires}&sig=${signature}`,
      expiresAt: new Date(Number(expires)).toISOString(),
    };
  }

  verifyAttachment(
    id: string,
    expires: string | undefined,
    signature: string | undefined,
  ): boolean {
    if (!expires || !signature || !/^\d+$/.test(expires)) return false;
    if (Number(expires) <= Date.now()) return false;
    const expected = Buffer.from(this.#signature(id, expires));
    const provided = Buffer.from(signature);
    return expected.length === provided.length && timingSafeEqual(expected, provided);
  }

  #avatarName(userId: string): string {
    return `avatars/${createHash('sha256').update(userId).digest('hex')}`;
  }

  async writeAvatar(userId: string, data: Uint8Array): Promise<void> {
    await this.write(this.#avatarName(userId), data);
  }

  async readAvatar(userId: string): Promise<Buffer | null> {
    return this.read(this.#avatarName(userId));
  }

  async removeAvatar(userId: string): Promise<void> {
    await this.remove(this.#avatarName(userId));
  }
}
