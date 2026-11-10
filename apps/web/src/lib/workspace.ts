import * as Y from 'yjs';
import {
  INDEX_KEY, MAX_NOTE_FONT_SIZE, MIN_NOTE_FONT_SIZE, SAVE_IDLE_MS, TEXT_FONT_SIZE,
  noteIntersects, noteKey, pageLayout,
  type ClientMessage, type CursorPosition, type NoteMeta, type NotePatch, type Participant,
  type SessionOptions, type ServerMessage, type TextNote, type WorkspaceSessionApi,
  type WorkspaceSnapshot,
} from '../../../../packages/shared/src/index';
import { getYState, saveYUpdates } from './storage';

const MAX_MESSAGE_BYTES = 12 * 1024 * 1024;
const MAX_NOTE_LENGTH = 1_000_000;

function encode(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function decode(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function lineCount(text: string): number {
  return text.split('\n').length;
}

function validMeta(value: unknown, id: string, pageCount: number): value is NoteMeta {
  if (typeof value !== 'object' || value === null) return false;
  const meta = value as Partial<NoteMeta>;
  return meta.id === id && typeof id === 'string' && id.length > 0 &&
    Number.isSafeInteger(meta.anchorPage) && meta.anchorPage! >= 1 && meta.anchorPage! <= pageCount &&
    typeof meta.x === 'number' && Number.isFinite(meta.x) &&
    typeof meta.y === 'number' && Number.isFinite(meta.y) &&
    Number.isSafeInteger(meta.lineCount) && meta.lineCount! >= 1;
}

function validCursor(cursor: CursorPosition | null): boolean {
  return cursor === null || Number.isFinite(cursor.x) && Number.isFinite(cursor.y) &&
    Math.abs(cursor.x) <= 10_000_000 && Math.abs(cursor.y) <= 10_000_000;
}

function sameSet(a: Set<string>, b: Set<string>): boolean {
  return a.size === b.size && [...a].every(value => b.has(value));
}

export class WorkspaceSession implements WorkspaceSessionApi {
  private readonly index = new Y.Doc();
  private readonly metadata = this.index.getMap<NoteMeta>('notes');
  private readonly layouts: ReturnType<typeof pageLayout>;
  private readonly clientId = crypto.randomUUID();
  private readonly listeners = new Set<() => void>();
  private readonly bodies = new Map<string, Y.Doc>();
  private readonly loadingBodies = new Map<string, Promise<Y.Doc | undefined>>();
  private readonly pendingText = new Map<string, string>();
  private pendingWrites = new Map<string, Uint8Array[]>();
  private savingWrites: Map<string, Uint8Array[]> | null = null;
  private persistRevision = 0;
  private unsentUpdates = new Map<string, Uint8Array[]>();
  private socket: WebSocket | null = null;
  private subscribed: Set<string> | null = null;
  private desired = new Set<string>();
  private editingNoteId: string | null = null;
  private visibleTop = 0;
  private visibleBottom = 0;
  private started = false;
  private destroyed = false;
  private welcomed = false;
  private reconnectDelay = 500;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private flushPromise: Promise<void> | null = null;
  private participants: Participant[] = [];
  private snapshot: WorkspaceSnapshot = {
    notes: [], participants: [], connection: 'offline', saveState: 'saved', error: null,
  };

  constructor(private readonly options: SessionOptions) {
    this.layouts = pageLayout(options.manifest.pages);
    this.index.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin !== 'load') this.queueWrite(INDEX_KEY, update);
      if (origin !== 'remote' && origin !== 'load') this.sendUpdate(INDEX_KEY, update);
    });
    this.metadata.observe(() => {
      this.refreshNotes();
      this.refreshVisibleNotes();
    });
  }

  connect(): void {
    if (this.started || this.destroyed) return;
    this.started = true;
    this.publish({ connection: 'connecting' });
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this.onVisibilityChange);
      window.addEventListener('pagehide', this.onPageHide);
    }
    void this.initialize();
  }

  private async initialize(): Promise<void> {
    try {
      const saved = await getYState(this.options.manifest.id, INDEX_KEY);
      if (this.destroyed) return;
      if (saved) Y.applyUpdate(this.index, saved, 'load');
    } catch {
      this.publish({ saveState: 'error', error: 'Browser storage could not be read.' });
    }
    if (this.destroyed) return;
    this.refreshNotes();
    this.refreshVisibleNotes();
    this.openSocket();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  getSnapshot(): WorkspaceSnapshot {
    return this.snapshot;
  }

  private publish(patch: Partial<WorkspaceSnapshot>): void {
    if (Object.entries(patch).every(([key, value]) => this.snapshot[key as keyof WorkspaceSnapshot] === value)) return;
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }

  private refreshNotes(): void {
    const notes: TextNote[] = [];
    for (const [id, value] of this.metadata) {
      if (!validMeta(value, id, this.options.manifest.pageCount)) continue;
      notes.push({ ...value, text: this.bodies.get(id)?.getText('text').toString() ?? null });
    }
    notes.sort((a, b) => a.anchorPage - b.anchorPage || a.y - b.y || a.x - b.x || a.id.localeCompare(b.id));
    this.publish({ notes });
  }

  setVisibleRange(top: number, bottom: number): void {
    if (!Number.isFinite(top) || !Number.isFinite(bottom)) return;
    this.visibleTop = Math.min(top, bottom);
    this.visibleBottom = Math.max(top, bottom);
    this.refreshVisibleNotes();
  }

  setEditingNote(id: string | null): void {
    if (id !== null && !this.metadata.has(id)) return;
    this.editingNoteId = id;
    if (id !== null) void this.ensureBody(id);
    this.refreshVisibleNotes();
  }

  private refreshVisibleNotes(): void {
    const desired = new Set<string>();
    for (const [id, value] of this.metadata) {
      if (validMeta(value, id, this.options.manifest.pageCount) &&
          noteIntersects(value, this.layouts, this.visibleTop, this.visibleBottom)) {
        desired.add(id);
        void this.ensureBody(id);
      }
    }
    if (this.editingNoteId && this.metadata.has(this.editingNoteId)) desired.add(this.editingNoteId);
    if (sameSet(desired, this.desired)) return;
    this.desired = desired;
    this.sendSubscriptions();
  }

  private sendSubscriptions(): void {
    if (!this.welcomed || !this.isOpen()) return;
    if (this.subscribed && sameSet(this.desired, this.subscribed)) return;
    this.subscribed = new Set(this.desired);
    this.send({ type: 'subscribe', keys: [...this.desired].map(noteKey) });
  }

  createNote(anchorPage: number, x: number, y: number): string {
    if (!Number.isSafeInteger(anchorPage) || anchorPage < 1 || anchorPage > this.options.manifest.pageCount ||
        !Number.isFinite(x) || !Number.isFinite(y)) throw new Error('Invalid note position.');
    const id = crypto.randomUUID();
    const doc = new Y.Doc();
    this.attachBody(id, doc);
    this.bodies.set(id, doc);
    this.editingNoteId = id;
    this.metadata.set(id, { id, anchorPage, x, y, lineCount: 1, fontSize: TEXT_FONT_SIZE });
    this.refreshNotes();
    this.refreshVisibleNotes();
    return id;
  }

  setNoteText(id: string, text: string): void {
    if (!this.metadata.has(id) || typeof text !== 'string') return;
    if (text.length > MAX_NOTE_LENGTH) {
      this.publish({ error: 'A note can contain at most 1,000,000 characters.' });
      return;
    }
    this.editingNoteId = id;
    this.refreshVisibleNotes();
    const doc = this.bodies.get(id);
    if (!doc) {
      this.pendingText.set(id, text);
      void this.ensureBody(id);
      return;
    }
    const ytext = doc.getText('text');
    const before = ytext.toString();
    if (before === text) return;
    let start = 0;
    while (start < before.length && start < text.length && before[start] === text[start]) start++;
    let oldEnd = before.length;
    let newEnd = text.length;
    while (oldEnd > start && newEnd > start && before[oldEnd - 1] === text[newEnd - 1]) {
      oldEnd--;
      newEnd--;
    }
    doc.transact(() => {
      if (oldEnd > start) ytext.delete(start, oldEnd - start);
      if (newEnd > start) ytext.insert(start, text.slice(start, newEnd));
    }, 'local');
  }

  updateNote(id: string, patch: NotePatch): void {
    const previous = this.metadata.get(id);
    if (!previous || !patch || typeof patch !== 'object') return;
    const changes: NotePatch = {};
    if (Object.hasOwn(patch, 'x')) {
      if (typeof patch.x !== 'number' || !Number.isFinite(patch.x)) return;
      if (patch.x !== previous.x) changes.x = patch.x;
    }
    if (Object.hasOwn(patch, 'y')) {
      if (typeof patch.y !== 'number' || !Number.isFinite(patch.y)) return;
      if (patch.y !== previous.y) changes.y = patch.y;
    }
    if (Object.hasOwn(patch, 'fontSize')) {
      if (typeof patch.fontSize !== 'number' || !Number.isFinite(patch.fontSize) ||
          patch.fontSize < MIN_NOTE_FONT_SIZE || patch.fontSize > MAX_NOTE_FONT_SIZE) return;
      if (patch.fontSize !== previous.fontSize) changes.fontSize = patch.fontSize;
    }
    if (Object.keys(changes).length === 0) return;
    // Always merge against the current index entry so position/font edits retain
    // the latest line count and old records without fontSize remain readable.
    this.metadata.set(id, { ...previous, ...changes });
  }

  deleteNote(id: string): void {
    this.deleteNotes([id]);
  }

  deleteNotes(ids: string[]): void {
    const unique = [...new Set(ids)].filter(id => this.metadata.has(id));
    if (unique.length === 0) return;
    this.index.transact(() => {
      for (const id of unique) this.metadata.delete(id);
    }, 'local');
    for (const id of unique) {
      this.pendingText.delete(id);
      this.unsentUpdates.delete(noteKey(id));
      this.bodies.get(id)?.destroy();
      this.bodies.delete(id);
      if (this.editingNoteId === id) this.editingNoteId = null;
    }
    this.refreshVisibleNotes();
  }

  private attachBody(id: string, doc: Y.Doc): void {
    doc.on('update', (update: Uint8Array, origin: unknown) => {
      const key = noteKey(id);
      if (origin !== 'load') this.queueWrite(key, update);
      if (origin !== 'remote' && origin !== 'load') this.sendUpdate(key, update);
      this.syncLineCount(id, doc);
      this.refreshNotes();
    });
  }

  private syncLineCount(id: string, doc: Y.Doc): void {
    const previous = this.metadata.get(id);
    if (!previous) return;
    const lines = lineCount(doc.getText('text').toString());
    if (previous.lineCount !== lines) this.metadata.set(id, { ...previous, lineCount: lines });
  }

  private ensureBody(id: string): Promise<Y.Doc | undefined> {
    const existing = this.bodies.get(id);
    if (existing) return Promise.resolve(existing);
    const inProgress = this.loadingBodies.get(id);
    if (inProgress) return inProgress;
    const task = (async () => {
      let saved: Uint8Array | undefined;
      try {
        saved = await this.readMergedState(noteKey(id));
      } catch {
        this.publish({ saveState: 'error', error: 'Browser storage could not be read.' });
      }
      if (this.destroyed || !this.metadata.has(id)) return undefined;
      const doc = new Y.Doc();
      if (saved) Y.applyUpdate(doc, saved, 'load');
      this.attachBody(id, doc);
      this.bodies.set(id, doc);
      const edit = this.pendingText.get(id);
      if (edit !== undefined) {
        this.pendingText.delete(id);
        this.setNoteText(id, edit);
      }
      this.refreshNotes();
      if (this.welcomed && this.subscribed?.has(id)) this.sendState(noteKey(id), Y.encodeStateAsUpdate(doc));
      return doc;
    })().catch(() => {
      this.publish({ error: 'This note could not be loaded.' });
      return undefined;
    }).finally(() => { this.loadingBodies.delete(id); });
    this.loadingBodies.set(id, task);
    return task;
  }

  setCursor(cursor: CursorPosition | null): void {
    if (!validCursor(cursor)) return;
    this.send({ type: 'cursor', cursor });
  }

  private visibleParticipants(participants: Participant[]): Participant[] {
    return participants.map(participant => participant.clientId === this.clientId
      ? { ...participant, cursor: null } : participant);
  }

  activity(): void {
    if (this.pendingWrites.size > 0) this.scheduleSave();
  }

  private queueWrite(key: string, update: Uint8Array): void {
    const pending = this.pendingWrites.get(key) ?? [];
    pending.push(update);
    this.pendingWrites.set(key, pending);
    if (this.snapshot.saveState !== 'saving') this.publish({ saveState: 'pending', error: null });
    this.scheduleSave();
  }

  private async readMergedState(key: string): Promise<Uint8Array | undefined> {
    // A flush may move updates out of pendingWrites while an IndexedDB read is
    // waiting. Retry if it committed during that read, then include in-flight
    // and still-pending updates in the returned binary state.
    for (;;) {
      const revision = this.persistRevision;
      const saved = await getYState(this.options.manifest.id, key);
      if (revision !== this.persistRevision) continue;
      const updates = [
        ...(saved ? [saved] : []),
        ...(this.savingWrites?.get(key) ?? []),
        ...(this.pendingWrites.get(key) ?? []),
      ];
      return updates.length ? Y.mergeUpdates(updates) : undefined;
    }
  }

  private scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.flush().catch(() => undefined);
    }, SAVE_IDLE_MS);
  }

  async flush(): Promise<void> {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    if (this.flushPromise) {
      await this.flushPromise;
      if (this.pendingWrites.size > 0) await this.flush();
      return;
    }
    if (this.pendingWrites.size === 0) return;
    const batch = this.pendingWrites;
    this.pendingWrites = new Map();
    this.savingWrites = batch;
    this.publish({ saveState: 'saving', error: null });
    const task = saveYUpdates(this.options.manifest.id, batch);
    this.flushPromise = task;
    try {
      await task;
      this.persistRevision++;
      this.publish({ saveState: this.pendingWrites.size > 0 ? 'pending' : 'saved' });
    } catch (error) {
      for (const [key, updates] of batch) {
        this.pendingWrites.set(key, [...updates, ...(this.pendingWrites.get(key) ?? [])]);
      }
      this.publish({ saveState: 'error', error: 'Browser storage could not save changes.' });
      // Keep the binary updates reachable after a workspace unmount. A later
      // successful IndexedDB transaction can still save them during this page.
      this.scheduleSave();
      throw error;
    } finally {
      this.savingWrites = null;
      this.flushPromise = null;
    }
    if (this.pendingWrites.size > 0) this.scheduleSave();
  }

  private openSocket(): void {
    if (this.destroyed || typeof WebSocket === 'undefined') return;
    const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(`${scheme}//${location.host}/ws`);
    this.socket = socket;
    this.welcomed = false;
    this.subscribed = null;
    this.publish({ connection: 'connecting' });
    socket.onopen = () => {
      if (this.socket !== socket || this.destroyed) return;
      this.send({
        type: 'join', documentId: this.options.manifest.id,
        accessToken: this.options.accessToken, ownerToken: this.options.ownerToken,
        clientId: this.clientId, name: this.options.profile.name,
      });
    };
    socket.onmessage = event => {
      if (this.socket !== socket || typeof event.data !== 'string' || event.data.length > MAX_MESSAGE_BYTES) return;
      let message: ServerMessage;
      try { message = JSON.parse(event.data) as ServerMessage; } catch { return; }
      void this.handleMessage(message).catch(() => {
        this.publish({ error: 'A collaboration update could not be applied.' });
      });
    };
    socket.onerror = () => { /* onclose handles the connection transition */ };
    socket.onclose = () => {
      if (this.socket !== socket || this.destroyed) return;
      this.socket = null;
      this.welcomed = false;
      this.subscribed = null;
      this.participants = [];
      this.publish({ connection: 'offline', participants: [] });
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        this.openSocket();
      }, this.reconnectDelay);
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, 10_000);
    };
  }

  private async handleMessage(message: ServerMessage): Promise<void> {
    if (this.destroyed || !message || typeof message !== 'object') return;
    switch (message.type) {
      case 'welcome':
        this.welcomed = true;
        this.reconnectDelay = 500;
        this.participants = this.visibleParticipants(message.participants);
        this.publish({
          connection: 'online', participants: this.participants,
          ...(this.snapshot.saveState === 'error' ? {} : { error: null }),
        });
        this.sendState(INDEX_KEY, Y.encodeStateAsUpdate(this.index));
        this.sendSubscriptions();
        for (const [id, doc] of this.bodies) this.sendState(noteKey(id), Y.encodeStateAsUpdate(doc));
        for (const [key, updates] of this.unsentUpdates) {
          this.sendUpdate(key, Y.mergeUpdates(updates));
        }
        this.unsentUpdates.clear();
        break;
      case 'participants':
        this.participants = this.visibleParticipants(message.participants);
        this.publish({ participants: this.participants });
        break;
      case 'cursor':
        this.participants = this.participants.map(participant =>
          participant.clientId === message.clientId ?
            { ...participant, cursor: participant.clientId === this.clientId ? null : message.cursor } : participant);
        this.publish({ participants: this.participants });
        break;
      case 'update':
        this.applyRemote(message.key, decode(message.update));
        break;
      case 'need-state':
        await Promise.all(message.keys.map(key => this.sendStoredState(key)));
        break;
      case 'error':
        this.publish({ error: message.message });
        break;
    }
  }

  private applyRemote(key: string, update: Uint8Array): void {
    if (key === INDEX_KEY) {
      Y.applyUpdate(this.index, update, 'remote');
      return;
    }
    if (!key.startsWith('note:')) return;
    const id = key.slice(5);
    const body = this.bodies.get(id);
    if (body) {
      Y.applyUpdate(body, update, 'remote');
    } else {
      // The owner receives guest changes even for notes outside the viewport.
      // Keep the binary update for a delayed IndexedDB merge without opening a Y.Doc.
      this.queueWrite(key, update);
    }
  }

  private async sendStoredState(key: string): Promise<void> {
    if (key !== INDEX_KEY && !key.startsWith('note:')) return;
    const id = key.startsWith('note:') ? key.slice(5) : '';
    if (id && !this.metadata.has(id)) return;
    const current = key === INDEX_KEY ? this.index : this.bodies.get(id);
    const updates: Uint8Array[] = [];
    if (current) updates.push(Y.encodeStateAsUpdate(current));
    const saved = await this.readMergedState(key).catch(() => undefined);
    if (saved) updates.push(saved);
    if (updates.length > 0) this.sendState(key, Y.mergeUpdates(updates));
  }

  private isOpen(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  private send(message: ClientMessage): boolean {
    if (!this.isOpen()) return false;
    this.socket!.send(JSON.stringify(message));
    return true;
  }

  private sendState(key: string, update: Uint8Array): void {
    this.send({ type: 'state', key, update: encode(update) });
  }

  private sendUpdate(key: string, update: Uint8Array): void {
    if (this.welcomed && this.send({ type: 'update', key, update: encode(update) })) return;
    const pending = this.unsentUpdates.get(key) ?? [];
    pending.push(update);
    this.unsentUpdates.set(key, pending);
  }

  private readonly onVisibilityChange = (): void => {
    if (document.visibilityState === 'hidden') void this.flush().catch(() => undefined);
  };

  private readonly onPageHide = (): void => {
    void this.flush().catch(() => undefined);
  };

  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.saveTimer) clearTimeout(this.saveTimer);
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.onVisibilityChange);
      window.removeEventListener('pagehide', this.onPageHide);
    }
    this.socket?.close();
    this.socket = null;
    try { await this.flush(); } catch { /* saveState retains the error */ }
    for (const doc of this.bodies.values()) doc.destroy();
    this.index.destroy();
    this.listeners.clear();
  }
}
