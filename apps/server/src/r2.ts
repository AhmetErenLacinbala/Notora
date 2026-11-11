import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { DatabaseSync } from 'node:sqlite';

export const R2_LIMIT_BYTES = 9_000_000_000;
const PART_BYTES = 8 * 1024 * 1024;
const CLASS_A_LIMIT = 800_000;
const CLASS_B_LIMIT = 8_000_000;
const CLASS_A_DAY_LIMIT = 20_000;
const CLASS_B_DAY_LIMIT = 200_000;
const KEY_PATTERN = /^notora\/[0-9a-f]{32}\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/;

export interface GatewayStatus {
  usedBytes: number; reservedBytes: number; limitBytes: number;
  classAUsed: number; classALimit: number; classBUsed: number; classBLimit: number; month: string;
}
export interface GatewayObject { key: string; size: number }
export class GatewayError extends Error {
  constructor(message: string, public readonly statusCode = 503) { super(message); }
}
function validCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
function objectSize(headers: Headers): number {
  // Cloudflare may compress a response or stream it without Content-Length.
  // The gateway's ledger-backed header is the uncompressed R2 object size.
  const authoritative = headers.get('x-notora-object-size');
  const raw = authoritative ?? headers.get('content-length');
  if (raw === null || !/^(0|[1-9]\d*)$/.test(raw)) throw new GatewayError('Invalid storage length');
  if (authoritative === null && headers.get('content-encoding')
    && headers.get('content-encoding') !== 'identity') throw new GatewayError('Unverified storage length');
  const size = Number(raw);
  if (!validCount(size)) throw new GatewayError('Invalid storage length');
  return size;
}
function safeKey(key: string): string {
  if (!KEY_PATTERN.test(key) || key.split('/').some(segment => segment === '.' || segment === '..')) {
    throw new GatewayError('Invalid storage key', 400);
  }
  return key;
}
async function failure(response: Response): Promise<GatewayError> {
  let message = 'Storage gateway unavailable';
  try {
    const value = await response.json() as { error?: unknown };
    if (typeof value.error === 'string' && value.error.length <= 200) message = value.error;
  } catch { /* Keep a bounded generic error. */ }
  return new GatewayError(message, [409, 429, 507].includes(response.status) ? response.status : 503);
}

/** All operations use the private gateway. Its DO is the authoritative cap;
 * this SQLite ledger is an independent, durable backstop for bytes and R2 calls. */
export class R2Gateway {
  private readonly base: string;
  private readonly db: DatabaseSync;
  private readonly fetcher: typeof fetch;
  private readonly secret: string;
  private transferActive = 0;
  private transferWaiters: Array<() => void> = [];

  constructor(dataDir: string, url: string, secret: string, fetcher: typeof fetch = fetch) {
    const parsed = new URL(url);
    if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash
      || (parsed.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname))) {
      throw new Error('Invalid R2 gateway URL');
    }
    if (!secret || secret.length < 32) throw new Error('R2 gateway secret is missing or too short');
    this.base = parsed.href.replace(/\/$/, '');
    this.secret = secret;
    this.fetcher = fetcher;
    this.db = new DatabaseSync(join(dataDir, 'r2-client.sqlite3'));
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS operation_usage (month TEXT PRIMARY KEY, class_a INTEGER NOT NULL, class_b INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS operation_day (day TEXT PRIMARY KEY, class_a INTEGER NOT NULL, class_b INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS object_ledger (key TEXT PRIMARY KEY, size INTEGER NOT NULL, state TEXT NOT NULL CHECK(state IN ('pending','committed')));
    `);
  }
  close(): void { this.db.close(); }
  private month(): string { return new Date().toISOString().slice(0, 7); }
  private charge(kind: 'A' | 'B'): void {
    const month = this.month();
    const day = new Date().toISOString().slice(0, 10);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT OR IGNORE INTO operation_usage(month,class_a,class_b) VALUES(?,0,0)').run(month);
      this.db.prepare('INSERT OR IGNORE INTO operation_day(day,class_a,class_b) VALUES(?,0,0)').run(day);
      const row = this.db.prepare('SELECT class_a, class_b FROM operation_usage WHERE month = ?').get(month) as { class_a: number; class_b: number };
      const daily = this.db.prepare('SELECT class_a, class_b FROM operation_day WHERE day = ?').get(day) as { class_a: number; class_b: number };
      if ((kind === 'A' && (row.class_a >= CLASS_A_LIMIT || daily.class_a >= CLASS_A_DAY_LIMIT))
        || (kind === 'B' && (row.class_b >= CLASS_B_LIMIT || daily.class_b >= CLASS_B_DAY_LIMIT))) {
        throw new GatewayError('Monthly storage operation limit reached', 507);
      }
      this.db.prepare('UPDATE operation_usage SET class_a=class_a+?, class_b=class_b+? WHERE month=?')
        .run(kind === 'A' ? 1 : 0, kind === 'B' ? 1 : 0, month);
      this.db.prepare('UPDATE operation_day SET class_a=class_a+?, class_b=class_b+? WHERE day=?')
        .run(kind === 'A' ? 1 : 0, kind === 'B' ? 1 : 0, day);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  private async request(path: string, kind: 'A' | 'B' | null, init: RequestInit = {}): Promise<Response> {
    if (kind) this.charge(kind);
    const transfer = init.method === 'PUT';
    if (transfer) await this.acquireTransfer();
    try {
      return await this.fetcher(`${this.base}${path}`, {
        ...init, headers: { authorization: `Bearer ${this.secret}`, 'accept-encoding': 'identity', ...init.headers },
        signal: init.signal ?? AbortSignal.timeout(300_000),
      });
    } catch { throw new GatewayError('Storage gateway unavailable'); }
    finally {
      if (transfer) {
        this.transferActive -= 1;
        // Grant the slot synchronously before the waiting promise resumes.
        const next = this.transferWaiters.shift();
        if (next) { this.transferActive += 1; next(); }
      }
    }
  }
  private acquireTransfer(): Promise<void> {
    if (this.transferActive < 3) { this.transferActive += 1; return Promise.resolve(); }
    return new Promise(resolve => this.transferWaiters.push(resolve));
  }
  async status(): Promise<GatewayStatus> {
    const response = await this.request('/v1/status', null);
    if (!response.ok) throw await failure(response);
    const value = await response.json() as GatewayStatus;
    if (!validCount(value.usedBytes) || !validCount(value.reservedBytes) || !validCount(value.limitBytes)
      || !validCount(value.classAUsed) || !validCount(value.classALimit)
      || !validCount(value.classBUsed) || !validCount(value.classBLimit)
      || !/^\d{4}-\d{2}$/.test(value.month) || value.limitBytes > R2_LIMIT_BYTES) {
      throw new GatewayError('Invalid storage gateway status');
    }
    return value;
  }
  private ledgerBytes(): number {
    const row = this.db.prepare('SELECT COALESCE(SUM(size),0) AS bytes FROM object_ledger').get() as { bytes: number };
    return row.bytes;
  }
  committedBytes(prefix: string): number {
    if (!/^notora\/[0-9a-f]{32}\/$/.test(prefix)) throw new GatewayError('Invalid storage prefix', 400);
    const row = this.db.prepare("SELECT COALESCE(SUM(size),0) AS bytes FROM object_ledger WHERE key LIKE ? AND state='committed'")
      .get(`${prefix}%`) as { bytes: number };
    return row.bytes;
  }
  async requireCapacity(bytes: number): Promise<void> {
    if (!validCount(bytes)) throw new GatewayError('Invalid storage size', 400);
    const remote = await this.status();
    if (remote.usedBytes + remote.reservedBytes + bytes > Math.min(remote.limitBytes, R2_LIMIT_BYTES)
      || this.ledgerBytes() + bytes > R2_LIMIT_BYTES) throw new GatewayError('Document storage is full', 507);
  }
  private reserveKey(key: string, size: number): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare('SELECT size FROM object_ledger WHERE key=?').get(key) as { size: number } | undefined;
      if (row && row.size !== size) throw new GatewayError('Storage object size changed', 409);
      if (!row) {
        if (this.ledgerBytes() + size > R2_LIMIT_BYTES) throw new GatewayError('Document storage is full', 507);
        this.db.prepare("INSERT INTO object_ledger(key,size,state) VALUES(?,?,'pending')").run(key, size);
      }
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  private markCommitted(key: string): void {
    this.db.prepare("UPDATE object_ledger SET state='committed' WHERE key=?").run(key);
  }
  private async matchesExistingFile(key: string, path: string, size: number): Promise<boolean> {
    const head = await this.headObject(key);
    if (!head) return false;
    if (head.size !== size) throw new GatewayError('Stored object size differs', 409);
    const remote = await this.getObject(key);
    const localDigest = createHash('sha256');
    const remoteDigest = createHash('sha256');
    await Promise.all([
      (async () => { for await (const chunk of createReadStream(path, { highWaterMark: 128 * 1024 })) localDigest.update(chunk); })(),
      (async () => { for await (const chunk of remote.stream) remoteDigest.update(chunk); })(),
    ]);
    if (localDigest.digest('hex') !== remoteDigest.digest('hex')) throw new GatewayError('Stored object content differs', 409);
    return true;
  }
  private async putStream(key: string, size: number, body: BodyInit, contentType: string): Promise<void> {
    const response = await this.request(`/v1/objects/${key}`, 'A', {
      method: 'PUT', headers: { 'content-length': String(size), 'content-type': contentType },
      body, duplex: 'half',
    } as RequestInit);
    if (!response.ok) throw await failure(response);
    const result = await response.json() as { key?: unknown; size?: unknown };
    if (result.key !== key || result.size !== size) throw new GatewayError('Mismatched storage response');
  }
  async putBytes(key: string, data: Buffer, contentType: string): Promise<void> {
    safeKey(key);
    if (data.length > PART_BYTES) throw new GatewayError('Storage object requires multipart', 413);
    if (!this.db.prepare('SELECT 1 FROM object_ledger WHERE key=?').get(key)) await this.requireCapacity(data.length);
    this.reserveKey(key, data.length);
    await this.putStream(key, data.length, data as unknown as BodyInit, contentType);
    this.markCommitted(key);
  }
  async putFile(key: string, path: string, contentType: string): Promise<void> {
    safeKey(key);
    const size = (await stat(path)).size;
    if (!validCount(size) || size === 0) throw new GatewayError('Empty storage object', 400);
    const existing = this.db.prepare('SELECT state FROM object_ledger WHERE key=?').get(key) as { state: string } | undefined;
    if (existing && await this.matchesExistingFile(key, path, size)) {
      this.markCommitted(key);
      return;
    }
    if (!existing) await this.requireCapacity(size);
    this.reserveKey(key, size);
    if (size <= PART_BYTES) {
      await this.putStream(key, size, Readable.toWeb(createReadStream(path)) as BodyInit, contentType);
    } else {
      await this.multipartFile(key, path, size, contentType, Boolean(existing));
    }
    this.markCommitted(key);
  }
  private async completeMultipart(uploadId: string, key: string, size: number): Promise<Response> {
    const response = await this.request(`/v1/multipart/${uploadId}/complete`, 'A', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    if (response.ok) {
      const result = await response.clone().json() as { key?: unknown; size?: unknown };
      if (result.key !== key || result.size !== size) throw new GatewayError('Mismatched multipart response');
    }
    return response;
  }
  private async multipartFile(key: string, path: string, size: number, contentType: string, retry: boolean): Promise<void> {
    const start = () => this.request('/v1/multipart', 'A', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key, size, contentType }),
    });
    let created = await start();
    if (created.status === 409) {
      // An earlier abort can be durable in the gateway while its R2 abort
      // failed. Discover and retry that exact session before starting anew.
      const prefix = `${key.split('/').slice(0, 2).join('/')}/`;
      let cursor: string | undefined;
      let pending: { key: string; uploadId?: string } | undefined;
      do {
        const page = await this.listPending(prefix, cursor);
        pending = page.pending.find(entry => entry.key === key);
        cursor = page.truncated ? page.cursor : undefined;
        if (!pending && page.truncated && !cursor) throw new GatewayError('Pending listing made no progress');
      } while (!pending && cursor);
      if (pending?.uploadId) {
        const aborted = await this.request(`/v1/multipart/${pending.uploadId}`, 'A', { method: 'DELETE' });
        if (aborted.status !== 204) throw await failure(aborted);
        created = await start();
      } else if (await this.matchesExistingFile(key, path, size)) return;
    }
    if (!created.ok) throw await failure(created);
    const { uploadId } = await created.json() as { uploadId?: unknown };
    if (typeof uploadId !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(uploadId)) throw new GatewayError('Invalid multipart session');
    if (retry) {
      // A lost completion response can leave the gateway in "completing".
      // Its idempotent start returns the same ID, allowing completion recovery.
      const prior = await this.completeMultipart(uploadId, key, size);
      if (prior.ok) return;
      if (prior.status !== 409) throw await failure(prior);
      const body = await prior.json() as { error?: unknown };
      if (body.error !== 'multipart upload incomplete') throw new GatewayError('Multipart recovery conflict', 409);
    }
    const parts = Math.ceil(size / PART_BYTES);
    let next = 1;
    let failed: unknown;
    const worker = async () => {
      while (!failed && next <= parts) {
        const number = next++;
        const start = (number - 1) * PART_BYTES;
        const length = Math.min(PART_BYTES, size - start);
        try {
          const response = await this.request(`/v1/multipart/${uploadId}/parts/${number}`, 'A', {
            method: 'PUT', headers: { 'content-length': String(length), 'content-type': 'application/octet-stream' },
            body: Readable.toWeb(createReadStream(path, { start, end: start + length - 1 })) as BodyInit,
            duplex: 'half',
          } as RequestInit);
          if (!response.ok) throw await failure(response);
          const result = await response.json() as { partNumber?: unknown; etag?: unknown };
          if (result.partNumber !== number || typeof result.etag !== 'string') throw new GatewayError('Invalid multipart part response');
        } catch (error) { failed = error; }
      }
    };
    await Promise.all(Array.from({ length: Math.min(3, parts) }, () => worker()));
    if (failed) {
      try {
        await this.abortMultipart(uploadId);
        this.db.prepare('DELETE FROM object_ledger WHERE key=? AND state=?').run(key, 'pending');
      } catch { /* Keep ledger hold after uncertain cleanup. */ }
      throw failed;
    }
    const completed = await this.completeMultipart(uploadId, key, size);
    if (!completed.ok) throw await failure(completed);
  }
  private async abortMultipart(uploadId: string): Promise<void> {
    const response = await this.request(`/v1/multipart/${uploadId}`, 'A', { method: 'DELETE' });
    if (response.status !== 204) throw await failure(response);
  }
  async headObject(key: string): Promise<{ size: number; etag: string | null } | null> {
    safeKey(key);
    const response = await this.request(`/v1/objects/${key}`, 'B', { method: 'HEAD' });
    if (response.status === 404) return null;
    if (!response.ok) throw await failure(response);
    const size = objectSize(response.headers);
    return { size, etag: response.headers.get('etag') };
  }
  async getObject(key: string, signal?: AbortSignal): Promise<{ stream: Readable; size: number; contentType: string; etag: string | null }> {
    safeKey(key);
    const response = await this.request(`/v1/objects/${key}`, 'B', signal ? { signal } : {});
    if (!response.ok) throw await failure(response);
    const size = objectSize(response.headers);
    if (!response.body) throw new GatewayError('Invalid storage response');
    return {
      stream: Readable.fromWeb(response.body as import('node:stream/web').ReadableStream), size,
      contentType: response.headers.get('content-type') ?? 'application/octet-stream',
      etag: response.headers.get('etag'),
    };
  }
  async getJson<T>(key: string): Promise<T> {
    const object = await this.getObject(key);
    if (object.size > PART_BYTES) { object.stream.destroy(); throw new GatewayError('Storage JSON exceeds limit'); }
    const chunks: Buffer[] = [];
    for await (const chunk of object.stream) chunks.push(Buffer.from(chunk));
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T;
  }
  async deleteObject(key: string): Promise<void> {
    safeKey(key);
    const response = await this.request(`/v1/objects/${key}`, 'A', { method: 'DELETE' });
    if (response.status !== 204) throw await failure(response);
    this.db.prepare('DELETE FROM object_ledger WHERE key=?').run(key);
  }
  async listObjects(prefix: string, cursor?: string): Promise<{ objects: GatewayObject[]; truncated: boolean; cursor?: string }> {
    if (!/^notora\/[0-9a-f]{32}\/$/.test(prefix)) throw new GatewayError('Invalid storage prefix', 400);
    const query = new URLSearchParams({ prefix });
    if (cursor) query.set('cursor', cursor);
    const response = await this.request(`/v1/objects?${query}`, 'A');
    if (!response.ok) throw await failure(response);
    const result = await response.json() as { objects?: GatewayObject[]; truncated?: boolean; cursor?: string };
    if (!Array.isArray(result.objects) || typeof result.truncated !== 'boolean'
      || result.objects.some(object => !object.key.startsWith(prefix) || !validCount(object.size))) {
      throw new GatewayError('Invalid storage listing');
    }
    return { objects: result.objects, truncated: result.truncated, cursor: result.cursor };
  }
  async listPending(prefix: string, cursor?: string): Promise<{ pending: Array<{ key: string; uploadId?: string }>; truncated: boolean; cursor?: string }> {
    if (!/^notora\/[0-9a-f]{32}\/$/.test(prefix)) throw new GatewayError('Invalid storage prefix', 400);
    const query = new URLSearchParams({ prefix });
    if (cursor) query.set('cursor', cursor);
    const response = await this.request(`/v1/pending?${query}`, null);
    if (!response.ok) throw await failure(response);
    const result = await response.json() as { pending?: Array<{ key: string; uploadId?: string }>; truncated?: boolean; cursor?: string };
    if (!Array.isArray(result.pending) || typeof result.truncated !== 'boolean'
      || result.pending.some(entry => typeof entry.key !== 'string' || !entry.key.startsWith(prefix)
        || (entry.uploadId !== undefined && !/^[0-9a-f-]{36}$/.test(entry.uploadId)))) {
      throw new GatewayError('Invalid storage pending listing');
    }
    if (result.cursor !== undefined && typeof result.cursor !== 'string') throw new GatewayError('Invalid storage pending cursor');
    return { pending: result.pending, truncated: result.truncated, cursor: result.cursor };
  }
  async deletePrefix(prefix: string): Promise<void> {
    // The gateway ledger includes in-flight reservations that R2 object
    // listing cannot see. Abort those before removing the sole local source.
    for (;;) {
      const page = await this.listPending(prefix);
      if (!page.pending.length) {
        if (page.truncated) throw new GatewayError('Pending listing made no progress');
        break;
      }
      for (const entry of page.pending) {
        if (entry.uploadId) {
          const response = await this.request(`/v1/multipart/${entry.uploadId}`, 'A', { method: 'DELETE' });
          if (response.status === 409) await this.deleteObject(entry.key);
          else if (response.status === 204) this.db.prepare('DELETE FROM object_ledger WHERE key=?').run(entry.key);
          else throw await failure(response);
        } else await this.deleteObject(entry.key);
      }
    }
    for (;;) {
      const page = await this.listObjects(prefix);
      if (!page.objects.length) {
        if (page.truncated) throw new GatewayError('Storage listing made no progress');
        // Both gateway ledger and R2 are now empty for this prefix.
        this.db.prepare('DELETE FROM object_ledger WHERE key LIKE ?').run(`${prefix}%`);
        return;
      }
      for (const object of page.objects) await this.deleteObject(object.key);
    }
  }
}
