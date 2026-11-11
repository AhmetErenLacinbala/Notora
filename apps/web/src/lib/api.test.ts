import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_UPLOAD_CHUNK_BYTES, type UploadResult } from '../../../../packages/shared/src/index';

const pageCache = vi.hoisted(() => new Map<string, Uint8Array>());
vi.mock('./storage', () => ({
  getCachedPage: vi.fn(async (id: string, version: string, page: number) => pageCache.get(`${id}:${version}:${page}`)),
  saveCachedPage: vi.fn(async (id: string, version: string, page: number, bytes: Uint8Array) => {
    pageCache.set(`${id}:${version}:${page}`, bytes);
  }),
}));

import { getManifest, getPageBytes, getPageLinks, uploadPdf } from './api';
import { getCachedPage, saveCachedPage } from './storage';

class UploadXHR {
  static instances: UploadXHR[] = [];
  static handle: (xhr: UploadXHR) => void = () => {};
  readonly upload: { onprogress?: (event: { lengthComputable: boolean; loaded: number; total: number }) => void } = {};
  responseType = '';
  response: unknown;
  status = 0;
  timeout = 0;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  ontimeout: (() => void) | null = null;
  body: Document | XMLHttpRequestBodyInit | null = null;
  method = '';
  url = '';
  headers: Record<string, string> = {};
  constructor() { UploadXHR.instances.push(this); }
  open(method: string, url: string): void { this.method = method; this.url = url; }
  setRequestHeader(name: string, value: string): void { this.headers[name] = value; }
  send(body: Document | XMLHttpRequestBodyInit | null): void {
    this.body = body;
    queueMicrotask(() => UploadXHR.handle(this));
  }
  respond(status: number, response: unknown): void {
    this.status = status;
    this.response = response;
    this.onload?.();
  }
}

const uploadResult: UploadResult = { documentId: 'doc', accessToken: 'access', ownerToken: 'owner' };

function stubUploadServer(size: number) {
  const state = {
    offset: 0, checks: 0, completions: 0,
    completeStatuses: [] as number[], statusStatuses: [] as number[],
    onComplete: () => {},
  };
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? 'GET';
    if (path === '/api/uploads' && method === 'POST') {
      return Response.json({ uploadId: 'session', uploadToken: 'upload-secret', offset: 0 }, { status: 201 });
    }
    if (path === '/api/uploads/session' && method === 'GET') {
      state.checks++;
      const code = state.statusStatuses.shift() ?? 200;
      return Response.json(code === 200 ? { offset: state.offset, size } : { error: 'gone' }, { status: code });
    }
    if (path === '/api/uploads/session/complete' && method === 'POST') {
      state.completions++;
      state.onComplete();
      const code = state.completeStatuses.shift() ?? 202;
      return Response.json(code === 202 ? uploadResult : { error: 'gateway' }, { status: code });
    }
    throw new Error(`Unexpected upload request: ${method} ${path}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('XMLHttpRequest', UploadXHR);
  UploadXHR.instances.length = 0;
  return { state, fetchMock };
}

describe('document API', () => {
  beforeEach(() => { pageCache.clear(); vi.clearAllMocks(); });
  afterEach(() => vi.unstubAllGlobals());

  it('keeps bearer credentials in headers and caches each immutable page version separately', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(new Uint8Array([37, 80, 68, 70]).buffer, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const first = await getPageBytes('doc', 'v1', 7, 'secret', undefined, 'owner');
    expect([...first]).toEqual([37, 80, 68, 70]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/documents/doc/pages/7.pdf?v=v1');
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ headers: { Authorization: 'Bearer secret' } });
    await getPageBytes('doc', 'v1', 7, 'secret', undefined, 'owner');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await getPageBytes('doc', 'v2', 7, 'secret', undefined, 'owner');
    await getPageBytes('doc', 'v1', 8, 'secret', undefined, 'owner');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('never reads or writes persistent pages for guests, even with a legacy cache', async () => {
    pageCache.set('doc:v1:7', new Uint8Array([1]));
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(new Uint8Array([37, 80, 68, 70]).buffer));
    vi.stubGlobal('fetch', fetchMock);
    const first = await getPageBytes('doc', 'v1', 7, 'secret');
    await getPageBytes('doc', 'v1', 7, 'secret');
    expect([...first]).toEqual([37, 80, 68, 70]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.every(([, init]) => init?.cache === 'no-store')).toBe(true);
    expect(getCachedPage).not.toHaveBeenCalled();
    expect(saveCachedPage).not.toHaveBeenCalled();
  });

  it('honors obsolete page requests and fetches manifest and links with bearer credentials', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchMock = vi.fn(async (url: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify(
      String(url).endsWith('/links') ? [] : { id: 'doc', status: 'processing' },
    ), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(getPageBytes('doc', 'v1', 1, 'secret', controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect((await getManifest('doc', 'secret')).status).toBe('processing');
    expect(await getPageLinks('doc', 1, 'secret')).toEqual([]);
    expect(fetchMock.mock.calls.every(call => new Headers(call[1]?.headers).get('Authorization') === 'Bearer secret')).toBe(true);
  });

  it('surfaces page storage errors without writing a failed response to owner cache', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'Storage temporarily unavailable.' }, { status: 503 })));
    await expect(getPageBytes('doc', 'v1', 1, 'secret', undefined, 'owner')).rejects.toMatchObject({
      name: 'ApiError', status: 503, message: 'Storage temporarily unavailable.',
    });
    expect(saveCachedPage).not.toHaveBeenCalled();
  });

  it('uploads sequential bounded slices with bearer headers and completes before reporting 100', async () => {
    const progress: number[] = [];
    const file = new File([new Uint8Array(3 * MAX_UPLOAD_CHUNK_BYTES + 100)], 'notes.pdf', { type: 'application/pdf' });
    const { state, fetchMock } = stubUploadServer(file.size);
    state.onComplete = () => {
      expect(state.offset).toBe(file.size);
      expect(progress.at(-1)).toBeLessThan(100);
    };
    UploadXHR.handle = xhr => {
      const chunk = xhr.body as Blob;
      expect(chunk).toBeInstanceOf(Blob);
      expect(xhr.method).toBe('PUT');
      expect(xhr.url).toBe('/api/uploads/session');
      expect(xhr.timeout).toBe(45_000);
      expect(xhr.headers).toMatchObject({
        Authorization: 'Bearer upload-secret', 'Content-Type': 'application/octet-stream',
        'Upload-Offset': String(state.offset),
      });
      expect(chunk.size).toBeGreaterThan(0);
      expect(chunk.size).toBeLessThanOrEqual(MAX_UPLOAD_CHUNK_BYTES);
      xhr.upload.onprogress?.({ lengthComputable: true, loaded: chunk.size, total: chunk.size });
      state.offset += chunk.size;
      xhr.respond(200, { offset: state.offset });
    };

    await expect(uploadPdf(file, percent => progress.push(percent), 'Test Host', 'profile-123')).resolves.toEqual(uploadResult);
    expect(UploadXHR.instances.map(xhr => (xhr.body as Blob).size).slice(0, 3))
      .toEqual([64 * 1024, 256 * 1024, MAX_UPLOAD_CHUNK_BYTES]);
    expect(progress.at(-1)).toBe(100);
    expect(progress.every((value, index) => index === 0 || value >= progress[index - 1])).toBe(true);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: file.name, size: file.size, hostName: 'Test Host', hostId: 'profile-123' }),
    });
    expect(fetchMock.mock.calls.at(-1)?.[1]).toMatchObject({
      method: 'POST', headers: { Authorization: 'Bearer upload-secret' },
    });
  });

  it('queries the committed offset after a lost chunk response and does not resend accepted bytes', async () => {
    const file = new File([new Uint8Array(80 * 1024)], 'notes.pdf');
    const { state } = stubUploadServer(file.size);
    UploadXHR.handle = xhr => {
      const chunk = xhr.body as Blob;
      state.offset += chunk.size;
      xhr.respond(UploadXHR.instances.length === 1 ? 502 : 200,
        UploadXHR.instances.length === 1 ? { error: 'proxy' } : { offset: state.offset });
    };
    await expect(uploadPdf(file)).resolves.toEqual(uploadResult);
    expect(state.checks).toBe(1);
    expect(UploadXHR.instances.map(xhr => Number(xhr.headers['Upload-Offset']))).toEqual([0, 64 * 1024]);
    expect(state.offset).toBe(file.size);
  });

  it('shrinks a timed-out chunk, retries from the server offset, and keeps progress monotonic', async () => {
    const file = new File([new Uint8Array(100 * 1024)], 'notes.pdf');
    const progress: number[] = [];
    const { state } = stubUploadServer(file.size);
    UploadXHR.handle = xhr => {
      const chunk = xhr.body as Blob;
      xhr.upload.onprogress?.({ lengthComputable: true, loaded: chunk.size, total: chunk.size });
      if (UploadXHR.instances.length === 1) {
        xhr.ontimeout?.();
        return;
      }
      state.offset += chunk.size;
      xhr.respond(200, { offset: state.offset });
    };
    await expect(uploadPdf(file, percent => progress.push(percent))).resolves.toEqual(uploadResult);
    expect(state.checks).toBe(1);
    expect(UploadXHR.instances.map(xhr => (xhr.body as Blob).size).slice(0, 2))
      .toEqual([64 * 1024, 32 * 1024]);
    expect(UploadXHR.instances.map(xhr => Number(xhr.headers['Upload-Offset'])).slice(0, 2)).toEqual([0, 0]);
    expect(progress.every((value, index) => index === 0 || value >= progress[index - 1])).toBe(true);
    expect(progress.at(-1)).toBe(100);
  });

  it('retries completion safely when its first response is lost', async () => {
    const file = new File([new Uint8Array(100)], 'notes.pdf');
    const { state } = stubUploadServer(file.size);
    state.completeStatuses.push(502, 202);
    UploadXHR.handle = xhr => {
      state.offset += (xhr.body as Blob).size;
      xhr.respond(200, { offset: state.offset });
    };
    await expect(uploadPdf(file)).resolves.toEqual(uploadResult);
    expect(state.completions).toBe(2);
    expect(state.checks).toBe(1);
  });

  it('retries completion while an earlier finalization is still busy', async () => {
    const file = new File([new Uint8Array(100)], 'notes.pdf');
    const { state } = stubUploadServer(file.size);
    state.completeStatuses.push(409, 202);
    UploadXHR.handle = xhr => {
      state.offset += (xhr.body as Blob).size;
      xhr.respond(200, { offset: state.offset });
    };
    await expect(uploadPdf(file)).resolves.toEqual(uploadResult);
    expect(state.completions).toBe(2);
    expect(state.checks).toBe(1);
  });

  it('reports an expired upload session after offset reconciliation', async () => {
    const file = new File([new Uint8Array(100)], 'notes.pdf');
    const { state } = stubUploadServer(file.size);
    state.statusStatuses.push(404);
    UploadXHR.handle = xhr => xhr.respond(502, { error: 'gateway' });
    await expect(uploadPdf(file)).rejects.toThrow('Upload session expired. Please start the upload again.');
    expect(state.checks).toBe(1);
    expect(UploadXHR.instances).toHaveLength(1);
  });

  it('stops after three network retries and checks the offset before each retry', async () => {
    const file = new File([new Uint8Array(100)], 'notes.pdf');
    const { state } = stubUploadServer(file.size);
    UploadXHR.handle = xhr => xhr.onerror?.();
    await expect(uploadPdf(file)).rejects.toThrow('Upload connection failed. Please try again.');
    expect(UploadXHR.instances).toHaveLength(4);
    expect(state.checks).toBe(3);
    expect(state.completions).toBe(0);
  });
});
