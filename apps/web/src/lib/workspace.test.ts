import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import {
  noteFontSize, type ClientMessage, type DocumentManifest, type NoteMeta,
  type ServerMessage, type SessionOptions,
} from '../../../../packages/shared/src/index';

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

class Socket {
  static OPEN = 1;
  static readonly instances: Socket[] = [];
  readyState = 0;
  sent: ClientMessage[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(readonly url: string) { Socket.instances.push(this); }
  open(): void { this.readyState = Socket.OPEN; this.onopen?.(); }
  receive(message: ServerMessage): void { this.onmessage?.({ data: JSON.stringify(message) }); }
  send(serialized: string): void { this.sent.push(JSON.parse(serialized) as ClientMessage); }
  close(): void { this.readyState = 3; this.onclose?.(); }
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

async function online(session: WorkspaceSession): Promise<Socket> {
  session.connect();
  await vi.waitFor(() => expect(Socket.instances.length).toBeGreaterThan(0));
  const socket = Socket.instances.at(-1)!;
  socket.open();
  expect(socket.sent[0]?.type).toBe('join');
  socket.receive({ type: 'welcome', clientId: 'client', participants: [] });
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
    secondSocket.receive({ type: 'welcome', clientId: 'client', participants: [] });
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
});
