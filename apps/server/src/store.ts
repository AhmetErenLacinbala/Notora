import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { mkdir, open, opendir, readFile, readdir, rename, rm, stat, truncate, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { MAX_UPLOAD_CHUNK_BYTES, type DocumentManifest, type PageLink, type StorageBudget, type UploadProvenance, type UploadResult, type UploadSession, type UploadStatus } from '../../../packages/shared/src/index.ts';
import type { PdfTools } from './pdf.ts';
import { cleanHostName } from './dashboard.ts';
import { R2Gateway, R2_LIMIT_BYTES, type GatewayObject } from './r2.ts';

const ID_PATTERN = /^[0-9a-f]{32}$/;
const PDF_HEADER = Buffer.from('%PDF-');
const UPLOAD_SESSION_IDLE_MS = 30 * 60 * 1000;
const UPLOAD_FIRST_DATA_MS = 5 * 60 * 1000;
const UPLOAD_ABSOLUTE_MS = 2 * 60 * 60 * 1000;
const UPLOAD_CHUNK_BUSY_MS = 2 * 60 * 1000;
const MAX_ACTIVE_UPLOAD_SESSIONS = 8;
const MAX_COMPLETED_UPLOAD_SESSIONS = 1024;
const RECORD_RESERVE_BYTES = 2048;

interface PendingUpload {
  id: string;
  tokenHash: string;
  filename: string;
  size: number;
  offset: number;
  createdAt: number;
  lastProgressAt: number;
  busy: boolean;
  broken?: boolean;
  result?: UploadResult;
  hostName?: string;
  provenance?: UploadProvenance;
  activeSource?: NodeJS.ReadableStream;
}

export interface DocumentRecord {
  manifest: DocumentManifest;
  accessHash: string;
  ownerHash: string;
  uploadedBytes: number;
  createdAt: number;
  hostName?: string;
  provenance?: UploadProvenance;
  storageProvider?: 'local' | 'r2';
  storagePrefix?: string;
  storageBytes?: number;
  cloudPendingBytes?: number;
  deleting?: boolean;
}

interface DashboardCatalogSink {
  upsertRecord(record: DocumentRecord): void;
  recordAccess(record: DocumentRecord, verifiedOwnerName?: string): void;
  removeRecord(id: string): void;
}

export class UploadError extends Error {
  constructor(public statusCode: number, message: string, public offset?: number) { super(message); }
}

function hash(value: string): Buffer { return createHash('sha256').update(value).digest(); }

function validToken(actual: string, expectedHex: string): boolean {
  if (!actual || !/^[0-9a-f]{64}$/.test(expectedHex)) return false;
  return timingSafeEqual(hash(actual), Buffer.from(expectedHex, 'hex'));
}

function titleFromFilename(filename: string): string {
  const leaf = filename.replaceAll('\\', '/').split('/').pop() || '';
  const withoutExtension = leaf.replace(/\.pdf$/i, '');
  return withoutExtension.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 180) || 'Untitled PDF';
}

async function syncDirectory(path: string): Promise<void> {
  // Directory fsync is available on Unix (our production container); ignore
  // filesystems that do not support it during local development.
  try {
    const handle = await open(path, 'r');
    try { await handle.sync(); } finally { await handle.close(); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EINVAL') throw error;
  }
}

async function writeJsonDurable(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
    const handle = await open(temporary, 'r');
    try { await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, path);
    await syncDirectory(dirname(path));
  } finally {
    await rm(temporary, { force: true });
  }
}

async function directoryBytes(path: string): Promise<number> {
  let total = 0;
  let entries;
  try { entries = await opendir(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw error;
  }
  for await (const entry of entries) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) total += await directoryBytes(child);
    else if (entry.isFile()) total += (await stat(child)).size;
  }
  return total;
}

export class DocumentStore {
  readonly documents = new Map<string, DocumentRecord>();
  private usedBytes = 0;
  private reservedBytes = 0;
  private readonly uploads = new Map<string, PendingUpload>();
  private uploadExpiryTimer?: NodeJS.Timeout;
  private queue: string[] = [];
  private processing = false;
  private idleResolvers: Array<() => void> = [];
  private fingerprints = new Map<string, Promise<{ sha256: string; size: number }>>();
  private fingerprintTail: Promise<unknown> = Promise.resolve();
  private dashboardCatalog?: DashboardCatalogSink;
  private cloudPendingBytes = 0;
  private legacyActive = 0;
  private deleting = new Set<string>();
  private migrating = new Set<string>();
  private activeReads = new Map<string, number>();
  private activeSessions = new Map<string, number>();
  private activeLocalReads = new Map<string, number>();
  private localReadWaiters = new Map<string, Set<(drained: boolean) => void>>();
  private pendingRecoveries: string[] = [];

  constructor(
    readonly dataDir: string,
    private readonly maxUploadBytes: number,
    private readonly storageBudgetBytes: number,
    private readonly pdf: PdfTools,
    readonly r2?: R2Gateway,
  ) {}

  private documentsDir(): string { return join(this.dataDir, 'documents'); }
  private incomingDir(): string { return join(this.dataDir, 'incoming'); }
  documentDir(id: string): string { return join(this.documentsDir(), id); }
  pagePath(id: string, version: string, number: number): string { return join(this.documentDir(id), 'pages', version, `${number}.pdf`); }
  linkPath(id: string, version: string, number: number): string { return join(this.documentDir(id), 'links', version, `${number}.json`); }

  async initialize(): Promise<void> {
    await mkdir(this.documentsDir(), { recursive: true });
    await rm(this.incomingDir(), { recursive: true, force: true });
    await mkdir(this.incomingDir(), { recursive: true });
    const pending: string[] = [];
    let missingR2 = false;
    for (const id of await readdir(this.documentsDir())) {
      if (!ID_PATTERN.test(id)) continue;
      try {
        const record = JSON.parse(await readFile(join(this.documentDir(id), 'record.json'), 'utf8')) as DocumentRecord;
        if (record.manifest?.id !== id || !validRecord(record)) continue;
        if (record.storageProvider === 'r2' && !this.r2) missingR2 = true;
        this.documents.set(id, record);
        if (this.r2 && record.cloudPendingBytes) this.cloudPendingBytes += record.cloudPendingBytes;
        if (record.deleting) { pending.push(id); continue; }
        if (record.manifest.status === 'processing') {
          await rm(join(this.documentDir(id), 'pages'), { recursive: true, force: true });
          await rm(join(this.documentDir(id), 'links'), { recursive: true, force: true });
          pending.push(id);
        } else if (this.r2 && record.cloudPendingBytes && record.manifest.status === 'ready') pending.push(id);
        else if (this.r2 && record.storageProvider === 'r2'
          && ['original.pdf', 'pages', 'links'].some(name => existsSync(join(this.documentDir(id), name)))) pending.push(id);
      } catch {
        // A partial upload without committed metadata is not a published document.
      }
    }
    if (missingR2) throw new Error('R2 gateway configuration is required for stored cloud documents');
    this.usedBytes = await directoryBytes(this.documentsDir());
    this.pendingRecoveries = pending;
    this.uploadExpiryTimer = setInterval(() => { void this.expireIdleUploads().catch(() => {}); }, 60_000);
    this.uploadExpiryTimer.unref();
  }

  close(): void { if (this.uploadExpiryTimer) clearInterval(this.uploadExpiryTimer); this.r2?.close(); }

  setDashboardCatalog(catalog: DashboardCatalogSink): void {
    this.dashboardCatalog = catalog;
    for (const id of this.pendingRecoveries.splice(0)) this.enqueue(id);
  }

  recordDashboardAccess(id: string, verifiedOwnerName?: string): void {
    const record = this.getRecord(id);
    if (!record) return;
    try { this.dashboardCatalog?.recordAccess(record, verifiedOwnerName); }
    catch { /* A catalog write must not interrupt an authorized document session. */ }
  }

  getRecord(id: string): DocumentRecord | undefined {
    const record = ID_PATTERN.test(id) ? this.documents.get(id) : undefined;
    return record?.deleting ? undefined : record;
  }

  beginRead(id: string): () => void {
    const record = this.getRecord(id);
    if (!record || this.deleting.has(id)) throw new UploadError(404, 'Document unavailable');
    const local = record.storageProvider !== 'r2';
    this.activeReads.set(id, (this.activeReads.get(id) ?? 0) + 1);
    if (local) this.activeLocalReads.set(id, (this.activeLocalReads.get(id) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const count = (this.activeReads.get(id) ?? 1) - 1;
      if (count) this.activeReads.set(id, count); else this.activeReads.delete(id);
      if (local) {
        const localCount = (this.activeLocalReads.get(id) ?? 1) - 1;
        if (localCount) this.activeLocalReads.set(id, localCount);
        else {
          this.activeLocalReads.delete(id);
          for (const resolve of this.localReadWaiters.get(id) ?? []) resolve(true);
          this.localReadWaiters.delete(id);
        }
      }
    };
  }

  beginSession(id: string): () => void {
    if (!this.getRecord(id) || this.deleting.has(id)) throw new UploadError(404, 'Document unavailable');
    this.activeSessions.set(id, (this.activeSessions.get(id) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const count = (this.activeSessions.get(id) ?? 1) - 1;
      if (count) this.activeSessions.set(id, count); else this.activeSessions.delete(id);
    };
  }

  private waitForLocalReads(id: string): Promise<boolean> {
    if (!this.activeLocalReads.has(id)) return Promise.resolve(true);
    return new Promise(resolve => {
      const waiters = this.localReadWaiters.get(id) ?? new Set<(drained: boolean) => void>();
      this.localReadWaiters.set(id, waiters);
      const done = (drained: boolean) => { clearTimeout(timer); waiters.delete(done); resolve(drained); };
      waiters.add(done);
      const timer = setTimeout(() => done(false), 30_000);
      timer.unref();
    });
  }

  authorize(id: string, accessToken: string, ownerToken?: string): { record: DocumentRecord; owner: boolean } | null {
    const record = this.getRecord(id);
    if (!record || !validToken(accessToken, record.accessHash)) return null;
    if (ownerToken !== undefined && !validToken(ownerToken, record.ownerHash)) return null;
    return { record, owner: ownerToken !== undefined };
  }

  fingerprint(id: string): Promise<{ sha256: string; size: number }> {
    const record = this.getRecord(id);
    if (!record) return Promise.reject(new UploadError(404, 'Document unavailable'));
    if (record.manifest.contentHash) return Promise.resolve({ sha256: record.manifest.contentHash, size: record.uploadedBytes });
    const pending = this.fingerprints.get(id);
    if (pending) return pending;
    // Serialize disk scans and coalesce duplicate requests. Never load the PDF
    // into a Buffer; large legacy documents need only a bounded read window.
    const work = this.fingerprintTail.catch(() => {}).then(async () => {
      if (this.getRecord(id)?.manifest.status === 'processing') await this.waitForIdle();
      const current = this.getRecord(id)!;
      if (current.manifest.contentHash) return { sha256: current.manifest.contentHash, size: current.uploadedBytes };
      const digest = createHash('sha256');
      const source = current.storageProvider === 'r2' && this.r2
        ? (await this.r2.getObject(`${current.storagePrefix}original.pdf`)).stream
        : createReadStream(join(this.documentDir(id), 'original.pdf'), { highWaterMark: 128 * 1024 });
      for await (const chunk of source) digest.update(chunk);
      const sha256 = digest.digest('hex');
      const latest = this.getRecord(id)!;
      const next = { ...latest, manifest: { ...latest.manifest, contentHash: sha256 } };
      const extraBytes = Buffer.byteLength(JSON.stringify(next)) - Buffer.byteLength(JSON.stringify(latest));
      this.reserve(extraBytes);
      try {
        await writeJsonDurable(join(this.documentDir(id), 'record.json'), next);
        this.documents.set(id, next);
        this.usedBytes += extraBytes;
      } finally { this.reservedBytes -= extraBytes; }
      return { sha256, size: next.uploadedBytes };
    });
    this.fingerprints.set(id, work);
    this.fingerprintTail = work.catch(() => {});
    void work.finally(() => { this.fingerprints.delete(id); }).catch(() => {});
    return work;
  }

  private reserve(bytes: number): void {
    if (this.usedBytes + this.reservedBytes + bytes > this.storageBudgetBytes) {
      throw new UploadError(507, 'Document storage is full');
    }
    this.reservedBytes += bytes;
  }

  private async cloudCapacity(additionalBytes: number): Promise<{ base: number; limit: number }> {
    if (!this.r2) return { base: 0, limit: R2_LIMIT_BYTES };
    const status = await this.r2.status();
    const base = status.usedBytes + status.reservedBytes;
    const limit = Math.min(R2_LIMIT_BYTES, status.limitBytes);
    if (base + this.cloudPendingBytes + additionalBytes > limit) {
      throw new UploadError(507, 'Document storage is full');
    }
    return { base, limit };
  }

  private uploadPath(id: string): string { return join(this.incomingDir(), `${id}.part`); }

  private authenticatedUpload(id: string, token: string): PendingUpload {
    const session = ID_PATTERN.test(id) ? this.uploads.get(id) : undefined;
    if (!session || !validToken(token, session.tokenHash)) throw new UploadError(404, 'Upload unavailable');
    if (session.broken) throw new UploadError(404, 'Upload unavailable');
    const now = Date.now();
    if (!session.result && (now - session.createdAt >= UPLOAD_ABSOLUTE_MS
      || (session.offset === 0 && now - session.createdAt >= UPLOAD_FIRST_DATA_MS)
      || (session.offset > 0 && now - session.lastProgressAt >= UPLOAD_SESSION_IDLE_MS))) {
      session.broken = true;
      throw new UploadError(404, 'Upload unavailable');
    }
    return session;
  }

  private async retireUpload(session: PendingUpload): Promise<void> {
    session.broken = true;
    if (!session.result) await rm(this.uploadPath(session.id), { force: true });
    this.uploads.delete(session.id);
    if (!session.result) {
      this.reservedBytes -= session.offset + RECORD_RESERVE_BYTES;
      if (this.r2) this.cloudPendingBytes -= session.offset;
    }
  }

  async createUploadSession(filename: unknown, size: unknown, hostName?: unknown, provenance?: UploadProvenance): Promise<UploadSession> {
    await this.expireIdleUploads();
    if (typeof filename !== 'string' || !filename.trim() || filename.length > 512
      || !Number.isSafeInteger(size) || (size as number) <= 0) {
      throw new UploadError(400, 'Provide a PDF filename and size');
    }
    if ((size as number) > this.maxUploadBytes) throw new UploadError(413, 'PDF exceeds upload limit');
    const cleanName = hostName === undefined || hostName === null ? null : cleanHostName(hostName);
    if (hostName !== undefined && hostName !== null && !cleanName) throw new UploadError(400, 'Invalid host name');
    if ([...this.uploads.values()].filter(session => !session.result).length >= MAX_ACTIVE_UPLOAD_SESSIONS
      || this.legacyActive + [...this.uploads.values()].filter(session => !session.result).length >= MAX_ACTIVE_UPLOAD_SESSIONS
      || this.uploads.size >= MAX_ACTIVE_UPLOAD_SESSIONS + MAX_COMPLETED_UPLOAD_SESSIONS) {
      throw new UploadError(503, 'Too many uploads in progress');
    }
    await this.cloudCapacity(0);
    if (this.legacyActive + [...this.uploads.values()].filter(session => !session.result).length >= MAX_ACTIVE_UPLOAD_SESSIONS) {
      throw new UploadError(503, 'Too many uploads in progress');
    }
    const id = randomBytes(16).toString('hex');
    const token = randomBytes(32).toString('base64url');
    this.reserve(RECORD_RESERVE_BYTES);
    const session: PendingUpload = {
      id, tokenHash: hash(token).toString('hex'), filename, size: size as number,
      offset: 0, createdAt: Date.now(), lastProgressAt: Date.now(), busy: true,
      hostName: cleanName ?? undefined, provenance,
    };
    this.uploads.set(id, session);
    try {
      const file = await open(this.uploadPath(id), 'wx', 0o600);
      await file.close();
      session.busy = false;
      return { uploadId: id, uploadToken: token, offset: 0 };
    } catch (error) {
      try { await this.retireUpload(session); } catch { /* Keep its reservation until cleanup succeeds. */ }
      session.busy = false;
      throw error;
    }
  }

  getUploadStatus(id: string, token: string): UploadStatus {
    const session = this.authenticatedUpload(id, token);
    return { offset: session.offset, size: session.size };
  }

  async appendUploadChunk(id: string, token: string, offset: number, source: NodeJS.ReadableStream): Promise<{ offset: number }> {
    const session = this.authenticatedUpload(id, token);
    if (!Number.isSafeInteger(offset) || offset < 0) throw new UploadError(400, 'Invalid upload offset');
    if (session.busy || session.result || offset !== session.offset) throw new UploadError(409, 'Upload offset conflict', session.offset);
    const cloudBase = await this.cloudCapacity(0);
    if (session.busy || session.result || offset !== session.offset) throw new UploadError(409, 'Upload offset conflict', session.offset);
    session.busy = true;
    session.activeSource = source;
    let received = 0;
    let held = 0;
    let tooLarge = false;
    let admissionError: Error | undefined;
    let committed = false;
    const abort = setTimeout(() => {
      session.broken = true;
      (source as { destroy?: (error?: Error) => void }).destroy?.(new UploadError(408, 'Upload chunk timed out'));
    }, Math.min(UPLOAD_CHUNK_BUSY_MS, Math.max(1, session.createdAt + UPLOAD_ABSOLUTE_MS - Date.now())));
    abort.unref();
    try {
      const meter = new Transform({
        transform: (chunk: Buffer, _encoding, callback) => {
          try {
            received = Math.min(MAX_UPLOAD_CHUNK_BYTES + 1, received + chunk.length);
            if (received > MAX_UPLOAD_CHUNK_BYTES || offset + received > session.size) {
              tooLarge = true;
              callback(null); return;
            }
            if (admissionError) { callback(null); return; }
            this.reserve(chunk.length);
            if (this.r2) {
              if (cloudBase.base + this.cloudPendingBytes + chunk.length > cloudBase.limit) {
                this.reservedBytes -= chunk.length;
                throw new UploadError(507, 'Document storage is full');
              }
              this.cloudPendingBytes += chunk.length;
            }
            held += chunk.length;
            callback(null, chunk);
          } catch (error) {
            // Drain the bounded request body before replying. Fastify inject and
            // some proxies otherwise wait for an aborted request stream.
            admissionError = error as Error;
            callback(null);
          }
        },
      });
      await pipeline(source, meter, createWriteStream(this.uploadPath(id), { flags: 'r+', start: offset }));
      if (admissionError) throw admissionError;
      if (session.broken) throw new UploadError(408, 'Upload expired');
      if (tooLarge) throw new UploadError(413, 'Upload chunk exceeds limit');
      if (received === 0) throw new UploadError(400, 'Upload an octet-stream chunk');
      const file = await open(this.uploadPath(id), 'r');
      try { await file.sync(); } finally { await file.close(); }
      session.offset = offset + received;
      session.lastProgressAt = Date.now();
      committed = true;
      return { offset: session.offset };
    } finally {
      try {
        if (!committed) {
          this.reservedBytes -= held;
          if (this.r2) this.cloudPendingBytes -= held;
          try { await truncate(this.uploadPath(id), offset); }
          catch (rollbackError) {
            // The file may contain uncommitted bytes. Never allow this session
            // to resume; hold its reservation if removing the file also fails.
            try { await this.retireUpload(session); } catch { /* Expiry retries cleanup. */ }
            throw rollbackError;
          }
        }
      } finally {
        clearTimeout(abort);
        session.activeSource = undefined;
        session.busy = false;
      }
    }
  }

  async completeUpload(id: string, token: string): Promise<UploadResult> {
    const session = this.authenticatedUpload(id, token);
    if (session.result) return session.result;
    if (session.busy || session.offset !== session.size) throw new UploadError(409, 'Upload incomplete', session.offset);
    await this.cloudCapacity(0);
    if (session.busy || session.broken) throw new UploadError(409, 'Upload incomplete', session.offset);
    session.busy = true;
    try {
      const file = await open(this.uploadPath(id), 'r');
      let header: Buffer;
      try {
        header = Buffer.alloc(PDF_HEADER.length);
        const { bytesRead } = await file.read(header, 0, header.length, 0);
        if (bytesRead !== PDF_HEADER.length || !header.equals(PDF_HEADER)) throw new UploadError(415, 'File is not a PDF');
      } finally { await file.close(); }
      const result = await this.publish(this.uploadPath(id), session.filename, session.size, session.hostName, session.provenance);
      this.reservedBytes -= session.offset + RECORD_RESERVE_BYTES;
      session.result = result;
      this.enqueue(result.documentId);
      return result;
    } catch (error) {
      // Publishing can move the .part file before a later disk write fails.
      // In that case the session cannot safely resume at its old offset.
      try { await this.retireUpload(session); } catch { /* Expiry retries cleanup. */ }
      throw error;
    } finally {
      session.busy = false;
      session.lastProgressAt = Date.now();
    }
  }

  async expireIdleUploads(now = Date.now()): Promise<void> {
    for (const session of this.uploads.values()) {
      const expired = session.broken || now - session.createdAt >= UPLOAD_ABSOLUTE_MS
        || (session.offset === 0 && now - session.createdAt >= UPLOAD_FIRST_DATA_MS)
        || (session.offset > 0 && now - session.lastProgressAt >= UPLOAD_SESSION_IDLE_MS);
      if (!expired) continue;
      if (session.busy) {
        session.broken = true;
        (session.activeSource as { destroy?: (error?: Error) => void } | undefined)?.destroy?.(new UploadError(408, 'Upload expired'));
        continue;
      }
      session.busy = true;
      try {
        await this.retireUpload(session);
      } catch {
        // Keep the session inaccessible and its bytes reserved until the next
        // cleanup attempt can remove the partial file.
      } finally { session.busy = false; }
    }
  }

  private async publish(temporary: string, filename: string, bytes: number, hostName?: string, provenance?: UploadProvenance): Promise<UploadResult> {
    const id = randomBytes(16).toString('hex');
    const accessToken = randomBytes(32).toString('base64url');
    const ownerToken = randomBytes(32).toString('base64url');
    const version = randomBytes(12).toString('hex');
    const documentDir = this.documentDir(id);
    let published = false;
    try {
      await mkdir(documentDir, { recursive: false });
      await syncDirectory(this.documentsDir());
      await rename(temporary, join(documentDir, 'original.pdf'));
      await syncDirectory(documentDir);
      const manifest: DocumentManifest = {
        schemaVersion: 1, id, version, title: titleFromFilename(filename),
        status: 'processing', pageCount: 0, pages: [], outline: [],
      };
      const record: DocumentRecord = {
        manifest, accessHash: hash(accessToken).toString('hex'), ownerHash: hash(ownerToken).toString('hex'),
        uploadedBytes: bytes, createdAt: Date.now(), hostName, provenance,
        storageProvider: 'local', cloudPendingBytes: this.r2 ? bytes : undefined,
      };
      const recordBytes = Buffer.byteLength(JSON.stringify(record));
      if (recordBytes > RECORD_RESERVE_BYTES) throw new UploadError(507, 'Document storage is full');
      await writeJsonDurable(join(documentDir, 'record.json'), record);
      published = true;
      this.usedBytes += bytes + recordBytes;
      this.documents.set(id, record);
      try { this.dashboardCatalog?.upsertRecord(record); }
      catch { /* The durable document remains available; startup can rebuild catalog metadata. */ }
      return { documentId: id, accessToken, ownerToken };
    } finally {
      if (!published) await rm(documentDir, { recursive: true, force: true });
    }
  }

  async upload(source: NodeJS.ReadableStream, filename: string, assertComplete: () => void = () => {}, provenance?: UploadProvenance): Promise<UploadResult> {
    if (this.legacyActive + [...this.uploads.values()].filter(session => !session.result).length >= MAX_ACTIVE_UPLOAD_SESSIONS) {
      throw new UploadError(503, 'Too many uploads in progress');
    }
    const cloudBase = await this.cloudCapacity(0);
    if (this.legacyActive + [...this.uploads.values()].filter(session => !session.result).length >= MAX_ACTIVE_UPLOAD_SESSIONS) {
      throw new UploadError(503, 'Too many uploads in progress');
    }
    this.reserve(RECORD_RESERVE_BYTES);
    this.legacyActive += 1;
    const id = randomBytes(16).toString('hex');
    const temporary = this.uploadPath(id);
    let bytes = 0;
    let reserved = RECORD_RESERVE_BYTES;
    let committed = false;
    let header = Buffer.alloc(0);
    const startedAt = Date.now();
    let lastProgressAt = startedAt;
    const abort = setInterval(() => {
      const now = Date.now();
      if (now - startedAt >= UPLOAD_ABSOLUTE_MS || (bytes === 0 && now - startedAt >= UPLOAD_FIRST_DATA_MS)
        || (bytes > 0 && now - lastProgressAt >= UPLOAD_SESSION_IDLE_MS)) {
        (source as { destroy?: (error?: Error) => void }).destroy?.(new UploadError(408, 'Upload timed out'));
      }
    }, 10_000);
    abort.unref();
    try {
      const meter = new Transform({
        transform: (chunk: Buffer, _encoding, callback) => {
          try {
            if (bytes + chunk.length > this.maxUploadBytes) throw new UploadError(413, 'PDF exceeds upload limit');
            this.reserve(chunk.length);
            if (this.r2) {
              if (cloudBase.base + this.cloudPendingBytes + chunk.length > cloudBase.limit) {
                this.reservedBytes -= chunk.length;
                throw new UploadError(507, 'Document storage is full');
              }
              this.cloudPendingBytes += chunk.length;
            }
            reserved += chunk.length;
            bytes += chunk.length;
            lastProgressAt = Date.now();
            if (header.length < PDF_HEADER.length) header = Buffer.concat([header, chunk.subarray(0, PDF_HEADER.length - header.length)]);
            callback(null, chunk);
          } catch (error) { callback(error as Error); }
        },
      });
      await pipeline(source, meter, createWriteStream(temporary, { flags: 'wx', mode: 0o600 }));
      assertComplete();
      if (!header.equals(PDF_HEADER)) throw new UploadError(415, 'File is not a PDF');
      await this.cloudCapacity(0);
      const handle = await open(temporary, 'r');
      try { await handle.sync(); } finally { await handle.close(); }
      const result = await this.publish(temporary, filename, bytes, undefined, provenance);
      this.reservedBytes -= reserved;
      committed = true;
      this.enqueue(result.documentId);
      return result;
    } finally {
      if (!committed) {
        this.reservedBytes -= reserved;
        if (this.r2) this.cloudPendingBytes -= bytes;
        await rm(temporary, { force: true });
      }
      clearInterval(abort);
      this.legacyActive -= 1;
    }
  }

  private enqueue(id: string): void {
    this.queue.push(id);
    if (!this.processing) queueMicrotask(() => { void this.drain(); });
  }

  private async drain(): Promise<void> {
    if (this.processing) return;
    this.processing = true;
    try {
      while (this.queue.length) {
        const id = this.queue.shift()!;
        try { await this.processDocument(id); } catch {
          // A failed status write (for example a full disk) must not stop the
          // remaining queue or create an unhandled rejection in the server.
          const record = this.documents.get(id);
          if (record?.manifest.status === 'processing' && !record.deleting) this.documents.set(id, {
            ...record,
            manifest: { ...record.manifest, status: 'error', error: 'This PDF could not be prepared.' },
          });
        }
      }
    } finally {
      this.processing = false;
      for (const resolve of this.idleResolvers.splice(0)) resolve();
    }
  }

  waitForIdle(): Promise<void> {
    if (!this.processing && !this.queue.length) return Promise.resolve();
    return new Promise(resolve => this.idleResolvers.push(resolve));
  }

  private async processDocument(id: string): Promise<void> {
    const record = this.documents.get(id);
    if (!record) return;
    if (record.deleting) { await this.finishDelete(id); return; }
    if (record.manifest.status === 'ready') {
      if (this.r2 && record.storageProvider !== 'r2') await this.migrateLocalDocument(id);
      else if (record.storageProvider === 'r2') await this.cleanupMigratedLocal(id);
      return;
    }
    const { version } = record.manifest;
    const base = this.documentDir(id);
    const pagesDir = join(base, 'pages', version);
    const linksDir = join(base, 'links', version);
    const before = await directoryBytes(base);
    try {
      await this.pdf.validate(join(base, 'original.pdf'));
      await mkdir(pagesDir, { recursive: true });
      await mkdir(linksDir, { recursive: true });
      const extracted = await this.pdf.extract(join(base, 'original.pdf'), pagesDir,
        outputBytes => this.usedBytes + this.reservedBytes + outputBytes <= this.storageBudgetBytes);
      if (!extracted.pages.length || extracted.pages.some((page, index) => page.number !== index + 1 || !Number.isFinite(page.width) || !Number.isFinite(page.height) || page.width <= 0 || page.height <= 0)) {
        throw new Error('Invalid page manifest');
      }
      for (const page of extracted.pages) {
        const file = this.pagePath(id, version, page.number);
        if ((await stat(file)).size === 0) throw new Error('Missing page PDF');
        await writeJsonDurable(this.linkPath(id, version, page.number), extracted.links[page.number - 1] ?? []);
      }
      const derivedBytes = (await directoryBytes(base)) - before;
      if (this.usedBytes + this.reservedBytes + derivedBytes > this.storageBudgetBytes) throw new Error('Document storage budget exceeded');
      await this.cloudCapacity(derivedBytes);
      const next: DocumentRecord = {
        ...record,
        manifest: { ...record.manifest, status: 'ready', pageCount: extracted.pages.length, pages: extracted.pages, outline: extracted.outline },
        cloudPendingBytes: this.r2 ? (record.cloudPendingBytes ?? 0) + derivedBytes : undefined,
      };
      await writeJsonDurable(join(base, 'record.json'), next);
      this.usedBytes += (await directoryBytes(base)) - before;
      if (this.r2) this.cloudPendingBytes += derivedBytes;
      this.documents.set(id, next);
      if (this.r2) {
        // A gateway failure leaves a complete, readable local copy for retry.
        try { await this.migrateLocalDocument(id); } catch { /* Retry at restart or with the one-at-a-time migration command. */ }
      }
    } catch {
      await rm(join(base, 'pages'), { recursive: true, force: true });
      await rm(join(base, 'links'), { recursive: true, force: true });
      const next: DocumentRecord = {
        ...record,
        manifest: { ...record.manifest, status: 'error', pageCount: 0, pages: [], outline: [], error: 'This PDF could not be prepared.' },
      };
      await writeJsonDurable(join(base, 'record.json'), next);
      this.usedBytes += (await directoryBytes(base)) - before;
      this.documents.set(id, next);
    }
  }

  async pageLinks(id: string, version: string, number: number): Promise<PageLink[]> {
    const record = this.getRecord(id);
    if (record?.storageProvider === 'r2' && this.r2) {
      return this.r2.getJson<PageLink[]>(`${record.storagePrefix}links/${version}/${number}.json`);
    }
    return JSON.parse(await readFile(this.linkPath(id, version, number), 'utf8')) as PageLink[];
  }

  async openPage(id: string, version: string, number: number, signal?: AbortSignal): Promise<{ stream: NodeJS.ReadableStream; size: number }> {
    const record = this.getRecord(id);
    if (!record) throw new UploadError(404, 'Page unavailable');
    if (record.storageProvider === 'r2' && this.r2) {
      const object = await this.r2.getObject(`${record.storagePrefix}pages/${version}/${number}.pdf`, signal);
      return { stream: object.stream, size: object.size };
    }
    const path = this.pagePath(id, version, number);
    return { stream: createReadStream(path), size: (await stat(path)).size };
  }

  async storageBudget(): Promise<StorageBudget> {
    if (!this.r2) return {
      provider: 'local', usedBytes: this.usedBytes, reservedBytes: this.reservedBytes,
      limitBytes: this.storageBudgetBytes, classAUsed: 0, classALimit: 0,
      classBUsed: 0, classBLimit: 0, month: new Date().toISOString().slice(0, 7), available: true,
    };
    try {
      const status = await this.r2.status();
      let committedOverlap = 0;
      for (const record of this.documents.values()) {
        if (!record.cloudPendingBytes || record.deleting) continue;
        committedOverlap += Math.min(record.cloudPendingBytes, this.r2.committedBytes(`notora/${record.manifest.id}/`));
      }
      return {
        provider: 'r2', ...status,
        reservedBytes: status.reservedBytes + Math.max(0, this.cloudPendingBytes - committedOverlap),
        available: true,
      };
    } catch {
      return {
        provider: 'r2', usedBytes: 0, reservedBytes: 0, limitBytes: R2_LIMIT_BYTES,
        classAUsed: 0, classALimit: 800_000, classBUsed: 0, classBLimit: 8_000_000,
        month: new Date().toISOString().slice(0, 7), available: false,
      };
    }
  }

  private async hashFile(path: string): Promise<string> {
    const digest = createHash('sha256');
    for await (const chunk of createReadStream(path, { highWaterMark: 128 * 1024 })) digest.update(chunk);
    return digest.digest('hex');
  }

  private async pool3<T>(items: T[], work: (item: T) => Promise<void>): Promise<void> {
    let next = 0;
    let failed: unknown;
    const worker = async () => {
      while (!failed && next < items.length) {
        const item = items[next++];
        try { await work(item); } catch (error) { failed = error; }
      }
    };
    await Promise.all(Array.from({ length: Math.min(3, items.length) }, () => worker()));
    if (failed) throw failed;
  }

  /** Idempotent one-document migration; keeps every local binary until all R2 HEAD checks pass. */
  async migrateLocalDocument(id: string): Promise<boolean> {
    if (!this.r2) throw new UploadError(503, 'R2 storage unavailable');
    const record = this.getRecord(id);
    if (!record) throw new UploadError(404, 'Document unavailable');
    if (record.storageProvider === 'r2') return false;
    if (record.manifest.status !== 'ready' || this.processing && this.queue.includes(id) || this.deleting.has(id)) {
      throw new UploadError(409, 'Document is busy');
    }
    if (this.migrating.has(id)) throw new UploadError(409, 'Document is busy');
    this.migrating.add(id);
    const base = this.documentDir(id);
    const prefix = `notora/${id}/`;
    try {
      const originalPath = join(base, 'original.pdf');
      const sha256 = record.manifest.contentHash ?? await this.hashFile(originalPath);
      const manifest: DocumentManifest = { ...record.manifest, contentHash: sha256 };
      const files: Array<{ key: string; path: string; contentType: string; size: number }> = [];
      const original = { key: `${prefix}original.pdf`, path: originalPath, contentType: 'application/pdf', size: (await stat(originalPath)).size };
      for (const page of manifest.pages) {
        const pdfPath = this.pagePath(id, manifest.version, page.number);
        const linksPath = this.linkPath(id, manifest.version, page.number);
        files.push({ key: `${prefix}pages/${manifest.version}/${page.number}.pdf`, path: pdfPath, contentType: 'application/pdf', size: (await stat(pdfPath)).size });
        files.push({ key: `${prefix}links/${manifest.version}/${page.number}.json`, path: linksPath, contentType: 'application/json', size: (await stat(linksPath)).size });
      }
      const manifestData = Buffer.from(JSON.stringify(manifest));
      const metadataData = Buffer.from(JSON.stringify({
        manifest, accessHash: record.accessHash, ownerHash: record.ownerHash,
        uploadedBytes: record.uploadedBytes, createdAt: record.createdAt,
        hostName: record.hostName, provenance: record.provenance,
      }));
      await this.r2.putFile(original.key, original.path, original.contentType);
      await this.pool3(files, file => this.r2!.putFile(file.key, file.path, file.contentType));
      await Promise.all([
        this.r2.putBytes(`${prefix}manifest.json`, manifestData, 'application/json'),
        this.r2.putBytes(`${prefix}metadata.json`, metadataData, 'application/json'),
      ]);
      const expected: GatewayObject[] = [
        { key: original.key, size: original.size },
        ...files.map(file => ({ key: file.key, size: file.size })),
        { key: `${prefix}manifest.json`, size: manifestData.length },
        { key: `${prefix}metadata.json`, size: metadataData.length },
      ];
      await this.pool3(expected, async object => {
        const head = await this.r2!.headObject(object.key);
        if (!head || head.size !== object.size) throw new Error('Cloud object verification failed');
      });
      const nextRecord: DocumentRecord = {
        ...record, manifest, storageProvider: 'r2', storagePrefix: prefix,
        storageBytes: expected.reduce((sum, object) => sum + object.size, 0),
        cloudPendingBytes: undefined,
      };
      await writeJsonDurable(join(base, 'record.json'), nextRecord);
      this.documents.set(id, nextRecord);
      this.cloudPendingBytes -= record.cloudPendingBytes ?? 0;
      await this.cleanupMigratedLocal(id);
      return true;
    } finally { this.migrating.delete(id); }
  }

  private async cleanupMigratedLocal(id: string): Promise<void> {
    if (this.documents.get(id)?.storageProvider !== 'r2') return;
    if (!(await this.waitForLocalReads(id))) return; // Retry on next restart.
    const base = this.documentDir(id);
    const before = await directoryBytes(base);
    await rm(join(base, 'original.pdf'), { force: true });
    await rm(join(base, 'pages'), { recursive: true, force: true });
    await rm(join(base, 'links'), { recursive: true, force: true });
    this.usedBytes += (await directoryBytes(base)) - before;
  }

  async deleteDocument(id: string): Promise<void> {
    const record = this.getRecord(id);
    if (!record) throw new UploadError(404, 'Document unavailable');
    if (record.manifest.status === 'processing' || this.queue.includes(id) || this.migrating.has(id)
      || (this.activeReads.get(id) ?? 0) > 0 || (this.activeSessions.get(id) ?? 0) > 0
      || this.deleting.has(id)) throw new UploadError(409, 'Document is busy');
    this.deleting.add(id);
    try {
      const deleting = { ...record, deleting: true };
      await writeJsonDurable(join(this.documentDir(id), 'record.json'), deleting);
      this.documents.set(id, deleting);
      await this.finishDelete(id);
    } finally { this.deleting.delete(id); }
  }

  private async finishDelete(id: string): Promise<void> {
    const record = this.documents.get(id);
    if (!record?.deleting) return;
    if (this.r2) await this.r2.deletePrefix(`notora/${id}/`);
    const bytes = await directoryBytes(this.documentDir(id));
    await rm(this.documentDir(id), { recursive: true, force: true });
    this.usedBytes -= bytes;
    this.cloudPendingBytes -= record.cloudPendingBytes ?? 0;
    this.documents.delete(id);
    this.dashboardCatalog?.removeRecord(id);
  }
}

function validRecord(record: DocumentRecord): boolean {
  const manifest = record.manifest;
  return manifest.schemaVersion === 1 && /^[0-9a-f]{24}$/.test(manifest.version)
    && ['processing', 'ready', 'error'].includes(manifest.status)
    && /^[0-9a-f]{64}$/.test(record.accessHash)
    && /^[0-9a-f]{64}$/.test(record.ownerHash);
}
