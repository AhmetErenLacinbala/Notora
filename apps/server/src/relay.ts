import type { IncomingMessage } from 'node:http';
import type { FastifyInstance } from 'fastify';
import { WebSocket, WebSocketServer } from 'ws';
import * as Y from 'yjs';
import type { ClientMessage, CursorPosition, Participant, ServerMessage } from '../../../packages/shared/src/index.ts';
import { INDEX_KEY } from '../../../packages/shared/src/index.ts';
import type { DocumentStore } from './store.ts';

const MAX_FRAME_BYTES = 12 * 1024 * 1024;
const MAX_UPDATE_BYTES = 8 * 1024 * 1024;
const MAX_ROOM_BYTES = 32 * 1024 * 1024;
const MAX_NOTES = 10_000;
const PALETTE = ['#2563eb', '#b45309', '#0f766e', '#a21caf', '#b91c1c', '#4f46e5', '#15803d'];
const KEY_PATTERN = /^note:[A-Za-z0-9_-]{1,128}$/;

interface Peer {
  socket: WebSocket;
  id: string;
  name: string;
  color: string;
  owner: boolean;
  cursor: CursorPosition | null;
  subscriptions: Set<string>;
  room: Room;
  lastCursorAt: number;
}

interface Room {
  peers: Set<Peer>;
  docs: Map<string, Y.Doc>;
  acceptedBytes: number;
}

function send(socket: WebSocket, message: ServerMessage): void {
  if (socket.readyState !== WebSocket.OPEN) return;
  if (socket.bufferedAmount > 16 * 1024 * 1024) { socket.terminate(); return; }
  socket.send(JSON.stringify(message));
}

function validKey(key: unknown): key is string {
  return key === INDEX_KEY || (typeof key === 'string' && KEY_PATTERN.test(key));
}

function validCursor(value: unknown): value is CursorPosition | null {
  if (value === null) return true;
  if (!value || typeof value !== 'object') return false;
  const cursor = value as CursorPosition;
  return Number.isFinite(cursor.x) && Number.isFinite(cursor.y) && Math.abs(cursor.x) <= 10_000_000 && Math.abs(cursor.y) <= 10_000_000;
}

function colorFor(id: string): string {
  let number = 0;
  for (const char of id) number = (number * 31 + char.charCodeAt(0)) >>> 0;
  return PALETTE[number % PALETTE.length];
}

function participants(room: Room): Participant[] {
  return [...room.peers].map(peer => ({
    clientId: peer.id, name: peer.name, color: peer.color, cursor: peer.cursor, owner: peer.owner,
  }));
}

function decodeUpdate(value: unknown): Uint8Array | null {
  if (typeof value !== 'string' || value.length > Math.ceil(MAX_UPDATE_BYTES * 4 / 3) + 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return null;
  const bytes = Buffer.from(value, 'base64');
  return bytes.length > 0 && bytes.length <= MAX_UPDATE_BYTES ? bytes : null;
}

export function attachRelay(server: FastifyInstance, store: DocumentStore): void {
  const rooms = new Map<string, Room>();
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES, perMessageDeflate: false });
  const sockets = new Set<WebSocket>();
  const lastPong = new WeakMap<WebSocket, number>();
  const heartbeat = setInterval(() => {
    const now = Date.now();
    for (const socket of sockets) {
      if (now - (lastPong.get(socket) ?? 0) > 45_000) socket.terminate();
      else if (socket.readyState === WebSocket.OPEN) socket.ping();
    }
  }, 30_000);
  heartbeat.unref();

  const broadcastParticipants = (room: Room) => {
    const message: ServerMessage = { type: 'participants', participants: participants(room) };
    for (const peer of room.peers) send(peer.socket, message);
  };

  const removePeer = (peer: Peer) => {
    const room = peer.room;
    if (!room.peers.delete(peer)) return;
    if (room.peers.size === 0) {
      for (const doc of room.docs.values()) doc.destroy();
      room.docs.clear();
      for (const [id, current] of rooms) if (current === room) rooms.delete(id);
    } else broadcastParticipants(room);
  };

  const askForState = (room: Room, key: string) => {
    const request: ServerMessage = { type: 'need-state', keys: [key] };
    const owners = [...room.peers].filter(peer => peer.owner);
    const others = [...room.peers].filter(peer => !peer.owner);
    for (const peer of [...owners, ...others]) send(peer.socket, request);
  };

  const sendState = (peer: Peer, key: string) => {
    const doc = peer.room.docs.get(key);
    if (doc) send(peer.socket, { type: 'update', key, update: Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64') });
    else askForState(peer.room, key);
  };

  const compactRoom = (room: Room) => {
    room.acceptedBytes = 0;
    for (const doc of room.docs.values()) room.acceptedBytes += Y.encodeStateAsUpdate(doc).byteLength;
  };

  const applyTo = (doc: Y.Doc, bytes: Uint8Array): number => {
    let changedBytes = 0;
    const count = (update: Uint8Array) => { changedBytes += update.byteLength; };
    doc.on('update', count);
    try { Y.applyUpdate(doc, bytes); } finally { doc.off('update', count); }
    return changedBytes;
  };

  const apply = (peer: Peer, key: string, encoded: string) => {
    if (!validKey(key)) { send(peer.socket, { type: 'error', message: 'Invalid note key' }); return; }
    const bytes = decodeUpdate(encoded);
    if (!bytes) { send(peer.socket, { type: 'error', message: 'Invalid update' }); return; }
    const room = peer.room;
    const previous = room.docs.get(key);
    if (!previous && room.docs.size >= MAX_NOTES + 1) { send(peer.socket, { type: 'error', message: 'Too many notes' }); return; }
    if (room.acceptedBytes + bytes.length > MAX_ROOM_BYTES - MAX_UPDATE_BYTES) compactRoom(room);
    const stage = key === INDEX_KEY || room.acceptedBytes + bytes.length > MAX_ROOM_BYTES - MAX_UPDATE_BYTES
      || (key !== INDEX_KEY && (previous?.getText('text').length ?? 0) + bytes.length > 1_000_000);
    const doc = stage || !previous ? new Y.Doc() : previous;
    if (stage && previous) Y.applyUpdate(doc, Y.encodeStateAsUpdate(previous));
    let changedBytes: number;
    try {
      changedBytes = applyTo(doc, bytes);
      if (changedBytes === 0) { if (doc !== previous) doc.destroy(); return; }
      if (key !== INDEX_KEY && doc.getText('text').length > 1_000_000) {
        if (doc !== previous) doc.destroy();
        send(peer.socket, { type: 'error', message: 'Text limit exceeded' });
        return;
      }
      if (key === INDEX_KEY && doc.getMap('notes').size > MAX_NOTES) {
        doc.destroy();
        send(peer.socket, { type: 'error', message: 'Too many notes' });
        return;
      }
    } catch {
      if (doc !== previous) doc.destroy();
      peer.socket.close(1007, 'Invalid Yjs update');
      return;
    }
    if (room.acceptedBytes + changedBytes > MAX_ROOM_BYTES) {
      if (doc !== previous) doc.destroy();
      send(peer.socket, { type: 'error', message: 'Room is full' });
      return;
    }
    if (doc !== previous) {
      room.docs.set(key, doc);
      previous?.destroy();
    }
    room.acceptedBytes += changedBytes;
    const message: ServerMessage = { type: 'update', key, update: encoded };
    for (const recipient of room.peers) {
      if (recipient === peer) continue;
      if (key === INDEX_KEY || recipient.owner || recipient.subscriptions.has(key)) send(recipient.socket, message);
    }
  };

  function join(socket: WebSocket, message: Extract<ClientMessage, { type: 'join' }>): Peer | null {
    if (typeof message.documentId !== 'string' || typeof message.accessToken !== 'string'
      || (message.ownerToken !== undefined && typeof message.ownerToken !== 'string')
      || typeof message.clientId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(message.clientId)
      || typeof message.name !== 'string' || !message.name.trim() || message.name.length > 80) {
      socket.close(1008, 'Invalid join');
      return null;
    }
    const auth = store.authorize(message.documentId, message.accessToken, message.ownerToken);
    if (!auth) { socket.close(1008, 'Access denied'); return null; }
    let room = rooms.get(message.documentId);
    if (!room) {
      room = { peers: new Set(), docs: new Map(), acceptedBytes: 0 };
      rooms.set(message.documentId, room);
    }
    if (room.peers.size >= 32) { socket.close(1013, 'Room is full'); return null; }
    for (const old of room.peers) {
      if (old.id === message.clientId) {
        room.peers.delete(old);
        old.socket.close(1000, 'Reconnected');
        break;
      }
    }
    // A reconnect may have removed the last peer and cleared the old room.
    room = rooms.get(message.documentId) ?? { peers: new Set(), docs: new Map(), acceptedBytes: 0 };
    rooms.set(message.documentId, room);
    const peer: Peer = {
      socket, id: message.clientId, name: message.name.trim(), color: colorFor(message.clientId),
      owner: auth.owner, cursor: null, subscriptions: new Set(), room, lastCursorAt: 0,
    };
    room.peers.add(peer);
    send(socket, { type: 'welcome', clientId: peer.id, participants: participants(room) });
    sendState(peer, INDEX_KEY);
    if (peer.owner) for (const key of room.docs.keys()) if (key !== INDEX_KEY) sendState(peer, key);
    broadcastParticipants(room);
    return peer;
  }

  function handleMessage(peer: Peer, message: ClientMessage): void {
    if (message.type === 'subscribe') {
      if (!Array.isArray(message.keys) || message.keys.length > 1024 || !message.keys.every(key => typeof key === 'string' && KEY_PATTERN.test(key))) {
        send(peer.socket, { type: 'error', message: 'Invalid subscriptions' }); return;
      }
      peer.subscriptions = new Set(message.keys);
      for (const key of peer.subscriptions) sendState(peer, key);
    } else if (message.type === 'update' || message.type === 'state') {
      apply(peer, message.key, message.update);
    } else if (message.type === 'cursor') {
      if (!validCursor(message.cursor)) return;
      const now = Date.now();
      if (message.cursor !== null && now - peer.lastCursorAt < 20) return;
      peer.lastCursorAt = now;
      peer.cursor = message.cursor;
      const broadcast: ServerMessage = { type: 'cursor', clientId: peer.id, cursor: peer.cursor };
      for (const other of peer.room.peers) if (other !== peer) send(other.socket, broadcast);
    } else {
      send(peer.socket, { type: 'error', message: 'Invalid message' });
    }
  }

  wss.on('connection', socket => {
    sockets.add(socket);
    lastPong.set(socket, Date.now());
    socket.on('pong', () => lastPong.set(socket, Date.now()));
    let peer: Peer | null = null;
    const joinTimeout = setTimeout(() => { if (!peer) socket.close(1008, 'Join required'); }, 5_000);
    socket.on('message', raw => {
      let message: ClientMessage;
      try {
        message = JSON.parse(raw.toString()) as ClientMessage;
        if (!message || typeof message !== 'object') throw new Error('Invalid message');
      } catch { socket.close(1007, 'Invalid message'); return; }
      if (!peer) {
        if (message.type !== 'join') { socket.close(1008, 'Join required'); return; }
        peer = join(socket, message);
        if (peer) clearTimeout(joinTimeout);
      } else if (message.type !== 'join') handleMessage(peer, message);
      else socket.close(1008, 'Already joined');
    });
    socket.on('close', () => {
      clearTimeout(joinTimeout);
      sockets.delete(socket);
      if (peer) removePeer(peer);
    });
    socket.on('error', () => { /* close handler releases room state */ });
  });

  const upgrade = (request: IncomingMessage, socket: import('node:net').Socket, head: Buffer) => {
    if (request.url !== '/ws') { socket.destroy(); return; }
    wss.handleUpgrade(request, socket, head, upgraded => wss.emit('connection', upgraded, request));
  };
  server.server.on('upgrade', upgrade);
  server.addHook('onClose', async () => {
    server.server.off('upgrade', upgrade);
    clearInterval(heartbeat);
    for (const socket of sockets) socket.terminate();
    await new Promise<void>(resolve => wss.close(() => resolve()));
  });
}
