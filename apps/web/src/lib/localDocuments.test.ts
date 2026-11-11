import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OwnedProject, UploadResult } from '../../../../packages/shared/src/index';
import type { LocalDocumentRecord } from './storage';

const state = vi.hoisted(() => ({
  records: new Map<string, LocalDocumentRecord>(),
  blobs: new Map<string, Blob>(),
  owned: [] as OwnedProject[],
  mergeCalls: [] as Array<[string, string]>,
  mappingWrites: 0,
}));
vi.mock('./storage', () => ({
  getLocalDocument: vi.fn(async (id: string) => state.records.get(id)),
  getOwnedProject: vi.fn(async (id: string) => state.owned.find(project => project.documentId === id)),
  getLocalBlob: vi.fn(async (id: string) => state.blobs.get(id)),
  importLocalBlob: vi.fn(async (proposal: LocalDocumentRecord, blob: Blob) => {
    const prior = state.records.get(proposal.id);
    const record = prior ? { ...prior, lastOpenedAt: proposal.lastOpenedAt } : proposal;
    state.records.set(record.id, record);
    if (!state.blobs.has(record.id)) state.blobs.set(record.id, blob);
    return record;
  }),
  listOwnedProjects: vi.fn(async () => state.owned),
  mergeWorkspaceStorage: vi.fn(async (from: string, to: string) => { state.mergeCalls.push([from, to]); }),
  saveOwnedProject: vi.fn(async (project: OwnedProject) => {
    state.owned = [...state.owned.filter(item => item.documentId !== project.documentId), project];
  }),
  saveLocalUploadAndOwned: vi.fn(async (record: LocalDocumentRecord, project: OwnedProject) => {
    state.mappingWrites++;
    state.records.set(record.id, record);
    state.owned = [...state.owned.filter(item => item.documentId !== project.documentId), project];
    return record;
  }),
}));
vi.mock('./api', () => ({ uploadPdf: vi.fn() }));

import { uploadPdf } from './api';
import { hashPdf, importLocalFile, resolveExistingUpload, uploadLocalDocument } from './localDocuments';

const result: UploadResult = { documentId: 'shared-1', accessToken: 'access', ownerToken: 'owner' };

describe('local PDF identity and sharing', () => {
  beforeEach(() => {
    state.records.clear();
    state.blobs.clear();
    state.owned = [];
    state.mergeCalls.length = 0;
    state.mappingWrites = 0;
    vi.mocked(uploadPdf).mockReset();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('hashes bounded slices and reuses the same local record for identical bytes under another filename', async () => {
    const content = new Uint8Array(2 * 1024 * 1024 + 17);
    content.set([37, 80, 68, 70, 45]);
    const slices: number[] = [];
    class TrackedBlob extends Blob {
      override slice(start?: number, end?: number, contentType?: string): Blob {
        const part = super.slice(start, end, contentType);
        slices.push(part.size);
        return part;
      }
      override arrayBuffer(): Promise<ArrayBuffer> { throw new Error('Whole-file read forbidden'); }
    }
    const tracked = new TrackedBlob([content]);
    expect(await hashPdf(tracked)).toBe(createHash('sha256').update(content).digest('hex'));
    expect(slices).toEqual([1024 * 1024, 1024 * 1024, 17]);

    const first = await importLocalFile(new File([content], 'First.pdf'));
    const second = await importLocalFile(new File([content], 'Renamed.pdf'));
    expect(second.id).toBe(first.id);
    expect(second.storageId).toBe(first.id);
    expect(second.title).toBe('First');
    expect(state.records.size).toBe(1);
    expect(state.blobs.size).toBe(1);
  });

  it('adopts a previous owned upload without uploading again and preserves its storage ID', async () => {
    const record = await importLocalFile(new File(['%PDF-same'], 'Notes.pdf'));
    state.owned = [{ ...result, title: 'Old name', createdAt: 1, lastOpenedAt: 1, contentHash: record.contentHash, storageId: 'old-storage' }];
    const adopted = await resolveExistingUpload(record, true);
    expect(adopted.upload).toEqual(result);
    expect(adopted.storageId).toBe('old-storage');
    expect(state.mergeCalls).toEqual([[record.id, 'old-storage']]);
    expect(state.mappingWrites).toBe(1);
    expect(uploadPdf).not.toHaveBeenCalled();
  });

  it('checks legacy owned fingerprints with owner credentials before associating a file', async () => {
    const record = await importLocalFile(new File(['%PDF-old'], 'Legacy.pdf'));
    state.owned = [{ ...result, title: 'Legacy', createdAt: 1, lastOpenedAt: 1 }];
    const fetchMock = vi.fn(async () => Response.json({ sha256: record.contentHash, size: record.size }));
    vi.stubGlobal('fetch', fetchMock);
    const adopted = await resolveExistingUpload(record, true);
    expect(adopted.upload).toEqual(result);
    expect(adopted.storageId).toBe(result.documentId);
    expect(fetchMock).toHaveBeenCalledWith('/api/documents/shared-1/fingerprint', {
      headers: { Authorization: 'Bearer access', 'x-owner-token': 'owner' }, cache: 'no-store',
    });
    expect(uploadPdf).not.toHaveBeenCalled();
  });

  it('coalesces concurrent uploads and persists their mapping before returning', async () => {
    const record = await importLocalFile(new File(['%PDF-new'], 'New.pdf'));
    let finish!: (value: UploadResult) => void;
    vi.mocked(uploadPdf).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const first = uploadLocalDocument(record.id, undefined, 'Test Host');
    const second = uploadLocalDocument(record.id);
    expect(first).toBe(second);
    await vi.waitFor(() => expect(uploadPdf).toHaveBeenCalledTimes(1));
    expect(vi.mocked(uploadPdf).mock.calls[0][2]).toBe('Test Host');
    finish(result);
    expect(await first).toEqual(result);
    expect(await second).toEqual(result);
    expect(state.mappingWrites).toBe(1);
    expect(state.records.get(record.id)?.upload).toEqual(result);
    expect(state.owned[0].storageId).toBe(record.id);
    await uploadLocalDocument(record.id);
    expect(uploadPdf).toHaveBeenCalledTimes(1);
  });

  it('blocks a new upload while a legacy owner fingerprint cannot be checked', async () => {
    const record = await importLocalFile(new File(['%PDF-uncertain'], 'Uncertain.pdf'));
    state.owned = [{ ...result, title: 'Old', createdAt: 1, lastOpenedAt: 1 }];
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    await expect(uploadLocalDocument(record.id)).rejects.toThrow('Could not check a previously shared PDF');
    expect(uploadPdf).not.toHaveBeenCalled();
  });
});
