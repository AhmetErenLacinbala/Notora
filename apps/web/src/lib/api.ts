import {
  MAX_UPLOAD_CHUNK_BYTES,
  type DocumentManifest, type PageLink, type UploadResult, type UploadSession, type UploadStatus,
} from '../../../../packages/shared/src/index';
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

const INITIAL_UPLOAD_CHUNK_BYTES = 64 * 1024;
const MIN_UPLOAD_CHUNK_BYTES = 16 * 1024;
const TARGET_CHUNK_MS = 10_000;
const UPLOAD_TIMEOUT_MS = 45_000;
const MAX_UPLOAD_RETRIES = 3;

class UploadTransportError extends ApiError {
  constructor(message: string, readonly timedOut = false) { super(message); }
}

function uploadError(status: number, payload: unknown): ApiError {
  if (status === 401 || status === 404 || status === 410) {
    return new ApiError('Upload session expired. Please start the upload again.', status);
  }
  const detail = typeof payload === 'object' && payload !== null && 'error' in payload &&
    typeof payload.error === 'string' ? payload.error : undefined;
  return new ApiError(detail ?? `Upload failed (${status}).`, status);
}

function transient(error: unknown): boolean {
  return error instanceof UploadTransportError || error instanceof ApiError &&
    (error.status === 502 || error.status === 503 || error.status === 504);
}

function shrinkChunk(error: unknown): boolean {
  return error instanceof UploadTransportError && error.timedOut || error instanceof ApiError &&
    (error.status === 502 || error.status === 504);
}

async function uploadJson(path: string, expectedStatus: number, init: RequestInit): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(path, { ...init, signal: controller.signal, cache: 'no-store' });
  } catch {
    throw new UploadTransportError(
      controller.signal.aborted ? 'Upload request timed out. Please try again.' :
        'Upload connection failed. Please try again.',
      controller.signal.aborted,
    );
  } finally {
    clearTimeout(timeout);
  }
  const payload: unknown = await response.json().catch(() => undefined);
  if (response.status !== expectedStatus) throw uploadError(response.status, payload);
  return payload;
}

async function retryTransient<T>(request: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await request(); } catch (error) {
      if (!transient(error) || attempt >= MAX_UPLOAD_RETRIES) throw error;
      await new Promise(resolve => setTimeout(resolve, 250 * 2 ** attempt));
    }
  }
}

function uploadPath(id: string): string {
  return `/api/uploads/${encodeURIComponent(id)}`;
}

function validOffset(value: unknown, size: number): value is number {
  return Number.isSafeInteger(value) && typeof value === 'number' && value >= 0 && value <= size;
}

function validResult(value: unknown): value is UploadResult {
  if (typeof value !== 'object' || value === null) return false;
  const result = value as Partial<UploadResult>;
  return typeof result.documentId === 'string' && result.documentId.length > 0 &&
    typeof result.accessToken === 'string' && result.accessToken.length > 0 &&
    typeof result.ownerToken === 'string' && result.ownerToken.length > 0;
}

function putChunk(
  path: string, token: string, offset: number, chunk: Blob, reportBytes: (bytes: number) => void,
): Promise<{ offset: number; elapsedMs: number }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const started = performance.now();
    xhr.open('PUT', path);
    xhr.responseType = 'json';
    xhr.timeout = UPLOAD_TIMEOUT_MS;
    xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.setRequestHeader('Upload-Offset', String(offset));
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.upload.onprogress = event => {
      if (event.lengthComputable) reportBytes(offset + Math.min(chunk.size, event.loaded));
    };
    xhr.onerror = () => reject(new UploadTransportError('Upload connection failed. Please try again.'));
    xhr.ontimeout = () => reject(new UploadTransportError('Upload request timed out. Please try again.', true));
    xhr.onabort = () => reject(new UploadTransportError('Upload was interrupted. Please try again.'));
    xhr.onload = () => {
      if (xhr.status !== 200) {
        reject(uploadError(xhr.status, xhr.response));
        return;
      }
      const response: unknown = xhr.response;
      if (typeof response !== 'object' || response === null || !('offset' in response) ||
          typeof response.offset !== 'number') {
        reject(new ApiError('The upload response was incomplete.'));
        return;
      }
      resolve({ offset: response.offset, elapsedMs: performance.now() - started });
    };
    try { xhr.send(chunk); } catch {
      reject(new UploadTransportError('Upload connection failed. Please try again.'));
    }
  });
}

export async function uploadPdf(file: File, onProgress?: (percent: number) => void, hostName?: string, hostId?: string): Promise<UploadResult> {
  if (!Number.isSafeInteger(file.size) || file.size <= 0) throw new ApiError('Choose a nonempty PDF.');
  let reported = -1;
  const report = (bytes: number, complete = false): void => {
    const percent = complete ? 100 : Math.min(99, Math.floor(bytes / file.size * 100));
    if (percent > reported) {
      reported = percent;
      onProgress?.(percent);
    }
  };

  const opened = await retryTransient(() => uploadJson('/api/uploads', 201, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filename: file.name, size: file.size, hostName, hostId }),
  }));
  if (typeof opened !== 'object' || opened === null || !('uploadId' in opened) ||
      typeof opened.uploadId !== 'string' || !opened.uploadId ||
      !('uploadToken' in opened) || typeof opened.uploadToken !== 'string' || !opened.uploadToken ||
      !('offset' in opened) || opened.offset !== 0) {
    throw new ApiError('The upload session response was incomplete.');
  }
  const session = opened as UploadSession;
  const path = uploadPath(session.uploadId);
  const headers = { Authorization: `Bearer ${session.uploadToken}` };
  const status = async (): Promise<UploadStatus> => {
    const value = await retryTransient(() => uploadJson(path, 200, { method: 'GET', headers }));
    if (typeof value !== 'object' || value === null || !('offset' in value) ||
        !validOffset(value.offset, file.size) || !('size' in value) || value.size !== file.size) {
      throw new ApiError('The upload session status was invalid.');
    }
    return value as UploadStatus;
  };

  let offset = session.offset;
  let chunkBytes = INITIAL_UPLOAD_CHUNK_BYTES;
  let retries = 0;
  while (offset < file.size) {
    const end = Math.min(file.size, offset + chunkBytes);
    try {
      const result = await putChunk(path, session.uploadToken, offset, file.slice(offset, end), report);
      if (result.offset !== end) throw new ApiError('The upload response had an unexpected offset.');
      offset = end;
      retries = 0;
      report(offset);
      const scale = Math.max(0.25, Math.min(4, TARGET_CHUNK_MS / Math.max(1, result.elapsedMs)));
      chunkBytes = Math.max(MIN_UPLOAD_CHUNK_BYTES,
        Math.min(MAX_UPLOAD_CHUNK_BYTES, Math.round(chunkBytes * scale)));
    } catch (error) {
      if (!(transient(error) || error instanceof ApiError && error.status === 409) ||
          retries >= MAX_UPLOAD_RETRIES) throw error;
      retries++;
      // A failed response may still follow a committed chunk. Ask the server
      // before resending any bytes, including after a 409 offset conflict.
      const committed = (await status()).offset;
      if (committed === end) {
        offset = end;
        retries = 0;
        report(offset);
      } else if (committed !== offset) {
        throw new ApiError('The upload session offset changed unexpectedly.');
      } else {
        if (shrinkChunk(error)) chunkBytes = Math.max(MIN_UPLOAD_CHUNK_BYTES, Math.floor(chunkBytes / 2));
        await new Promise(resolve => setTimeout(resolve, 250 * 2 ** (retries - 1)));
      }
    }
  }

  let completed: unknown;
  for (let attempt = 0; ; attempt++) {
    try {
      completed = await uploadJson(`${path}/complete`, 202, { method: 'POST', headers });
      break;
    } catch (error) {
      if (!(transient(error) || error instanceof ApiError && error.status === 409) ||
          attempt >= MAX_UPLOAD_RETRIES) throw error;
      if ((await status()).offset !== file.size) throw new ApiError('The upload is incomplete. Please try again.');
      await new Promise(resolve => setTimeout(resolve, 250 * 2 ** attempt));
    }
  }
  if (!validResult(completed)) throw new ApiError('The upload response was incomplete.');
  report(file.size, true);
  return completed;
}

export async function getManifest(id: string, token: string): Promise<DocumentManifest> {
  const response = await requireOk(await fetch(documentPath(id), {
    headers: authorized(token),
    cache: 'no-store',
  }));
  return response.json() as Promise<DocumentManifest>;
}

export async function getPageBytes(
  id: string, version: string, page: number, token: string, signal?: AbortSignal, ownerToken?: string,
): Promise<Uint8Array> {
  signal?.throwIfAborted();
  if (!Number.isSafeInteger(page) || page < 1) throw new ApiError('Invalid page number.');
  // Guests use session memory only; owners read just the requested cached page.
  const cached = ownerToken ? await getCachedPage(id, version, page).catch(() => undefined) : undefined;
  signal?.throwIfAborted();
  if (cached) return cached;
  const response = await requireOk(await fetch(
    `${documentPath(id)}/pages/${page}.pdf?v=${encodeURIComponent(version)}`,
    { headers: authorized(token), signal, cache: 'no-store' },
  ));
  const bytes = new Uint8Array(await response.arrayBuffer());
  signal?.throwIfAborted();
  // A browser storage quota failure must not prevent the current page from rendering.
  if (ownerToken) await saveCachedPage(id, version, page, bytes).catch(() => undefined);
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
