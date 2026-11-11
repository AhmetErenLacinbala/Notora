import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import * as Y from 'yjs';
import type { Camera, DocumentManifest, OwnedProject, Profile, UploadResult } from '../../../../packages/shared/src/index';

export interface LocalDocumentRecord {
  id: string;
  title: string;
  contentHash: string;
  size: number;
  createdAt: number;
  lastOpenedAt: number;
  storageId: string;
  manifest?: DocumentManifest;
  upload?: UploadResult;
}

interface NotoraDatabase extends DBSchema {
  profile: { key: string; value: Profile };
  ownedProjects: { key: string; value: OwnedProject };
  cameras: { key: string; value: Camera };
  pages: { key: string; value: Uint8Array };
  yUpdates: { key: string; value: Uint8Array };
  localDocuments: { key: string; value: LocalDocumentRecord };
  localBlobs: { key: string; value: Blob };
}

let databasePromise: Promise<IDBPDatabase<NotoraDatabase>> | undefined;

function database(): Promise<IDBPDatabase<NotoraDatabase>> {
  databasePromise ??= openDB<NotoraDatabase>('notora', 2, {
    upgrade(db, oldVersion) {
      if (oldVersion < 1) {
        db.createObjectStore('profile');
        db.createObjectStore('ownedProjects');
        db.createObjectStore('cameras');
        db.createObjectStore('pages');
        db.createObjectStore('yUpdates');
      }
      if (oldVersion < 2) {
        db.createObjectStore('localDocuments');
        db.createObjectStore('localBlobs');
      }
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

export async function listLocalDocuments(): Promise<LocalDocumentRecord[]> {
  const documents = await (await database()).getAll('localDocuments');
  return documents.sort((a, b) => b.lastOpenedAt - a.lastOpenedAt || b.createdAt - a.createdAt);
}

export async function getLocalDocument(id: string): Promise<LocalDocumentRecord | undefined> {
  return (await database()).get('localDocuments', id);
}

export async function importLocalBlob(proposal: LocalDocumentRecord, blob: Blob): Promise<LocalDocumentRecord> {
  const db = await database();
  const tx = db.transaction(['localDocuments', 'localBlobs'], 'readwrite');
  const documents = tx.objectStore('localDocuments');
  const blobs = tx.objectStore('localBlobs');
  const existing = await documents.get(proposal.id);
  const record = existing ? { ...existing, lastOpenedAt: proposal.lastOpenedAt } : proposal;
  if (!(await blobs.count(proposal.id))) await blobs.put(blob, proposal.id);
  await documents.put(record, proposal.id);
  await tx.done;
  return record;
}

export async function updateLocalManifest(id: string, manifest: DocumentManifest): Promise<LocalDocumentRecord> {
  const db = await database();
  const tx = db.transaction('localDocuments', 'readwrite');
  const record = await tx.store.get(id);
  if (!record) throw new Error('This local PDF is unavailable.');
  const updated = { ...record, manifest, lastOpenedAt: Date.now() };
  await tx.store.put(updated, id);
  await tx.done;
  return updated;
}

export async function saveLocalUploadAndOwned(record: LocalDocumentRecord, project: OwnedProject): Promise<LocalDocumentRecord> {
  if (!record.upload) throw new Error('The shared PDF mapping is incomplete.');
  const db = await database();
  const tx = db.transaction(['localDocuments', 'ownedProjects'], 'readwrite');
  const documents = tx.objectStore('localDocuments');
  const latest = await documents.get(record.id);
  if (latest?.upload && latest.upload.documentId !== record.upload.documentId) {
    await tx.done;
    return latest;
  }
  const updated = {
    ...latest, ...record,
    manifest: record.manifest ?? latest?.manifest,
    lastOpenedAt: Math.max(record.lastOpenedAt, latest?.lastOpenedAt ?? 0),
  };
  await documents.put(updated, record.id);
  await tx.objectStore('ownedProjects').put(project, project.documentId);
  await tx.done;
  return updated;
}

export async function getLocalBlob(id: string): Promise<Blob | undefined> {
  return (await database()).get('localBlobs', id);
}

// Keep the legacy remote notes while adopting their ID as the local record's
// storage ID. This copies and merges rather than deleting either set of data.
export async function mergeWorkspaceStorage(fromId: string, toId: string): Promise<void> {
  if (fromId === toId) return;
  const db = await database();
  const tx = db.transaction(['yUpdates', 'cameras'], 'readwrite');
  const updates = tx.objectStore('yUpdates');
  const fromPrefix = `${fromId}\u0000`;
  let cursor = await updates.openCursor(IDBKeyRange.bound(fromPrefix, `${fromPrefix}\uffff`));
  while (cursor) {
    const key = String(cursor.key);
    const target = `${toId}\u0000${key.slice(fromPrefix.length)}`;
    const prior = await updates.get(target);
    await updates.put(prior ? Y.mergeUpdates([prior, cursor.value]) : cursor.value, target);
    cursor = await cursor.continue();
  }
  const cameras = tx.objectStore('cameras');
  const localCamera = await cameras.get(fromId);
  if (localCamera) await cameras.put(localCamera, toId);
  await tx.done;
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
