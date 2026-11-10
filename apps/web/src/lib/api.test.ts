import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const pageCache = vi.hoisted(() => new Map<string, Uint8Array>());
vi.mock('./storage', () => ({
  getCachedPage: vi.fn(async (id: string, version: string, page: number) => pageCache.get(`${id}:${version}:${page}`)),
  saveCachedPage: vi.fn(async (id: string, version: string, page: number, bytes: Uint8Array) => {
    pageCache.set(`${id}:${version}:${page}`, bytes);
  }),
}));

import { getManifest, getPageBytes, getPageLinks, uploadPdf } from './api';

class UploadXHR {
  static instance: UploadXHR;
  readonly upload: { onprogress?: (event: { lengthComputable: boolean; loaded: number; total: number }) => void } = {};
  responseType = '';
  response: unknown;
  status = 0;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  body: Document | XMLHttpRequestBodyInit | null = null;
  method = '';
  url = '';
  constructor() { UploadXHR.instance = this; }
  open(method: string, url: string): void { this.method = method; this.url = url; }
  send(body: Document | XMLHttpRequestBodyInit | null): void { this.body = body; }
}

describe('document API', () => {
  beforeEach(() => pageCache.clear());
  afterEach(() => vi.unstubAllGlobals());

  it('keeps bearer credentials in headers and caches each immutable page version separately', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(new Uint8Array([37, 80, 68, 70]).buffer, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const first = await getPageBytes('doc', 'v1', 7, 'secret');
    expect([...first]).toEqual([37, 80, 68, 70]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/documents/doc/pages/7.pdf?v=v1');
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ headers: { Authorization: 'Bearer secret' } });
    await getPageBytes('doc', 'v1', 7, 'secret');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await getPageBytes('doc', 'v2', 7, 'secret');
    await getPageBytes('doc', 'v1', 8, 'secret');
    expect(fetchMock).toHaveBeenCalledTimes(3);
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

  it('uploads a File as multipart and reports 100 only after the accepted response', async () => {
    vi.stubGlobal('XMLHttpRequest', UploadXHR);
    const progress: number[] = [];
    const file = new File([new Uint8Array([37, 80, 68, 70])], 'notes.pdf', { type: 'application/pdf' });
    const promise = uploadPdf(file, percent => progress.push(percent));
    const xhr = UploadXHR.instance;
    expect(xhr.method).toBe('POST');
    expect(xhr.url).toBe('/api/documents');
    expect(xhr.body).toBeInstanceOf(FormData);
    expect((xhr.body as FormData).get('file')).toMatchObject({ name: 'notes.pdf', size: 4, type: 'application/pdf' });
    xhr.upload.onprogress?.({ lengthComputable: true, loaded: 100, total: 100 });
    expect(progress).toEqual([99]);
    xhr.status = 202;
    xhr.response = { documentId: 'doc', accessToken: 'access', ownerToken: 'owner' };
    xhr.onload?.();
    await expect(promise).resolves.toEqual(xhr.response);
    expect(progress).toEqual([99, 100]);
  });
});
