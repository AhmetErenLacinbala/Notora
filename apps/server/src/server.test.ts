import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import * as Y from 'yjs';
import type { FastifyInstance } from 'fastify';
import { MAX_UPLOAD_CHUNK_BYTES, REMOVED_CLOSE_CODE, type ServerMessage, type UploadResult, type UploadSession } from '../../../packages/shared/src/index.ts';
import { createServer } from './index.ts';
import type { PdfTools } from './pdf.ts';

const pdf = Buffer.from('%PDF-1.7\nA test PDF\n%%EOF\n');
const resources: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of resources.splice(0).reverse()) await cleanup();
});

function fakeTools(onExtract?: () => Promise<void>): PdfTools {
  return {
    async validate(source) {
      if (!(await readFile(source)).subarray(0, 5).equals(Buffer.from('%PDF-'))) throw new Error('Invalid');
    },
    async extract(_source, pagesDir) {
      await onExtract?.();
      await writeFile(join(pagesDir, '1.pdf'), pdf);
      await writeFile(join(pagesDir, '2.pdf'), pdf);
      return {
        pages: [{ number: 1, width: 612, height: 792 }, { number: 2, width: 400, height: 600 }],
        outline: [{ title: 'Chapter', destination: { page: 2, y: 50 }, items: [] }],
        links: [[{ rect: [10, 20, 30, 40], destination: { page: 2 } }], []],
      };
    },
  };
}

async function setup(tools = fakeTools(), options: { maxUploadMb?: number; storageBudgetMb?: number; dataDir?: string } = {}) {
  const dir = options.dataDir ?? await mkdtemp(join(tmpdir(), 'notora-test-'));
  const { app, store } = await createServer({ dataDir: dir, webDir: join(dir, 'no-web-build'), pdfTools: tools, maxUploadMb: options.maxUploadMb, storageBudgetMb: options.storageBudgetMb });
  resources.push(async () => { await store.waitForIdle(); await app.close(); if (!options.dataDir) await rm(dir, { recursive: true, force: true }); });
  return { app, store, dir };
}

function multipartPayload(content = pdf, filename = 'A Book.pdf') {
  const boundary = 'notora-boundary';
  return {
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/pdf\r\n\r\n`),
      content,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
  };
}

async function upload(app: FastifyInstance): Promise<UploadResult> {
  const response = await app.inject({ method: 'POST', url: '/api/documents', ...multipartPayload() });
  expect(response.statusCode).toBe(202);
  return response.json() as UploadResult;
}

async function beginUpload(app: FastifyInstance, size = pdf.length, filename = 'A Book.pdf'): Promise<UploadSession> {
  const response = await app.inject({ method: 'POST', url: '/api/uploads', payload: { filename, size } });
  expect(response.statusCode).toBe(201);
  return response.json() as UploadSession;
}

function uploadHeaders(session: UploadSession, offset = 0) {
  return {
    authorization: `Bearer ${session.uploadToken}`,
    'content-type': 'application/octet-stream',
    'upload-offset': String(offset),
  };
}

class Messages {
  readonly socket: WebSocket;
  readonly closed: Promise<{ code: number; reason: string }>;
  readonly received: ServerMessage[] = [];
  private waiters: Array<() => void> = [];

  constructor(url: string) {
    this.socket = new WebSocket(url);
    this.closed = new Promise(resolve => this.socket.once('close', (code, reason) => resolve({ code, reason: reason.toString() })));
    this.socket.on('message', raw => {
      this.received.push(JSON.parse(raw.toString()) as ServerMessage);
      for (const wake of this.waiters.splice(0)) wake();
    });
  }

  async open() {
    if (this.socket.readyState === WebSocket.OPEN) return;
    await new Promise<void>((resolve, reject) => {
      this.socket.once('open', () => resolve());
      this.socket.once('error', reject);
    });
  }

  send(value: unknown) { this.socket.send(JSON.stringify(value)); }

  async next(predicate: (message: ServerMessage) => boolean): Promise<ServerMessage> {
    const end = Date.now() + 3_000;
    while (Date.now() < end) {
      const index = this.received.findIndex(predicate);
      if (index >= 0) return this.received.splice(index, 1)[0];
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('WebSocket message timed out')), end - Date.now());
        this.waiters.push(() => { clearTimeout(timeout); resolve(); });
      });
    }
    throw new Error('WebSocket message timed out');
  }

  close() { this.socket.terminate(); }
}

async function connect(url: string, tokens: UploadResult, clientId: string, name: string, ownerToken?: string): Promise<Messages> {
  const client = new Messages(url);
  await client.open();
  client.send({ type: 'join', documentId: tokens.documentId, accessToken: tokens.accessToken, ownerToken, clientId, name });
  return client;
}

describe('Notora server', () => {
  it('serves the built SPA at home and room routes while API misses stay JSON', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'notora-spa-test-'));
    const webDir = join(dir, 'web');
    await mkdir(webDir);
    await writeFile(join(webDir, 'index.html'), '<!doctype html><title>Notora</title>');
    const { app } = await createServer({ dataDir: join(dir, 'data'), webDir, pdfTools: fakeTools() });
    resources.push(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
    expect((await app.inject({ method: 'GET', url: '/' })).body).toContain('<title>Notora</title>');
    expect((await app.inject({ method: 'GET', url: '/r/example' })).body).toContain('<title>Notora</title>');
    expect((await app.inject({ method: 'GET', url: '/api/absent' })).json()).toEqual({ error: 'Not found' });
  });

  it('streams an upload, protects every document endpoint, and serves versioned isolated pages', async () => {
    const { app, store, dir } = await setup();
    const tokens = await upload(app);
    expect(tokens.accessToken).not.toBe(tokens.ownerToken);
    await store.waitForIdle();

    const manifest = await app.inject({ method: 'GET', url: `/api/documents/${tokens.documentId}`, headers: { authorization: `Bearer ${tokens.accessToken}` } });
    expect(manifest.statusCode).toBe(200);
    expect(manifest.json()).toMatchObject({ status: 'ready', title: 'A Book', pageCount: 2, pages: [{ number: 1 }, { number: 2 }] });
    const version = manifest.json().version as string;
    expect((await readFile(join(dir, 'documents', tokens.documentId, 'original.pdf'))).equals(pdf)).toBe(true);
    const record = await readFile(join(dir, 'documents', tokens.documentId, 'record.json'), 'utf8');
    expect(record).not.toContain(tokens.accessToken);
    expect(record).not.toContain(tokens.ownerToken);

    const path = `/api/documents/${tokens.documentId}/pages/1.pdf?v=${version}`;
    const headers = { authorization: `Bearer ${tokens.accessToken}` };
    expect((await app.inject({ method: 'GET', url: path })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: path, headers: { authorization: 'Bearer wrong' } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `/api/documents/${tokens.documentId}/pages/1/links` })).statusCode).toBe(401);
    const page = await app.inject({ method: 'GET', url: path, headers });
    expect(page.statusCode).toBe(200);
    expect(page.headers['cache-control']).toBe('private, no-store');
    expect(page.headers['content-type']).toContain('application/pdf');
    expect(page.rawPayload.equals(pdf)).toBe(true);
    const unchanged = await app.inject({ method: 'GET', url: path, headers: { ...headers, 'if-none-match': String(page.headers.etag) } });
    expect(unchanged.statusCode).toBe(304);
    expect(unchanged.headers['cache-control']).toBe('private, no-store');
    expect((await app.inject({ method: 'GET', url: `/api/documents/${tokens.documentId}/pages/3.pdf`, headers })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `/api/documents/${tokens.documentId}/pages/1.pdf?v=wrong`, headers })).statusCode).toBe(404);
    const links = await app.inject({ method: 'GET', url: `/api/documents/${tokens.documentId}/pages/1/links`, headers });
    expect(links.headers['cache-control']).toBe('private, no-store');
    expect(links.json()).toEqual([{ rect: [10, 20, 30, 40], destination: { page: 2 } }]);
    expect((await app.inject({ method: 'GET', url: '/api/missing' })).json()).toEqual({ error: 'Not found' });
    expect((await app.inject({ method: 'GET', url: '/healthz' })).json()).toMatchObject({ status: 'ok' });
  });

  it('loads durable manifests and page files after a server restart', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'notora-restart-test-'));
    const first = await createServer({ dataDir: dir, webDir: join(dir, 'no-web-build'), pdfTools: fakeTools() });
    const tokens = await upload(first.app);
    await first.store.waitForIdle();
    await first.app.close();
    const second = await createServer({ dataDir: dir, webDir: join(dir, 'no-web-build'), pdfTools: fakeTools() });
    resources.push(async () => { await second.app.close(); await rm(dir, { recursive: true, force: true }); });
    const headers = { authorization: `Bearer ${tokens.accessToken}` };
    const manifest = await second.app.inject({ method: 'GET', url: `/api/documents/${tokens.documentId}`, headers });
    expect(manifest.json()).toMatchObject({ status: 'ready', pageCount: 2 });
    const page = await second.app.inject({ method: 'GET', url: `/api/documents/${tokens.documentId}/pages/2.pdf`, headers });
    expect(page.statusCode).toBe(200);
    expect(page.rawPayload.equals(pdf)).toBe(true);
  });

  it('fingerprints originals only for owners, caches durably, and preserves processing results', async () => {
    let release!: () => void;
    const processing = new Promise<void>(resolve => { release = resolve; });
    const { app, store, dir } = await setup(fakeTools(() => processing));
    const tokens = await upload(app);
    const url = `/api/documents/${tokens.documentId}/fingerprint`;
    const headers = { authorization: `Bearer ${tokens.accessToken}`, 'x-owner-token': tokens.ownerToken };
    expect((await app.inject({ method: 'GET', url })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url, headers: { authorization: headers.authorization } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url, headers: { ...headers, 'x-owner-token': 'wrong' } })).statusCode).toBe(404);
    const pending = app.inject({ method: 'GET', url, headers });
    release();
    const response = await pending;
    const expected = { sha256: createHash('sha256').update(pdf).digest('hex'), size: pdf.length };
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(expected);
    await store.waitForIdle();
    const saved = JSON.parse(await readFile(join(dir, 'documents', tokens.documentId, 'record.json'), 'utf8'));
    expect(saved.manifest).toMatchObject({ contentHash: expected.sha256, status: 'ready', pageCount: 2 });
    // A second request must use metadata rather than read the original again.
    await rm(join(dir, 'documents', tokens.documentId, 'original.pdf'));
    expect((await app.inject({ method: 'GET', url, headers })).json()).toEqual(expected);
  });

  it('rejects oversized uploads and processes documents one at a time', async () => {
    let active = 0;
    let maximum = 0;
    const { app, store } = await setup(fakeTools(async () => {
      maximum = Math.max(maximum, ++active);
      await new Promise(resolve => setTimeout(resolve, 30));
      active -= 1;
    }));
    await Promise.all([upload(app), upload(app)]);
    await store.waitForIdle();
    expect(maximum).toBe(1);

    const limited = await setup(fakeTools(), { maxUploadMb: 0.00002 });
    const response = await limited.app.inject({ method: 'POST', url: '/api/documents', ...multipartPayload(Buffer.concat([pdf, Buffer.alloc(100)])) });
    expect(response.statusCode).toBe(413);
    expect(limited.store.documents.size).toBe(0);
  });

  it('streams sequential chunks with private status, offset conflicts, durable completion and idempotent retry', async () => {
    const { app, store, dir } = await setup();
    const session = await beginUpload(app, pdf.length, '../A Book.pdf');
    const route = `/api/uploads/${session.uploadId}`;
    expect((await app.inject({ method: 'GET', url: route })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: route, headers: { authorization: 'Bearer wrong' } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: `${route}/complete`, headers: { authorization: `Bearer ${session.uploadToken}` } })).json()).toMatchObject({ offset: 0 });

    const first = pdf.subarray(0, 7);
    const sent = await app.inject({ method: 'PUT', url: route, headers: uploadHeaders(session), payload: first });
    expect(sent.statusCode).toBe(200);
    expect(sent.json()).toEqual({ offset: 7 });
    const duplicate = await app.inject({ method: 'PUT', url: route, headers: uploadHeaders(session), payload: first });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json()).toMatchObject({ offset: 7 });
    expect((await app.inject({ method: 'GET', url: route, headers: { authorization: `Bearer ${session.uploadToken}` } })).json()).toEqual({ offset: 7, size: pdf.length });
    const rest = await app.inject({ method: 'PUT', url: route, headers: uploadHeaders(session, 7), payload: pdf.subarray(7) });
    expect(rest.json()).toEqual({ offset: pdf.length });
    const complete = await app.inject({ method: 'POST', url: `${route}/complete`, headers: { authorization: `Bearer ${session.uploadToken}` } });
    expect(complete.statusCode).toBe(202);
    const result = complete.json() as UploadResult;
    expect((await app.inject({ method: 'POST', url: `${route}/complete`, headers: { authorization: `Bearer ${session.uploadToken}` } })).json()).toEqual(result);
    expect((await readFile(join(dir, 'documents', result.documentId, 'original.pdf'))).equals(pdf)).toBe(true);
    const record = await readFile(join(dir, 'documents', result.documentId, 'record.json'), 'utf8');
    expect(record).not.toContain(session.uploadToken);
    expect(record).not.toContain(result.accessToken);
    expect(record).not.toContain(result.ownerToken);
    await store.waitForIdle();
    const manifest = await app.inject({ method: 'GET', url: `/api/documents/${result.documentId}`, headers: { authorization: `Bearer ${result.accessToken}` } });
    expect(manifest.json()).toMatchObject({ status: 'ready', title: 'A Book' });
  });

  it('returns 202 before validation, then records invalid PDFs as errors', async () => {
    let release!: () => void;
    const validation = new Promise<void>(resolve => { release = resolve; });
    const tools = fakeTools();
    tools.validate = async () => { await validation; throw new Error('Invalid PDF'); };
    const { app, store } = await setup(tools);
    const pending = app.inject({ method: 'POST', url: '/api/documents', ...multipartPayload() });
    const early = await Promise.race([pending.then(() => true), new Promise<false>(resolve => setTimeout(() => resolve(false), 300))]);
    release();
    expect(early).toBe(true);
    const response = await pending;
    expect(response.statusCode).toBe(202);
    const result = response.json() as UploadResult;
    await store.waitForIdle();
    const manifest = await app.inject({ method: 'GET', url: `/api/documents/${result.documentId}`, headers: { authorization: `Bearer ${result.accessToken}` } });
    expect(manifest.json()).toMatchObject({ status: 'error', error: 'This PDF could not be prepared.' });
  });

  it('rejects non-PDF headers and rolls back failed or overlapping chunks', async () => {
    const { app, store, dir } = await setup();
    const bad = await beginUpload(app, 5);
    const badRoute = `/api/uploads/${bad.uploadId}`;
    expect((await app.inject({ method: 'PUT', url: badRoute, headers: uploadHeaders(bad), payload: Buffer.from('hello') })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: `${badRoute}/complete`, headers: { authorization: `Bearer ${bad.uploadToken}` } })).statusCode).toBe(415);
    expect((await app.inject({ method: 'GET', url: badRoute, headers: { authorization: `Bearer ${bad.uploadToken}` } })).statusCode).toBe(404);

    const session = await beginUpload(app);
    const path = join(dir, 'incoming', `${session.uploadId}.part`);
    async function* broken() { yield pdf.subarray(0, 8); throw new Error('Connection broke'); }
    await expect(store.appendUploadChunk(session.uploadId, session.uploadToken, 0, Readable.from(broken()))).rejects.toThrow('Connection broke');
    expect((await stat(path)).size).toBe(0);
    expect(store.getUploadStatus(session.uploadId, session.uploadToken)).toEqual({ offset: 0, size: pdf.length });
    const slow = new PassThrough();
    const first = store.appendUploadChunk(session.uploadId, session.uploadToken, 0, slow);
    await expect(store.appendUploadChunk(session.uploadId, session.uploadToken, 0, Readable.from(pdf))).rejects.toMatchObject({ statusCode: 409, offset: 0 });
    slow.end(pdf);
    expect(await first).toEqual({ offset: pdf.length });
  });

  it('retires a session when a failed chunk cannot be truncated', async () => {
    const { app, store, dir } = await setup(fakeTools(), { storageBudgetMb: 0.003 });
    const session = await beginUpload(app);
    const path = join(dir, 'incoming', `${session.uploadId}.part`);
    const source = new PassThrough();
    const pending = store.appendUploadChunk(session.uploadId, session.uploadToken, 0, source);
    source.write(pdf.subarray(0, 8));
    let written = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      if ((await stat(path)).size === 8) { written = true; break; }
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    expect(written).toBe(true);
    await rm(path);
    source.destroy(new Error('Connection lost'));
    await expect(pending).rejects.toMatchObject({ code: 'ENOENT' });
    expect(() => store.getUploadStatus(session.uploadId, session.uploadToken)).toThrow();
    expect((await app.inject({ method: 'GET', url: `/api/uploads/${session.uploadId}`, headers: { authorization: `Bearer ${session.uploadToken}` } })).statusCode).toBe(404);
    await beginUpload(app); // The retired partial no longer holds storage quota.
  });

  it('bounds chunk size and active session storage, releasing expired partial uploads', async () => {
    const { app, store, dir } = await setup(fakeTools(), { storageBudgetMb: 0.003 });
    const session = await beginUpload(app, pdf.length);
    expect((await app.inject({ method: 'POST', url: '/api/uploads', payload: { filename: 'Second.pdf', size: pdf.length } })).statusCode).toBe(507);
    const route = `/api/uploads/${session.uploadId}`;
    const tooLarge = await app.inject({ method: 'PUT', url: route, headers: uploadHeaders(session), payload: Buffer.alloc(MAX_UPLOAD_CHUNK_BYTES + 1) });
    expect(tooLarge.statusCode).toBe(413);
    await expect(store.appendUploadChunk(session.uploadId, session.uploadToken, 0, Readable.from([Buffer.alloc(MAX_UPLOAD_CHUNK_BYTES + 1)]))).rejects.toMatchObject({ statusCode: 413 });
    expect(store.getUploadStatus(session.uploadId, session.uploadToken).offset).toBe(0);
    expect((await stat(join(dir, 'incoming', `${session.uploadId}.part`))).size).toBe(0);
    await store.expireIdleUploads(Date.now() + 30 * 60 * 1000 + 1);
    expect((await app.inject({ method: 'GET', url: route, headers: { authorization: `Bearer ${session.uploadToken}` } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/api/uploads', payload: { filename: 'Second.pdf', size: pdf.length } })).statusCode).toBe(201);
  });

  it('accepts a full 1 MiB chunk followed by the final byte', async () => {
    const { app, dir } = await setup();
    const source = Buffer.alloc(MAX_UPLOAD_CHUNK_BYTES + 1);
    pdf.copy(source);
    const session = await beginUpload(app, source.length);
    const route = `/api/uploads/${session.uploadId}`;
    const first = await app.inject({ method: 'PUT', url: route, headers: uploadHeaders(session), payload: source.subarray(0, MAX_UPLOAD_CHUNK_BYTES) });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ offset: MAX_UPLOAD_CHUNK_BYTES });
    const last = await app.inject({ method: 'PUT', url: route, headers: uploadHeaders(session, MAX_UPLOAD_CHUNK_BYTES), payload: source.subarray(MAX_UPLOAD_CHUNK_BYTES) });
    expect(last.json()).toEqual({ offset: source.length });
    const complete = await app.inject({ method: 'POST', url: `${route}/complete`, headers: { authorization: `Bearer ${session.uploadToken}` } });
    expect(complete.statusCode).toBe(202);
    const result = complete.json() as UploadResult;
    expect((await readFile(join(dir, 'documents', result.documentId, 'original.pdf'))).equals(source)).toBe(true);
  });

  it('relays Yjs state to owners offscreen and releases room state after disconnect', async () => {
    const { app, store } = await setup();
    const tokens = await upload(app);
    await store.waitForIdle();
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const url = address.replace(/^http/, 'ws') + '/ws';
    const owner = new Messages(url);
    const guest = new Messages(url);
    resources.push(async () => { owner.close(); guest.close(); });
    await owner.open();
    owner.send({ type: 'join', documentId: tokens.documentId, accessToken: tokens.accessToken, ownerToken: tokens.ownerToken, clientId: 'owner', name: 'Owner' });
    expect((await owner.next(message => message.type === 'welcome')).type).toBe('welcome');
    await guest.open();
    guest.send({ type: 'join', documentId: tokens.documentId, accessToken: tokens.accessToken, clientId: 'guest', name: 'Guest' });
    expect((await guest.next(message => message.type === 'welcome')).type).toBe('welcome');

    const note = new Y.Doc();
    note.getText('text').insert(0, 'guest edit');
    guest.send({ type: 'update', key: 'note:one', update: Buffer.from(Y.encodeStateAsUpdate(note)).toString('base64') });
    const received = await owner.next(message => message.type === 'update' && message.key === 'note:one');
    expect(received.type).toBe('update');
    if (received.type === 'update') {
      const merged = new Y.Doc();
      Y.applyUpdate(merged, Buffer.from(received.update, 'base64'));
      expect(merged.getText('text').toString()).toBe('guest edit');
    }
    guest.send({ type: 'cursor', cursor: { x: 10, y: 20 } });
    expect(await owner.next(message => message.type === 'cursor' && message.cursor?.x === 10)).toMatchObject({ type: 'cursor', clientId: 'guest' });
    guest.send({ type: 'cursor', cursor: null });
    expect(await owner.next(message => message.type === 'cursor' && message.cursor === null)).toMatchObject({ type: 'cursor', clientId: 'guest' });
    // Replaying the same state is a no-op and must not consume room capacity.
    for (let index = 0; index < 4; index++) {
      guest.send({ type: 'state', key: 'note:one', update: Buffer.from(Y.encodeStateAsUpdate(note)).toString('base64') });
    }
    note.getText('text').insert(10, ' continued');
    guest.send({ type: 'state', key: 'note:one', update: Buffer.from(Y.encodeStateAsUpdate(note)).toString('base64') });
    expect((await owner.next(message => message.type === 'update' && message.key === 'note:one')).type).toBe('update');
    owner.close();
    guest.close();
    await new Promise(resolve => setTimeout(resolve, 30));

    const late = new Messages(url);
    resources.push(async () => { late.close(); });
    await late.open();
    late.send({ type: 'join', documentId: tokens.documentId, accessToken: tokens.accessToken, clientId: 'late', name: 'Late' });
    await late.next(message => message.type === 'welcome');
    late.send({ type: 'subscribe', keys: ['note:one'] });
    expect((await late.next(message => message.type === 'need-state' && message.keys.includes('note:one'))).type).toBe('need-state');
  });

  it('grants removal only to a verified owner, regardless of arrival order, name, or client ID', async () => {
    const { app, store } = await setup();
    const tokens = await upload(app);
    await store.waitForIdle();
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const url = `${address.replace(/^http/, 'ws')}/ws`;
    const clients: Messages[] = [];
    resources.push(async () => { for (const client of clients) client.close(); });

    const firstGuest = await connect(url, tokens, 'first', 'Owner');
    clients.push(firstGuest);
    expect(await firstGuest.next(message => message.type === 'welcome')).toMatchObject({
      participants: [{ clientId: 'first', owner: false }],
    });
    firstGuest.send({ type: 'kick', clientId: 'first', owner: true, ownerToken: tokens.ownerToken });
    expect(await firstGuest.next(message => message.type === 'error')).toMatchObject({ message: 'Only the owner can remove participants' });

    const owner = await connect(url, tokens, 'owner', 'Creator', tokens.ownerToken);
    clients.push(owner);
    expect(await owner.next(message => message.type === 'welcome')).toMatchObject({
      participants: expect.arrayContaining([{ clientId: 'owner', name: 'Creator', owner: true, color: expect.any(String), cursor: null }]),
    });
    firstGuest.send({ type: 'kick', clientId: 'owner', owner: true, ownerToken: tokens.ownerToken });
    expect(await firstGuest.next(message => message.type === 'error')).toMatchObject({ message: 'Only the owner can remove participants' });
    expect(owner.socket.readyState).toBe(WebSocket.OPEN);

    const forgedOwner = await connect(url, tokens, 'forged', 'Creator', 'wrong-owner-token');
    clients.push(forgedOwner);
    expect((await forgedOwner.closed).code).toBe(1008);
    expect(forgedOwner.received.some(message => message.type === 'welcome')).toBe(false);

    const duplicateId = await connect(url, tokens, 'owner', 'Impersonator');
    clients.push(duplicateId);
    expect(await duplicateId.closed).toMatchObject({ code: 1008, reason: 'Client ID already in use' });
    expect(owner.socket.readyState).toBe(WebSocket.OPEN);

    const secondOwner = await connect(url, tokens, 'second-owner', 'Another creator tab', tokens.ownerToken);
    clients.push(secondOwner);
    expect(await secondOwner.next(message => message.type === 'welcome')).toMatchObject({
      participants: expect.arrayContaining([{ clientId: 'second-owner', owner: true, color: expect.any(String), cursor: null, name: 'Another creator tab' }]),
    });
    owner.send({ type: 'kick', clientId: 'owner' });
    expect(await owner.next(message => message.type === 'error')).toMatchObject({ message: 'Cannot remove an owner' });
    owner.send({ type: 'kick', clientId: 'second-owner' });
    expect(await owner.next(message => message.type === 'error')).toMatchObject({ message: 'Cannot remove an owner' });
    expect(secondOwner.socket.readyState).toBe(WebSocket.OPEN);
  });

  it('removes only a guest in the same room, clears their preview, and ignores late frames', async () => {
    const { app, store } = await setup();
    const tokens = await upload(app);
    const otherTokens = await upload(app);
    await store.waitForIdle();
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const url = `${address.replace(/^http/, 'ws')}/ws`;
    const clients: Messages[] = [];
    resources.push(async () => { for (const client of clients) client.close(); });

    const owner = await connect(url, tokens, 'owner', 'Owner', tokens.ownerToken);
    clients.push(owner);
    await owner.next(message => message.type === 'welcome');
    const guest = await connect(url, tokens, 'guest', 'Guest');
    clients.push(guest);
    await guest.next(message => message.type === 'welcome');
    const otherRoomGuest = await connect(url, otherTokens, 'other-room', 'Other room guest');
    clients.push(otherRoomGuest);
    await otherRoomGuest.next(message => message.type === 'welcome');

    owner.send({ type: 'kick', clientId: 'other-room' });
    expect(await owner.next(message => message.type === 'error')).toMatchObject({ message: 'Participant unavailable' });
    expect(otherRoomGuest.socket.readyState).toBe(WebSocket.OPEN);

    guest.send({ type: 'drawing-preview', preview: {
      id: 'pending', kind: 'stroke', anchorPage: 1, x: 0, y: 0, width: 2, seq: 0,
      points: [{ x: 0, y: 0 }],
    } });
    expect(await owner.next(message => message.type === 'drawing-preview' && message.clientId === 'guest' && message.preview !== null))
      .toMatchObject({ clientId: 'guest' });
    owner.received.length = 0;

    let sentAfterRemoval = false;
    guest.socket.on('message', raw => {
      if ((JSON.parse(raw.toString()) as ServerMessage).type !== 'removed' || guest.socket.readyState !== WebSocket.OPEN) return;
      sentAfterRemoval = true;
      guest.send({ type: 'cursor', cursor: { x: 999, y: 999 } });
      const note = new Y.Doc();
      note.getText('text').insert(0, 'late edit');
      guest.send({ type: 'update', key: 'note:late', update: Buffer.from(Y.encodeStateAsUpdate(note)).toString('base64') });
    });
    owner.send({ type: 'kick', clientId: 'guest' });
    expect(await guest.next(message => message.type === 'removed')).toMatchObject({ message: expect.stringContaining('removed') });
    expect(await guest.closed).toMatchObject({ code: REMOVED_CLOSE_CODE, reason: 'Removed by owner' });
    expect(sentAfterRemoval).toBe(true);
    expect(await owner.next(message => message.type === 'drawing-preview' && message.clientId === 'guest' && message.preview === null))
      .toMatchObject({ clientId: 'guest', preview: null });
    const remaining = await owner.next(message => message.type === 'participants' && !message.participants.some(participant => participant.clientId === 'guest'));
    expect(remaining).toMatchObject({ participants: expect.arrayContaining([{ clientId: 'owner', owner: true, color: expect.any(String), cursor: null, name: 'Owner' }]) });
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(owner.received.some(message => message.type === 'cursor' && message.clientId === 'guest' && message.cursor?.x === 999)).toBe(false);
    expect(owner.received.some(message => message.type === 'update' && message.key === 'note:late')).toBe(false);

    const rejoined = await connect(url, tokens, 'guest', 'Guest');
    clients.push(rejoined);
    expect((await rejoined.next(message => message.type === 'welcome')).type).toBe('welcome');
  });
});
