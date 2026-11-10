import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, open, opendir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { DocumentManifest, PageLink, UploadResult } from '../../../packages/shared/src/index.ts';
import type { PdfTools } from './pdf.ts';

const ID_PATTERN = /^[0-9a-f]{32}$/;
const PDF_HEADER = Buffer.from('%PDF-');

export interface DocumentRecord {
  manifest: DocumentManifest;
  accessHash: string;
  ownerHash: string;
  uploadedBytes: number;
  createdAt: number;
}

export class UploadError extends Error {
  constructor(public statusCode: number, message: string) { super(message); }
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
  private queue: string[] = [];
  private processing = false;
  private idleResolvers: Array<() => void> = [];

  constructor(
    readonly dataDir: string,
    private readonly maxUploadBytes: number,
    private readonly storageBudgetBytes: number,
    private readonly pdf: PdfTools,
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
    for (const id of await readdir(this.documentsDir())) {
      if (!ID_PATTERN.test(id)) continue;
      try {
        const record = JSON.parse(await readFile(join(this.documentDir(id), 'record.json'), 'utf8')) as DocumentRecord;
        if (record.manifest?.id !== id || !validRecord(record)) continue;
        this.documents.set(id, record);
        if (record.manifest.status === 'processing') {
          await rm(join(this.documentDir(id), 'pages'), { recursive: true, force: true });
          await rm(join(this.documentDir(id), 'links'), { recursive: true, force: true });
          pending.push(id);
        }
      } catch {
        // A partial upload without committed metadata is not a published document.
      }
    }
    this.usedBytes = await directoryBytes(this.documentsDir());
    for (const id of pending) this.enqueue(id);
  }

  getRecord(id: string): DocumentRecord | undefined {
    return ID_PATTERN.test(id) ? this.documents.get(id) : undefined;
  }

  authorize(id: string, accessToken: string, ownerToken?: string): { record: DocumentRecord; owner: boolean } | null {
    const record = this.getRecord(id);
    if (!record || !validToken(accessToken, record.accessHash)) return null;
    if (ownerToken !== undefined && !validToken(ownerToken, record.ownerHash)) return null;
    return { record, owner: ownerToken !== undefined };
  }

  private reserve(bytes: number): void {
    if (this.usedBytes + this.reservedBytes + bytes > this.storageBudgetBytes) {
      throw new UploadError(507, 'Document storage is full');
    }
    this.reservedBytes += bytes;
  }

  async upload(source: NodeJS.ReadableStream, filename: string, assertComplete: () => void = () => {}): Promise<UploadResult> {
    const id = randomBytes(16).toString('hex');
    const accessToken = randomBytes(32).toString('base64url');
    const ownerToken = randomBytes(32).toString('base64url');
    const version = randomBytes(12).toString('hex');
    const temporary = join(this.incomingDir(), `${id}.part`);
    const documentDir = this.documentDir(id);
    let bytes = 0;
    let reserved = 0;
    let committed = false;
    let header = Buffer.alloc(0);
    try {
      const meter = new Transform({
        transform: (chunk: Buffer, _encoding, callback) => {
          try {
            if (bytes + chunk.length > this.maxUploadBytes) throw new UploadError(413, 'PDF exceeds upload limit');
            this.reserve(chunk.length);
            reserved += chunk.length;
            bytes += chunk.length;
            if (header.length < PDF_HEADER.length) header = Buffer.concat([header, chunk.subarray(0, PDF_HEADER.length - header.length)]);
            callback(null, chunk);
          } catch (error) { callback(error as Error); }
        },
      });
      await pipeline(source, meter, createWriteStream(temporary, { flags: 'wx', mode: 0o600 }));
      assertComplete();
      if (!header.equals(PDF_HEADER)) throw new UploadError(415, 'File is not a PDF');
      const handle = await open(temporary, 'r');
      try { await handle.sync(); } finally { await handle.close(); }
      try { await this.pdf.validate(temporary); } catch { throw new UploadError(415, 'PDF is invalid or unsupported'); }
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
        uploadedBytes: bytes, createdAt: Date.now(),
      };
      await writeJsonDurable(join(documentDir, 'record.json'), record);
      this.usedBytes += bytes + (await stat(join(documentDir, 'record.json'))).size;
      this.reservedBytes -= reserved;
      committed = true;
      this.documents.set(id, record);
      this.enqueue(id);
      return { documentId: id, accessToken, ownerToken };
    } finally {
      if (!committed) {
        this.reservedBytes -= reserved;
        await rm(temporary, { force: true });
        await rm(documentDir, { recursive: true, force: true });
      }
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
          if (record) this.documents.set(id, {
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
    const { version } = record.manifest;
    const base = this.documentDir(id);
    const pagesDir = join(base, 'pages', version);
    const linksDir = join(base, 'links', version);
    const before = await directoryBytes(base);
    try {
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
      const next: DocumentRecord = {
        ...record,
        manifest: { ...record.manifest, status: 'ready', pageCount: extracted.pages.length, pages: extracted.pages, outline: extracted.outline },
      };
      await writeJsonDurable(join(base, 'record.json'), next);
      this.usedBytes += (await directoryBytes(base)) - before;
      this.documents.set(id, next);
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
    return JSON.parse(await readFile(this.linkPath(id, version, number), 'utf8')) as PageLink[];
  }
}

function validRecord(record: DocumentRecord): boolean {
  const manifest = record.manifest;
  return manifest.schemaVersion === 1 && /^[0-9a-f]{24}$/.test(manifest.version)
    && ['processing', 'ready', 'error'].includes(manifest.status)
    && /^[0-9a-f]{64}$/.test(record.accessHash)
    && /^[0-9a-f]{64}$/.test(record.ownerHash);
}
