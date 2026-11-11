// The public Worker and this Durable Object are the only route to the private bucket.
// The SQLite ledger is authoritative. A failed or interrupted R2 write retains its
// reservation until an authenticated retry reconciles it or R2 confirms cleanup.

export const MAX_REQUEST_BYTES = 8 * 1024 * 1024;
export const MAX_STORAGE_BYTES = 9_000_000_000;
export const MAX_CLASS_A_MONTH = 800_000;
export const MAX_CLASS_B_MONTH = 8_000_000;
export const MAX_CLASS_A_DAY = 20_000;
export const MAX_CLASS_B_DAY = 200_000;
export const MAX_PARALLEL_UPLOADS = 3;
export const MAX_PARALLEL_READS = 8;

export interface SqlCursor<T> { toArray(): T[]; rowsWritten: number }
export interface SqlStore {
  exec<T = Record<string, unknown>>(query: string, ...bindings: unknown[]): SqlCursor<T>;
}
export interface QuotaStorage {
  sql: SqlStore;
  transactionSync<T>(callback: () => T): T;
}
export interface BucketObject {
  key: string; size: number; etag: string; httpEtag: string;
  body?: ReadableStream<Uint8Array>;
  customMetadata?: Record<string, string>;
}
export interface MultipartHandle {
  uploadId: string;
  uploadPart(number: number, bytes: Uint8Array): Promise<{ partNumber: number; etag: string }>;
  complete(parts: { partNumber: number; etag: string }[]): Promise<BucketObject>;
  abort(): Promise<void>;
}
export interface PrivateBucket {
  head(key: string): Promise<BucketObject | null>;
  get(key: string): Promise<BucketObject | null>;
  put(key: string, bytes: Uint8Array, options: {
    onlyIf: Headers; httpMetadata: { contentType: string }; customMetadata: Record<string, string>;
    storageClass: 'Standard';
  }): Promise<BucketObject | null>;
  delete(key: string): Promise<void>;
  list(options: { prefix: string; cursor?: string; limit: number }): Promise<{
    objects: { key: string; size: number }[]; truncated: boolean; cursor?: string;
  }>;
  createMultipartUpload(key: string, options: {
    httpMetadata: { contentType: string }; customMetadata: Record<string, string>;
    storageClass: 'Standard';
  }): Promise<MultipartHandle>;
  resumeMultipartUpload(key: string, uploadId: string): MultipartHandle;
}
export interface GatewayEnv {
  BUCKET: PrivateBucket;
  GATEWAY_SECRET: string;
  STORAGE_LIMIT_BYTES?: string;
  CLASS_A_LIMIT?: string;
  CLASS_B_LIMIT?: string;
  CLASS_A_DAILY_LIMIT?: string;
  CLASS_B_DAILY_LIMIT?: string;
}

interface Policy {
  storage_limit: number; class_a_limit: number; class_b_limit: number;
  class_a_daily_limit: number; class_b_daily_limit: number;
}
interface Totals { used_bytes: number; reserved_bytes: number }
interface Usage { class_a_used: number; class_b_used: number }
interface Entry {
  key: string; kind: 'single' | 'multipart'; state: string; size: number;
  reserve: number; part_reserved: number; part_bytes: number;
  content_type: string; digest: string | null; etag: string | null;
  upload_id: string | null; r2_upload_id: string | null; token: string;
  committed: number;
}
interface Part {
  upload_id: string; part_number: number; size: number; reserved: number;
  digest: string | null; etag: string | null; state: string;
}

export class GatewayError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
function fail(status: number, message: string): never { throw new GatewayError(status, message); }
const json = (value: unknown, status = 200): Response => new Response(JSON.stringify(value), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
});
const errorResponse = (status: number, message: string): Response => json({ error: message }, status);

function limit(value: string | undefined, maximum: number): number {
  if (value === undefined) return maximum;
  if (!/^(0|[1-9]\d*)$/.test(value)) fail(503, 'gateway configuration unavailable');
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > maximum) fail(503, 'gateway configuration unavailable');
  return parsed;
}

export function authorized(request: Request, secret: string | undefined): boolean {
  if (!secret || secret.length < 32) return false;
  const header = request.headers.get('authorization');
  if (!header?.startsWith('Bearer ')) return false;
  const token = header.slice(7);
  // Keep comparison work independent of the first differing character.
  let difference = token.length ^ secret.length;
  for (let i = 0; i < Math.max(token.length, secret.length); i++) {
    difference |= (token.charCodeAt(i) || 0) ^ (secret.charCodeAt(i) || 0);
  }
  return difference === 0;
}

function validKey(key: string): boolean {
  if (key.length > 1024 || !/^notora\/[0-9a-f]{32}\//.test(key)) return false;
  const rest = key.slice(40);
  return rest.length > 0 && rest.split('/').every(segment =>
    segment.length > 0 && segment.length <= 128 && segment !== '.' && segment !== '..' &&
    /^[A-Za-z0-9._-]+$/.test(segment));
}
function validPrefix(prefix: string): boolean {
  if (prefix.length > 1024 || !/^notora\/[0-9a-f]{32}\//.test(prefix)) return false;
  const rest = prefix.slice(40).replace(/\/$/, '');
  return rest === '' || rest.split('/').every(segment =>
    segment.length > 0 && segment.length <= 128 && segment !== '.' && segment !== '..' &&
    /^[A-Za-z0-9._-]+$/.test(segment));
}
function parseLength(request: Request, max = MAX_REQUEST_BYTES): number {
  const raw = request.headers.get('content-length');
  if (!raw || !/^(0|[1-9]\d*)$/.test(raw)) fail(411, 'content-length required');
  const size = Number(raw);
  if (!Number.isSafeInteger(size) || size > max) fail(413, 'request body too large');
  return size;
}
function contentType(request: Request): string {
  const value = request.headers.get('content-type');
  if (!value || value.length > 128 || !/^[\x20-\x7e]+$/.test(value)) fail(400, 'content-type required');
  return value;
}
async function readBytes(request: Request, expected: number, max = MAX_REQUEST_BYTES): Promise<Uint8Array> {
  if (expected > max) fail(413, 'request body too large');
  if (!request.body) {
    if (expected === 0) return new Uint8Array();
    fail(400, 'request body length mismatch');
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > expected || total > max) fail(413, 'request body length mismatch');
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  if (total !== expected) fail(400, 'request body length mismatch');
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}
async function readJson(request: Request): Promise<Record<string, unknown>> {
  const declared = request.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > 4096)) fail(413, 'request body too large');
  const reader = request.body?.getReader();
  let length = 0;
  const chunks: Uint8Array[] = [];
  if (reader) try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > 4096) fail(413, 'request body too large');
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') fail(400, 'invalid JSON');
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof GatewayError) throw error;
    fail(400, 'invalid JSON');
  }
}
async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.buffer as ArrayBuffer));
  return Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
}
const month = (): string => new Date().toISOString().slice(0, 7);
const day = (): string => new Date().toISOString().slice(0, 10);
const etag = (object: BucketObject): string => object.httpEtag || `"${object.etag}"`;
function missingMultipart(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { status?: unknown; code?: unknown; message?: unknown };
  return candidate.status === 404 || candidate.code === 'NoSuchUpload' ||
    (typeof candidate.message === 'string' && /\bNoSuchUpload\b/.test(candidate.message));
}

export class StorageGateway {
  private sql: SqlStore;
  private locks = new Set<string>();
  private activeParts = new Map<string, Set<number>>();
  private uploadInitialization = new Map<string, Promise<string>>();
  private activeUploads = 0;
  private activeReads = 0;

  constructor(private storage: QuotaStorage, private env: GatewayEnv) {
    this.sql = storage.sql;
    const initial: Policy = {
      storage_limit: limit(env.STORAGE_LIMIT_BYTES, MAX_STORAGE_BYTES),
      class_a_limit: limit(env.CLASS_A_LIMIT, MAX_CLASS_A_MONTH),
      class_b_limit: limit(env.CLASS_B_LIMIT, MAX_CLASS_B_MONTH),
      class_a_daily_limit: limit(env.CLASS_A_DAILY_LIMIT, MAX_CLASS_A_DAY),
      class_b_daily_limit: limit(env.CLASS_B_DAILY_LIMIT, MAX_CLASS_B_DAY),
    };
    storage.transactionSync(() => {
      this.sql.exec(`CREATE TABLE IF NOT EXISTS policy (
        id INTEGER PRIMARY KEY CHECK (id=1), storage_limit INTEGER NOT NULL,
        class_a_limit INTEGER NOT NULL, class_b_limit INTEGER NOT NULL,
        class_a_daily_limit INTEGER NOT NULL, class_b_daily_limit INTEGER NOT NULL)`);
      this.sql.exec(`CREATE TABLE IF NOT EXISTS totals (
        id INTEGER PRIMARY KEY CHECK (id=1), used_bytes INTEGER NOT NULL,
        reserved_bytes INTEGER NOT NULL)`);
      this.sql.exec(`CREATE TABLE IF NOT EXISTS usage_month (
        month TEXT PRIMARY KEY, class_a_used INTEGER NOT NULL, class_b_used INTEGER NOT NULL)`);
      this.sql.exec(`CREATE TABLE IF NOT EXISTS usage_day (
        day TEXT PRIMARY KEY, class_a_used INTEGER NOT NULL, class_b_used INTEGER NOT NULL)`);
      this.sql.exec(`CREATE TABLE IF NOT EXISTS entries (
        key TEXT PRIMARY KEY, kind TEXT NOT NULL, state TEXT NOT NULL,
        size INTEGER NOT NULL, reserve INTEGER NOT NULL, part_reserved INTEGER NOT NULL,
        part_bytes INTEGER NOT NULL, content_type TEXT NOT NULL,
        digest TEXT, etag TEXT, upload_id TEXT UNIQUE, r2_upload_id TEXT,
        token TEXT NOT NULL, committed INTEGER NOT NULL)`);
      this.sql.exec(`CREATE TABLE IF NOT EXISTS parts (
        upload_id TEXT NOT NULL, part_number INTEGER NOT NULL, size INTEGER NOT NULL,
        reserved INTEGER NOT NULL, digest TEXT, etag TEXT, state TEXT NOT NULL,
        PRIMARY KEY(upload_id, part_number))`);
      this.sql.exec(`INSERT OR IGNORE INTO policy VALUES (1,?,?,?,?,?)`,
        initial.storage_limit, initial.class_a_limit, initial.class_b_limit,
        initial.class_a_daily_limit, initial.class_b_daily_limit);
      this.sql.exec(`UPDATE policy SET storage_limit=MIN(storage_limit,?),
        class_a_limit=MIN(class_a_limit,?), class_b_limit=MIN(class_b_limit,?),
        class_a_daily_limit=MIN(class_a_daily_limit,?),
        class_b_daily_limit=MIN(class_b_daily_limit,?) WHERE id=1`,
        initial.storage_limit, initial.class_a_limit, initial.class_b_limit,
        initial.class_a_daily_limit, initial.class_b_daily_limit);
      this.sql.exec(`INSERT OR IGNORE INTO totals VALUES (1,0,0)`);
    });
  }

  private rows<T>(query: string, ...bindings: unknown[]): T[] {
    return this.sql.exec<T>(query, ...bindings).toArray();
  }
  private one<T>(query: string, ...bindings: unknown[]): T {
    const row = this.rows<T>(query, ...bindings)[0];
    if (!row) fail(503, 'quota ledger unavailable');
    return row;
  }
  private policy(): Policy { return this.one<Policy>('SELECT * FROM policy WHERE id=1'); }
  private totals(): Totals { return this.one<Totals>('SELECT used_bytes,reserved_bytes FROM totals WHERE id=1'); }
  private entry(key: string): Entry | undefined {
    return this.rows<Entry>('SELECT * FROM entries WHERE key=?', key)[0];
  }
  private upload(uploadId: string): Entry | undefined {
    return this.rows<Entry>('SELECT * FROM entries WHERE upload_id=?', uploadId)[0];
  }
  private usage(table: 'usage_month' | 'usage_day', period: string): Usage {
    return this.rows<Usage>(`SELECT class_a_used,class_b_used FROM ${table} WHERE ${table === 'usage_month' ? 'month' : 'day'}=?`, period)[0]
      ?? { class_a_used: 0, class_b_used: 0 };
  }
  private charge(kind: 'a' | 'b'): void {
    this.storage.transactionSync(() => {
      const p = this.policy();
      const m = month();
      const d = day();
      const monthly = this.usage('usage_month', m);
      const daily = this.usage('usage_day', d);
      const column = kind === 'a' ? 'class_a_used' : 'class_b_used';
      const monthlyLimit = kind === 'a' ? p.class_a_limit : p.class_b_limit;
      const dailyLimit = kind === 'a' ? p.class_a_daily_limit : p.class_b_daily_limit;
      if (monthly[column] >= monthlyLimit || daily[column] >= dailyLimit) fail(429, 'operation quota exhausted');
      this.sql.exec(`INSERT OR IGNORE INTO usage_month VALUES (?,0,0)`, m);
      this.sql.exec(`INSERT OR IGNORE INTO usage_day VALUES (?,0,0)`, d);
      this.sql.exec(`UPDATE usage_month SET ${column}=${column}+1 WHERE month=?`, m);
      this.sql.exec(`UPDATE usage_day SET ${column}=${column}+1 WHERE day=?`, d);
    });
  }
  private reserve(size: number): void {
    const totals = this.totals();
    if (totals.used_bytes + totals.reserved_bytes + size > this.policy().storage_limit) {
      fail(507, 'storage quota exhausted');
    }
    this.sql.exec('UPDATE totals SET reserved_bytes=reserved_bytes+? WHERE id=1', size);
  }
  private async locked<T>(key: string, action: () => Promise<T>): Promise<T> {
    if (this.locks.has(key) || this.activeParts.get(key)?.size) fail(409, 'operation in progress');
    this.locks.add(key);
    try { return await action(); } finally { this.locks.delete(key); }
  }
  private async lockedPart<T>(key: string, number: number, action: () => Promise<T>): Promise<T> {
    if (this.locks.has(key) || this.activeParts.get(key)?.has(number)) fail(409, 'operation in progress');
    const active = this.activeParts.get(key) ?? new Set<number>();
    this.activeParts.set(key, active);
    active.add(number);
    try { return await action(); }
    finally {
      active.delete(number);
      if (active.size === 0) this.activeParts.delete(key);
    }
  }
  private async uploadSlot<T>(action: () => Promise<T>): Promise<T> {
    if (this.activeUploads >= MAX_PARALLEL_UPLOADS) fail(429, 'too many concurrent uploads');
    this.activeUploads++;
    try { return await action(); } finally { this.activeUploads--; }
  }
  private readStream(source: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
    const reader = source.getReader();
    let released = false;
    const release = () => {
      if (!released) { released = true; this.activeReads--; reader.releaseLock(); }
    };
    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const next = await reader.read();
          if (next.done) { release(); controller.close(); }
          else controller.enqueue(next.value);
        } catch (error) { release(); controller.error(error); }
      },
      async cancel(reason) {
        try { await reader.cancel(reason); } finally { release(); }
      },
    });
  }

  async fetch(request: Request): Promise<Response> {
    if (!this.env.GATEWAY_SECRET || this.env.GATEWAY_SECRET.length < 32) {
      return errorResponse(503, 'gateway configuration unavailable');
    }
    if (!authorized(request, this.env.GATEWAY_SECRET)) return errorResponse(401, 'unauthorized');
    try { return await this.route(request); }
    catch (error) {
      if (error instanceof GatewayError) return errorResponse(error.status, error.message);
      return errorResponse(503, 'storage unavailable');
    }
  }

  private async route(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    if (path === '/v1/status' && request.method === 'GET' && !url.search) return json(this.status());
    if (path === '/v1/objects' && request.method === 'GET') return this.list(url);
    if (path === '/v1/pending' && request.method === 'GET') return this.pending(url);
    if (path.startsWith('/v1/objects/')) {
      if (url.search || path.includes('%')) fail(400, 'invalid object key');
      const key = path.slice('/v1/objects/'.length);
      if (!validKey(key)) fail(400, 'invalid object key');
      if (request.method === 'PUT') return this.put(key, request);
      if (request.method === 'GET') return this.read(key, false);
      if (request.method === 'HEAD') return this.read(key, true);
      if (request.method === 'DELETE') return this.delete(key);
    }
    if (path === '/v1/multipart' && request.method === 'POST' && !url.search) {
      return this.startMultipart(request);
    }
    const part = /^\/v1\/multipart\/([0-9a-f-]{36})\/parts\/([1-9]\d*)$/.exec(path);
    if (part && request.method === 'PUT' && !url.search) return this.putPart(part[1], Number(part[2]), request);
    const action = /^\/v1\/multipart\/([0-9a-f-]{36})(\/complete)?$/.exec(path);
    if (action && !url.search) {
      if (action[2] && request.method === 'POST') return this.completeMultipart(action[1], request);
      if (!action[2] && request.method === 'DELETE') return this.abortMultipart(action[1]);
    }
    return errorResponse(404, 'not found');
  }

  private status(): Record<string, number | string> {
    const p = this.policy();
    const t = this.totals();
    const m = this.usage('usage_month', month());
    const d = this.usage('usage_day', day());
    return {
      usedBytes: t.used_bytes, reservedBytes: t.reserved_bytes, limitBytes: p.storage_limit,
      classAUsed: m.class_a_used, classALimit: p.class_a_limit,
      classBUsed: m.class_b_used, classBLimit: p.class_b_limit, month: month(),
      classADailyUsed: d.class_a_used, classADailyLimit: p.class_a_daily_limit,
      classBDailyUsed: d.class_b_used, classBDailyLimit: p.class_b_daily_limit,
    };
  }

  private async list(url: URL): Promise<Response> {
    if ([...url.searchParams.keys()].some(key => key !== 'prefix' && key !== 'cursor') ||
        url.searchParams.getAll('prefix').length !== 1 || url.searchParams.getAll('cursor').length > 1) {
      fail(400, 'invalid list query');
    }
    const prefix = url.searchParams.get('prefix') ?? '';
    const cursor = url.searchParams.get('cursor') ?? undefined;
    if (!validPrefix(prefix) || (cursor && (cursor.length > 2048 || !/^[\x21-\x7e]+$/.test(cursor)))) {
      fail(400, 'invalid list query');
    }
    this.charge('a');
    const result = await this.env.BUCKET.list({ prefix, cursor, limit: 1000 });
    return json({ objects: result.objects.map(object => ({ key: object.key, size: object.size })),
      truncated: result.truncated, ...(result.truncated && result.cursor ? { cursor: result.cursor } : {}) });
  }

  private pending(url: URL): Response {
    if ([...url.searchParams.keys()].some(key => key !== 'prefix' && key !== 'cursor') ||
        url.searchParams.getAll('prefix').length !== 1 || url.searchParams.getAll('cursor').length > 1) {
      fail(400, 'invalid pending query');
    }
    const prefix = url.searchParams.get('prefix') ?? '';
    const cursor = url.searchParams.get('cursor') ?? '';
    if (!validPrefix(prefix) || (cursor && (!validKey(cursor) || !cursor.startsWith(prefix)))) {
      fail(400, 'invalid pending query');
    }
    // Include committed rows too: a DELETE can succeed at R2 and fail before
    // SQLite releases its used-byte accounting, leaving nothing for R2 list.
    const rows = this.rows<Pick<Entry, 'key' | 'kind' | 'committed' | 'upload_id'>>(
      'SELECT key,kind,committed,upload_id FROM entries WHERE substr(key,1,?)=? AND key>? ORDER BY key LIMIT 501',
      prefix.length, prefix, cursor);
    const page = rows.slice(0, 500);
    const truncated = rows.length > 500;
    return json({
      pending: page.map(row => ({ key: row.key,
        ...(row.kind === 'multipart' && !row.committed && row.upload_id ? { uploadId: row.upload_id } : {}) })),
      truncated,
      ...(truncated ? { cursor: page[page.length - 1].key } : {}),
    });
  }

  private async read(key: string, head: boolean): Promise<Response> {
    const row = this.entry(key);
    if (!row || !row.committed || row.state !== 'committed') fail(404, 'not found');
    if (!head) {
      if (this.activeReads >= MAX_PARALLEL_READS) fail(429, 'too many concurrent reads');
      this.activeReads++;
    }
    let handedOff = false;
    try {
      this.charge('b');
      const object = head ? await this.env.BUCKET.head(key) : await this.env.BUCKET.get(key);
      if (!object || object.size !== row.size || (!head && !object.body)) fail(503, 'storage unavailable');
      const response = new Response(head ? null : this.readStream(object.body!), {
        status: 200,
        headers: {
          'content-type': row.content_type,
          'content-length': String(row.size),
          // Cloudflare may remove Content-Length when it transforms or streams
          // the response. This ledger value remains the stored object size.
          'x-notora-object-size': String(row.size),
          etag: etag(object),
          'cache-control': 'private, no-store',
          'x-content-type-options': 'nosniff',
        },
      });
      handedOff = !head;
      return response;
    } finally {
      if (!head && !handedOff) this.activeReads--;
    }
  }

  private commit(key: string, object: BucketObject): void {
    this.storage.transactionSync(() => {
      const row = this.entry(key);
      if (!row || row.committed || object.size !== row.size) fail(503, 'storage reconciliation failed');
      this.sql.exec(`UPDATE entries SET state='committed',committed=1,reserve=0,
        part_reserved=0,etag=? WHERE key=?`, etag(object), key);
      this.sql.exec('UPDATE totals SET used_bytes=used_bytes+?,reserved_bytes=reserved_bytes-? WHERE id=1',
        row.size, row.reserve + row.part_reserved);
      // Retain part digests/ETags for an idempotent backend retry after a lost
      // complete response. DELETE of the object removes them later.
    });
  }

  private async put(key: string, request: Request): Promise<Response> {
    const size = parseLength(request);
    const type = contentType(request);
    return this.locked(key, () => this.uploadSlot(async () => {
      let row = this.entry(key);
      let fresh = false;
      if (!row) {
        this.storage.transactionSync(() => {
          if (this.entry(key)) fail(409, 'object key already in use');
          this.reserve(size);
          this.sql.exec(`INSERT INTO entries VALUES (?,'single','pending',?, ?,0,0,?,NULL,NULL,NULL,NULL,?,0)`,
            key, size, size, type, crypto.randomUUID());
        });
        row = this.entry(key)!;
        fresh = true;
      } else if (row.kind !== 'single' || row.size !== size || row.content_type !== type || row.state === 'deleting') {
        fail(409, 'object key already in use');
      }
      let bytes: Uint8Array;
      try { bytes = await readBytes(request, size); }
      catch (error) {
        if (fresh) this.dropUnwritten(key);
        throw error;
      }
      const digest = await sha256(bytes);
      row = this.entry(key)!;
      if (row.digest && row.digest !== digest) fail(409, 'immutable object differs');
      if (row.committed) return json({ key, size: row.size, etag: row.etag });
      if (!row.digest) this.sql.exec('UPDATE entries SET digest=? WHERE key=?', digest, key);
      this.charge('b');
      const existing = await this.env.BUCKET.head(key);
      if (existing) {
        if (existing.size !== size || existing.customMetadata?.gatewayToken !== row.token ||
            existing.customMetadata?.sha256 !== digest) fail(409, 'immutable object differs');
        this.commit(key, existing);
        return json({ key, size, etag: etag(existing) });
      }
      this.charge('a');
      const created = await this.env.BUCKET.put(key, bytes, {
        onlyIf: new Headers({ 'If-None-Match': '*' }),
        httpMetadata: { contentType: type },
        customMetadata: { gatewayToken: row.token, sha256: digest },
        storageClass: 'Standard',
      });
      if (!created) fail(409, 'immutable object differs');
      this.commit(key, created);
      return json({ key, size, etag: etag(created) }, 201);
    }));
  }

  private dropUnwritten(key: string): void {
    this.storage.transactionSync(() => {
      const row = this.entry(key);
      if (row && row.kind === 'single' && row.state === 'pending' && !row.digest) {
        this.sql.exec('DELETE FROM entries WHERE key=?', key);
        this.sql.exec('UPDATE totals SET reserved_bytes=reserved_bytes-? WHERE id=1', row.reserve);
      }
    });
  }

  private async delete(key: string): Promise<Response> {
    return this.locked(key, async () => {
      const row = this.entry(key);
      if (row?.kind === 'multipart' && !row.committed) fail(409, 'abort multipart upload first');
      if (row) this.sql.exec(`UPDATE entries SET state='deleting' WHERE key=?`, key);
      // Delete and abort are currently free R2 operations. Charge A anyway so
      // cleanup remains bounded if provider classification changes.
      this.charge('a');
      await this.env.BUCKET.delete(key);
      if (row) this.storage.transactionSync(() => {
        const current = this.entry(key);
        if (!current || current.state !== 'deleting') fail(503, 'quota ledger unavailable');
        this.sql.exec('DELETE FROM entries WHERE key=?', key);
        if (current.upload_id) this.sql.exec('DELETE FROM parts WHERE upload_id=?', current.upload_id);
        this.sql.exec('UPDATE totals SET used_bytes=used_bytes-?,reserved_bytes=reserved_bytes-? WHERE id=1',
          current.committed ? current.size : 0, current.reserve + current.part_reserved);
      });
      return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
    });
  }

  private async startMultipart(request: Request): Promise<Response> {
    const body = await readJson(request);
    if (Object.keys(body).some(key => !['key', 'size', 'contentType'].includes(key)) ||
        typeof body.key !== 'string' || !validKey(body.key) ||
        typeof body.size !== 'number' || !Number.isSafeInteger(body.size) ||
        body.size < 1 || body.size > MAX_STORAGE_BYTES ||
        typeof body.contentType !== 'string' || body.contentType.length === 0 ||
        body.contentType.length > 128 || !/^[\x20-\x7e]+$/.test(body.contentType)) {
      fail(400, 'invalid multipart request');
    }
    const key = body.key;
    const size = body.size;
    const type = body.contentType;
    return this.locked(key, async () => {
      const existing = this.entry(key);
      if (existing) {
        if (existing.kind === 'multipart' && existing.state !== 'aborting' &&
            existing.state !== 'deleting' && existing.size === size && existing.content_type === type) {
          return json({ uploadId: existing.upload_id });
        }
        fail(409, 'object key already in use');
      }
      const uploadId = crypto.randomUUID();
      this.storage.transactionSync(() => {
        this.reserve(size);
        this.sql.exec(`INSERT INTO entries VALUES (?,'multipart','uploading',?,?,0,0,?,NULL,NULL,?,NULL,?,0)`,
          key, size, size, type, uploadId, crypto.randomUUID());
      });
      return json({ uploadId }, 201);
    });
  }

  private async putPart(uploadId: string, partNumber: number, request: Request): Promise<Response> {
    const row = this.upload(uploadId);
    if (!row || row.kind !== 'multipart') fail(404, 'upload not found');
    if (!Number.isSafeInteger(partNumber) || partNumber > 10_000) fail(400, 'invalid part number');
    const expectedParts = Math.ceil(row.size / MAX_REQUEST_BYTES);
    if (partNumber > expectedParts) fail(400, 'invalid part number');
    const expectedSize = Math.min(MAX_REQUEST_BYTES, row.size - (partNumber - 1) * MAX_REQUEST_BYTES);
    const size = parseLength(request);
    if (size !== expectedSize) fail(400, 'part length mismatch');
    return this.lockedPart(row.key, partNumber, () => this.uploadSlot(async () => {
      let current = this.upload(uploadId);
      if (!current) fail(404, 'upload not found');
      let part = this.rows<Part>('SELECT * FROM parts WHERE upload_id=? AND part_number=?', uploadId, partNumber)[0];
      if (current.state !== 'uploading' &&
          !((current.state === 'completing' || current.state === 'committed') && part?.state === 'committed')) {
        fail(409, 'upload not writable');
      }
      let added = 0;
      if (part?.state !== 'committed') {
        this.storage.transactionSync(() => {
          this.reserve(size);
          if (part) {
            this.sql.exec('UPDATE parts SET reserved=reserved+? WHERE upload_id=? AND part_number=?',
              size, uploadId, partNumber);
          } else {
            this.sql.exec(`INSERT INTO parts VALUES (?,?,?,?,NULL,NULL,'pending')`, uploadId, partNumber, size, size);
          }
          this.sql.exec('UPDATE entries SET part_reserved=part_reserved+? WHERE key=?', size, row.key);
        });
        added = size;
      }
      let bytes: Uint8Array;
      try { bytes = await readBytes(request, size); }
      catch (error) {
        if (added) this.unreservePart(uploadId, partNumber, added);
        throw error;
      }
      const digest = await sha256(bytes);
      part = this.rows<Part>('SELECT * FROM parts WHERE upload_id=? AND part_number=?', uploadId, partNumber)[0];
      if (part?.digest && part.digest !== digest) {
        if (added) this.unreservePart(uploadId, partNumber, added);
        fail(409, 'immutable part differs');
      }
      if (part?.state === 'committed') return json({ partNumber, etag: part.etag });
      if (!part?.digest) this.sql.exec('UPDATE parts SET digest=? WHERE upload_id=? AND part_number=?',
        digest, uploadId, partNumber);
      const r2id = await this.ensureMultipartUpload(row.key);
      this.charge('a');
      const uploaded = await this.env.BUCKET.resumeMultipartUpload(row.key, r2id).uploadPart(partNumber, bytes);
      this.storage.transactionSync(() => {
        const p = this.rows<Part>('SELECT * FROM parts WHERE upload_id=? AND part_number=?', uploadId, partNumber)[0];
        if (!p || p.state === 'committed') fail(503, 'quota ledger unavailable');
        this.sql.exec(`UPDATE parts SET state='committed',etag=? WHERE upload_id=? AND part_number=?`,
          uploaded.etag, uploadId, partNumber);
        this.sql.exec('UPDATE entries SET part_bytes=part_bytes+? WHERE key=?', size, row.key);
      });
      return json({ partNumber, etag: uploaded.etag });
    }));
  }

  private async ensureMultipartUpload(key: string): Promise<string> {
    const row = this.entry(key);
    if (!row || row.kind !== 'multipart' || !row.upload_id) fail(503, 'quota ledger unavailable');
    if (row.r2_upload_id) return row.r2_upload_id;
    const inflight = this.uploadInitialization.get(key);
    if (inflight) return inflight;
    const creating = (async () => {
      this.charge('b');
      const object = await this.env.BUCKET.head(key);
      if (object) fail(409, 'object key already in use');
      this.charge('a');
      const created = await this.env.BUCKET.createMultipartUpload(key, {
        httpMetadata: { contentType: row.content_type },
        customMetadata: { gatewayToken: row.token },
        storageClass: 'Standard',
      });
      this.sql.exec('UPDATE entries SET r2_upload_id=? WHERE key=? AND r2_upload_id IS NULL',
        created.uploadId, key);
      return created.uploadId;
    })();
    this.uploadInitialization.set(key, creating);
    try { return await creating; }
    finally { this.uploadInitialization.delete(key); }
  }

  private unreservePart(uploadId: string, partNumber: number, amount: number): void {
    this.storage.transactionSync(() => {
      const row = this.upload(uploadId);
      const part = this.rows<Part>('SELECT * FROM parts WHERE upload_id=? AND part_number=?', uploadId, partNumber)[0];
      if (!row || !part || part.reserved < amount || part.state === 'committed') return;
      if (part.reserved === amount && !part.digest) {
        this.sql.exec('DELETE FROM parts WHERE upload_id=? AND part_number=?', uploadId, partNumber);
      } else {
        this.sql.exec('UPDATE parts SET reserved=reserved-? WHERE upload_id=? AND part_number=?',
          amount, uploadId, partNumber);
      }
      this.sql.exec('UPDATE entries SET part_reserved=part_reserved-? WHERE key=?', amount, row.key);
      this.sql.exec('UPDATE totals SET reserved_bytes=reserved_bytes-? WHERE id=1', amount);
    });
  }

  private async completeMultipart(uploadId: string, request: Request): Promise<Response> {
    const body = await readJson(request);
    if (Object.keys(body).length !== 0) fail(400, 'invalid multipart request');
    const found = this.upload(uploadId);
    if (!found || found.kind !== 'multipart') fail(404, 'upload not found');
    return this.locked(found.key, async () => {
      const row = this.upload(uploadId);
      if (!row) fail(404, 'upload not found');
      if (row.committed) return json({ key: row.key, size: row.size, etag: row.etag });
      if (row.state !== 'uploading' && row.state !== 'completing') fail(409, 'upload not completable');
      const parts = this.rows<Part>('SELECT * FROM parts WHERE upload_id=? ORDER BY part_number', uploadId);
      const count = Math.ceil(row.size / MAX_REQUEST_BYTES);
      if (parts.length !== count || row.part_bytes !== row.size || !row.r2_upload_id ||
          parts.some((part, i) => part.part_number !== i + 1 || part.state !== 'committed' ||
            part.size !== Math.min(MAX_REQUEST_BYTES, row.size - i * MAX_REQUEST_BYTES) || !part.etag)) {
        fail(409, 'multipart upload incomplete');
      }
      this.sql.exec(`UPDATE entries SET state='completing' WHERE key=?`, row.key);
      this.charge('b');
      const existing = await this.env.BUCKET.head(row.key);
      if (existing) {
        if (existing.size !== row.size || existing.customMetadata?.gatewayToken !== row.token) {
          fail(409, 'immutable object differs');
        }
        this.commit(row.key, existing);
        return json({ key: row.key, size: row.size, etag: etag(existing) });
      }
      this.charge('a');
      const object = await this.env.BUCKET.resumeMultipartUpload(row.key, row.r2_upload_id)
        .complete(parts.map(part => ({ partNumber: part.part_number, etag: part.etag! })));
      this.commit(row.key, object);
      return json({ key: row.key, size: row.size, etag: etag(object) });
    });
  }

  private async abortMultipart(uploadId: string): Promise<Response> {
    const found = this.upload(uploadId);
    if (!found) return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
    if (found.kind !== 'multipart') fail(404, 'upload not found');
    return this.locked(found.key, async () => {
      const row = this.upload(uploadId);
      if (!row) return new Response(null, { status: 204 });
      if (row.committed) fail(409, 'upload already completed; delete object explicitly');
      this.sql.exec(`UPDATE entries SET state='aborting' WHERE key=?`, row.key);
      if (row.r2_upload_id) {
        this.charge('b');
        const object = await this.env.BUCKET.head(row.key);
        if (object) {
          if (object.customMetadata?.gatewayToken !== row.token || object.size !== row.size) {
            fail(409, 'immutable object differs');
          }
          this.commit(row.key, object);
          fail(409, 'upload already completed; delete object explicitly');
        }
        this.charge('a');
        try { await this.env.BUCKET.resumeMultipartUpload(row.key, row.r2_upload_id).abort(); }
        catch (error) { if (!missingMultipart(error)) throw error; }
      }
      this.storage.transactionSync(() => {
        const current = this.upload(uploadId);
        if (!current || current.state !== 'aborting') fail(503, 'quota ledger unavailable');
        this.sql.exec('DELETE FROM parts WHERE upload_id=?', uploadId);
        this.sql.exec('DELETE FROM entries WHERE key=?', current.key);
        this.sql.exec('UPDATE totals SET reserved_bytes=reserved_bytes-? WHERE id=1',
          current.reserve + current.part_reserved);
      });
      return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
    });
  }
}
