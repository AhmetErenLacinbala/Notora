import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import * as Y from 'yjs';
import type { Camera, OwnedProject, Profile } from '../../../../packages/shared/src/index';

interface NotoraDatabase extends DBSchema {
  profile: { key: string; value: Profile };
  ownedProjects: { key: string; value: OwnedProject };
  cameras: { key: string; value: Camera };
  pages: { key: string; value: Uint8Array };
  yUpdates: { key: string; value: Uint8Array };
}

let databasePromise: Promise<IDBPDatabase<NotoraDatabase>> | undefined;

function database(): Promise<IDBPDatabase<NotoraDatabase>> {
  databasePromise ??= openDB<NotoraDatabase>('notora', 1, {
    upgrade(db) {
      db.createObjectStore('profile');
      db.createObjectStore('ownedProjects');
      db.createObjectStore('cameras');
      db.createObjectStore('pages');
      db.createObjectStore('yUpdates');
    },
  });
  return databasePromise;
}

export async function getProfile(): Promise<Profile | null> {
  return (await (await database()).get('profile', 'current')) ?? null;
}

export async function saveProfile(profile: Profile): Promise<void> {
  await (await database()).put('profile', profile, 'current');
}

export async function listOwnedProjects(): Promise<OwnedProject[]> {
  const projects = await (await database()).getAll('ownedProjects');
  return projects.sort((a, b) => b.lastOpenedAt - a.lastOpenedAt || b.createdAt - a.createdAt);
}

export async function saveOwnedProject(project: OwnedProject): Promise<void> {
  await (await database()).put('ownedProjects', project, project.documentId);
}

export async function getOwnedProject(id: string): Promise<OwnedProject | undefined> {
  return (await database()).get('ownedProjects', id);
}

export async function loadCamera(id: string): Promise<Camera | undefined> {
  return (await database()).get('cameras', id);
}

export async function saveCamera(id: string, camera: Camera): Promise<void> {
  await (await database()).put('cameras', camera, id);
}

export async function getCachedPage(id: string, version: string, page: number): Promise<Uint8Array | undefined> {
  return (await database()).get('pages', pageCacheKey(id, version, page));
}

export async function saveCachedPage(id: string, version: string, page: number, bytes: Uint8Array): Promise<void> {
  await (await database()).put('pages', bytes, pageCacheKey(id, version, page));
}

function pageCacheKey(id: string, version: string, page: number): string {
  return `${id}\u0000${version}\u0000${page}`;
}

function yKey(documentId: string, key: string): string {
  return `${documentId}\u0000${key}`;
}

export async function getYState(documentId: string, key: string): Promise<Uint8Array | undefined> {
  return (await database()).get('yUpdates', yKey(documentId, key));
}

// Merge in one IndexedDB transaction so two tabs cannot replace each other's Yjs changes.
// Values remain Yjs binary updates; loading a body does not require JSON reconstruction.
export async function saveYUpdates(documentId: string, updates: Map<string, Uint8Array[]>): Promise<void> {
  if (updates.size === 0) return;
  const db = await database();
  const tx = db.transaction('yUpdates', 'readwrite');
  for (const [key, incoming] of updates) {
    if (incoming.length === 0) continue;
    const storageKey = yKey(documentId, key);
    const prior = await tx.store.get(storageKey);
    await tx.store.put(Y.mergeUpdates(prior ? [prior, ...incoming] : incoming), storageKey);
  }
  await tx.done;
}
