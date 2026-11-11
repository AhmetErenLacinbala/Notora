import { afterEach, describe, expect, it, vi } from 'vitest';
import { DashboardRequestError, deleteDashboardDocument, documentsFrom } from './dashboardData';

const document = {
  id: 'a'.repeat(32), title: 'Proposal', hostName: 'A. User', uploadedAt: 1_700_000_000_000,
  lastAccessedAt: null, sizeBytes: 1024, pageCount: 2, status: 'ready',
  provenance: { hostId: 'profile-1', ipAddress: '203.0.113.1', countryCode: 'TR', userAgent: 'Browser' },
  storageBytes: 2048, storagePrefix: `notora/${'a'.repeat(32)}/`, storageProvider: 'r2',
};

describe('dashboard data', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('accepts complete private metadata and unknown legacy provenance without inventing values', () => {
    const storage = { provider: 'r2', usedBytes: 2048, reservedBytes: 512, limitBytes: 9_000_000_000,
      classAUsed: 3, classALimit: 800_000, classBUsed: 4, classBLimit: 8_000_000,
      classADailyUsed: 2, classADailyLimit: 20_000, classBDailyUsed: 4, classBDailyLimit: 200_000,
      month: '2026-11', available: true };
    expect(documentsFrom({ documents: [document], total: 1, offset: 0, limit: 50, storage }).storage).toEqual(storage);
    const { classADailyUsed, classADailyLimit, classBDailyUsed, classBDailyLimit, ...legacyStorage } = storage;
    expect(documentsFrom({ documents: [document], total: 1, offset: 0, limit: 50, storage: legacyStorage }).storage).toEqual(legacyStorage);
    const legacy = { ...document, hostName: null, uploadedAt: null, provenance: undefined, storageBytes: undefined,
      storagePrefix: undefined, storageProvider: undefined };
    expect(documentsFrom({ documents: [legacy], total: 1, offset: 0, limit: 50 }).documents[0]).toEqual(legacy);
  });

  it('rejects malformed size and provenance rather than displaying misleading capacity or origin', () => {
    expect(() => documentsFrom({ documents: [{ ...document, sizeBytes: -1 }], total: 1, offset: 0, limit: 50 })).toThrow('invalid file list');
    expect(() => documentsFrom({ documents: [{ ...document, provenance: { ...document.provenance, ipAddress: 123 } }], total: 1, offset: 0, limit: 50 })).toThrow('invalid file list');
    expect(() => documentsFrom({ documents: [document], total: 1, offset: 0, limit: 50, storage: { usedBytes: 100 } })).toThrow('invalid file list');
    expect(() => documentsFrom({ documents: [document], total: 1, offset: 0, limit: 50,
      storage: { provider: 'r2', usedBytes: 0, reservedBytes: 0, limitBytes: 9_000_000_000,
        classAUsed: 0, classALimit: 800_000, classBUsed: 0, classBLimit: 8_000_000,
        classADailyUsed: -1, month: '2026-11', available: true } })).toThrow('invalid file list');
  });

  it('deletes only through authenticated same-origin API and surfaces conflict errors', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(deleteDashboardDocument(document.id)).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith(`/api/dashboard/documents/${document.id}`, {
      method: 'DELETE', credentials: 'same-origin', cache: 'no-store',
    });
    fetchMock.mockImplementationOnce(async () => Response.json({ error: 'Document is processing.' }, { status: 409 }));
    await expect(deleteDashboardDocument(document.id)).rejects.toMatchObject({
      name: 'DashboardRequestError', status: 409, message: 'Document is processing.',
    });
  });

  it('treats an expired operator session as a signed-out state', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 401 })));
    await expect(deleteDashboardDocument(document.id)).rejects.toBeInstanceOf(DashboardRequestError);
    await expect(deleteDashboardDocument(document.id)).rejects.toMatchObject({ status: 401 });
  });

  it('does not claim success when the delete response is lost', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('network'); }));
    await expect(deleteDashboardDocument(document.id)).rejects.toThrow('Refresh the list before trying again.');
  });
});
