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

const STORAGE_WAIT_MS = 10_000;

export class StorageConnectionError extends Error {
  constructor(readonly reason: 'blocked' | 'timeout') {
    super(reason === 'blocked'
      ? 'Close other Notora tabs, then try again. Your saved PDFs and notes are still in this browser.'
      : 'Browser storage is not responding. Close other Notora tabs, then try again. Your saved PDFs and notes are still in this browser.');
    this.name = 'StorageConnectionError';
  }
}

let databasePromise: Promise<IDBPDatabase<NotoraDatabase>> | undefined;
let upgradeBlocked = false;
const blockedListeners = new Set<() => void>();

function resetDatabaseConnection(request: Promise<IDBPDatabase<NotoraDatabase>>): void {
  if (databasePromise !== request) return;
  databasePromise = undefined;
  upgradeBlocked = false;
}

function waitForStorage<T>(operation: Promise<T>, watchBlocked = false): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const finish = (settle: () => void) => {
      if (settled) return;
      settled = true;
      if (timeout !== undefined) clearTimeout(timeout);
      blockedListeners.delete(onBlocked);
      settle();
    };
    const onBlocked = () => finish(() => reject(new StorageConnectionError('blocked')));
    timeout = setTimeout(
      () => finish(() => reject(new StorageConnectionError(watchBlocked && upgradeBlocked ? 'blocked' : 'timeout'))),
      STORAGE_WAIT_MS,
    );
    if (watchBlocked) blockedListeners.add(onBlocked);
    operation.then(
      value => finish(() => resolve(value)),
      error => finish(() => reject(error)),
    );
  });
}

function database(): Promise<IDBPDatabase<NotoraDatabase>> {
  if (!databasePromise) {
    let request!: Promise<IDBPDatabase<NotoraDatabase>>;
    let connection: IDBPDatabase<NotoraDatabase> | undefined;
    request = openDB<NotoraDatabase>('notora', 2, {
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
      blocked() {
        upgradeBlocked = true;
        for (const listener of [...blockedListeners]) listener();
      },
      blocking() {
        // Release this tab's connection when a later app version needs an upgrade.
        connection?.close();
        void request.then(db => db.close());
        resetDatabaseConnection(request);
      },
      terminated() {
        resetDatabaseConnection(request);
      },
    });
    databasePromise = request;
    // A timed-out or blocked caller must not start a second open request.
    // Keep this request so a later successful upgrade is adopted on retry.
    void request.then(
      db => {
        if (databasePromise === request) {
          connection = db;
          upgradeBlocked = false;
        } else {
          db.close();
        }
      },
      () => resetDatabaseConnection(request),
    );
  }
  return waitForStorage(databasePromise, true);
}

export async function getProfile(): Promise<Profile | null> {
  return (await waitForStorage(database().then(db => db.get('profile', 'current')))) ?? null;
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

// Old guest page caches are reproducible from the server. Keep annotation
// records: an older offline edit may still exist only in that browser.
export async function clearGuestPageCache(documentId: string): Promise<void> {
  const db = await database();
  const tx = db.transaction(['ownedProjects', 'pages', 'cameras'], 'readwrite');
  if (await tx.objectStore('ownedProjects').get(documentId)) {
    await tx.done;
    return;
  }
  const pages = tx.objectStore('pages');
  const prefix = `${documentId}\u0000`;
  let cursor = await pages.openKeyCursor(IDBKeyRange.bound(prefix, `${prefix}\uffff`));
  while (cursor) {
    await pages.delete(cursor.primaryKey);
    cursor = await cursor.continue();
  }
  await tx.objectStore('cameras').delete(documentId);
  await tx.done;
}
