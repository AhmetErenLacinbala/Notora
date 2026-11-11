import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import * as Y from 'yjs';
import { WebSocket as RealWebSocket } from 'ws';
import {
  noteFontSize, REMOVED_CLOSE_CODE, type ClientMessage, type CubicBezier, type DocumentManifest, type DrawingMeta, type NoteMeta,
  type ServerMessage, type SessionOptions,
} from '../../../../packages/shared/src/index';
import { decodeCurves, drawingBounds, encodeCurves } from './drawingGeometry';

const persistence = vi.hoisted(() => ({
  states: new Map<string, Uint8Array>(),
  saves: [] as Array<Map<string, Uint8Array[]>>,
}));

vi.mock('./storage', () => ({
  getYState: vi.fn(async (documentId: string, key: string) => persistence.states.get(`${documentId}:${key}`)),
  saveYUpdates: vi.fn(async (documentId: string, updates: Map<string, Uint8Array[]>) => {
    persistence.saves.push(updates);
    for (const [key, values] of updates) {
      const storageKey = `${documentId}:${key}`;
      const previous = persistence.states.get(storageKey);
      persistence.states.set(storageKey, Y.mergeUpdates(previous ? [previous, ...values] : values));
    }
  }),
}));

import { WorkspaceSession } from './workspace';
import { getYState, saveYUpdates } from './storage';
import type { DocumentStore } from '../../../server/src/store';
import { attachRelay } from '../../../server/src/relay';

class Socket {
  static OPEN = 1;
  static readonly instances: Socket[] = [];
  readyState = 0;
  sent: ClientMessage[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(readonly url: string) { Socket.instances.push(this); }
  open(): void { this.readyState = Socket.OPEN; this.onopen?.(); }
  receive(message: ServerMessage): void { this.onmessage?.({ data: JSON.stringify(message) }); }
  send(serialized: string): void { this.sent.push(JSON.parse(serialized) as ClientMessage); }
  close(code = 1000, reason = ''): void { this.readyState = 3; this.onclose?.({ code, reason }); }
}

const manifest: DocumentManifest = {
  schemaVersion: 1, id: 'document', version: 'one', title: 'Document', status: 'ready', pageCount: 3,
  pages: [1, 2, 3].map(number => ({ number, width: 600, height: 800 })), outline: [],
};

function options(owner = false): SessionOptions {
  return {
    manifest, accessToken: 'access', ownerToken: owner ? 'owner' : undefined,
    profile: { id: owner ? 'owner-profile' : 'guest-profile', name: owner ? 'Owner' : 'Guest' },
  };
}

const drawingCurves: CubicBezier[] = [[0, 0, 5, -5, 15, 5, 20, 0]];

function drawingMeta(y = 830): Omit<DrawingMeta, 'id'> {
  return { kind: 'stroke', anchorPage: 1, x: 20, y, width: 2, bounds: drawingBounds(drawingCurves, 2, 'stroke') };
}

async function online(session: WorkspaceSession): Promise<Socket> {
  session.connect();
  await vi.waitFor(() => expect(Socket.instances.length).toBeGreaterThan(0));
  const socket = Socket.instances.at(-1)!;
  socket.open();
  expect(socket.sent[0]?.type).toBe('join');
  const join = socket.sent[0] as Extract<ClientMessage, { type: 'join' }>;
  socket.receive({ type: 'welcome', clientId: join.clientId, participants: [
    { clientId: join.clientId, name: join.name, color: '#123456', cursor: null, owner: Boolean(join.ownerToken) },
  ] });
  return socket;
}

function updateFor(socket: Socket, key: string): Extract<ClientMessage, { type: 'update' }> {
  const update = socket.sent.findLast(message => message.type === 'update' && message.key === key);
  expect(update).toBeDefined();
  return update as Extract<ClientMessage, { type: 'update' }>;
}

describe('WorkspaceSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    persistence.states.clear();
    persistence.saves.length = 0;
    Socket.instances.length = 0;
    vi.stubGlobal('WebSocket', Socket);
    vi.stubGlobal('location', { protocol: 'http:', host: 'localhost:3000' });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('keeps a stable snapshot, loads a note spilling into the next page, and saves after input idle', async () => {
    const session = new WorkspaceSession(options(true));
    const first = session.getSnapshot();
    expect(session.getSnapshot()).toBe(first);
    await online(session);
    const id = session.createNote(1, 20, 810);
    session.setNoteText(id, 'first\nsecond');
    expect(session.getSnapshot()).not.toBe(first);
    expect(session.getSnapshot().notes[0]).toMatchObject({ id, lineCount: 2, text: 'first\nsecond' });
    session.setVisibleRange(865, 880);
    const socket = Socket.instances[0];
    expect(socket.sent.some(message => message.type === 'subscribe' && message.keys.includes(`note:${id}`))).toBe(true);

    vi.useFakeTimers();
    session.activity();
    await vi.advanceTimersByTimeAsync(9_999);
    expect(persistence.saves).toHaveLength(0);
    session.activity();
    await vi.advanceTimersByTimeAsync(9_999);
    expect(persistence.saves).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(persistence.states.has('document:index')).toBe(true);
    expect(persistence.states.has(`document:note:${id}`)).toBe(true);
    expect(session.getSnapshot().saveState).toBe('saved');
    await session.destroy();
  });

  it('persists a guest edit in the offscreen owner browser without loading its body', async () => {
    const owner = new WorkspaceSession(options(true));
    const guest = new WorkspaceSession(options());
    const ownerSocket = await online(owner);
    const guestSocket = await online(guest);
    owner.setVisibleRange(0, 100);
    guest.setVisibleRange(850, 950);
    const id = guest.createNote(1, 20, 810);
    ownerSocket.receive({ type: 'update', key: 'index', update: updateFor(guestSocket, 'index').update });
    expect(owner.getSnapshot().notes[0]).toMatchObject({ id, text: null });
    guest.setNoteText(id, 'guest edit');
    ownerSocket.receive({ type: 'update', key: `note:${id}`, update: updateFor(guestSocket, `note:${id}`).update });
    expect(owner.getSnapshot().notes[0]?.text).toBeNull();
    await owner.flush();
    const saved = persistence.states.get(`document:note:${id}`);
    expect(saved).toBeDefined();
    const restored = new Y.Doc();
    Y.applyUpdate(restored, saved!);
    expect(restored.getText('text').toString()).toBe('guest edit');
    await owner.destroy();
    await guest.destroy();
  });

  it('never reads or writes guest document storage, including old records, idle, flush and destroy', async () => {
    const oldIndex = new Y.Doc();
    oldIndex.getMap<NoteMeta>('notes').set('legacy-guest-note', {
      id: 'legacy-guest-note', anchorPage: 1, x: 10, y: 10, lineCount: 1,
    });
    persistence.states.set('legacy-guest:index', Y.encodeStateAsUpdate(oldIndex));
    const session = new WorkspaceSession({ ...options(), storageId: 'legacy-guest' });
    const socket = await online(session);
    expect(session.getSnapshot().notes).toEqual([]);
    expect(vi.mocked(getYState)).not.toHaveBeenCalled();

    const id = session.createNote(1, 20, 20);
    session.setNoteText(id, 'guest edit');
    session.createDrawing(drawingMeta(20), drawingCurves);
    const remoteIndex = new Y.Doc();
    remoteIndex.getMap<NoteMeta>('notes').set('offscreen', {
      id: 'offscreen', anchorPage: 1, x: 10, y: 700, lineCount: 1,
    });
    remoteIndex.getMap<DrawingMeta>('drawings').set('remote-drawing', {
      ...drawingMeta(720), id: 'remote-drawing',
    });
    const remoteBody = new Y.Doc();
    remoteBody.getText('text').insert(0, 'remote RAM text');
    const remoteDrawing = new Y.Doc();
    remoteDrawing.transact(() => {
      remoteDrawing.getMap('geometry').set('version', 1);
      remoteDrawing.getMap('geometry').set('curves', encodeCurves(drawingCurves));
    });
    socket.receive({ type: 'update', key: 'index', update: Buffer.from(Y.encodeStateAsUpdate(remoteIndex)).toString('base64') });
    socket.receive({ type: 'update', key: 'note:offscreen', update: Buffer.from(Y.encodeStateAsUpdate(remoteBody)).toString('base64') });
    socket.receive({ type: 'update', key: 'drawing:remote-drawing', update: Buffer.from(Y.encodeStateAsUpdate(remoteDrawing)).toString('base64') });
    expect(session.getSnapshot().notes.find(note => note.id === 'offscreen')?.text).toBeNull();
    expect(session.getSnapshot().drawings.find(drawing => drawing.id === 'remote-drawing')?.curves).toBeNull();
    socket.receive({ type: 'need-state', keys: ['note:offscreen'] });
    await vi.waitFor(() => expect(socket.sent.some(message => message.type === 'state' && message.key === 'note:offscreen')).toBe(true));
    session.setVisibleRange(700, 850);
    await vi.waitFor(() => expect(session.getSnapshot().notes.find(note => note.id === 'offscreen')?.text).toBe('remote RAM text'));
    await vi.waitFor(() => expect(session.getSnapshot().drawings.find(drawing => drawing.id === 'remote-drawing')?.curves).toEqual(drawingCurves));

    vi.useFakeTimers();
    session.activity();
    await vi.advanceTimersByTimeAsync(20_000);
    await session.flush();
    await session.destroy();
    expect(vi.mocked(getYState)).not.toHaveBeenCalled();
    expect(vi.mocked(saveYUpdates)).not.toHaveBeenCalled();
    expect(persistence.states.has('legacy-guest:index')).toBe(true);
    expect(persistence.states.has(`legacy-guest:note:${id}`)).toBe(false);
  });

  it('keeps guest offscreen bodies and offline edits in RAM through reconnect', async () => {
    const session = new WorkspaceSession(options());
    const first = await online(session);
    const remoteIndex = new Y.Doc();
    remoteIndex.getMap<NoteMeta>('notes').set('remote-note', {
      id: 'remote-note', anchorPage: 1, x: 10, y: 700, lineCount: 1,
    });
    const remoteBody = new Y.Doc();
    remoteBody.getText('text').insert(0, 'offscreen state');
    first.receive({ type: 'update', key: 'index', update: Buffer.from(Y.encodeStateAsUpdate(remoteIndex)).toString('base64') });
    first.receive({ type: 'update', key: 'note:remote-note', update: Buffer.from(Y.encodeStateAsUpdate(remoteBody)).toString('base64') });
    vi.useFakeTimers();
    first.close();
    const ownId = session.createNote(1, 25, 25);
    session.setNoteText(ownId, 'offline edit');
    await vi.advanceTimersByTimeAsync(500);
    const second = Socket.instances.at(-1)!;
    second.open();
    const join = second.sent[0] as Extract<ClientMessage, { type: 'join' }>;
    second.receive({ type: 'welcome', clientId: join.clientId, participants: [
      { clientId: join.clientId, name: 'Guest', color: '#123456', cursor: null, owner: false },
    ] });
    expect(second.sent.some(message => message.type === 'state' && message.key === 'index')).toBe(true);
    expect(second.sent.some(message => message.type === 'state' && message.key === `note:${ownId}`)).toBe(true);
    second.receive({ type: 'need-state', keys: ['note:remote-note'] });
    await vi.advanceTimersByTimeAsync(1);
    const state = second.sent.findLast(message => message.type === 'state' && message.key === 'note:remote-note') as
      Extract<ClientMessage, { type: 'state' }>;
    const restored = new Y.Doc();
    Y.applyUpdate(restored, Uint8Array.from(atob(state.update), char => char.charCodeAt(0)));
    expect(restored.getText('text').toString()).toBe('offscreen state');
    session.setVisibleRange(700, 850);
    await vi.advanceTimersByTimeAsync(1);
    expect(session.getSnapshot().notes.find(note => note.id === 'remote-note')?.text).toBe('offscreen state');
    expect(vi.mocked(getYState)).not.toHaveBeenCalled();
    expect(vi.mocked(saveYUpdates)).not.toHaveBeenCalled();
    await session.destroy();
  });

  it('reads an old note without font metadata, then saves font and position without loading offscreen text', async () => {
    const id = 'legacy-note';
    const index = new Y.Doc();
    index.getMap<NoteMeta>('notes').set(id, { id, anchorPage: 1, x: 20, y: 700, lineCount: 2 });
    persistence.states.set('document:index', Y.encodeStateAsUpdate(index));
    const body = new Y.Doc();
    body.getText('text').insert(0, 'old\nnote');
    persistence.states.set(`document:note:${id}`, Y.encodeStateAsUpdate(body));

    const session = new WorkspaceSession(options(true));
    session.setVisibleRange(0, 100);
    const socket = await online(session);
    expect(session.getSnapshot().notes[0]).toMatchObject({ id, x: 20, y: 700, lineCount: 2, text: null });
    expect(noteFontSize(session.getSnapshot().notes[0])).toBe(18);
    expect(vi.mocked(getYState)).not.toHaveBeenCalledWith('document', `note:${id}`);

    const indexUpdates = () => socket.sent.filter(message => message.type === 'update' && message.key === 'index').length;
    const beforeInvalid = indexUpdates();
    session.updateNote(id, { x: Number.NaN, fontSize: 24 });
    session.updateNote(id, { fontSize: 73 });
    session.updateNote(id, { x: Number.POSITIVE_INFINITY });
    expect(indexUpdates()).toBe(beforeInvalid);

    session.updateNote(id, { x: 50, fontSize: 24 });
    expect(session.getSnapshot().notes[0]).toMatchObject({ x: 50, y: 700, lineCount: 2, fontSize: 24, text: null });
    expect(vi.mocked(getYState)).not.toHaveBeenCalledWith('document', `note:${id}`);
    session.updateNote(id, { y: 20 });
    await vi.waitFor(() => expect(session.getSnapshot().notes[0]?.text).toBe('old\nnote'));
    expect(session.getSnapshot().notes[0]).toMatchObject({ x: 50, y: 20, fontSize: 24, lineCount: 2 });

    vi.useFakeTimers();
    session.activity();
    await vi.advanceTimersByTimeAsync(9_999);
    expect(persistence.saves).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(session.getSnapshot().saveState).toBe('saved');
    await session.destroy();

    vi.useRealTimers();
    Socket.instances.length = 0;
    const reopened = new WorkspaceSession(options(true));
    reopened.setVisibleRange(0, 100);
    await online(reopened);
    await vi.waitFor(() => expect(reopened.getSnapshot().notes[0]?.text).toBe('old\nnote'));
    expect(reopened.getSnapshot().notes[0]).toMatchObject({ x: 50, y: 20, fontSize: 24, lineCount: 2 });
    await reopened.destroy();
  });

  it('syncs note font and position to an offscreen owner without loading the body', async () => {
    const owner = new WorkspaceSession(options(true));
    const guest = new WorkspaceSession(options());
    const ownerSocket = await online(owner);
    const guestSocket = await online(guest);
    owner.setVisibleRange(0, 100);
    const id = guest.createNote(1, 20, 700, 1);
    ownerSocket.receive({ type: 'update', key: 'index', update: updateFor(guestSocket, 'index').update });
    guest.setNoteText(id, 'guest\ntext');
    ownerSocket.receive({ type: 'update', key: 'index', update: updateFor(guestSocket, 'index').update });
    expect(owner.getSnapshot().notes[0]).toMatchObject({ id, lineCount: 2, fontSize: 1, text: null });
    ownerSocket.receive({ type: 'update', key: `note:${id}`, update: updateFor(guestSocket, `note:${id}`).update });

    guest.updateNote(id, { x: 125, y: 720, fontSize: 28 });
    ownerSocket.receive({ type: 'update', key: 'index', update: updateFor(guestSocket, 'index').update });
    expect(owner.getSnapshot().notes[0]).toMatchObject({ x: 125, y: 720, fontSize: 28, lineCount: 2, text: null });
    guest.setNoteText(id, 'guest\ntext\nmore');
    ownerSocket.receive({ type: 'update', key: 'index', update: updateFor(guestSocket, 'index').update });
    ownerSocket.receive({ type: 'update', key: `note:${id}`, update: updateFor(guestSocket, `note:${id}`).update });
    expect(owner.getSnapshot().notes[0]).toMatchObject({ x: 125, y: 720, fontSize: 28, lineCount: 3, text: null });
    expect(vi.mocked(getYState)).not.toHaveBeenCalledWith('document', `note:${id}`);
    await owner.flush();
    await owner.destroy();
    await guest.destroy();

    Socket.instances.length = 0;
    const reopened = new WorkspaceSession(options(true));
    reopened.setVisibleRange(700, 850);
    await online(reopened);
    await vi.waitFor(() => expect(reopened.getSnapshot().notes[0]?.text).toBe('guest\ntext\nmore'));
    expect(reopened.getSnapshot().notes[0]).toMatchObject({ x: 125, y: 720, fontSize: 28, lineCount: 3 });
    await reopened.destroy();
  });

  it('deletes selected notes in one index update and preserves unselected notes', async () => {
    const session = new WorkspaceSession(options(true));
    const socket = await online(session);
    const first = session.createNote(1, 10, 10);
    const second = session.createNote(1, 20, 20);
    const keep = session.createNote(1, 30, 30);
    session.setNoteText(keep, 'keep me');
    const beforeDelete = socket.sent.filter(message => message.type === 'update' && message.key === 'index').length;
    session.deleteNotes([first, second, first, 'missing']);
    expect(socket.sent.filter(message => message.type === 'update' && message.key === 'index')).toHaveLength(beforeDelete + 1);
    expect(session.getSnapshot().notes).toEqual([expect.objectContaining({ id: keep, text: 'keep me' })]);
    await session.flush();
    await session.destroy();

    Socket.instances.length = 0;
    const reopened = new WorkspaceSession(options(true));
    reopened.setVisibleRange(0, 100);
    await online(reopened);
    await vi.waitFor(() => expect(reopened.getSnapshot().notes[0]?.text).toBe('keep me'));
    expect(reopened.getSnapshot().notes.map(note => note.id)).toEqual([keep]);
    reopened.deleteNote(keep);
    expect(reopened.getSnapshot().notes).toHaveLength(0);
    await reopened.destroy();
  });

  it('merges simultaneous textarea insertions from two clients without replacing the full text', async () => {
    const owner = new WorkspaceSession(options(true));
    const guest = new WorkspaceSession(options());
    const ownerSocket = await online(owner);
    const guestSocket = await online(guest);
    guest.setVisibleRange(0, 300);
    const id = owner.createNote(1, 20, 10);
    owner.setNoteText(id, 'base');
    guestSocket.receive({ type: 'update', key: 'index', update: updateFor(ownerSocket, 'index').update });
    guestSocket.receive({ type: 'update', key: `note:${id}`, update: updateFor(ownerSocket, `note:${id}`).update });
    await vi.waitFor(() => expect(guest.getSnapshot().notes[0]?.text).toBe('base'));

    owner.setNoteText(id, 'base A');
    guest.setNoteText(id, 'base B');
    guestSocket.receive({ type: 'update', key: `note:${id}`, update: updateFor(ownerSocket, `note:${id}`).update });
    ownerSocket.receive({ type: 'update', key: `note:${id}`, update: updateFor(guestSocket, `note:${id}`).update });
    expect(owner.getSnapshot().notes[0]?.text).toBe(guest.getSnapshot().notes[0]?.text);
    expect(owner.getSnapshot().notes[0]?.text).toContain(' A');
    expect(owner.getSnapshot().notes[0]?.text).toContain(' B');
    await owner.destroy();
    await guest.destroy();
  });

  it('answers state requests while an offscreen update is still being saved', async () => {
    const session = new WorkspaceSession(options(true));
    const socket = await online(session);
    session.setVisibleRange(0, 100);
    const id = 'offscreen';
    const index = new Y.Doc();
    index.getMap('notes').set(id, { id, anchorPage: 1, x: 0, y: 700, lineCount: 1 });
    socket.receive({ type: 'update', key: 'index', update: Buffer.from(Y.encodeStateAsUpdate(index)).toString('base64') });
    const body = new Y.Doc();
    body.getText('text').insert(0, 'saved during flush');
    socket.receive({ type: 'update', key: `note:${id}`, update: Buffer.from(Y.encodeStateAsUpdate(body)).toString('base64') });
    expect(session.getSnapshot().notes[0]?.text).toBeNull();

    const originalSave = vi.mocked(saveYUpdates).getMockImplementation()!;
    let release!: () => void;
    vi.mocked(saveYUpdates).mockImplementationOnce(async (documentId, updates) => {
      await new Promise<void>(resolve => { release = resolve; });
      await originalSave(documentId, updates);
    });
    const saving = session.flush();
    const prior = socket.sent.filter(message => message.type === 'state' && message.key === `note:${id}`).length;
    socket.receive({ type: 'need-state', keys: [`note:${id}`] });
    await vi.waitFor(() => expect(socket.sent.filter(message => message.type === 'state' && message.key === `note:${id}`).length).toBeGreaterThan(prior));
    const state = socket.sent.findLast(message => message.type === 'state' && message.key === `note:${id}`) as
      Extract<ClientMessage, { type: 'state' }>;
    const restored = new Y.Doc();
    Y.applyUpdate(restored, Uint8Array.from(atob(state.update), char => char.charCodeAt(0)));
    expect(restored.getText('text').toString()).toBe('saved during flush');
    release();
    await saving;
    await session.destroy();
  });

  it('retains a failed close save for retry and restores the note after a new session', async () => {
    const session = new WorkspaceSession(options(true));
    await online(session);
    const id = session.createNote(1, 25, 40);
    session.setNoteText(id, 'persist after retry');
    vi.useFakeTimers();
    vi.mocked(saveYUpdates).mockRejectedValueOnce(new Error('temporary IndexedDB failure'));
    await session.destroy();
    expect(session.getSnapshot().saveState).toBe('error');
    expect(persistence.states.has(`document:note:${id}`)).toBe(false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(persistence.states.has(`document:note:${id}`)).toBe(true);

    vi.useRealTimers();
    Socket.instances.length = 0;
    const reopened = new WorkspaceSession(options(true));
    reopened.setVisibleRange(0, 300);
    await online(reopened);
    await vi.waitFor(() => expect(reopened.getSnapshot().notes[0]?.text).toBe('persist after retry'));
    await reopened.destroy();
  });

  it('keeps participant names and canonical remote cursors while hiding the local cursor', async () => {
    const session = new WorkspaceSession(options(true));
    const socket = await online(session);
    const join = socket.sent[0] as Extract<ClientMessage, { type: 'join' }>;
    socket.receive({ type: 'participants', participants: [
      { clientId: join.clientId, name: 'Owner', color: '#123456', cursor: { x: 20, y: 30 }, owner: true },
      { clientId: 'remote-client', name: 'Teacher', color: '#abcdef', cursor: { x: 812, y: 1940 }, owner: false },
    ] });
    expect(session.getSnapshot().participants).toEqual([
      { clientId: join.clientId, name: 'Owner', color: '#123456', cursor: null, owner: true },
      { clientId: 'remote-client', name: 'Teacher', color: '#abcdef', cursor: { x: 812, y: 1940 }, owner: false },
    ]);
    socket.receive({ type: 'cursor', clientId: 'remote-client', cursor: { x: 910, y: 2010 } });
    expect(session.getSnapshot().participants[1].cursor).toEqual({ x: 910, y: 2010 });
    session.setCursor({ x: 5, y: 6 });
    expect(session.getSnapshot().participants[0].cursor).toBeNull();
    expect(socket.sent.at(-1)).toEqual({ type: 'cursor', cursor: { x: 5, y: 6 } });
    await session.destroy();
  });

  it('grants kick controls only from the server-confirmed own participant', async () => {
    const guest = new WorkspaceSession({ ...options(), profile: { id: 'imposter', name: 'Owner' } });
    const guestSocket = await online(guest);
    const guestId = (guestSocket.sent[0] as Extract<ClientMessage, { type: 'join' }>).clientId;
    guestSocket.receive({ type: 'participants', participants: [
      { clientId: guestId, name: 'Owner', color: '#123456', cursor: null, owner: false },
      { clientId: 'real-owner', name: 'Owner', color: '#abcdef', cursor: null, owner: true },
    ] });
    expect(guest.getSnapshot().isAdmin).toBe(false);
    guest.kickParticipant('real-owner');
    expect(guestSocket.sent.some(message => message.type === 'kick')).toBe(false);

    const admin = new WorkspaceSession(options(true));
    const adminSocket = await online(admin);
    const adminId = (adminSocket.sent[0] as Extract<ClientMessage, { type: 'join' }>).clientId;
    expect(admin.getSnapshot().isAdmin).toBe(true);
    adminSocket.receive({ type: 'participants', participants: [
      { clientId: 'first-guest', name: 'Owner', color: '#abcdef', cursor: null, owner: false },
      { clientId: adminId, name: 'Owner', color: '#123456', cursor: null, owner: true },
      { clientId: 'other-owner', name: 'Creator', color: '#abcdef', cursor: null, owner: true },
    ] });
    admin.kickParticipant(adminId);
    admin.kickParticipant('other-owner');
    admin.kickParticipant('unknown');
    expect(adminSocket.sent.some(message => message.type === 'kick')).toBe(false);
    admin.kickParticipant('first-guest');
    expect(adminSocket.sent.filter(message => message.type === 'kick')).toEqual([
      { type: 'kick', clientId: 'first-guest' },
    ]);
    await admin.destroy();
    await guest.destroy();
  });

  it('treats a removed frame as terminal and ignores late state and edit attempts', async () => {
    const session = new WorkspaceSession(options());
    const socket = await online(session);
    const ownId = session.createNote(1, 20, 20);
    session.setNoteText(ownId, 'before removal');
    socket.receive({ type: 'participants', participants: [
      { clientId: 'remote', name: 'Remote', color: '#abcdef', cursor: null, owner: true },
    ] });
    socket.receive({ type: 'drawing-preview', clientId: 'remote', preview: {
      id: 'pending-stroke', kind: 'stroke', anchorPage: 1, x: 20, y: 20, width: 2,
      seq: 0, points: [{ x: 0, y: 0 }],
    } });
    expect(session.getSnapshot().drawingPreviews).toHaveLength(1);
    const before = socket.sent.length;
    socket.receive({ type: 'need-state', keys: ['index'] });
    socket.receive({ type: 'removed', message: 'The creator removed you.' });
    await Promise.resolve();
    expect(session.getSnapshot()).toMatchObject({
      connection: 'removed', isAdmin: false, participants: [], drawingPreviews: [],
      notes: [], drawings: [], error: 'The creator removed you.',
    });
    socket.receive({ type: 'welcome', clientId: 'late', participants: [] });
    socket.receive({ type: 'update', key: 'index', update: Buffer.from(Y.encodeStateAsUpdate(new Y.Doc())).toString('base64') });
    session.setNoteText(ownId, 'after removal');
    session.setCursor({ x: 1, y: 1 });
    session.sendDrawingPreview(null);
    expect(() => session.createNote(1, 30, 30)).toThrow('removed');
    expect(socket.sent).toHaveLength(before);
    vi.useFakeTimers();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(Socket.instances).toHaveLength(1);
    await session.destroy();
  });

  it('treats a removal close code as terminal without reconnecting', async () => {
    const session = new WorkspaceSession(options());
    const socket = await online(session);
    vi.useFakeTimers();
    socket.close(REMOVED_CLOSE_CODE, 'Access revoked.');
    expect(session.getSnapshot()).toMatchObject({ connection: 'removed', error: 'Access revoked.' });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(Socket.instances).toHaveLength(1);
    await session.destroy();
  });

  it('keeps a focused note subscribed while its page scrolls out of range', async () => {
    const session = new WorkspaceSession(options(true));
    const socket = await online(session);
    const id = session.createNote(1, 20, 30);
    session.setVisibleRange(0, 300);
    session.setEditingNote(id);
    session.setVisibleRange(2_000, 2_200);
    const whileFocused = socket.sent.findLast(message => message.type === 'subscribe') as
      Extract<ClientMessage, { type: 'subscribe' }>;
    expect(whileFocused.keys).toContain(`note:${id}`);
    session.setEditingNote(null);
    const afterBlur = socket.sent.findLast(message => message.type === 'subscribe') as
      Extract<ClientMessage, { type: 'subscribe' }>;
    expect(afterBlur.keys).not.toContain(`note:${id}`);
    await session.destroy();
  });

  it('replays disconnected edits after reconnect and answers a state request', async () => {
    const session = new WorkspaceSession(options(true));
    const firstSocket = await online(session);
    const id = session.createNote(2, 30, 40);
    session.setNoteText(id, 'before');
    vi.useFakeTimers();
    firstSocket.close();
    expect(session.getSnapshot().connection).toBe('offline');
    session.setNoteText(id, 'before and after');
    await vi.advanceTimersByTimeAsync(500);
    const secondSocket = Socket.instances.at(-1)!;
    expect(secondSocket).not.toBe(firstSocket);
    secondSocket.open();
    const secondJoin = secondSocket.sent[0] as Extract<ClientMessage, { type: 'join' }>;
    secondSocket.receive({ type: 'welcome', clientId: secondJoin.clientId, participants: [] });
    const beforeRequest = secondSocket.sent.filter(message => message.type === 'state' && message.key === `note:${id}`).length;
    secondSocket.receive({ type: 'need-state', keys: [`note:${id}`] });
    await vi.advanceTimersByTimeAsync(20);
    expect(secondSocket.sent.filter(message => message.type === 'state' && message.key === `note:${id}`).length)
      .toBeGreaterThan(beforeRequest);
    const state = secondSocket.sent.findLast(message => message.type === 'state' && message.key === `note:${id}`) as
      Extract<ClientMessage, { type: 'state' }>;
    const restored = new Y.Doc();
    Y.applyUpdate(restored, Uint8Array.from(atob(state.update), char => char.charCodeAt(0)));
    expect(restored.getText('text').toString()).toBe('before and after');
    await session.destroy();
  });

  it('keeps local-only drawings under storageId across the transition to a shared document', async () => {
    const local = new WorkspaceSession({ ...options(true), manifest: { ...manifest, id: 'local-temp' }, storageId: 'stable-file', localOnly: true });
    local.connect();
    await vi.waitFor(() => expect(vi.mocked(getYState)).toHaveBeenCalledWith('stable-file', 'index'));
    expect(local.getSnapshot().connection).toBe('local');
    expect(Socket.instances).toHaveLength(0);
    const id = local.createDrawing(drawingMeta(20), drawingCurves);
    local.setVisibleRange(0, 100);
    expect(local.getSnapshot().drawings[0]).toMatchObject({ id, curves: drawingCurves });
    await local.flush();
    expect(persistence.states.has('stable-file:index')).toBe(true);
    expect(persistence.states.has(`stable-file:drawing:${id}`)).toBe(true);
    await local.destroy();

    const shared = new WorkspaceSession({ ...options(true), manifest: { ...manifest, id: 'uploaded-document' }, storageId: 'stable-file' });
    shared.setVisibleRange(0, 100);
    const socket = await online(shared);
    await vi.waitFor(() => expect(shared.getSnapshot().drawings[0]?.curves).toEqual(drawingCurves));
    expect((socket.sent[0] as Extract<ClientMessage, { type: 'join' }>).documentId).toBe('uploaded-document');
    expect(socket.sent.some(message => message.type === 'state' && message.key === `drawing:${id}`)).toBe(true);
    await shared.destroy();
  });

  it('keeps rapid consecutive strokes through save and lazy page-boundary reload', async () => {
    const localOptions = { ...options(true), localOnly: true };
    const session = new WorkspaceSession(localOptions);
    session.connect();
    await vi.waitFor(() => expect(vi.mocked(getYState)).toHaveBeenCalledWith('document', 'index'));
    const ids = [780, 830, 860].map((y, index) => session.createDrawing(
      { ...drawingMeta(y), x: 20 + index * 40 }, drawingCurves,
    ));
    expect(session.getSnapshot().drawings.map(drawing => drawing.id)).toEqual(ids);
    expect(session.getSnapshot().drawings.every(drawing => drawing.curves !== null)).toBe(true);
    await session.flush();
    await session.destroy();

    const reopened = new WorkspaceSession(localOptions);
    reopened.setVisibleRange(855, 900);
    reopened.connect();
    await vi.waitFor(() => expect(reopened.getSnapshot().drawings).toHaveLength(3));
    await vi.waitFor(() => expect(reopened.getSnapshot().drawings[1]?.curves).toEqual(drawingCurves));
    expect(reopened.getSnapshot().drawings[0]?.curves).toBeNull();
    reopened.setVisibleRange(0, 900);
    await vi.waitFor(() => expect(reopened.getSnapshot().drawings.every(drawing => drawing.curves !== null)).toBe(true));
    await reopened.destroy();
  });

  it('restores guest strokes from the creator after a relay restart without a guest disk copy', async () => {
    vi.stubGlobal('WebSocket', RealWebSocket);
    const store = {
      authorize(documentId: string, accessToken: string, ownerToken?: string) {
        if (documentId !== 'document' || accessToken !== 'access' || ownerToken && ownerToken !== 'owner') return null;
        return { record: { manifest }, owner: ownerToken === 'owner' };
      },
    } as unknown as DocumentStore;
    const firstRelay = Fastify();
    attachRelay(firstRelay, store);
    let secondRelay: ReturnType<typeof Fastify> | undefined;
    let originalOwner: WorkspaceSession | undefined;
    let originalGuest: WorkspaceSession | undefined;
    let reopenedOwner: WorkspaceSession | undefined;
    let freshGuest: WorkspaceSession | undefined;
    try {
      const firstAddress = await firstRelay.listen({ host: '127.0.0.1', port: 0 });
      vi.stubGlobal('location', { protocol: 'http:', host: new URL(firstAddress).host });
      originalOwner = new WorkspaceSession(options(true));
      originalOwner.setVisibleRange(0, 100);
      originalOwner.connect();
      await vi.waitFor(() => expect(originalOwner!.getSnapshot().connection).toBe('online'));
      originalGuest = new WorkspaceSession(options());
      originalGuest.setVisibleRange(0, 900);
      originalGuest.connect();
      await vi.waitFor(() => expect(originalGuest!.getSnapshot().connection).toBe('online'));
      const ids = [700, 720, 740].map(y => originalGuest!.createDrawing(drawingMeta(y), drawingCurves));
      await vi.waitFor(async () => {
        await originalOwner!.flush();
        for (const id of ids) expect(persistence.states.has(`document:drawing:${id}`)).toBe(true);
      });
      expect(originalOwner.getSnapshot().drawings.every(drawing => drawing.curves === null)).toBe(true);
      await originalGuest.flush();
      await originalGuest.destroy();
      await originalOwner.destroy();
      await firstRelay.close();

      secondRelay = Fastify();
      attachRelay(secondRelay, store);
      const secondAddress = await secondRelay.listen({ host: '127.0.0.1', port: 0 });
      vi.stubGlobal('location', { protocol: 'http:', host: new URL(secondAddress).host });
      reopenedOwner = new WorkspaceSession(options(true));
      reopenedOwner.setVisibleRange(0, 900);
      reopenedOwner.connect();
      await vi.waitFor(() => expect(reopenedOwner!.getSnapshot().connection).toBe('online'));
      await vi.waitFor(() => expect(reopenedOwner!.getSnapshot().drawings.map(drawing => drawing.id)).toEqual(ids));
      await vi.waitFor(() => expect(reopenedOwner!.getSnapshot().drawings.every(drawing => drawing.curves !== null)).toBe(true));

      freshGuest = new WorkspaceSession({ ...options(), storageId: 'fresh-guest' });
      freshGuest.setVisibleRange(0, 900);
      freshGuest.connect();
      await vi.waitFor(() => expect(freshGuest!.getSnapshot().drawings.map(drawing => drawing.id)).toEqual(ids));
      await vi.waitFor(() => expect(freshGuest!.getSnapshot().drawings.every(drawing => drawing.curves !== null)).toBe(true));
    } finally {
      await freshGuest?.destroy();
      await reopenedOwner?.destroy();
      await originalGuest?.destroy();
      await originalOwner?.destroy();
      if (secondRelay) await secondRelay.close();
      else await firstRelay.close();
    }
  });

  it('queues offscreen owner geometry, loads a crossing-page stroke lazily, and ignores a late body after deletion', async () => {
    const owner = new WorkspaceSession(options(true));
    const guest = new WorkspaceSession(options());
    const ownerSocket = await online(owner);
    const guestSocket = await online(guest);
    owner.setVisibleRange(0, 100);
    const id = guest.createDrawing(drawingMeta(), drawingCurves);
    ownerSocket.receive({ type: 'update', key: 'index', update: updateFor(guestSocket, 'index').update });
    const bodyUpdate = updateFor(guestSocket, `drawing:${id}`).update;
    ownerSocket.receive({ type: 'update', key: `drawing:${id}`, update: bodyUpdate });
    expect(owner.getSnapshot().drawings[0]).toMatchObject({ id, curves: null });
    expect(vi.mocked(getYState)).not.toHaveBeenCalledWith('document', `drawing:${id}`);
    await owner.flush();
    const saved = persistence.states.get(`document:drawing:${id}`)!;
    const body = new Y.Doc();
    Y.applyUpdate(body, saved);
    expect(decodeCurves(body.getMap('geometry').get('curves') as Uint8Array)).toEqual(drawingCurves);
    owner.setVisibleRange(860, 870); // The drawing starts on page one and crosses into page two.
    await vi.waitFor(() => expect(owner.getSnapshot().drawings[0]?.curves).toEqual(drawingCurves));

    guest.deleteDrawings([id]);
    ownerSocket.receive({ type: 'update', key: 'index', update: updateFor(guestSocket, 'index').update });
    ownerSocket.receive({ type: 'update', key: `drawing:${id}`, update: bodyUpdate });
    expect(owner.getSnapshot().drawings).toEqual([]);
    vi.useFakeTimers();
    ownerSocket.close();
    await vi.advanceTimersByTimeAsync(500);
    const reconnected = Socket.instances.at(-1)!;
    reconnected.open();
    reconnected.receive({ type: 'welcome', clientId: (reconnected.sent[0] as Extract<ClientMessage, { type: 'join' }>).clientId, participants: [] });
    expect(reconnected.sent.some(message => message.type === 'state' && message.key === `drawing:${id}`)).toBe(false);
    await owner.flush();
    await owner.destroy();
    await guest.destroy();

    vi.useRealTimers();
    Socket.instances.length = 0;
    const reopened = new WorkspaceSession(options(true));
    reopened.setVisibleRange(860, 870);
    await online(reopened);
    expect(reopened.getSnapshot().drawings).toEqual([]);
    await reopened.destroy();
  });

  it('replays offline drawing state after reconnect and answers a drawing state request', async () => {
    const session = new WorkspaceSession(options(true));
    const first = await online(session);
    vi.useFakeTimers();
    first.close();
    const id = session.createDrawing(drawingMeta(20), drawingCurves);
    await vi.advanceTimersByTimeAsync(500);
    const second = Socket.instances.at(-1)!;
    second.open();
    second.receive({ type: 'welcome', clientId: (second.sent[0] as Extract<ClientMessage, { type: 'join' }>).clientId, participants: [] });
    expect(second.sent.some(message => message.type === 'state' && message.key === `drawing:${id}`)).toBe(true);
    const prior = second.sent.filter(message => message.type === 'state' && message.key === `drawing:${id}`).length;
    second.receive({ type: 'need-state', keys: [`drawing:${id}`] });
    await vi.advanceTimersByTimeAsync(10);
    expect(second.sent.filter(message => message.type === 'state' && message.key === `drawing:${id}`).length).toBeGreaterThan(prior);
    await session.destroy();
  });

  it('accumulates delta previews and clears them on final geometry, disconnect and expiry', async () => {
    const session = new WorkspaceSession(options(true));
    const socket = await online(session);
    session.setVisibleRange(0, 100);
    const base = { id: 'remote-stroke', kind: 'stroke' as const, anchorPage: 1, x: 20, y: 20, width: 2 };
    socket.receive({ type: 'drawing-preview', clientId: 'remote', preview: { ...base, seq: 0, points: [{ x: 0, y: 0 }] } });
    socket.receive({ type: 'drawing-preview', clientId: 'remote', preview: { ...base, seq: 1, points: [{ x: 5, y: 1 }] } });
    expect(session.getSnapshot().drawingPreviews[0]).toMatchObject({ clientId: 'remote', seq: 1, points: [{ x: 0, y: 0 }, { x: 5, y: 1 }] });
    socket.receive({ type: 'drawing-preview', clientId: 'remote', preview: { ...base, seq: 3, points: [{ x: 9, y: 1 }] } });
    expect(session.getSnapshot().drawingPreviews).toEqual([]);
    socket.receive({ type: 'drawing-preview', clientId: 'remote', preview: { ...base, seq: 0, points: [{ x: 0, y: 0 }] } });
    const index = new Y.Doc();
    index.getMap<DrawingMeta>('drawings').set(base.id, { ...base, bounds: drawingBounds(drawingCurves, 2, 'stroke') });
    socket.receive({ type: 'update', key: 'index', update: Buffer.from(Y.encodeStateAsUpdate(index)).toString('base64') });
    expect(session.getSnapshot().drawingPreviews).toHaveLength(1);
    socket.receive({ type: 'drawing-preview', clientId: 'remote', preview: null });
    expect(session.getSnapshot().drawingPreviews).toHaveLength(1); // Keep it until geometry is ready.
    const body = new Y.Doc();
    body.transact(() => {
      body.getMap('geometry').set('version', 1);
      body.getMap('geometry').set('curves', encodeCurves(drawingCurves));
    });
    socket.receive({ type: 'update', key: `drawing:${base.id}`, update: Buffer.from(Y.encodeStateAsUpdate(body)).toString('base64') });
    await vi.waitFor(() => expect(session.getSnapshot().drawingPreviews).toEqual([]));

    socket.receive({ type: 'drawing-preview', clientId: 'other', preview: { ...base, id: 'other-stroke', seq: 0, points: [{ x: 0, y: 0 }] } });
    expect(session.getSnapshot().drawingPreviews).toHaveLength(1);
    socket.receive({ type: 'participants', participants: [] });
    expect(session.getSnapshot().drawingPreviews).toEqual([]);

    vi.useFakeTimers();
    socket.receive({ type: 'drawing-preview', clientId: 'other', preview: { ...base, id: 'third-stroke', seq: 0, points: [{ x: 0, y: 0 }] } });
    await vi.advanceTimersByTimeAsync(9_001);
    expect(session.getSnapshot().drawingPreviews).toEqual([]);
    await session.destroy();
  });
});
