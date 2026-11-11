import * as Y from 'yjs';
import {
  INDEX_KEY, MAX_DRAWING_SEGMENTS, MAX_NOTE_FONT_SIZE, MAX_PREVIEW_POINTS,
  MIN_NOTE_FONT_SIZE, SAVE_IDLE_MS, TEXT_FONT_SIZE,
  drawingKey, noteIntersects, noteKey, pageLayout,
  type ClientMessage, type CubicBezier, type CursorPosition, type DrawingMeta,
  type DrawingPreviewPacket, type DrawingShape, type NoteMeta, type NotePatch, type Participant,
  type RemoteDrawingPreview, type SessionOptions, type ServerMessage, type TextNote, type WorkspaceSessionApi,
  type WorkspaceSnapshot,
} from '../../../../packages/shared/src/index';
import { decodeCurves, drawingBounds, encodeCurves } from './drawingGeometry';
import { getYState, saveYUpdates } from './storage';

const MAX_MESSAGE_BYTES = 12 * 1024 * 1024;
const MAX_NOTE_LENGTH = 1_000_000;
const MAX_PREVIEW_BUFFERED_POINTS = 8192;
const PREVIEW_IDLE_MS = 8_000;
const MAX_COORDINATE = 10_000_000;

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
    Math.abs(cursor.x) <= MAX_COORDINATE && Math.abs(cursor.y) <= MAX_COORDINATE;
}

function validDrawingMeta(value: unknown, id: string, pageCount: number): value is DrawingMeta {
  if (!value || typeof value !== 'object' || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) return false;
  const meta = value as Partial<DrawingMeta>;
  const bounds = meta.bounds;
  return meta.id === id && (meta.kind === 'stroke' || meta.kind === 'arrow') &&
    Number.isSafeInteger(meta.anchorPage) && meta.anchorPage! >= 1 && meta.anchorPage! <= pageCount &&
    typeof meta.x === 'number' && Number.isFinite(meta.x) && Math.abs(meta.x) <= MAX_COORDINATE &&
    typeof meta.y === 'number' && Number.isFinite(meta.y) && Math.abs(meta.y) <= MAX_COORDINATE &&
    typeof meta.width === 'number' && Number.isFinite(meta.width) && meta.width > 0 && meta.width <= 256 &&
    !!bounds && [bounds.minX, bounds.minY, bounds.maxX, bounds.maxY].every(
      number => typeof number === 'number' && Number.isFinite(number) && Math.abs(number) <= MAX_COORDINATE) &&
    bounds.minX <= bounds.maxX && bounds.minY <= bounds.maxY;
}

function validPreview(value: unknown, pageCount: number): value is DrawingPreviewPacket {
  if (!value || typeof value !== 'object') return false;
  const packet = value as Partial<DrawingPreviewPacket>;
  return validDrawingMeta({ ...packet, bounds: { minX: 0, minY: 0, maxX: 0, maxY: 0 } }, packet.id ?? '', pageCount) &&
    Number.isSafeInteger(packet.seq) && packet.seq! >= 0 && packet.seq! <= 1_000_000 &&
    Array.isArray(packet.points) && packet.points.length > 0 && packet.points.length <= MAX_PREVIEW_POINTS &&
    packet.points.every(point => !!point && typeof point === 'object' && validCursor(point));
}

function drawingIntersects(meta: DrawingMeta, layouts: ReturnType<typeof pageLayout>, top: number, bottom: number): boolean {
  const page = layouts[meta.anchorPage - 1];
  if (!page) return false;
  const drawingTop = page.y + meta.y + meta.bounds.minY;
  const drawingBottom = page.y + meta.y + meta.bounds.maxY;
  return drawingTop <= bottom && drawingBottom >= top;
}

function sameSet(a: Set<string>, b: Set<string>): boolean {
  return a.size === b.size && [...a].every(value => b.has(value));
}

export class WorkspaceSession implements WorkspaceSessionApi {
  private readonly index = new Y.Doc();
  private readonly metadata = this.index.getMap<NoteMeta>('notes');
  private readonly drawingMetadata = this.index.getMap<DrawingMeta>('drawings');
  private readonly layouts: ReturnType<typeof pageLayout>;
  private readonly storageId: string;
  private readonly clientId = crypto.randomUUID();
  private readonly listeners = new Set<() => void>();
  private readonly bodies = new Map<string, Y.Doc>();
  private readonly loadingBodies = new Map<string, Promise<Y.Doc | undefined>>();
  private readonly drawingBodies = new Map<string, Y.Doc>();
  private readonly loadingDrawingBodies = new Map<string, Promise<Y.Doc | undefined>>();
  private readonly decodedCurves = new WeakMap<Uint8Array, CubicBezier[] | null>();
  private readonly previewByClient = new Map<string, { preview: RemoteDrawingPreview; updatedAt: number }>();
  private previewTimer: ReturnType<typeof setInterval> | null = null;
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
    notes: [], drawings: [], drawingPreviews: [], participants: [], connection: 'offline', saveState: 'saved', error: null,
  };

  constructor(private readonly options: SessionOptions) {
    this.layouts = pageLayout(options.manifest.pages);
    this.storageId = options.storageId ?? options.manifest.id;
    if (options.localOnly) this.snapshot = { ...this.snapshot, connection: 'local' };
    this.index.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin !== 'load') this.queueWrite(INDEX_KEY, update);
      if (origin !== 'remote' && origin !== 'load') this.sendUpdate(INDEX_KEY, update);
    });
    this.metadata.observe(() => {
      this.refreshNotes();
      this.refreshVisibleNotes();
    });
    this.drawingMetadata.observe(() => {
      for (const [id, body] of this.drawingBodies) {
        if (this.drawingMetadata.has(id)) continue;
        body.destroy();
        this.drawingBodies.delete(id);
        this.unsentUpdates.delete(drawingKey(id));
        this.pendingWrites.delete(drawingKey(id));
      }
      this.refreshDrawings();
      this.refreshVisibleNotes();
    });
  }

  connect(): void {
    if (this.started || this.destroyed) return;
    this.started = true;
    this.publish({ connection: this.options.localOnly ? 'local' : 'connecting' });
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this.onVisibilityChange);
      window.addEventListener('pagehide', this.onPageHide);
    }
    void this.initialize();
  }

  private async initialize(): Promise<void> {
    try {
      const saved = await getYState(this.storageId, INDEX_KEY);
      if (this.destroyed) return;
      if (saved) Y.applyUpdate(this.index, saved, 'load');
    } catch {
      this.publish({ saveState: 'error', error: 'Browser storage could not be read.' });
    }
    if (this.destroyed) return;
    this.refreshNotes();
    this.refreshDrawings();
    this.refreshVisibleNotes();
    if (!this.options.localOnly) this.openSocket();
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

  private refreshDrawings(): void {
    const drawings: DrawingShape[] = [];
    let clearedPreview = false;
    for (const [id, value] of this.drawingMetadata) {
      if (!validDrawingMeta(value, id, this.options.manifest.pageCount)) continue;
      const encoded = this.drawingBodies.get(id)?.getMap('geometry').get('curves');
      const curves = this.curvesFor(encoded);
      drawings.push({ ...value, curves });
      if (curves) {
        for (const [clientId, state] of this.previewByClient) {
          if (state.preview.id === id) {
            this.previewByClient.delete(clientId);
            clearedPreview = true;
          }
        }
      }
    }
    if (clearedPreview) this.publishPreviews();
    drawings.sort((a, b) => a.anchorPage - b.anchorPage || a.y - b.y || a.x - b.x || a.id.localeCompare(b.id));
    this.publish({ drawings });
  }

  private curvesFor(encoded: unknown): CubicBezier[] | null {
    if (!(encoded instanceof Uint8Array)) return null;
    if (this.decodedCurves.has(encoded)) return this.decodedCurves.get(encoded) ?? null;
    const curves = decodeCurves(encoded);
    this.decodedCurves.set(encoded, curves);
    return curves;
  }

  private publishPreviews(): void {
    this.publish({ drawingPreviews: [...this.previewByClient.values()].map(state => state.preview) });
    if (this.previewByClient.size === 0 && this.previewTimer) {
      clearInterval(this.previewTimer);
      this.previewTimer = null;
    } else if (this.previewByClient.size > 0 && !this.previewTimer) {
      this.previewTimer = setInterval(() => {
        const now = Date.now();
        let changed = false;
        for (const [clientId, state] of this.previewByClient) {
          if (now - state.updatedAt > PREVIEW_IDLE_MS) {
            this.previewByClient.delete(clientId);
            changed = true;
          }
        }
        if (changed) this.publishPreviews();
      }, 1_000);
    }
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
        desired.add(noteKey(id));
        void this.ensureBody(id);
      }
    }
    for (const [id, value] of this.drawingMetadata) {
      if (validDrawingMeta(value, id, this.options.manifest.pageCount) &&
          drawingIntersects(value, this.layouts, this.visibleTop, this.visibleBottom)) {
        desired.add(drawingKey(id));
        void this.ensureDrawingBody(id);
      }
    }
    if (this.editingNoteId && this.metadata.has(this.editingNoteId)) desired.add(noteKey(this.editingNoteId));
    if (sameSet(desired, this.desired)) return;
    this.desired = desired;
    this.sendSubscriptions();
  }

  private sendSubscriptions(): void {
    if (!this.welcomed || !this.isOpen()) return;
    if (this.subscribed && sameSet(this.desired, this.subscribed)) return;
    this.subscribed = new Set(this.desired);
    this.send({ type: 'subscribe', keys: [...this.desired] });
  }

  createDrawing(meta: Omit<DrawingMeta, 'id'>, curves: CubicBezier[], providedId?: string): string {
    const id = providedId ?? crypto.randomUUID();
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(id) || this.drawingMetadata.has(id)) {
      throw new Error('Invalid drawing ID.');
    }
    if (!validDrawingMeta({ ...meta, id }, id, this.options.manifest.pageCount) ||
        !Array.isArray(curves) || curves.length < 1 || curves.length > MAX_DRAWING_SEGMENTS ||
        !curves.every(curve => Array.isArray(curve) && curve.length === 8 && curve.every(
          coordinate => Number.isFinite(coordinate) && Math.abs(coordinate) <= MAX_COORDINATE))) {
      throw new Error('Invalid drawing.');
    }
    const bytes = encodeCurves(curves);
    const canonical = { ...meta, bounds: drawingBounds(decodeCurves(bytes)!, meta.width, meta.kind) };
    if (!validDrawingMeta({ ...canonical, id }, id, this.options.manifest.pageCount)) {
      throw new Error('Invalid drawing bounds.');
    }
    const doc = new Y.Doc();
    this.attachDrawingBody(id, doc);
    this.drawingBodies.set(id, doc);
    this.drawingMetadata.set(id, { ...canonical, id });
    doc.transact(() => {
      doc.getMap('geometry').set('version', 1);
      doc.getMap('geometry').set('curves', bytes);
    }, 'local');
    this.refreshDrawings();
    this.refreshVisibleNotes();
    return id;
  }

  updateDrawing(id: string, patch: { x?: number; y?: number }): void {
    const previous = this.drawingMetadata.get(id);
    if (!previous || !patch || typeof patch !== 'object') return;
    const changes: { x?: number; y?: number } = {};
    for (const axis of ['x', 'y'] as const) {
      if (!Object.hasOwn(patch, axis)) continue;
      const value = patch[axis];
      if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > MAX_COORDINATE) return;
      if (value !== previous[axis]) changes[axis] = value;
    }
    if (Object.keys(changes).length) this.drawingMetadata.set(id, { ...previous, ...changes });
  }

  deleteDrawings(ids: string[]): void {
    const unique = [...new Set(ids)].filter(id => this.drawingMetadata.has(id));
    if (unique.length === 0) return;
    this.index.transact(() => {
      for (const id of unique) this.drawingMetadata.delete(id);
    }, 'local');
    for (const id of unique) {
      this.unsentUpdates.delete(drawingKey(id));
      this.pendingWrites.delete(drawingKey(id));
      this.drawingBodies.get(id)?.destroy();
      this.drawingBodies.delete(id);
    }
    this.refreshDrawings();
    this.refreshVisibleNotes();
  }

  sendDrawingPreview(preview: DrawingPreviewPacket | null): void {
    if (this.options.localOnly || (preview !== null && !validPreview(preview, this.options.manifest.pageCount))) return;
    this.send({ type: 'drawing-preview', preview });
  }

  createNote(anchorPage: number, x: number, y: number, fontSize = TEXT_FONT_SIZE): string {
    if (!Number.isSafeInteger(anchorPage) || anchorPage < 1 || anchorPage > this.options.manifest.pageCount ||
        !Number.isFinite(x) || !Number.isFinite(y)) throw new Error('Invalid note position.');
    if (!Number.isFinite(fontSize) || fontSize < MIN_NOTE_FONT_SIZE || fontSize > MAX_NOTE_FONT_SIZE) {
      throw new Error('Invalid note font size.');
    }
    const id = crypto.randomUUID();
    const doc = new Y.Doc();
    this.attachBody(id, doc);
    this.bodies.set(id, doc);
    this.editingNoteId = id;
    this.metadata.set(id, { id, anchorPage, x, y, lineCount: 1, fontSize });
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

  private attachDrawingBody(id: string, doc: Y.Doc): void {
    doc.on('update', (update: Uint8Array, origin: unknown) => {
      if (!this.drawingMetadata.has(id)) return;
      const key = drawingKey(id);
      if (origin !== 'load') this.queueWrite(key, update);
      if (origin !== 'remote' && origin !== 'load') this.sendUpdate(key, update);
      this.refreshDrawings();
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
      if (this.welcomed && this.subscribed?.has(noteKey(id))) this.sendState(noteKey(id), Y.encodeStateAsUpdate(doc));
      return doc;
    })().catch(() => {
      this.publish({ error: 'This note could not be loaded.' });
      return undefined;
    }).finally(() => { this.loadingBodies.delete(id); });
    this.loadingBodies.set(id, task);
    return task;
  }

  private ensureDrawingBody(id: string): Promise<Y.Doc | undefined> {
    const existing = this.drawingBodies.get(id);
    if (existing) return Promise.resolve(existing);
    const inProgress = this.loadingDrawingBodies.get(id);
    if (inProgress) return inProgress;
    const task = (async () => {
      let saved: Uint8Array | undefined;
      try {
        saved = await this.readMergedState(drawingKey(id));
      } catch {
        this.publish({ saveState: 'error', error: 'Browser storage could not be read.' });
      }
      if (this.destroyed || !this.drawingMetadata.has(id)) return undefined;
      const doc = new Y.Doc();
      if (saved) Y.applyUpdate(doc, saved, 'load');
      this.attachDrawingBody(id, doc);
      this.drawingBodies.set(id, doc);
      this.refreshDrawings();
      if (this.welcomed && this.subscribed?.has(drawingKey(id))) {
        this.sendState(drawingKey(id), Y.encodeStateAsUpdate(doc));
      }
      return doc;
    })().catch(() => {
      this.publish({ error: 'This drawing could not be loaded.' });
      return undefined;
    }).finally(() => { this.loadingDrawingBodies.delete(id); });
    this.loadingDrawingBodies.set(id, task);
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

  private receiveDrawingPreview(clientId: string, packet: DrawingPreviewPacket | null): void {
    if (clientId === this.clientId || !/^[A-Za-z0-9_-]{1,128}$/.test(clientId)) return;
    const previous = this.previewByClient.get(clientId);
    if (previous && Date.now() - previous.updatedAt > PREVIEW_IDLE_MS) {
      this.previewByClient.delete(clientId);
      this.publishPreviews();
    }
    if (packet === null) {
      const active = this.previewByClient.get(clientId)?.preview;
      if (active && this.drawingMetadata.has(active.id) &&
          !this.drawingBodies.get(active.id)?.getMap('geometry').has('curves')) return;
      if (this.previewByClient.delete(clientId)) this.publishPreviews();
      return;
    }
    if (!validPreview(packet, this.options.manifest.pageCount) || this.drawingMetadata.has(packet.id)) {
      if (this.previewByClient.delete(clientId)) this.publishPreviews();
      return;
    }
    const old = this.previewByClient.get(clientId)?.preview;
    if (old && (old.id !== packet.id || old.kind !== packet.kind || old.anchorPage !== packet.anchorPage ||
        old.x !== packet.x || old.y !== packet.y || old.width !== packet.width ||
        packet.seq !== 0 && packet.seq !== old.seq + 1)) {
      this.previewByClient.delete(clientId);
      this.publishPreviews();
      return;
    }
    if (!old && packet.seq !== 0 || (packet.seq === 0 ? 0 : old?.points.length ?? 0) + packet.points.length > MAX_PREVIEW_BUFFERED_POINTS) {
      this.previewByClient.delete(clientId);
      this.publishPreviews();
      return;
    }
    this.previewByClient.set(clientId, {
      preview: { ...packet, points: old && packet.seq !== 0 ? [...old.points, ...packet.points] : [...packet.points], clientId },
      updatedAt: Date.now(),
    });
    this.publishPreviews();
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
      const saved = await getYState(this.storageId, key);
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
    const task = saveYUpdates(this.storageId, batch);
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
    if (this.destroyed || this.options.localOnly || typeof WebSocket === 'undefined') return;
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
      this.previewByClient.clear();
      this.publishPreviews();
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
        for (const [id, doc] of this.drawingBodies) {
          if (this.drawingMetadata.has(id)) this.sendState(drawingKey(id), Y.encodeStateAsUpdate(doc));
        }
        for (const [key, updates] of this.unsentUpdates) {
          this.sendUpdate(key, Y.mergeUpdates(updates));
        }
        this.unsentUpdates.clear();
        break;
      case 'participants':
        this.participants = this.visibleParticipants(message.participants);
        for (const clientId of this.previewByClient.keys()) {
          if (!message.participants.some(participant => participant.clientId === clientId)) {
            this.previewByClient.delete(clientId);
          }
        }
        this.publishPreviews();
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
      case 'drawing-preview':
        this.receiveDrawingPreview(message.clientId, message.preview);
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
    const drawing = key.startsWith('drawing:');
    if (!drawing && !key.startsWith('note:')) return;
    const id = key.slice(drawing ? 8 : 5);
    if (drawing ? !this.drawingMetadata.has(id) : !this.metadata.has(id)) return;
    const body = drawing ? this.drawingBodies.get(id) : this.bodies.get(id);
    if (body) {
      Y.applyUpdate(body, update, 'remote');
    } else {
      // The owner receives guest changes even for items outside the viewport.
      // Keep the binary update for a delayed IndexedDB merge without opening a Y.Doc.
      this.queueWrite(key, update);
    }
  }

  private async sendStoredState(key: string): Promise<void> {
    const note = key.startsWith('note:');
    const drawing = key.startsWith('drawing:');
    if (key !== INDEX_KEY && !note && !drawing) return;
    const id = note ? key.slice(5) : drawing ? key.slice(8) : '';
    if (note && !this.metadata.has(id) || drawing && !this.drawingMetadata.has(id)) return;
    const current = key === INDEX_KEY ? this.index : note ? this.bodies.get(id) : this.drawingBodies.get(id);
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
    if (this.options.localOnly) return;
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
    if (this.previewTimer) clearInterval(this.previewTimer);
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.onVisibilityChange);
      window.removeEventListener('pagehide', this.onPageHide);
    }
    this.socket?.close();
    this.socket = null;
    try { await this.flush(); } catch { /* saveState retains the error */ }
    for (const doc of this.bodies.values()) doc.destroy();
    for (const doc of this.drawingBodies.values()) doc.destroy();
    this.index.destroy();
    this.listeners.clear();
  }
}
