import type { DocumentManifest, PageLink, UploadResult } from '../../../../packages/shared/src/index';
import { getCachedPage, saveCachedPage } from './storage';

export class ApiError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'ApiError';
  }
}

function documentPath(id: string): string {
  return `/api/documents/${encodeURIComponent(id)}`;
}

function authorized(token: string): HeadersInit {
  return { Authorization: `Bearer ${token}` };
}

async function requireOk(response: Response): Promise<Response> {
  if (response.ok) return response;
  let detail: unknown;
  try {
    detail = await response.json();
  } catch {
    // A proxy or network gateway may return a non-JSON error page.
  }
  const message = typeof detail === 'object' && detail !== null && 'error' in detail &&
    typeof detail.error === 'string' ? detail.error :
    response.status === 401 || response.status === 404 ? 'This document link is unavailable.' :
    `Request failed (${response.status}).`;
  throw new ApiError(message, response.status);
}

export function uploadPdf(file: File, onProgress?: (percent: number) => void): Promise<UploadResult> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/documents');
    xhr.responseType = 'json';
    xhr.upload.onprogress = event => {
      if (event.lengthComputable && event.total > 0) {
        // 100 means the server has durably accepted the upload, not just sent bytes.
        onProgress?.(Math.min(99, Math.round(event.loaded / event.total * 100)));
      }
    };
    xhr.onerror = () => reject(new ApiError('Upload failed. Check your connection and try again.'));
    xhr.onabort = () => reject(new ApiError('Upload was cancelled.'));
    xhr.onload = () => {
      const response: unknown = xhr.response;
      if (xhr.status !== 202 && xhr.status !== 200) {
        const message = typeof response === 'object' && response !== null && 'error' in response &&
          typeof response.error === 'string' ? response.error : `Upload failed (${xhr.status}).`;
        reject(new ApiError(message, xhr.status));
        return;
      }
      if (typeof response !== 'object' || response === null ||
          !('documentId' in response) || typeof response.documentId !== 'string' ||
          !('accessToken' in response) || typeof response.accessToken !== 'string' ||
          !('ownerToken' in response) || typeof response.ownerToken !== 'string') {
        reject(new ApiError('The upload response was incomplete.'));
        return;
      }
      onProgress?.(100);
      resolve(response as UploadResult);
    };
    const body = new FormData();
    body.append('file', file, file.name);
    xhr.send(body);
  });
}

export async function getManifest(id: string, token: string): Promise<DocumentManifest> {
  const response = await requireOk(await fetch(documentPath(id), {
    headers: authorized(token),
    cache: 'no-store',
  }));
  return response.json() as Promise<DocumentManifest>;
}

export async function getPageBytes(
  id: string, version: string, page: number, token: string, signal?: AbortSignal,
): Promise<Uint8Array> {
  signal?.throwIfAborted();
  if (!Number.isSafeInteger(page) || page < 1) throw new ApiError('Invalid page number.');
  // Only one requested record is read; there is no all-pages memory cache.
  const cached = await getCachedPage(id, version, page).catch(() => undefined);
  signal?.throwIfAborted();
  if (cached) return cached;
  const response = await requireOk(await fetch(
    `${documentPath(id)}/pages/${page}.pdf?v=${encodeURIComponent(version)}`,
    { headers: authorized(token), signal, cache: 'no-store' },
  ));
  const bytes = new Uint8Array(await response.arrayBuffer());
  signal?.throwIfAborted();
  // A browser storage quota failure must not prevent the current page from rendering.
  await saveCachedPage(id, version, page, bytes).catch(() => undefined);
  signal?.throwIfAborted();
  return bytes;
}

export async function getPageLinks(
  id: string, page: number, token: string, signal?: AbortSignal,
): Promise<PageLink[]> {
  if (!Number.isSafeInteger(page) || page < 1) throw new ApiError('Invalid page number.');
  const response = await requireOk(await fetch(`${documentPath(id)}/pages/${page}/links`, {
    headers: authorized(token), signal, cache: 'no-store',
  }));
  return response.json() as Promise<PageLink[]>;
}
