import 'fake-indexeddb/auto';
import { deleteDB, openDB } from 'idb';
import { describe, expect, it, vi } from 'vitest';
import type { Camera, OwnedProject, Profile } from '../../../../packages/shared/src/index';

describe('IndexedDB upgrade lifecycle', () => {
  it('reports a blocked v1 upgrade, adopts the pending request on retry, and preserves existing records', async () => {
    const old = await openDB('notora', 1, {
      upgrade(db) {
        db.createObjectStore('profile');
        db.createObjectStore('ownedProjects');
        db.createObjectStore('cameras');
        db.createObjectStore('pages');
        db.createObjectStore('yUpdates');
      },
    });
    const profile: Profile = { id: 'user-1', name: 'Existing reader' };
    const project: OwnedProject = {
      documentId: 'doc-1', accessToken: 'access', ownerToken: 'owner',
      title: 'Existing PDF', createdAt: 1, lastOpenedAt: 2,
    };
    const camera: Camera = { scrollLeft: 12, scrollTop: 34, zoom: 1.5 };
    const page = new Uint8Array([1, 2, 3]);
    const update = new Uint8Array([4, 5, 6]);
    try {
      await old.put('profile', profile, 'current');
      await old.put('ownedProjects', project, project.documentId);
      await old.put('cameras', camera, project.documentId);
      await old.put('pages', page, 'doc-1\u0000v1\u00001');
      await old.put('yUpdates', update, 'doc-1\u0000index');

      const storage = await import('./storage');
      const openSpy = vi.spyOn(indexedDB, 'open');
      const initial = storage.getProfile();
      await expect(initial).rejects.toMatchObject({
        name: 'StorageConnectionError',
        reason: 'blocked',
      });
      expect(openSpy).toHaveBeenCalledTimes(1);

      const retry = storage.getProfile();
      expect(openSpy).toHaveBeenCalledTimes(1);
      old.close();
      await expect(retry).resolves.toEqual(profile);
      expect(await storage.listOwnedProjects()).toEqual([project]);
      expect(await storage.loadCamera(project.documentId)).toEqual(camera);
      expect(await storage.getCachedPage('doc-1', 'v1', 1)).toEqual(page);
      expect(await storage.getYState('doc-1', 'index')).toEqual(update);
      expect(await storage.listLocalDocuments()).toEqual([]);

      // This tab must release its v2 connection for a future schema upgrade.
      const future = await openDB('notora', 3);
      future.close();
      await expect(storage.getProfile()).rejects.toMatchObject({ name: 'VersionError' });

      // A failed open must not poison retries after the environment changes.
      await deleteDB('notora');
      await expect(storage.getProfile()).resolves.toBeNull();
      openSpy.mockRestore();
    } finally {
      old.close();
      await deleteDB('notora');
    }
  });
});
