import { scryptSync } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import type { FastifyInstance } from 'fastify';
import type { DashboardDocumentsResponse, UploadResult, UploadSession } from '../../../packages/shared/src/index.ts';
import { createServer } from './index.ts';
import type { PdfTools } from './pdf.ts';

const pdf = Buffer.from('%PDF-1.7\nA dashboard fixture\n%%EOF\n');
const salt = Buffer.alloc(16, 7);
const password = 'test-fixture-password';
const passwordHash = `scrypt:${salt.toString('hex')}:${scryptSync(password, salt, 64).toString('hex')}`;
const origin = 'https://notora.example';
const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const task of cleanup.splice(0).reverse()) await task();
});

function fakePdfTools(): PdfTools {
  return {
    async validate() {},
    async extract(_source, pagesDir) {
      await writeFile(join(pagesDir, '1.pdf'), pdf);
      return { pages: [{ number: 1, width: 612, height: 792 }], outline: [], links: [[]] };
    },
  };
}

async function setup(configured = true, dataDir?: string, now: () => number = Date.now) {
  const dir = dataDir ?? await mkdtemp(join(tmpdir(), 'notora-dashboard-'));
  const { app, store } = await createServer({
    dataDir: dir,
    webDir: join(dir, 'no-web-build'),
    pdfTools: fakePdfTools(),
    dashboard: {
      username: configured ? 'viewer' : '', passwordHash: configured ? passwordHash : '',
      publicOrigin: origin, now, sessionTtlMs: 60_000,
    },
  });
  cleanup.push(async () => { await store.waitForIdle(); await app.close(); if (!dataDir) await rm(dir, { recursive: true, force: true }); });
  return { app, store, dir };
}

async function login(app: FastifyInstance, suppliedPassword = password, suppliedOrigin = origin) {
  return app.inject({ method: 'POST', url: '/api/dashboard/login', headers: { origin: suppliedOrigin }, payload: { username: 'viewer', password: suppliedPassword } });
}

function cookie(response: { headers: Record<string, unknown> }): string {
  return String(response.headers['set-cookie']).split(';')[0];
}

async function list(app: FastifyInstance, sessionCookie: string, query = ''): Promise<DashboardDocumentsResponse> {
  const response = await app.inject({ method: 'GET', url: `/api/dashboard/documents${query}`, headers: { cookie: sessionCookie } });
  expect(response.statusCode).toBe(200);
  return response.json() as DashboardDocumentsResponse;
}

async function upload(app: FastifyInstance, hostName?: string): Promise<UploadResult> {
  const begin = await app.inject({ method: 'POST', url: '/api/uploads', payload: { filename: 'A Book.pdf', size: pdf.length, hostName } });
  expect(begin.statusCode).toBe(201);
  const session = begin.json() as UploadSession;
  const path = `/api/uploads/${session.uploadId}`;
  const headers = { authorization: `Bearer ${session.uploadToken}` };
  const chunk = await app.inject({ method: 'PUT', url: path, headers: { ...headers, 'content-type': 'application/octet-stream', 'upload-offset': '0' }, payload: pdf });
  expect(chunk.statusCode).toBe(200);
  const complete = await app.inject({ method: 'POST', url: `${path}/complete`, headers });
  expect(complete.statusCode).toBe(202);
  return complete.json() as UploadResult;
}

async function joinRoom(app: FastifyInstance, tokens: UploadResult, name: string, owner = false): Promise<WebSocket> {
  const listeningAddress = app.server.address();
  const address = listeningAddress && typeof listeningAddress !== 'string'
    ? `http://127.0.0.1:${listeningAddress.port}`
    : await app.listen({ host: '127.0.0.1', port: 0 });
  const socket = new WebSocket(`${address.replace(/^http/, 'ws')}/ws`);
  await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  socket.send(JSON.stringify({
    type: 'join', documentId: tokens.documentId, accessToken: tokens.accessToken,
    ownerToken: owner ? tokens.ownerToken : undefined,
    clientId: `${name}-${owner ? 'owner' : 'guest'}`, name,
  }));
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('WebSocket join timed out')), 3000);
    socket.on('message', data => {
      if (JSON.parse(data.toString()).type === 'welcome') { clearTimeout(timeout); resolve(); }
    });
    socket.once('error', reject);
  });
  cleanup.push(async () => { socket.terminate(); });
  return socket;
}

describe('protected dashboard', () => {
  it('fails closed without credentials and enforces login, origin, sessions, logout, and expiry', async () => {
    const unconfigured = await setup(false);
    expect((await login(unconfigured.app)).statusCode).toBe(503);
    expect((await unconfigured.app.inject({ method: 'GET', url: '/api/dashboard/session' })).statusCode).toBe(503);
    expect((await unconfigured.app.inject({ method: 'GET', url: '/api/dashboard/documents' })).statusCode).toBe(503);

    let now = Date.now();
    const { app } = await setup(true, undefined, () => now);
    expect((await app.inject({ method: 'GET', url: '/api/dashboard/session' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/dashboard/documents' })).statusCode).toBe(401);
    expect((await login(app, password, 'https://other.example')).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/dashboard/login', headers: { 'sec-fetch-site': 'cross-site' }, payload: { username: 'viewer', password } })).statusCode).toBe(403);
    expect((await login(app, 'wrong')).statusCode).toBe(401);
    const success = await login(app);
    expect(success.statusCode).toBe(200);
    expect(success.json()).toEqual({ username: 'viewer' });
    expect(success.headers['cache-control']).toBe('private, no-store');
    expect(success.headers['set-cookie']).toContain('HttpOnly; SameSite=Strict; Path=/api/dashboard');
    expect(success.headers['set-cookie']).toContain('Secure');
    const sessionCookie = cookie(success);
    expect((await app.inject({ method: 'GET', url: '/api/dashboard/session', headers: { cookie: sessionCookie } })).json()).toEqual({ username: 'viewer' });
    expect((await app.inject({ method: 'POST', url: '/api/dashboard/logout', headers: { cookie: sessionCookie, origin: 'https://other.example' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/dashboard/session', headers: { cookie: sessionCookie } })).statusCode).toBe(200);
    const logout = await app.inject({ method: 'POST', url: '/api/dashboard/logout', headers: { cookie: sessionCookie, origin } });
    expect(logout.statusCode).toBe(204);
    expect(logout.headers['set-cookie']).toContain('Max-Age=0');
    expect((await app.inject({ method: 'GET', url: '/api/dashboard/session', headers: { cookie: sessionCookie } })).statusCode).toBe(401);
    const second = await login(app);
    now += 60_001;
    expect((await app.inject({ method: 'GET', url: '/api/dashboard/session', headers: { cookie: cookie(second) } })).statusCode).toBe(401);
  });

  it('bounds login input and attempts per client', async () => {
    let now = Date.now();
    const { app } = await setup(true, undefined, () => now);
    expect((await app.inject({ method: 'POST', url: '/api/dashboard/login', headers: { origin }, payload: { username: 'viewer' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/dashboard/login', headers: { origin, 'content-type': 'text/plain' }, payload: 'hello' })).statusCode).toBe(415);
    expect((await app.inject({ method: 'POST', url: '/api/dashboard/login', headers: { origin }, payload: { username: 'viewer', password: 'x'.repeat(3000) } })).statusCode).toBe(413);
    for (let attempt = 0; attempt < 10; attempt++) expect((await login(app, 'wrong')).statusCode).toBe(401);
    expect((await login(app)).statusCode).toBe(429);
    now += 5 * 60 * 1000 + 1;
    expect((await login(app)).statusCode).toBe(200);
  });

  it('binds the host to its upload, prevents guest renaming, persists metadata, and keeps capabilities out of listings', async () => {
    let now = Date.now();
    const { app, store, dir } = await setup(true, undefined, () => now);
    const first = await upload(app, 'Alice');
    const second = await upload(app, 'Bob');
    await store.waitForIdle();
    const sessionCookie = cookie(await login(app));
    const initial = await list(app, sessionCookie);
    expect(initial.total).toBe(2);
    expect(initial.documents.map(document => document.hostName).sort()).toEqual(['Alice', 'Bob']);
    expect(initial.documents.every(document => document.uploadedAt !== null && document.lastAccessedAt === null && document.status === 'ready')).toBe(true);
    expect((await list(app, sessionCookie, '?offset=1&limit=1')).documents).toHaveLength(1);
    expect((await app.inject({ method: 'GET', url: '/api/dashboard/documents?limit=101', headers: { cookie: sessionCookie } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/api/dashboard/documents?offset=-1', headers: { cookie: sessionCookie } })).statusCode).toBe(400);
    const responseText = JSON.stringify(initial);
    expect(responseText).not.toContain(first.accessToken);
    expect(responseText).not.toContain(first.ownerToken);
    expect(responseText).not.toContain(second.accessToken);
    expect(responseText).not.toContain(second.ownerToken);
    expect(responseText).not.toContain('Hash');

    expect((await app.inject({ method: 'GET', url: `/api/documents/${first.documentId}` })).statusCode).toBe(401);
    expect((await list(app, sessionCookie)).documents.find(document => document.id === first.documentId)?.lastAccessedAt).toBeNull();
    const guest = await joinRoom(app, first, 'Mallory');
    const afterGuest = (await list(app, sessionCookie)).documents.find(document => document.id === first.documentId)!;
    expect(afterGuest.hostName).toBe('Alice');
    expect(afterGuest.lastAccessedAt).toBe(now);
    now += 1000;
    const owner = await joinRoom(app, first, 'Creator', true);
    expect((await list(app, sessionCookie)).documents.find(document => document.id === first.documentId)?.hostName).toBe('Creator');

    const firstRecord = await readFile(join(dir, 'documents', first.documentId, 'record.json'), 'utf8');
    expect(firstRecord).not.toContain(first.accessToken);
    expect(firstRecord).not.toContain(first.ownerToken);
    const guestClosed = new Promise<void>(resolve => guest.once('close', () => resolve()));
    const ownerClosed = new Promise<void>(resolve => owner.once('close', () => resolve()));
    guest.terminate();
    owner.terminate();
    await Promise.all([guestClosed, ownerClosed]);
    await app.close();
    const restarted = await setup(true, dir, () => now);
    const restartedCookie = cookie(await login(restarted.app));
    const restored = (await list(restarted.app, restartedCookie)).documents.find(document => document.id === first.documentId)!;
    expect(restored.hostName).toBe('Creator');
    expect(restored.lastAccessedAt).toBe(now);
    expect(restored.sizeBytes).toBe(pdf.length);
    expect(restored.pageCount).toBe(1);
  });

  it('coalesces page reads while the dashboard shows the latest access and flushes on close', async () => {
    let now = Date.now();
    const { app, store, dir } = await setup(true, undefined, () => now);
    const tokens = await upload(app);
    await store.waitForIdle();
    const sessionCookie = cookie(await login(app));
    const headers = { authorization: `Bearer ${tokens.accessToken}` };
    expect((await app.inject({ method: 'GET', url: `/api/documents/${tokens.documentId}/pages/2/links`, headers })).statusCode).toBe(404);
    expect((await list(app, sessionCookie)).documents[0].lastAccessedAt).toBeNull();
    expect((await app.inject({ method: 'GET', url: `/api/documents/${tokens.documentId}`, headers })).statusCode).toBe(200);
    const firstAccess = now;
    now += 1000;
    expect((await app.inject({ method: 'GET', url: `/api/documents/${tokens.documentId}/pages/1/links`, headers })).statusCode).toBe(200);
    expect((await list(app, sessionCookie)).documents[0].lastAccessedAt).toBe(now);
    const dbPath = join(dir, 'dashboard.sqlite3');
    const beforeClose = new DatabaseSync(dbPath, { readOnly: true });
    expect((beforeClose.prepare('SELECT last_accessed_at FROM dashboard_documents WHERE id = ?').get(tokens.documentId) as { last_accessed_at: number }).last_accessed_at).toBe(firstAccess);
    beforeClose.close();
    await app.close();
    const afterClose = new DatabaseSync(dbPath, { readOnly: true });
    expect((afterClose.prepare('SELECT last_accessed_at FROM dashboard_documents WHERE id = ?').get(tokens.documentId) as { last_accessed_at: number }).last_accessed_at).toBe(now);
    afterClose.close();
  });

  it('uses null for missing historical upload times when rebuilding the catalog', async () => {
    const { app, store, dir } = await setup();
    const tokens = await upload(app);
    await store.waitForIdle();
    await app.close();
    const recordPath = join(dir, 'documents', tokens.documentId, 'record.json');
    const record = JSON.parse(await readFile(recordPath, 'utf8')) as Record<string, unknown>;
    delete record.createdAt;
    await writeFile(recordPath, JSON.stringify(record));
    await rm(join(dir, 'dashboard.sqlite3'));
    const restarted = await setup(true, dir);
    const sessionCookie = cookie(await login(restarted.app));
    expect((await list(restarted.app, sessionCookie)).documents[0].uploadedAt).toBeNull();
  });
});
