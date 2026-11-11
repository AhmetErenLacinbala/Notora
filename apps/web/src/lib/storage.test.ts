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

describe('legacy guest cache cleanup', () => {
  it('removes only reproducible guest pages and camera, preserving owned data and old annotations', async () => {
    const storage = await import('./storage');
    const profile: Profile = { id: 'local-reader', name: 'Reader' };
    const owner: OwnedProject = {
      documentId: 'owner-doc', accessToken: 'access', ownerToken: 'owner',
      title: 'Owned PDF', createdAt: 1, lastOpenedAt: 2,
    };
    const camera: Camera = { scrollLeft: 10, scrollTop: 20, zoom: 1 };
    const page = new Uint8Array([37, 80, 68, 70]);
    const legacyNote = new Uint8Array([1, 2, 3]);
    try {
      await storage.saveProfile(profile);
      await storage.saveOwnedProject(owner);
      await storage.saveCachedPage('guest-doc', 'v1', 1, page);
      await storage.saveCachedPage('guest-doc', 'v2', 2, page);
      await storage.saveCachedPage('guest-doc-other', 'v1', 1, page);
      await storage.saveCachedPage(owner.documentId, 'v1', 1, page);
      await storage.saveCamera('guest-doc', camera);
      await storage.saveCamera(owner.documentId, camera);
      const db = await openDB('notora', 2);
      await db.put('yUpdates', legacyNote, 'guest-doc\u0000note:old');
      db.close();
      await storage.clearGuestPageCache('guest-doc');
      await storage.clearGuestPageCache(owner.documentId);
      expect(await storage.getCachedPage('guest-doc', 'v1', 1)).toBeUndefined();
      expect(await storage.getCachedPage('guest-doc', 'v2', 2)).toBeUndefined();
      expect(await storage.loadCamera('guest-doc')).toBeUndefined();
      expect(await storage.getCachedPage('guest-doc-other', 'v1', 1)).toEqual(page);
      expect(await storage.getCachedPage(owner.documentId, 'v1', 1)).toEqual(page);
      expect(await storage.loadCamera(owner.documentId)).toEqual(camera);
      expect(await storage.getYState('guest-doc', 'note:old')).toEqual(legacyNote);
      expect(await storage.getProfile()).toEqual(profile);
      expect(await storage.getOwnedProject(owner.documentId)).toEqual(owner);
    } finally {
      await deleteDB('notora');
    }
  });
});
