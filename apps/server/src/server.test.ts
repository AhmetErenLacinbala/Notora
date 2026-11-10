import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import * as Y from 'yjs';
import type { FastifyInstance } from 'fastify';
import type { ServerMessage, UploadResult } from '../../../packages/shared/src/index.ts';
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

async function setup(tools = fakeTools(), options: { maxUploadMb?: number; dataDir?: string } = {}) {
  const dir = options.dataDir ?? await mkdtemp(join(tmpdir(), 'notora-test-'));
  const { app, store } = await createServer({ dataDir: dir, webDir: join(dir, 'no-web-build'), pdfTools: tools, maxUploadMb: options.maxUploadMb });
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

class Messages {
  readonly socket: WebSocket;
  readonly received: ServerMessage[] = [];
  private waiters: Array<() => void> = [];

  constructor(url: string) {
    this.socket = new WebSocket(url);
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
    expect(page.headers['content-type']).toContain('application/pdf');
    expect(page.rawPayload.equals(pdf)).toBe(true);
    expect((await app.inject({ method: 'GET', url: path, headers: { ...headers, 'if-none-match': String(page.headers.etag) } })).statusCode).toBe(304);
    expect((await app.inject({ method: 'GET', url: `/api/documents/${tokens.documentId}/pages/3.pdf`, headers })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `/api/documents/${tokens.documentId}/pages/1.pdf?v=wrong`, headers })).statusCode).toBe(404);
    const links = await app.inject({ method: 'GET', url: `/api/documents/${tokens.documentId}/pages/1/links`, headers });
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
});
