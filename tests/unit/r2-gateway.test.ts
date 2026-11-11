import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import {
  MAX_REQUEST_BYTES, MAX_STORAGE_BYTES, StorageGateway,
  type BucketObject, type GatewayEnv, type MultipartHandle, type PrivateBucket,
  type QuotaStorage, type SqlCursor,
} from '../../cloudflare/gateway';

const secret = 'test-gateway-secret-with-at-least-32-characters';
const id = (n: string) => n.repeat(32);
const key = (n: string, name = 'original.pdf') => `notora/${id(n)}/${name}`;
const auth = { authorization: `Bearer ${secret}` };

class TestStorage implements QuotaStorage {
  db = new DatabaseSync(':memory:');
  failOnce: RegExp | null = null;
  sql = {
    exec: <T>(query: string, ...bindings: unknown[]): SqlCursor<T> => {
      if (this.failOnce?.test(query)) { this.failOnce = null; throw new Error('simulated SQLite failure'); }
      const trimmed = query.trimStart();
      if (/^(CREATE|PRAGMA)/i.test(trimmed)) {
        this.db.exec(query);
        return { toArray: () => [] as T[], rowsWritten: 0 };
      }
      const statement = this.db.prepare(query);
      if (/^SELECT/i.test(trimmed)) {
        const rows = statement.all(...bindings as (string | number | null)[]) as T[];
        return { toArray: () => rows, rowsWritten: 0 };
      }
      const result = statement.run(...bindings as (string | number | null)[]);
      return { toArray: () => [] as T[], rowsWritten: Number(result.changes) };
    },
  };
  transactionSync<T>(callback: () => T): T {
    this.db.exec('BEGIN');
    try { const result = callback(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  close(): void { this.db.close(); }
}

interface Stored { bytes: Uint8Array; contentType: string; metadata: Record<string, string>; etag: string }
interface Upload {
  key: string; contentType: string; metadata: Record<string, string>;
  parts: Map<number, { bytes: Uint8Array; etag: string }>;
}
class TestBucket implements PrivateBucket {
  objects = new Map<string, Stored>();
  uploads = new Map<string, Upload>();
  calls = { head: 0, get: 0, put: 0, delete: 0, list: 0, create: 0, part: 0, complete: 0, abort: 0 };
  failDelete = false;
  failAbort = false;
  failPart = false;
  delayHead: Promise<void> | null = null;
  private serial = 0;
  private object(key: string, value: Stored, body = false): BucketObject {
    return {
      key, size: value.bytes.byteLength, etag: value.etag, httpEtag: `"${value.etag}"`,
      customMetadata: value.metadata,
      ...(body ? { body: new ReadableStream<Uint8Array>({ start(controller) {
        controller.enqueue(value.bytes); controller.close();
      } }) } : {}),
    };
  }
  async head(key: string): Promise<BucketObject | null> {
    this.calls.head++;
    if (this.delayHead) await this.delayHead;
    const value = this.objects.get(key);
    return value ? this.object(key, value) : null;
  }
  async get(key: string): Promise<BucketObject | null> {
    this.calls.get++;
    const value = this.objects.get(key);
    return value ? this.object(key, value, true) : null;
  }
  async put(key: string, bytes: Uint8Array, options: {
    onlyIf: Headers; httpMetadata: { contentType: string }; customMetadata: Record<string, string>;
    storageClass: 'Standard';
  }): Promise<BucketObject | null> {
    this.calls.put++;
    if (this.objects.has(key) && options.onlyIf.get('if-none-match') === '*') return null;
    const value = { bytes: bytes.slice(), contentType: options.httpMetadata.contentType,
      metadata: { ...options.customMetadata }, etag: `single-${++this.serial}` };
    this.objects.set(key, value);
    return this.object(key, value);
  }
  async delete(key: string): Promise<void> {
    this.calls.delete++;
    if (this.failDelete) throw new Error('R2 failed');
    this.objects.delete(key);
  }
  async list(options: { prefix: string; cursor?: string; limit: number }) {
    this.calls.list++;
    const all = [...this.objects.entries()].filter(([name]) => name.startsWith(options.prefix))
      .sort(([a], [b]) => a.localeCompare(b));
    const offset = Number(options.cursor || '0');
    const objects = all.slice(offset, offset + options.limit).map(([name, stored]) =>
      ({ key: name, size: stored.bytes.byteLength }));
    const truncated = offset + objects.length < all.length;
    return { objects, truncated, ...(truncated ? { cursor: String(offset + objects.length) } : {}) };
  }
  async createMultipartUpload(key: string, options: {
    httpMetadata: { contentType: string }; customMetadata: Record<string, string>;
    storageClass: 'Standard';
  }): Promise<MultipartHandle> {
    this.calls.create++;
    const uploadId = `r2-${++this.serial}`;
    this.uploads.set(uploadId, { key, contentType: options.httpMetadata.contentType,
      metadata: { ...options.customMetadata }, parts: new Map() });
    return this.resumeMultipartUpload(key, uploadId);
  }
  resumeMultipartUpload(key: string, uploadId: string): MultipartHandle {
    const bucket = this;
    const getUpload = () => {
      const upload = bucket.uploads.get(uploadId);
      if (!upload || upload.key !== key) throw new Error('NoSuchUpload');
      return upload;
    };
    return {
      uploadId,
      async uploadPart(number, bytes) {
        bucket.calls.part++;
        if (bucket.failPart) throw new Error('R2 failed');
        const upload = getUpload();
        const etag = `part-${number}-${++bucket.serial}`;
        upload.parts.set(number, { bytes: bytes.slice(), etag });
        return { partNumber: number, etag };
      },
      async complete(parts) {
        bucket.calls.complete++;
        const upload = getUpload();
        const size = parts.reduce((n, part) => n + (upload.parts.get(part.partNumber)?.bytes.byteLength ?? 0), 0);
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const part of parts) {
          const stored = upload.parts.get(part.partNumber);
          if (!stored || stored.etag !== part.etag) throw new Error('BadPart');
          bytes.set(stored.bytes, offset); offset += stored.bytes.byteLength;
        }
        const value = { bytes, contentType: upload.contentType,
          metadata: upload.metadata, etag: `multipart-${++bucket.serial}` };
        bucket.objects.set(key, value);
        bucket.uploads.delete(uploadId);
        return bucket.object(key, value);
      },
      async abort() {
        bucket.calls.abort++;
        if (bucket.failAbort) throw new Error('R2 failed');
        getUpload();
        bucket.uploads.delete(uploadId);
      },
    };
  }
}

const storages: TestStorage[] = [];
afterEach(() => { for (const storage of storages.splice(0)) storage.close(); });
function setup(overrides: Partial<GatewayEnv> = {}) {
  const storage = new TestStorage(); storages.push(storage);
  const bucket = new TestBucket();
  const env: GatewayEnv = { BUCKET: bucket, GATEWAY_SECRET: secret, ...overrides };
  return { storage, bucket, env, gateway: new StorageGateway(storage, env) };
}
async function call(gateway: StorageGateway, path: string, method = 'GET', body?: Uint8Array | object,
  headers: Record<string, string> = {}) {
  const encoded = body && !(body instanceof Uint8Array) ? JSON.stringify(body) : body;
  const bytes = typeof encoded === 'string' ? new TextEncoder().encode(encoded) : encoded;
  return gateway.fetch(new Request(`https://storage.example${path}`, {
    method,
    headers: { ...auth, ...(bytes ? { 'content-length': String(bytes.byteLength) } : {}),
      ...(body && !(body instanceof Uint8Array) ? { 'content-type': 'application/json' } : {}), ...headers },
    ...(bytes ? { body: bytes.buffer as ArrayBuffer } : {}),
  }));
}
async function status(gateway: StorageGateway) {
  const response = await call(gateway, '/v1/status');
  expect(response.status).toBe(200);
  return response.json() as Promise<Record<string, number | string>>;
}

describe('private R2 gateway', () => {
  it('rejects unauthorized requests, invalid keys, foreign prefixes and unknown routes before R2', async () => {
    const { gateway, bucket } = setup();
    const unauth = await gateway.fetch(new Request('https://storage.example/v1/status'));
    expect(unauth.status).toBe(401);
    expect((await call(gateway, '/v1/objects/notora%2f' + id('a') + '/x', 'GET')).status).toBe(400);
    expect((await call(gateway, '/v1/objects/' + key('a', '../x'), 'GET')).status).toBe(400);
    expect((await call(gateway, '/v1/objects?prefix=other/', 'GET')).status).toBe(400);
    expect((await call(gateway, '/v1/not-real')).status).toBe(404);
    expect(Object.values(bucket.calls).reduce((a, b) => a + b, 0)).toBe(0);
  });

  it('reserves before concurrent writes, enforces the exact byte cap and keeps it across restart', async () => {
    const { gateway, storage, bucket, env } = setup({ STORAGE_LIMIT_BYTES: '10' });
    let release!: () => void;
    bucket.delayHead = new Promise<void>(resolve => { release = resolve; });
    const first = call(gateway, `/v1/objects/${key('a')}`, 'PUT', new Uint8Array(6),
      { 'content-type': 'application/pdf' });
    await new Promise(resolve => setTimeout(resolve, 5));
    const second = await call(gateway, `/v1/objects/${key('b')}`, 'PUT', new Uint8Array(6),
      { 'content-type': 'application/pdf' });
    expect(second.status).toBe(507);
    expect((await status(gateway)).reservedBytes).toBe(6);
    release();
    expect((await first).status).toBe(201);
    const restarted = new StorageGateway(storage, { ...env, STORAGE_LIMIT_BYTES: undefined });
    expect(await status(restarted)).toMatchObject({ usedBytes: 6, reservedBytes: 0, limitBytes: 10 });
    expect((await call(restarted, `/v1/objects/${key('b')}`, 'PUT', new Uint8Array(4),
      { 'content-type': 'application/pdf' })).status).toBe(201);
    expect((await status(restarted)).usedBytes).toBe(10);
    expect(MAX_STORAGE_BYTES).toBe(9_000_000_000);
  });

  it('bounds concurrent upload bodies inside the gateway', async () => {
    const { gateway, bucket } = setup();
    let release!: () => void;
    bucket.delayHead = new Promise<void>(resolve => { release = resolve; });
    const request = (letter: string) => call(gateway, `/v1/objects/${key(letter)}`,
      'PUT', new Uint8Array([1]), { 'content-type': 'application/pdf' });
    const pending = [request('a'), request('b'), request('c')];
    await new Promise(resolve => setTimeout(resolve, 5));
    expect((await request('d')).status).toBe(429);
    expect((await status(gateway)).reservedBytes).toBe(3);
    release();
    expect((await Promise.all(pending)).map(response => response.status)).toEqual([201, 201, 201]);
  });

  it('compares immutable retries and reconciles a write committed in R2 before SQLite', async () => {
    const { gateway, storage, bucket, env } = setup();
    storage.failOnce = /UPDATE entries SET state='committed'/;
    const bytes = new Uint8Array([1, 2, 3]);
    expect((await call(gateway, `/v1/objects/${key('a')}`, 'PUT', bytes,
      { 'content-type': 'application/pdf' })).status).toBe(503);
    expect((await status(gateway)).reservedBytes).toBe(3);
    expect(bucket.objects.has(key('a'))).toBe(true);
    const restarted = new StorageGateway(storage, env);
    expect((await call(restarted, `/v1/objects/${key('a')}`, 'PUT', new Uint8Array([9, 9, 9]),
      { 'content-type': 'application/pdf' })).status).toBe(409);
    expect((await call(restarted, `/v1/objects/${key('a')}`, 'PUT', bytes,
      { 'content-type': 'application/pdf' })).status).toBe(200);
    expect(await status(restarted)).toMatchObject({ usedBytes: 3, reservedBytes: 0 });
    expect(bucket.calls.put).toBe(1);
    const downloaded = await call(restarted, `/v1/objects/${key('a')}`);
    expect(downloaded.headers.get('cache-control')).toContain('no-store');
    expect(new Uint8Array(await downloaded.arrayBuffer())).toEqual(bytes);
  });

  it('charges before R2 reads, writes, list and cleanup and retains charge after failures', async () => {
    const { gateway, bucket } = setup({ CLASS_A_LIMIT: '3', CLASS_B_LIMIT: '2' });
    expect((await call(gateway, `/v1/objects/${key('a')}`, 'PUT', new Uint8Array([1]),
      { 'content-type': 'application/pdf' })).status).toBe(201); // B head, A put
    expect((await call(gateway, `/v1/objects/${key('a')}`, 'HEAD')).status).toBe(200); // B head
    expect((await call(gateway, `/v1/objects/${key('a')}`)).status).toBe(429); // B cap
    bucket.failDelete = true;
    expect((await call(gateway, `/v1/objects/${key('a')}`, 'DELETE')).status).toBe(503); // A delete
    expect(await status(gateway)).toMatchObject({ usedBytes: 1, classAUsed: 2, classBUsed: 2 });
    bucket.failDelete = false;
    expect((await call(gateway, `/v1/objects/${key('a')}`, 'DELETE')).status).toBe(204);
    expect(await status(gateway)).toMatchObject({ usedBytes: 0, classAUsed: 3 });
    expect((await call(gateway, `/v1/objects?prefix=notora/${id('a')}/`)).status).toBe(429);
    expect(bucket.calls.list).toBe(0);
  });

  it('keeps multipart bytes and parts charged through retries and verifies exact completion', async () => {
    const { gateway, bucket, storage, env } = setup();
    const name = key('a');
    const size = MAX_REQUEST_BYTES + 3;
    const started = await call(gateway, '/v1/multipart', 'POST',
      { key: name, size, contentType: 'application/pdf' });
    expect(started.status).toBe(201);
    const { uploadId } = await started.json() as { uploadId: string };
    expect((await status(gateway)).reservedBytes).toBe(size);
    const first = new Uint8Array(MAX_REQUEST_BYTES);
    first[0] = 7;
    const put1 = () => call(gateway, `/v1/multipart/${uploadId}/parts/1`, 'PUT', first);
    expect((await put1()).status).toBe(200);
    expect((await status(gateway)).reservedBytes).toBe(size + MAX_REQUEST_BYTES);
    expect((await put1()).status).toBe(200);
    expect(bucket.calls.part).toBe(1);
    expect((await call(gateway, `/v1/multipart/${uploadId}/parts/2`, 'PUT', new Uint8Array([1, 2, 3]))).status).toBe(200);
    expect((await call(gateway, `/v1/multipart/${uploadId}/complete`, 'POST', {})).status).toBe(200);
    const restarted = new StorageGateway(storage, env);
    expect((await call(restarted, `/v1/multipart/${uploadId}/complete`, 'POST', {})).status).toBe(200);
    expect(await status(restarted)).toMatchObject({ usedBytes: size, reservedBytes: 0 });
    const read = await call(restarted, `/v1/objects/${name}`);
    expect(read.status).toBe(200);
    expect(Number(read.headers.get('content-length'))).toBe(size);
    expect((await read.arrayBuffer()).byteLength).toBe(size);
  });

  it('admits distinct parts concurrently with one R2 upload and makes lost-complete retries idempotent', async () => {
    const { gateway, bucket } = setup();
    const name = key('c');
    const size = MAX_REQUEST_BYTES + 1;
    const started = await call(gateway, '/v1/multipart', 'POST',
      { key: name, size, contentType: 'application/pdf' });
    const { uploadId } = await started.json() as { uploadId: string };
    let release!: () => void;
    bucket.delayHead = new Promise<void>(resolve => { release = resolve; });
    const firstBytes = new Uint8Array(MAX_REQUEST_BYTES);
    const part1 = call(gateway, `/v1/multipart/${uploadId}/parts/1`, 'PUT', firstBytes);
    const part2 = call(gateway, `/v1/multipart/${uploadId}/parts/2`, 'PUT', new Uint8Array([8]));
    await new Promise(resolve => setTimeout(resolve, 5));
    expect((await status(gateway)).reservedBytes).toBe(size * 2);
    release();
    expect((await part1).status).toBe(200);
    expect((await part2).status).toBe(200);
    expect(bucket.calls.create).toBe(1);
    expect((await call(gateway, `/v1/multipart/${uploadId}/complete`, 'POST', {})).status).toBe(200);
    const restarted = await call(gateway, '/v1/multipart', 'POST',
      { key: name, size, contentType: 'application/pdf' });
    expect((await restarted.json() as { uploadId: string }).uploadId).toBe(uploadId);
    expect((await call(gateway, `/v1/multipart/${uploadId}/parts/1`, 'PUT', firstBytes)).status).toBe(200);
    expect((await call(gateway, `/v1/multipart/${uploadId}/parts/2`, 'PUT', new Uint8Array([9]))).status).toBe(409);
    expect(bucket.calls.part).toBe(2);
  });

  it('retains multipart reservation on failed abort, then releases only after R2 confirms abort', async () => {
    const { gateway, bucket } = setup();
    const size = 3;
    const started = await call(gateway, '/v1/multipart', 'POST',
      { key: key('a'), size, contentType: 'application/pdf' });
    const { uploadId } = await started.json() as { uploadId: string };
    expect((await call(gateway, `/v1/multipart/${uploadId}/parts/1`, 'PUT', new Uint8Array([1, 2, 3]))).status).toBe(200);
    bucket.failAbort = true;
    expect((await call(gateway, `/v1/multipart/${uploadId}`, 'DELETE')).status).toBe(503);
    expect((await status(gateway)).reservedBytes).toBe(6);
    const pending = await call(gateway, `/v1/pending?prefix=notora/${id('a')}/`);
    expect(await pending.json()).toMatchObject({ pending: [{ key: key('a'), uploadId }], truncated: false });
    bucket.failAbort = false;
    expect((await call(gateway, `/v1/multipart/${uploadId}`, 'DELETE')).status).toBe(204);
    expect((await status(gateway)).reservedBytes).toBe(0);
    expect((await call(gateway, `/v1/multipart/${uploadId}`, 'DELETE')).status).toBe(204);
  });

  it('lists every ledger entry for document cleanup, including interrupted writes', async () => {
    const { gateway, storage } = setup();
    const committed = key('a', 'metadata.json');
    const interrupted = key('a', 'manifest.json');
    const multipart = key('a', 'original.pdf');
    expect((await call(gateway, `/v1/objects/${committed}`, 'PUT', new Uint8Array([1]),
      { 'content-type': 'application/json' })).status).toBe(201);
    storage.failOnce = /UPDATE entries SET state='committed'/;
    expect((await call(gateway, `/v1/objects/${interrupted}`, 'PUT', new Uint8Array([2]),
      { 'content-type': 'application/json' })).status).toBe(503);
    const started = await call(gateway, '/v1/multipart', 'POST',
      { key: multipart, size: 2, contentType: 'application/pdf' });
    const { uploadId } = await started.json() as { uploadId: string };
    const listed = await call(gateway, `/v1/pending?prefix=notora/${id('a')}/`);
    expect(await listed.json()).toEqual({ pending: [
      { key: interrupted }, { key: committed }, { key: multipart, uploadId },
    ], truncated: false });
    expect((await call(gateway, `/v1/pending?prefix=notora/${id('a')}/&cursor=other`)).status).toBe(400);
    expect((await call(gateway, `/v1/multipart/${uploadId}`, 'DELETE')).status).toBe(204);
    expect((await call(gateway, `/v1/objects/${interrupted}`, 'DELETE')).status).toBe(204);
    expect((await call(gateway, `/v1/objects/${committed}`, 'DELETE')).status).toBe(204);
    expect(await status(gateway)).toMatchObject({ usedBytes: 0, reservedBytes: 0 });
    expect(await (await call(gateway, `/v1/pending?prefix=notora/${id('a')}/`)).json())
      .toEqual({ pending: [], truncated: false });
  });

  it('recovers a completed R2 multipart object after SQLite fails to record completion', async () => {
    const { gateway, bucket, storage, env } = setup();
    const started = await call(gateway, '/v1/multipart', 'POST',
      { key: key('a'), size: 2, contentType: 'application/pdf' });
    const { uploadId } = await started.json() as { uploadId: string };
    expect((await call(gateway, `/v1/multipart/${uploadId}/parts/1`, 'PUT',
      new Uint8Array([1, 2]))).status).toBe(200);
    storage.failOnce = /UPDATE entries SET state='committed'/;
    expect((await call(gateway, `/v1/multipart/${uploadId}/complete`, 'POST', {})).status).toBe(503);
    expect(bucket.objects.has(key('a'))).toBe(true);
    expect((await status(gateway)).reservedBytes).toBe(4);
    const restarted = new StorageGateway(storage, env);
    expect((await call(restarted, `/v1/multipart/${uploadId}/complete`, 'POST', {})).status).toBe(200);
    expect(await status(restarted)).toMatchObject({ usedBytes: 2, reservedBytes: 0 });
    expect(bucket.calls.complete).toBe(1);
  });

  it('holds ambiguous failed part bytes until a successful completion reconciles them', async () => {
    const { gateway, bucket } = setup();
    const started = await call(gateway, '/v1/multipart', 'POST',
      { key: key('a'), size: 2, contentType: 'application/pdf' });
    const { uploadId } = await started.json() as { uploadId: string };
    bucket.failPart = true;
    const part = () => call(gateway, `/v1/multipart/${uploadId}/parts/1`, 'PUT', new Uint8Array([1, 2]));
    expect((await part()).status).toBe(503);
    expect((await status(gateway)).reservedBytes).toBe(4);
    bucket.failPart = false;
    expect((await part()).status).toBe(200);
    expect((await status(gateway)).reservedBytes).toBe(6);
    expect((await call(gateway, `/v1/multipart/${uploadId}/complete`, 'POST', {})).status).toBe(200);
    expect(await status(gateway)).toMatchObject({ usedBytes: 2, reservedBytes: 0 });
  });

  it('releases an expired multipart upload only after R2 reports it absent', async () => {
    const { gateway, bucket } = setup();
    const started = await call(gateway, '/v1/multipart', 'POST',
      { key: key('a'), size: 2, contentType: 'application/pdf' });
    const { uploadId } = await started.json() as { uploadId: string };
    expect((await call(gateway, `/v1/multipart/${uploadId}/parts/1`, 'PUT',
      new Uint8Array([1, 2]))).status).toBe(200);
    bucket.uploads.clear(); // R2's documented automatic seven-day abort.
    expect((await call(gateway, `/v1/multipart/${uploadId}`, 'DELETE')).status).toBe(204);
    expect((await status(gateway)).reservedBytes).toBe(0);
  });

  it('cannot raise a persisted daily operation cap on restart', async () => {
    const { gateway, storage, bucket, env } = setup({ CLASS_A_DAILY_LIMIT: '1' });
    expect((await call(gateway, `/v1/objects/${key('a')}`, 'PUT', new Uint8Array([1]),
      { 'content-type': 'application/pdf' })).status).toBe(201);
    const restarted = new StorageGateway(storage, { ...env, CLASS_A_DAILY_LIMIT: undefined });
    expect(await status(restarted)).toMatchObject({ classADailyUsed: 1, classADailyLimit: 1 });
    expect((await call(restarted, `/v1/objects?prefix=notora/${id('a')}/`)).status).toBe(429);
    expect(bucket.calls.list).toBe(0);
  });
});
