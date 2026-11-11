import { createHash, randomUUID, scryptSync } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { PdfTools } from './pdf.ts';
import { createServer } from './index.ts';
import { R2Gateway } from './r2.ts';
import { DocumentStore } from './store.ts';
import type { UploadResult, UploadSession } from '../../../packages/shared/src/index.ts';

const pdf = Buffer.from('%PDF-1.7\nR2 fixture\n%%EOF\n');
const secret = 'r2-test-secret-that-is-at-least-32-bytes';
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const task of cleanup.splice(0).reverse()) await task(); });

class MemoryGateway {
  readonly objects = new Map<string, Buffer>();
  readonly pendingSingles = new Set<string>();
  readonly multipart = new Map<string, { key: string; size: number; parts: Map<number, Buffer> }>();
  limit = 9_000_000_000;
  failNextPut = false;
  failNextDelete = false;
  failCompleteBeforeCommit = false;
  failCompleteAfterCommit = false;
  activePuts = 0;
  maxPuts = 0;
  fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    if ((init?.headers as Record<string, string>)?.authorization !== `Bearer ${secret}`) return new Response('{}', { status: 401 });
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
    if (url.pathname === '/v1/status') {
      const usedBytes = [...this.objects.values()].reduce((sum, object) => sum + object.length, 0);
      return json({ usedBytes, reservedBytes: 0, limitBytes: this.limit, classAUsed: 0, classALimit: 800_000,
        classBUsed: 0, classBLimit: 8_000_000, month: '2026-11' });
    }
    if (url.pathname === '/v1/multipart' && method === 'POST') {
      const request = JSON.parse(String(init?.body)) as { key: string; size: number };
      for (const [uploadId, session] of this.multipart) {
        if (session.key === request.key && session.size === request.size) return json({ uploadId });
      }
      const uploadId = randomUUID();
      this.multipart.set(uploadId, { ...request, parts: new Map() });
      return json({ uploadId });
    }
    const multi = /^\/v1\/multipart\/([^/]+)(?:\/parts\/(\d+)|\/complete)?$/.exec(url.pathname);
    if (multi) {
      const session = this.multipart.get(multi[1]);
      if (!session) return json({ error: 'Missing multipart' }, 404);
      if (method === 'DELETE') { this.multipart.delete(multi[1]); return new Response(null, { status: 204 }); }
      if (multi[2] && method === 'PUT') {
        const bytes = Buffer.from(await new Response(init?.body).arrayBuffer());
        this.activePuts++; this.maxPuts = Math.max(this.maxPuts, this.activePuts);
        await new Promise(resolve => setTimeout(resolve, 5));
        this.activePuts--;
        session.parts.set(Number(multi[2]), bytes);
        return json({ partNumber: Number(multi[2]), etag: 'part-etag' });
      }
      if (url.pathname.endsWith('/complete') && method === 'POST') {
        const merged = Buffer.concat([...session.parts].sort((a, b) => a[0] - b[0]).map(([, bytes]) => bytes));
        if (merged.length !== session.size) return json({ error: 'multipart upload incomplete' }, 409);
        if (this.failCompleteBeforeCommit) { this.failCompleteBeforeCommit = false; return json({ error: 'Temporary failure' }, 503); }
        this.objects.set(session.key, merged);
        this.multipart.delete(multi[1]);
        if (this.failCompleteAfterCommit) { this.failCompleteAfterCommit = false; return json({ error: 'Lost response' }, 503); }
        return json({ key: session.key, size: merged.length, etag: 'object-etag' });
      }
    }
    if (url.pathname === '/v1/objects' && method === 'GET') {
      const prefix = url.searchParams.get('prefix') ?? '';
      return json({ objects: [...this.objects].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, size: value.length })),
        truncated: false });
    }
    if (url.pathname === '/v1/pending' && method === 'GET') {
      const prefix = url.searchParams.get('prefix') ?? '';
      const pending = [
        ...[...this.objects.keys()].filter(key => key.startsWith(prefix)).map(key => ({ key })),
        ...[...this.pendingSingles].filter(key => key.startsWith(prefix)).map(key => ({ key })),
        ...[...this.multipart].filter(([, session]) => session.key.startsWith(prefix))
          .map(([uploadId, session]) => ({ key: session.key, uploadId })),
      ];
      return json({ pending, truncated: false });
    }
    const prefix = '/v1/objects/';
    if (!url.pathname.startsWith(prefix)) return json({ error: 'Missing' }, 404);
    const key = url.pathname.slice(prefix.length);
    if (method === 'PUT') {
      if (this.failNextPut) {
        this.failNextPut = false;
        this.pendingSingles.add(key);
        return json({ error: 'Temporary failure' }, 503);
      }
      const bytes = Buffer.from(await new Response(init?.body).arrayBuffer());
      this.activePuts++; this.maxPuts = Math.max(this.maxPuts, this.activePuts);
      await new Promise(resolve => setTimeout(resolve, 5));
      this.activePuts--;
      this.objects.set(key, bytes);
      this.pendingSingles.delete(key);
      return json({ key, size: bytes.length, etag: 'object-etag' });
    }
    const object = this.objects.get(key);
    if (method === 'DELETE') {
      if (this.failNextDelete) { this.failNextDelete = false; return json({ error: 'Temporary delete failure' }, 503); }
      this.objects.delete(key);
      this.pendingSingles.delete(key);
      return new Response(null, { status: 204 });
    }
    if (!object) return json({ error: 'Missing' }, 404);
    const headers = { 'content-length': String(object.length), 'content-type': key.endsWith('.pdf') ? 'application/pdf' : 'application/json', etag: 'object-etag' };
    if (method === 'HEAD') return new Response(null, { status: 200, headers });
    return new Response(new Uint8Array(object) as BodyInit, { status: 200, headers });
  };
}

function fakeTools(): PdfTools {
  return {
    async validate() {},
    async extract(_source, pagesDir) {
      await writeFile(join(pagesDir, '1.pdf'), pdf);
      return { pages: [{ number: 1, width: 612, height: 792 }], outline: [], links: [[{ rect: [1, 2, 3, 4], destination: { page: 1 } }]] };
    },
  };
}

async function server(gateway: MemoryGateway, dir: string, dashboard = false) {
  const salt = Buffer.alloc(16, 3);
  const hash = `scrypt:${salt.toString('hex')}:${scryptSync('password', salt, 64).toString('hex')}`;
  const r2Gateway = new R2Gateway(dir, 'https://gateway.example', secret, gateway.fetch);
  const result = await createServer({ dataDir: dir, webDir: join(dir, 'no-web-build'), pdfTools: fakeTools(),
    r2Gateway, dashboard: dashboard ? { username: 'operator', passwordHash: hash, publicOrigin: 'https://notora.example' } : undefined });
  cleanup.push(async () => { await result.store.waitForIdle(); await result.app.close(); });
  return result;
}

async function upload(app: FastifyInstance, hostId?: string): Promise<UploadResult> {
  const begin = await app.inject({ method: 'POST', url: '/api/uploads',
    headers: { 'x-forwarded-for': '8.8.8.8', 'user-agent': 'R2 test browser' },
    payload: { filename: 'Book.pdf', size: pdf.length, hostName: 'Alice', hostId, ipAddress: '1.2.3.4', countryCode: 'ZZ' } });
  expect(begin.statusCode).toBe(201);
  const session = begin.json() as UploadSession;
  const path = `/api/uploads/${session.uploadId}`;
  const headers = { authorization: `Bearer ${session.uploadToken}` };
  expect((await app.inject({ method: 'PUT', url: path, headers: { ...headers, 'content-type': 'application/octet-stream', 'upload-offset': '0' }, payload: pdf })).statusCode).toBe(200);
  const complete = await app.inject({ method: 'POST', url: `${path}/complete`, headers });
  expect(complete.statusCode).toBe(202);
  return complete.json() as UploadResult;
}

describe('R2 document storage', () => {
  it('commits and verifies cloud objects before removing local PDFs, then serves after restart', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'notora-r2-'));
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
    const gateway = new MemoryGateway();
    const first = await server(gateway, dir);
    const tokens = await upload(first.app);
    await first.store.waitForIdle();
    const prefix = `notora/${tokens.documentId}/`;
    expect([...gateway.objects.keys()].sort()).toEqual([
      `${prefix}links/${first.store.getRecord(tokens.documentId)!.manifest.version}/1.json`,
      `${prefix}manifest.json`, `${prefix}metadata.json`, `${prefix}original.pdf`,
      `${prefix}pages/${first.store.getRecord(tokens.documentId)!.manifest.version}/1.pdf`,
    ].sort());
    await expect(stat(join(dir, 'documents', tokens.documentId, 'original.pdf'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(first.store.getRecord(tokens.documentId)?.storageProvider).toBe('r2');
    await first.app.close();
    const unconfigured = new DocumentStore(dir, 256 * 1024 * 1024, 2 * 1024 * 1024 * 1024, fakeTools());
    await expect(unconfigured.initialize()).rejects.toThrow('R2 gateway configuration is required');
    const second = await server(gateway, dir);
    const headers = { authorization: `Bearer ${tokens.accessToken}` };
    const page = await second.app.inject({ method: 'GET', url: `/api/documents/${tokens.documentId}/pages/1.pdf`, headers });
    expect(page.statusCode).toBe(200);
    expect(page.rawPayload.equals(pdf)).toBe(true);
    const links = await second.app.inject({ method: 'GET', url: `/api/documents/${tokens.documentId}/pages/1/links`, headers });
    expect(links.json()).toEqual([{ rect: [1, 2, 3, 4], destination: { page: 1 } }]);
    expect((await second.app.inject({ method: 'GET', url: `/api/documents/${tokens.documentId}` })).statusCode).toBe(401);
    const fingerprint = await second.app.inject({ method: 'GET', url: `/api/documents/${tokens.documentId}/fingerprint`,
      headers: { ...headers, 'x-owner-token': tokens.ownerToken } });
    expect(fingerprint.json()).toEqual({ sha256: createHash('sha256').update(pdf).digest('hex'), size: pdf.length });
  });

  it('keeps the local copy on transfer failure and retries without changing IDs or capabilities', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'notora-r2-failure-'));
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
    const gateway = new MemoryGateway();
    gateway.failNextPut = true;
    const { app, store } = await server(gateway, dir);
    const tokens = await upload(app);
    await store.waitForIdle();
    expect(store.getRecord(tokens.documentId)?.storageProvider).toBe('local');
    expect(await readFile(join(dir, 'documents', tokens.documentId, 'original.pdf'))).toEqual(pdf);
    const release = store.beginRead(tokens.documentId);
    const migrating = store.migrateLocalDocument(tokens.documentId);
    for (let attempt = 0; attempt < 100 && store.getRecord(tokens.documentId)?.storageProvider !== 'r2'; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    expect(store.getRecord(tokens.documentId)?.storageProvider).toBe('r2');
    expect(await readFile(join(dir, 'documents', tokens.documentId, 'original.pdf'))).toEqual(pdf);
    release();
    expect(await migrating).toBe(true);
    await expect(stat(join(dir, 'documents', tokens.documentId, 'original.pdf'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await app.inject({ method: 'GET', url: `/api/documents/${tokens.documentId}`,
      headers: { authorization: `Bearer ${tokens.accessToken}` } })).statusCode).toBe(200);
  });

  it('deletes a failed migration only after clearing its gateway reservation', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'notora-r2-failed-delete-'));
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
    const gateway = new MemoryGateway();
    gateway.failNextPut = true;
    const { app, store } = await server(gateway, dir);
    const tokens = await upload(app);
    await store.waitForIdle();
    expect(gateway.pendingSingles.size).toBe(1);
    expect(await readFile(join(dir, 'documents', tokens.documentId, 'original.pdf'))).toEqual(pdf);
    await store.deleteDocument(tokens.documentId);
    expect(gateway.pendingSingles.size).toBe(0);
    expect(store.getRecord(tokens.documentId)).toBeUndefined();
    await expect(stat(join(dir, 'documents', tokens.documentId))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('retains a deleting marker and local record when cloud deletion fails, then resumes on restart', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'notora-r2-delete-retry-'));
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
    const gateway = new MemoryGateway();
    const first = await server(gateway, dir);
    const tokens = await upload(first.app);
    await first.store.waitForIdle();
    gateway.failNextDelete = true;
    await expect(first.store.deleteDocument(tokens.documentId)).rejects.toThrow();
    expect(first.store.getRecord(tokens.documentId)).toBeUndefined();
    expect(JSON.parse(await readFile(join(dir, 'documents', tokens.documentId, 'record.json'), 'utf8')).deleting).toBe(true);
    await first.app.close();
    const second = await server(gateway, dir);
    await second.store.waitForIdle();
    expect(second.store.getRecord(tokens.documentId)).toBeUndefined();
    await expect(stat(join(dir, 'documents', tokens.documentId))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('admits only received bytes, rejects cloud quota overflow, and expires idle probes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'notora-r2-quota-'));
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
    const gateway = new MemoryGateway();
    gateway.limit = pdf.length + 2;
    const { app, store } = await server(gateway, dir);
    const created = await app.inject({ method: 'POST', url: '/api/uploads', payload: { filename: 'Large.pdf', size: pdf.length + 100 } });
    expect(created.statusCode).toBe(201); // Declared size is not reserved up front.
    const session = created.json() as UploadSession;
    const route = `/api/uploads/${session.uploadId}`;
    const headers = { authorization: `Bearer ${session.uploadToken}` };
    expect((await app.inject({ method: 'GET', url: route, headers })).statusCode).toBe(200);
    await store.expireIdleUploads(Date.now() + 5 * 60 * 1000 + 1);
    expect((await app.inject({ method: 'GET', url: route, headers })).statusCode).toBe(404);
    const next = await app.inject({ method: 'POST', url: '/api/uploads', payload: { filename: 'Large.pdf', size: pdf.length + 100 } });
    expect(next.statusCode).toBe(201);
    const current = next.json() as UploadSession;
    const currentRoute = `/api/uploads/${current.uploadId}`;
    const currentHeaders = { authorization: `Bearer ${current.uploadToken}`, 'content-type': 'application/octet-stream', 'upload-offset': '0' };
    expect((await app.inject({ method: 'PUT', url: currentRoute, headers: currentHeaders, payload: pdf })).statusCode).toBe(200);
    expect((await store.storageBudget()).reservedBytes).toBe(pdf.length);
    expect((await app.inject({ method: 'PUT', url: currentRoute, headers: { ...currentHeaders, 'upload-offset': String(pdf.length) }, payload: Buffer.from('abc') })).statusCode).toBe(507);
    expect(store.getUploadStatus(current.uploadId, current.uploadToken).offset).toBe(pdf.length);
  });

  it('shows trusted provenance privately and requires operator session and origin to delete all objects', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'notora-r2-delete-'));
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
    const gateway = new MemoryGateway();
    const { app, store } = await server(gateway, dir, true);
    const hostId = '123e4567-e89b-42d3-a456-426614174000';
    const tokens = await upload(app, hostId);
    await store.waitForIdle();
    const login = await app.inject({ method: 'POST', url: '/api/dashboard/login',
      headers: { origin: 'https://notora.example' }, payload: { username: 'operator', password: 'password' } });
    const cookie = String(login.headers['set-cookie']).split(';')[0];
    const list = await app.inject({ method: 'GET', url: '/api/dashboard/documents', headers: { cookie } });
    const document = list.json().documents[0];
    expect(document.provenance).toMatchObject({ hostId, userAgent: 'R2 test browser' });
    expect(document.provenance.ipAddress).not.toBe('8.8.8.8');
    expect(document.provenance.ipAddress).not.toBe('1.2.3.4');
    expect(document.provenance.countryCode).toBeNull();
    expect(document.storageProvider).toBe('r2');
    expect(list.json().storage).toMatchObject({ provider: 'r2', available: true });
    const url = `/api/dashboard/documents/${tokens.documentId}`;
    expect((await app.inject({ method: 'DELETE', url })).statusCode).toBe(401);
    expect((await app.inject({ method: 'DELETE', url, headers: { cookie } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'DELETE', url, headers: { cookie, origin: 'https://wrong.example' } })).statusCode).toBe(403);
    const release = store.beginRead(tokens.documentId);
    expect((await app.inject({ method: 'DELETE', url, headers: { cookie, origin: 'https://notora.example' } })).statusCode).toBe(409);
    release();
    const releaseSession = store.beginSession(tokens.documentId);
    expect((await app.inject({ method: 'DELETE', url, headers: { cookie, origin: 'https://notora.example' } })).statusCode).toBe(409);
    releaseSession();
    expect((await app.inject({ method: 'DELETE', url, headers: { cookie, origin: 'https://notora.example' } })).statusCode).toBe(204);
    expect(store.getRecord(tokens.documentId)).toBeUndefined();
    expect([...gateway.objects.keys()].filter(key => key.startsWith(`notora/${tokens.documentId}/`))).toHaveLength(0);
  });

  it('streams multipart uploads in at most three parallel 8 MiB parts', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'notora-r2-multipart-'));
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
    const gateway = new MemoryGateway();
    const r2 = new R2Gateway(dir, 'https://gateway.example', secret, gateway.fetch);
    const path = join(dir, 'large.pdf');
    const source = Buffer.alloc(17 * 1024 * 1024, 7);
    await writeFile(path, source);
    await r2.putFile(`notora/${'a'.repeat(32)}/original.pdf`, path, 'application/pdf');
    expect(gateway.maxPuts).toBeGreaterThan(1);
    expect(gateway.maxPuts).toBeLessThanOrEqual(3);
    expect(gateway.objects.get(`notora/${'a'.repeat(32)}/original.pdf`)).toEqual(source);
    r2.close();
  });

  it('recovers a multipart completion with a lost response without a second cloud object', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'notora-r2-retry-'));
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
    const gateway = new MemoryGateway();
    const r2 = new R2Gateway(dir, 'https://gateway.example', secret, gateway.fetch);
    const path = join(dir, 'large.pdf');
    await writeFile(path, Buffer.alloc(8 * 1024 * 1024 + 1, 9));
    const key = `notora/${'b'.repeat(32)}/original.pdf`;
    gateway.failCompleteBeforeCommit = true;
    await expect(r2.putFile(key, path, 'application/pdf')).rejects.toThrow('Temporary failure');
    expect(gateway.objects.has(key)).toBe(false);
    await expect(r2.putFile(key, path, 'application/pdf')).resolves.toBeUndefined();
    expect(gateway.objects.get(key)?.length).toBe(8 * 1024 * 1024 + 1);
    r2.close();
  });

  it('aborts incomplete multipart reservations before deleting a document prefix', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'notora-r2-abort-'));
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
    const gateway = new MemoryGateway();
    const r2 = new R2Gateway(dir, 'https://gateway.example', secret, gateway.fetch);
    const path = join(dir, 'large.pdf');
    await writeFile(path, Buffer.alloc(8 * 1024 * 1024 + 1, 5));
    const prefix = `notora/${'c'.repeat(32)}/`;
    gateway.failCompleteBeforeCommit = true;
    await expect(r2.putFile(`${prefix}original.pdf`, path, 'application/pdf')).rejects.toThrow();
    expect(gateway.multipart.size).toBe(1);
    await r2.deletePrefix(prefix);
    expect(gateway.multipart.size).toBe(0);
    expect([...gateway.objects.keys()].filter(key => key.startsWith(prefix))).toHaveLength(0);
    r2.close();
  });
});
