import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { OwnedProject, UploadResult } from '../../../../packages/shared/src/index';
import { uploadPdf } from './api';
import {
  getLocalBlob, getLocalDocument, getOwnedProject, importLocalBlob, listOwnedProjects, mergeWorkspaceStorage,
  saveLocalUploadAndOwned, saveOwnedProject, type LocalDocumentRecord,
} from './storage';

const HASH_CHUNK_BYTES = 1024 * 1024;
const uploading = new Map<string, Promise<UploadResult>>();

export async function hashPdf(blob: Blob): Promise<string> {
  if (!Number.isSafeInteger(blob.size) || blob.size <= 0) throw new Error('Choose a nonempty PDF.');
  const hash = sha256.create();
  for (let offset = 0; offset < blob.size; offset += HASH_CHUNK_BYTES) {
    const bytes = new Uint8Array(await blob.slice(offset, Math.min(offset + HASH_CHUNK_BYTES, blob.size)).arrayBuffer());
    hash.update(bytes);
  }
  return bytesToHex(hash.digest());
}

export async function importLocalFile(file: File): Promise<LocalDocumentRecord> {
  if (file.size < 5) throw new Error('Choose a valid PDF file.');
  const header = new Uint8Array(await file.slice(0, 5).arrayBuffer());
  if (String.fromCharCode(...header) !== '%PDF-') throw new Error('Choose a valid PDF file.');
  const contentHash = await hashPdf(file);
  const id = `local-${contentHash}`;
  const now = Date.now();
  const record: LocalDocumentRecord = {
    id,
    title: file.name.replace(/\.pdf$/i, '').trim().slice(0, 200) || 'Untitled PDF',
    contentHash,
    size: file.size,
    createdAt: now,
    lastOpenedAt: now,
    storageId: id,
  };
  return importLocalBlob(record, file);
}

async function legacyFingerprint(project: OwnedProject): Promise<{ sha256: string; size: number } | null> {
  const response = await fetch(`/api/documents/${encodeURIComponent(project.documentId)}/fingerprint`, {
    headers: { Authorization: `Bearer ${project.accessToken}`, 'x-owner-token': project.ownerToken },
    cache: 'no-store',
  });
  // A stale owned record is not proof that the user still owns that document.
  if (response.status === 401 || response.status === 403 || response.status === 404) return null;
  if (!response.ok) throw new Error('Could not check a previously shared PDF. Please try again.');
  const value: unknown = await response.json();
  if (typeof value !== 'object' || value === null || !('sha256' in value) ||
      typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(value.sha256) ||
      !('size' in value) || typeof value.size !== 'number' || !Number.isSafeInteger(value.size) || value.size <= 0) {
    throw new Error('The previous PDF fingerprint response was invalid.');
  }
  return { sha256: value.sha256.toLowerCase(), size: value.size };
}

async function adoptOwned(record: LocalDocumentRecord, project: OwnedProject): Promise<LocalDocumentRecord> {
  const storageId = project.storageId ?? project.documentId;
  if (storageId !== record.storageId) await mergeWorkspaceStorage(record.storageId, storageId);
  const next = { ...record, storageId, upload: {
    documentId: project.documentId, accessToken: project.accessToken, ownerToken: project.ownerToken,
  } };
  return saveLocalUploadAndOwned(next, { ...project, storageId, contentHash: record.contentHash, lastOpenedAt: Date.now() });
}

// Call before starting an upload. If an old owner record cannot be checked,
// fail closed to avoid creating a duplicate shared document by accident.
export async function resolveExistingUpload(record: LocalDocumentRecord, requireCompleteCheck = false): Promise<LocalDocumentRecord> {
  const current = await getLocalDocument(record.id) ?? record;
  if (current.upload) {
    if (!(await getOwnedProject(current.upload.documentId))) {
      await saveOwnedProject({
        ...current.upload, title: current.title, createdAt: current.createdAt,
        lastOpenedAt: Date.now(), storageId: current.storageId, contentHash: current.contentHash,
      });
    }
    return current;
  }
  const owned = await listOwnedProjects();
  let unavailable = false;
  for (const project of owned) {
    if (project.contentHash) {
      if (project.contentHash.toLowerCase() === current.contentHash) return adoptOwned(current, project);
      continue;
    }
    try {
      const fingerprint = await legacyFingerprint(project);
      if (!fingerprint) continue;
      await saveOwnedProject({ ...project, contentHash: fingerprint.sha256 });
      if (fingerprint.size === current.size && fingerprint.sha256 === current.contentHash) {
        return adoptOwned(current, project);
      }
    } catch {
      unavailable = true;
    }
  }
  if (unavailable && requireCompleteCheck) {
    throw new Error('Could not check a previously shared PDF. Please try again before uploading.');
  }
  return current;
}

async function shareOnce(id: string, onProgress?: (percent: number) => void, hostName?: string): Promise<UploadResult> {
  const run = async (): Promise<UploadResult> => {
    const record = await getLocalDocument(id);
    if (!record) throw new Error('This local PDF is unavailable.');
    const matched = await resolveExistingUpload(record, true);
    if (matched.upload) return matched.upload;
    const blob = await getLocalBlob(id);
    if (!blob) throw new Error('This local PDF is missing from browser storage.');
    const file = new File([blob], `${record.title}.pdf`, { type: 'application/pdf' });
    const result = await uploadPdf(file, onProgress, hostName);
    // The upload is already durable when the API returns. Persist its mapping
    // before any manifest polling or route transition so retries reuse it.
    await saveLocalUploadAndOwned({ ...matched, upload: result }, {
      ...result, title: record.title, createdAt: Date.now(), lastOpenedAt: Date.now(),
      storageId: matched.storageId, contentHash: matched.contentHash,
    });
    return result;
  };
  if (typeof navigator !== 'undefined' && navigator.locks) {
    return navigator.locks.request(`notora-upload-${id}`, run);
  }
  return run();
}

export function uploadLocalDocument(id: string, onProgress?: (percent: number) => void, hostName?: string): Promise<UploadResult> {
  const existing = uploading.get(id);
  if (existing) return existing;
  const promise = shareOnce(id, onProgress, hostName).finally(() => uploading.delete(id));
  uploading.set(id, promise);
  return promise;
}
