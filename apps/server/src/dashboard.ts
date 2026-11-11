import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { chmodSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { DashboardDocument, DashboardDocumentsResponse, DashboardSession } from '../../../packages/shared/src/index.ts';
import type { DocumentRecord, DocumentStore } from './store.ts';

const COOKIE_NAME = 'notora_dashboard';
const SESSION_MS = 8 * 60 * 60 * 1000;
const LOGIN_WINDOW_MS = 5 * 60 * 1000;
const MAX_LOGIN_ATTEMPTS = 10;
const MAX_LOGIN_CLIENTS = 2048;
const MAX_SESSIONS = 1024;
const ACCESS_WRITE_INTERVAL_MS = 5_000;

interface CatalogMetadata {
  hostName: string | null;
  uploadedAt: number | null;
  lastAccessedAt: number | null;
}

interface CatalogRow {
  id: string;
  host_name: string | null;
  uploaded_at: number | null;
  last_accessed_at: number | null;
}

export interface DashboardOptions {
  username?: string;
  passwordHash?: string;
  publicOrigin?: string;
  now?: () => number;
  sessionTtlMs?: number;
}

export function cleanHostName(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 160) return null;
  const name = value.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return name && name.length <= 80 ? name : null;
}

function knownTimestamp(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

export class DashboardCatalog {
  private readonly db: DatabaseSync;
  private readonly metadata = new Map<string, CatalogMetadata>();
  private readonly pendingAccess = new Set<string>();
  private readonly lastWrittenAt = new Map<string, number>();
  private accessFlushTimer?: NodeJS.Timeout;
  private readonly insert;
  private readonly updateAccess;
  private readonly deleteRecordStatement;
  private readonly now: () => number;

  constructor(dataDir: string, documents: ReadonlyMap<string, DocumentRecord>, now: () => number = Date.now) {
    this.now = now;
    const path = join(dataDir, 'dashboard.sqlite3');
    this.db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS dashboard_documents (
        id TEXT PRIMARY KEY,
        host_name TEXT,
        uploaded_at INTEGER,
        last_accessed_at INTEGER
      )
    `);
    this.insert = this.db.prepare(`
      INSERT INTO dashboard_documents (id, host_name, uploaded_at, last_accessed_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        host_name = COALESCE(dashboard_documents.host_name, excluded.host_name),
        uploaded_at = COALESCE(dashboard_documents.uploaded_at, excluded.uploaded_at)
    `);
    this.updateAccess = this.db.prepare(`
      UPDATE dashboard_documents SET host_name = ?, last_accessed_at = ? WHERE id = ?
    `);
    this.deleteRecordStatement = this.db.prepare('DELETE FROM dashboard_documents WHERE id = ?');
    for (const row of this.db.prepare('SELECT id, host_name, uploaded_at, last_accessed_at FROM dashboard_documents').all() as unknown as CatalogRow[]) {
      if (documents.has(row.id)) {
        this.metadata.set(row.id, {
          hostName: row.host_name,
          uploadedAt: knownTimestamp(row.uploaded_at),
          lastAccessedAt: knownTimestamp(row.last_accessed_at),
        });
      }
    }
    this.db.exec('BEGIN');
    try {
      for (const record of documents.values()) this.upsertRecord(record);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      this.db.close();
      throw error;
    }
  }

  upsertRecord(record: DocumentRecord): void {
    const id = record.manifest.id;
    const previous = this.metadata.get(id);
    const current: CatalogMetadata = {
      hostName: previous?.hostName ?? cleanHostName(record.hostName),
      uploadedAt: previous?.uploadedAt ?? knownTimestamp(record.createdAt),
      lastAccessedAt: previous?.lastAccessedAt ?? null,
    };
    this.insert.run(id, current.hostName, current.uploadedAt, current.lastAccessedAt);
    this.metadata.set(id, current);
  }

  removeRecord(id: string): void {
    this.deleteRecordStatement.run(id);
    this.metadata.delete(id);
    this.pendingAccess.delete(id);
    this.lastWrittenAt.delete(id);
  }

  private writeAccess(id: string): void {
    const metadata = this.metadata.get(id);
    if (!metadata) return;
    this.updateAccess.run(metadata.hostName, metadata.lastAccessedAt, id);
    this.pendingAccess.delete(id);
    this.lastWrittenAt.set(id, this.now());
  }

  private scheduleAccessFlush(): void {
    if (this.accessFlushTimer || !this.pendingAccess.size) return;
    this.accessFlushTimer = setTimeout(() => {
      this.accessFlushTimer = undefined;
      for (const id of [...this.pendingAccess]) {
        try { this.writeAccess(id); } catch { /* Retry at shutdown or the next timer. */ }
      }
      this.scheduleAccessFlush();
    }, ACCESS_WRITE_INTERVAL_MS);
    this.accessFlushTimer.unref();
  }

  recordAccess(record: DocumentRecord, verifiedOwnerName?: string): void {
    const id = record.manifest.id;
    if (!this.metadata.has(id)) this.upsertRecord(record);
    const metadata = this.metadata.get(id)!;
    const ownerName = cleanHostName(verifiedOwnerName);
    const hostChanged = ownerName !== null && ownerName !== metadata.hostName;
    metadata.hostName = ownerName ?? metadata.hostName;
    metadata.lastAccessedAt = this.now();
    const lastWrite = this.lastWrittenAt.get(id);
    if (hostChanged || lastWrite === undefined || metadata.lastAccessedAt - lastWrite >= ACCESS_WRITE_INTERVAL_MS) {
      try { this.writeAccess(id); }
      catch (error) { this.pendingAccess.add(id); this.scheduleAccessFlush(); throw error; }
    } else {
      this.pendingAccess.add(id);
      this.scheduleAccessFlush();
    }
  }

  list(documents: ReadonlyMap<string, DocumentRecord>, offset: number, limit: number): DashboardDocumentsResponse {
    const entries: DashboardDocument[] = [];
    for (const record of documents.values()) {
      if (record.deleting) continue;
      const metadata = this.metadata.get(record.manifest.id);
      entries.push({
        id: record.manifest.id,
        title: record.manifest.title,
        hostName: metadata?.hostName ?? cleanHostName(record.hostName),
        uploadedAt: metadata?.uploadedAt ?? knownTimestamp(record.createdAt),
        lastAccessedAt: metadata?.lastAccessedAt ?? null,
        sizeBytes: record.uploadedBytes,
        pageCount: record.manifest.pageCount,
        status: record.manifest.status,
        provenance: record.provenance ?? { hostId: null, ipAddress: null, countryCode: null, userAgent: null },
        storageProvider: record.storageProvider ?? 'local',
        storagePrefix: record.storagePrefix,
        storageBytes: record.storageBytes,
      });
    }
    entries.sort((a, b) => (b.uploadedAt ?? -1) - (a.uploadedAt ?? -1) || b.id.localeCompare(a.id));
    return { documents: entries.slice(offset, offset + limit), total: entries.length, offset, limit };
  }

  close(): void {
    if (this.accessFlushTimer) clearTimeout(this.accessFlushTimer);
    for (const id of [...this.pendingAccess]) {
      try { this.writeAccess(id); } catch { /* Shutdown must still close the database. */ }
    }
    this.db.close();
  }
}

interface Session { expiresAt: number }
interface Attempt { count: number; resetAt: number }

class DashboardAuth {
  readonly username: string | null;
  private readonly salt: Buffer | null;
  private readonly digest: Buffer | null;
  private readonly publicOrigin: string | null;
  private readonly invalidOrigin: boolean;
  private readonly secureCookie: boolean;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly sessions = new Map<string, Session>();
  private readonly attempts = new Map<string, Attempt>();

  constructor(options: DashboardOptions = {}) {
    const username = options.username ?? process.env.DASHBOARD_USERNAME;
    const encoded = options.passwordHash ?? process.env.DASHBOARD_PASSWORD_HASH;
    const hash = /^scrypt:([0-9a-f]{32}):([0-9a-f]{128})$/.exec(encoded ?? '');
    this.username = typeof username === 'string' && username.length > 0 && username.length <= 128 && hash ? username : null;
    this.salt = hash ? Buffer.from(hash[1], 'hex') : null;
    this.digest = hash ? Buffer.from(hash[2], 'hex') : null;
    const origin = options.publicOrigin ?? process.env.PUBLIC_ORIGIN;
    let parsedOrigin: URL | null = null;
    try { if (origin) parsedOrigin = new URL(origin); } catch { /* Invalid configuration fails closed. */ }
    this.invalidOrigin = Boolean(origin) && (!parsedOrigin || !['http:', 'https:'].includes(parsedOrigin.protocol)
      || parsedOrigin.origin !== parsedOrigin.href.replace(/\/$/, ''));
    this.publicOrigin = parsedOrigin?.origin ?? null;
    this.secureCookie = process.env.NODE_ENV === 'production' || parsedOrigin?.protocol === 'https:';
    this.now = options.now ?? Date.now;
    this.ttlMs = Number.isSafeInteger(options.sessionTtlMs) && (options.sessionTtlMs ?? 0) > 0
      ? options.sessionTtlMs! : SESSION_MS;
  }

  get configured(): boolean { return this.username !== null && !this.invalidOrigin; }

  sameOrigin(request: FastifyRequest): boolean {
    const expected = this.publicOrigin ?? `${request.protocol}://${request.headers.host ?? ''}`;
    const origin = request.headers.origin;
    if (origin !== undefined) return origin === expected;
    const fetchSite = request.headers['sec-fetch-site'];
    return fetchSite === 'same-origin' || fetchSite === 'none';
  }

  private sessionHash(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  private sessionToken(request: FastifyRequest): string | null {
    const header = request.headers.cookie;
    if (!header) return null;
    const matches = header.split(';').map(part => part.trim()).filter(part => part.startsWith(`${COOKIE_NAME}=`));
    if (matches.length !== 1) return null;
    const token = matches[0].slice(COOKIE_NAME.length + 1);
    return /^[A-Za-z0-9_-]{43}$/.test(token) ? token : null;
  }

  session(request: FastifyRequest): DashboardSession | null {
    const token = this.sessionToken(request);
    if (!token) return null;
    const key = this.sessionHash(token);
    const session = this.sessions.get(key);
    if (!session) return null;
    if (session.expiresAt <= this.now()) {
      this.sessions.delete(key);
      return null;
    }
    return { username: this.username! };
  }

  allowAttempt(request: FastifyRequest): boolean {
    const now = this.now();
    const key = request.ip;
    const previous = this.attempts.get(key);
    if (!previous || previous.resetAt <= now) {
      if (this.attempts.size >= MAX_LOGIN_CLIENTS) this.attempts.delete(this.attempts.keys().next().value!);
      this.attempts.set(key, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
      return true;
    }
    if (previous.count >= MAX_LOGIN_ATTEMPTS) return false;
    previous.count += 1;
    return true;
  }

  resetAttempts(request: FastifyRequest): void { this.attempts.delete(request.ip); }

  async verify(username: string, password: string): Promise<boolean> {
    if (!this.salt || !this.digest || !this.username) return false;
    const computed = await new Promise<Buffer>((resolve, reject) => {
      scrypt(password, this.salt!, 64, { N: 16384, r: 8, p: 1 }, (error, derived) => {
        if (error) reject(error); else resolve(derived);
      });
    });
    const actualUser = createHash('sha256').update(username).digest();
    const expectedUser = createHash('sha256').update(this.username).digest();
    const passwordMatches = timingSafeEqual(computed, this.digest);
    const usernameMatches = timingSafeEqual(actualUser, expectedUser);
    return passwordMatches && usernameMatches;
  }

  createSession(reply: FastifyReply): DashboardSession {
    const now = this.now();
    for (const [key, session] of this.sessions) if (session.expiresAt <= now) this.sessions.delete(key);
    if (this.sessions.size >= MAX_SESSIONS) this.sessions.delete(this.sessions.keys().next().value!);
    const token = randomBytes(32).toString('base64url');
    this.sessions.set(this.sessionHash(token), { expiresAt: now + this.ttlMs });
    reply.header('Set-Cookie', `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Strict; Path=/api/dashboard; Max-Age=${Math.ceil(this.ttlMs / 1000)}${this.secureCookie ? '; Secure' : ''}`);
    return { username: this.username! };
  }

  revoke(request: FastifyRequest, reply: FastifyReply): void {
    const token = this.sessionToken(request);
    if (token) this.sessions.delete(this.sessionHash(token));
    reply.header('Set-Cookie', `${COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/api/dashboard; Max-Age=0${this.secureCookie ? '; Secure' : ''}`);
  }
}

function jsonRequest(request: FastifyRequest): boolean {
  return /^application\/json(?:\s*;|$)/i.test(String(request.headers['content-type'] ?? ''));
}

function pagination(value: unknown, fallback: number, maximum: number): number | null {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)$/.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number <= maximum ? number : null;
}

export function attachDashboard(app: FastifyInstance, store: DocumentStore, catalog: DashboardCatalog, options: DashboardOptions = {}): void {
  const auth = new DashboardAuth(options);
  const unavailable = (reply: FastifyReply) => reply.code(503).send({ error: 'Dashboard unavailable' });
  const unauthorized = (reply: FastifyReply) => reply.code(401).send({ error: 'Dashboard login required' });

  app.addHook('onRequest', async (request, reply) => {
    if (request.url.startsWith('/api/dashboard/')) reply.header('Cache-Control', 'private, no-store');
  });

  app.post('/api/dashboard/login', { bodyLimit: 2048 }, async (request, reply) => {
    if (!auth.configured) return unavailable(reply);
    if (!auth.sameOrigin(request)) return reply.code(403).send({ error: 'Origin denied' });
    if (!jsonRequest(request)) return reply.code(415).send({ error: 'Send JSON' });
    const body = request.body as Record<string, unknown> | null;
    if (!body || typeof body !== 'object' || Array.isArray(body)
      || typeof body.username !== 'string' || typeof body.password !== 'string'
      || body.username.length > 128 || body.password.length > 1024 || !body.password) {
      return reply.code(400).send({ error: 'Invalid login' });
    }
    if (!auth.allowAttempt(request)) return reply.code(429).send({ error: 'Too many login attempts' });
    if (!(await auth.verify(body.username, body.password))) return unauthorized(reply);
    auth.resetAttempts(request);
    return reply.send(auth.createSession(reply));
  });

  app.get('/api/dashboard/session', async (request, reply) => {
    if (!auth.configured) return unavailable(reply);
    return auth.session(request) ?? unauthorized(reply);
  });

  app.post('/api/dashboard/logout', async (request, reply) => {
    if (!auth.configured) return unavailable(reply);
    if (!auth.sameOrigin(request)) return reply.code(403).send({ error: 'Origin denied' });
    auth.revoke(request, reply);
    return reply.code(204).send();
  });

  app.get<{ Querystring: { offset?: string; limit?: string } }>('/api/dashboard/documents', async (request, reply) => {
    if (!auth.configured) return unavailable(reply);
    if (!auth.session(request)) return unauthorized(reply);
    const offset = pagination(request.query.offset, 0, Number.MAX_SAFE_INTEGER);
    const limit = pagination(request.query.limit, 50, 100);
    if (offset === null || limit === null || limit < 1) return reply.code(400).send({ error: 'Invalid pagination' });
    return { ...catalog.list(store.documents, offset, limit), storage: await store.storageBudget() };
  });

  app.delete<{ Params: { id: string } }>('/api/dashboard/documents/:id', async (request, reply) => {
    if (!auth.configured) return unavailable(reply);
    if (!auth.session(request)) return unauthorized(reply);
    if (!auth.sameOrigin(request)) return reply.code(403).send({ error: 'Origin denied' });
    try {
      await store.deleteDocument(request.params.id);
      return reply.code(204).send();
    } catch (error) {
      const status = typeof (error as { statusCode?: unknown }).statusCode === 'number'
        ? (error as { statusCode: number }).statusCode : 503;
      return reply.code(status).send({ error: status === 409 ? 'Document is busy' : status === 404 ? 'Document unavailable' : 'Document deletion failed' });
    }
  });
}
