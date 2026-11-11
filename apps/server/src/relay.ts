import type { IncomingMessage } from 'node:http';
import type { FastifyInstance } from 'fastify';
import { WebSocket, WebSocketServer } from 'ws';
import * as Y from 'yjs';
import type { ClientMessage, CubicBezier, CursorPosition, DrawingMeta, DrawingPreviewPacket, Participant, ServerMessage } from '../../../packages/shared/src/index.ts';
import { INDEX_KEY, MAX_DRAWING_SEGMENTS, MAX_PREVIEW_POINTS, REMOVED_CLOSE_CODE } from '../../../packages/shared/src/index.ts';
import { decodeCurves } from '../../../packages/shared/src/drawing.ts';
import type { DocumentStore } from './store.ts';

const MAX_FRAME_BYTES = 12 * 1024 * 1024;
const MAX_UPDATE_BYTES = 8 * 1024 * 1024;
const MAX_ROOM_BYTES = 32 * 1024 * 1024;
const MAX_NOTES = 10_000;
const MAX_DRAWINGS = 10_000;
const MAX_DRAWING_BODY_BYTES = 1024 * 1024;
const MAX_PREVIEW_BUFFERED_POINTS = 8192;
const PREVIEW_IDLE_MS = 8_000;
const PREVIEW_RATE_PER_MS = 25 / 1_000;
const PREVIEW_BURST = 5;
const ROOM_PREVIEW_RATE_PER_MS = 100 / 1_000;
const ROOM_PREVIEW_BURST = 20;
const MAX_COORDINATE = 10_000_000;
const PALETTE = ['#2563eb', '#b45309', '#0f766e', '#a21caf', '#b91c1c', '#4f46e5', '#15803d'];
const KEY_PATTERN = /^(?:note|drawing):[A-Za-z0-9_-]{1,128}$/;
const DRAWING_KEY_PATTERN = /^drawing:[A-Za-z0-9_-]{1,128}$/;

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
  preview: { packet: DrawingPreviewPacket; pointCount: number; lastAt: number } | null;
  previewTokens: number;
  previewBudgetAt: number;
}

interface Room {
  peers: Set<Peer>;
  docs: Map<string, Y.Doc>;
  acceptedBytes: number;
  pageCount: number;
  previewTokens: number;
  previewBudgetAt: number;
}

function send(socket: WebSocket, message: ServerMessage): void {
  if (socket.readyState !== WebSocket.OPEN) return;
  if (socket.bufferedAmount > 16 * 1024 * 1024) { socket.terminate(); return; }
  socket.send(JSON.stringify(message));
}

function validKey(key: unknown): key is string {
  return key === INDEX_KEY || (typeof key === 'string' && KEY_PATTERN.test(key));
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
    packet.points.every(point => !!point && typeof point === 'object' &&
      Number.isFinite(point.x) && Number.isFinite(point.y) &&
      Math.abs(point.x) <= MAX_COORDINATE && Math.abs(point.y) <= MAX_COORDINATE);
}

function geometryMatchesBounds(meta: DrawingMeta, curves: CubicBezier[]): boolean {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const include = (x: number, y: number) => {
    minX = Math.min(minX, x); minY = Math.min(minY, y);
    maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
  };
  for (const curve of curves) for (let i = 0; i < 8; i += 2) include(curve[i], curve[i + 1]);
  if (meta.kind === 'arrow') {
    const curve = curves[curves.length - 1];
    const tipX = curve[6], tipY = curve[7];
    let dx = tipX - curve[4], dy = tipY - curve[5];
    if (Math.hypot(dx, dy) < 1e-10) { dx = tipX - curve[0]; dy = tipY - curve[1]; }
    const length = Math.hypot(dx, dy);
    if (length >= 1e-10) {
      const tx = dx / length, ty = dy / length, size = Math.max(8, meta.width * 4);
      const backX = tipX - tx * size, backY = tipY - ty * size;
      include(backX - ty * size * 0.5, backY + tx * size * 0.5);
      include(backX + ty * size * 0.5, backY - tx * size * 0.5);
    }
  }
  const pad = meta.width / 2;
  const bounds = meta.bounds;
  const tolerance = 0.01;
  return Math.abs(bounds.minX - (minX - pad)) <= tolerance &&
    Math.abs(bounds.minY - (minY - pad)) <= tolerance &&
    Math.abs(bounds.maxX - (maxX + pad)) <= tolerance &&
    Math.abs(bounds.maxY - (maxY + pad)) <= tolerance;
}

function immutableDrawingMeta(before: DrawingMeta, after: DrawingMeta): boolean {
  return before.kind === after.kind && before.anchorPage === after.anchorPage && before.width === after.width &&
    before.bounds.minX === after.bounds.minX && before.bounds.minY === after.bounds.minY &&
    before.bounds.maxX === after.bounds.maxX && before.bounds.maxY === after.bounds.maxY;
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

  const broadcastPreview = (peer: Peer, preview: DrawingPreviewPacket | null) => {
    const message: ServerMessage = { type: 'drawing-preview', clientId: peer.id, preview };
    for (const other of peer.room.peers) if (other !== peer) send(other.socket, message);
  };

  const clearPreview = (peer: Peer, notify = true) => {
    if (!peer.preview) return;
    peer.preview = null;
    if (notify) broadcastPreview(peer, null);
  };

  const previewExpiry = setInterval(() => {
    const now = Date.now();
    for (const room of rooms.values()) {
      for (const peer of room.peers) {
        if (peer.preview && now - peer.preview.lastAt > PREVIEW_IDLE_MS) clearPreview(peer);
      }
    }
  }, 1_000);
  previewExpiry.unref();

  const broadcastParticipants = (room: Room) => {
    const message: ServerMessage = { type: 'participants', participants: participants(room) };
    for (const peer of room.peers) send(peer.socket, message);
  };

  const removePeer = (peer: Peer) => {
    const room = peer.room;
    if (!room.peers.delete(peer)) return;
    clearPreview(peer);
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
    const drawing = DRAWING_KEY_PATTERN.test(key);
    if (drawing && !room.docs.get(INDEX_KEY)?.getMap('drawings').has(key.slice(8))) {
      send(peer.socket, { type: 'error', message: 'Unknown drawing' }); return;
    }
    if (!previous && room.docs.size >= MAX_NOTES + MAX_DRAWINGS + 1) {
      send(peer.socket, { type: 'error', message: 'Too many items' }); return;
    }
    if (room.acceptedBytes + bytes.length > MAX_ROOM_BYTES - MAX_UPDATE_BYTES) compactRoom(room);
    const stage = key === INDEX_KEY || drawing || room.acceptedBytes + bytes.length > MAX_ROOM_BYTES - MAX_UPDATE_BYTES
      || (key !== INDEX_KEY && (previous?.getText('text').length ?? 0) + bytes.length > 1_000_000);
    const doc = stage || !previous ? new Y.Doc() : previous;
    if (stage && previous) Y.applyUpdate(doc, Y.encodeStateAsUpdate(previous));
    let changedBytes: number;
    try {
      changedBytes = applyTo(doc, bytes);
      if (changedBytes === 0) { if (doc !== previous) doc.destroy(); return; }
      if (drawing && previous) {
        doc.destroy();
        send(peer.socket, { type: 'error', message: 'Drawing geometry is final' });
        return;
      }
      if (drawing) {
        const geometry = doc.getMap('geometry');
        const curves = geometry.get('curves');
        const decoded = curves instanceof Uint8Array ? decodeCurves(curves) : null;
        const meta = room.docs.get(INDEX_KEY)?.getMap<DrawingMeta>('drawings').get(key.slice(8));
        if (geometry.get('version') !== 1 || geometry.size !== 2 || !decoded ||
            decoded.length < 1 || decoded.length > MAX_DRAWING_SEGMENTS ||
            !meta || !geometryMatchesBounds(meta, decoded) ||
            Y.encodeStateAsUpdate(doc).byteLength > MAX_DRAWING_BODY_BYTES) {
          doc.destroy();
          send(peer.socket, { type: 'error', message: 'Invalid drawing geometry' });
          return;
        }
      }
      if (key !== INDEX_KEY && !drawing && doc.getText('text').length > 1_000_000) {
        if (doc !== previous) doc.destroy();
        send(peer.socket, { type: 'error', message: 'Text limit exceeded' });
        return;
      }
      if (key === INDEX_KEY) {
        const drawings = doc.getMap<DrawingMeta>('drawings');
        if (doc.getMap('notes').size > MAX_NOTES || drawings.size > MAX_DRAWINGS ||
            [...drawings].some(([id, value]) => {
              if (!validDrawingMeta(value, id, room.pageCount)) return true;
              const old = previous?.getMap<DrawingMeta>('drawings').get(id);
              if (old && !immutableDrawingMeta(old, value)) return true;
              const encoded = room.docs.get(`drawing:${id}`)?.getMap('geometry').get('curves');
              const curves = encoded instanceof Uint8Array ? decodeCurves(encoded) : null;
              return !!curves && !geometryMatchesBounds(value, curves);
            })) {
          doc.destroy();
          send(peer.socket, { type: 'error', message: 'Invalid drawing index' });
          return;
        }
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
    if (key === INDEX_KEY) {
      const drawings = doc.getMap('drawings');
      let removed = false;
      for (const [bodyKey, body] of room.docs) {
        if (DRAWING_KEY_PATTERN.test(bodyKey) && !drawings.has(bodyKey.slice(8))) {
          room.docs.delete(bodyKey);
          body.destroy();
          removed = true;
        }
      }
      if (removed) compactRoom(room);
    }
    const message: ServerMessage = { type: 'update', key, update: encoded };
    for (const recipient of room.peers) {
      if (recipient === peer) continue;
      if (key === INDEX_KEY || recipient.owner || recipient.subscriptions.has(key)) send(recipient.socket, message);
    }
    if (drawing) {
      for (const active of room.peers) {
        if (active.preview?.packet.id === key.slice(8)) clearPreview(active, false);
      }
    }
  };

  const relayPreview = (peer: Peer, value: unknown) => {
    if (value === null) { clearPreview(peer); return; }
    if (!validPreview(value, peer.room.pageCount)) {
      clearPreview(peer);
      return;
    }
    const now = Date.now();
    if (peer.preview && now - peer.preview.lastAt > PREVIEW_IDLE_MS) clearPreview(peer);
    const old = peer.preview;
    peer.previewTokens = Math.min(PREVIEW_BURST, peer.previewTokens + Math.max(0, now - peer.previewBudgetAt) * PREVIEW_RATE_PER_MS);
    peer.previewBudgetAt = now;
    const room = peer.room;
    room.previewTokens = Math.min(ROOM_PREVIEW_BURST, room.previewTokens + Math.max(0, now - room.previewBudgetAt) * ROOM_PREVIEW_RATE_PER_MS);
    room.previewBudgetAt = now;
    if (peer.previewTokens < 1 || room.previewTokens < 1 ||
        peer.room.docs.get(INDEX_KEY)?.getMap('drawings').has(value.id) ||
        old && (old.packet.id !== value.id || old.packet.kind !== value.kind ||
          old.packet.anchorPage !== value.anchorPage || old.packet.x !== value.x ||
          old.packet.y !== value.y || old.packet.width !== value.width ||
          value.seq !== 0 && value.seq !== old.packet.seq + 1) ||
        !old && value.seq !== 0 ||
        (value.seq === 0 ? 0 : old?.pointCount ?? 0) + value.points.length > MAX_PREVIEW_BUFFERED_POINTS) {
      clearPreview(peer);
      return;
    }
    peer.previewTokens -= 1;
    room.previewTokens -= 1;
    const packet: DrawingPreviewPacket = {
      id: value.id, kind: value.kind, anchorPage: value.anchorPage,
      x: value.x, y: value.y, width: value.width, seq: value.seq,
      points: value.points.map(({ x, y }) => ({ x, y })),
    };
    peer.preview = { packet: { ...packet, points: [] }, pointCount: (value.seq === 0 ? 0 : old?.pointCount ?? 0) + value.points.length, lastAt: now };
    broadcastPreview(peer, packet);
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
      room = { peers: new Set(), docs: new Map(), acceptedBytes: 0, pageCount: auth.record.manifest.pageCount,
        previewTokens: ROOM_PREVIEW_BURST, previewBudgetAt: Date.now() };
      rooms.set(message.documentId, room);
    }
    room.pageCount = auth.record.manifest.pageCount;
    if (room.peers.size >= 32) { socket.close(1013, 'Room is full'); return null; }
    if ([...room.peers].some(peer => peer.id === message.clientId)) {
      socket.close(1008, 'Client ID already in use');
      return null;
    }
    const peer: Peer = {
      socket, id: message.clientId, name: message.name.trim(), color: colorFor(message.clientId),
      owner: auth.owner, cursor: null, subscriptions: new Set(), room, lastCursorAt: 0,
      preview: null, previewTokens: PREVIEW_BURST, previewBudgetAt: Date.now(),
    };
    room.peers.add(peer);
    store.recordDashboardAccess?.(message.documentId, peer.owner ? peer.name : undefined);
    send(socket, { type: 'welcome', clientId: peer.id, participants: participants(room) });
    sendState(peer, INDEX_KEY);
    if (peer.owner) for (const key of room.docs.keys()) if (key !== INDEX_KEY) sendState(peer, key);
    broadcastParticipants(room);
    return peer;
  }

  function handleMessage(peer: Peer, message: ClientMessage): void {
    if (!peer.room.peers.has(peer)) return;
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
    } else if (message.type === 'drawing-preview') {
      relayPreview(peer, message.preview);
    } else if (message.type === 'kick') {
      if (!peer.owner) { send(peer.socket, { type: 'error', message: 'Only the owner can remove participants' }); return; }
      if (typeof message.clientId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(message.clientId)) {
        send(peer.socket, { type: 'error', message: 'Invalid participant' }); return;
      }
      const target = [...peer.room.peers].find(other => other.id === message.clientId);
      if (!target) { send(peer.socket, { type: 'error', message: 'Participant unavailable' }); return; }
      if (target === peer || target.owner) {
        send(peer.socket, { type: 'error', message: 'Cannot remove an owner' }); return;
      }
      send(target.socket, { type: 'removed', message: 'The document owner removed you from this session.' });
      target.socket.close(REMOVED_CLOSE_CODE, 'Removed by owner');
      removePeer(target);
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
      if (socket.readyState !== WebSocket.OPEN || peer && !peer.room.peers.has(peer)) return;
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
    clearInterval(previewExpiry);
    for (const socket of sockets) socket.terminate();
    await new Promise<void>(resolve => wss.close(() => resolve()));
  });
}
