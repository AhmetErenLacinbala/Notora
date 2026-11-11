import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import * as Y from 'yjs';
import {
  type CubicBezier, type DrawingMeta, type DrawingPreviewPacket, type ServerMessage,
} from '../../../packages/shared/src/index.ts';
import { encodeCurves } from '../../../packages/shared/src/drawing.ts';
import type { DocumentStore } from './store.ts';
import { attachRelay } from './relay.ts';

class Messages {
  readonly socket: WebSocket;
  private readonly received: ServerMessage[] = [];
  private readonly waiters: Array<() => void> = [];

  constructor(url: string) {
    this.socket = new WebSocket(url);
    this.socket.on('message', raw => {
      this.received.push(JSON.parse(raw.toString()) as ServerMessage);
      for (const wake of this.waiters.splice(0)) wake();
    });
  }

  async open(): Promise<void> {
    if (this.socket.readyState === WebSocket.OPEN) return;
    await new Promise<void>((resolve, reject) => {
      this.socket.once('open', () => resolve());
      this.socket.once('error', reject);
    });
  }

  send(message: unknown): void { this.socket.send(JSON.stringify(message)); }

  async next(predicate: (message: ServerMessage) => boolean): Promise<ServerMessage> {
    const deadline = Date.now() + 3_000;
    for (;;) {
      const index = this.received.findIndex(predicate);
      if (index >= 0) return this.received.splice(index, 1)[0];
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error('WebSocket message timed out');
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('WebSocket message timed out')), remaining);
        this.waiters.push(() => { clearTimeout(timeout); resolve(); });
      });
    }
  }

  close(): void { this.socket.terminate(); }
}

const curves: CubicBezier[] = [[0, 0, 5, 0, 15, 0, 20, 0]];
const meta: DrawingMeta = {
  id: 'draw1', kind: 'stroke', anchorPage: 1, x: 40, y: 50, width: 2,
  bounds: { minX: -1, minY: -1, maxX: 21, maxY: 1 },
};
const preview: DrawingPreviewPacket = {
  id: 'draw1', kind: 'stroke', anchorPage: 1, x: 40, y: 50, width: 2,
  seq: 0, points: [{ x: 0, y: 0 }],
};
const base64 = (doc: Y.Doc) => Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64');

describe('drawing relay', () => {
  it('forwards consecutive completed strokes in order, including one across a page boundary', async () => {
    const app = Fastify();
    const store = {
      authorize(documentId: string, accessToken: string) {
        if (documentId !== 'document' || accessToken !== 'access') return null;
        return { record: { manifest: { pageCount: 2 } }, owner: false };
      },
    } as unknown as DocumentStore;
    attachRelay(app, store);
    let sender: Messages | undefined;
    let receiver: Messages | undefined;
    try {
      const address = await app.listen({ host: '127.0.0.1', port: 0 });
      const url = `${address.replace(/^http/, 'ws')}/ws`;
      sender = new Messages(url);
      receiver = new Messages(url);
      await sender.open();
      sender.send({ type: 'join', documentId: 'document', accessToken: 'access', clientId: 'sender', name: 'Sender' });
      await sender.next(message => message.type === 'welcome');
      await receiver.open();
      receiver.send({ type: 'join', documentId: 'document', accessToken: 'access', clientId: 'receiver', name: 'Receiver' });
      await receiver.next(message => message.type === 'welcome');
      receiver.send({ type: 'subscribe', keys: ['drawing:draw1', 'drawing:draw2', 'drawing:draw3'] });

      const index = new Y.Doc();
      index.on('update', update => sender!.send({ type: 'update', key: 'index', update: Buffer.from(update).toString('base64') }));
      for (const [number, y] of [700, 790, 830].entries()) {
        const id = `draw${number + 1}`;
        index.getMap<DrawingMeta>('drawings').set(id, { ...meta, id, y });
        const body = new Y.Doc();
        body.transact(() => {
          body.getMap('geometry').set('version', 1);
          body.getMap('geometry').set('curves', encodeCurves(curves));
        });
        sender.send({ type: 'update', key: `drawing:${id}`, update: base64(body) });
      }
      for (let number = 1; number <= 3; number++) {
        const received = await receiver.next(message => message.type === 'update' && message.key === `drawing:draw${number}`);
        if (received.type !== 'update') throw new Error('Expected drawing update');
        const body = new Y.Doc();
        Y.applyUpdate(body, Buffer.from(received.update, 'base64'));
        expect(body.getMap('geometry').get('curves')).toEqual(encodeCurves(curves));
      }
    } finally {
      sender?.close();
      receiver?.close();
      await app.close();
    }
  });

  it('validates drawing index/body and bounds preview deltas while routing geometry to an offscreen owner', async () => {
    const app = Fastify();
    const store = {
      authorize(documentId: string, accessToken: string, ownerToken?: string) {
        if (documentId !== 'document' || accessToken !== 'access' || ownerToken && ownerToken !== 'owner') return null;
        return { record: { manifest: { pageCount: 2 } }, owner: ownerToken === 'owner' };
      },
    } as unknown as DocumentStore;
    attachRelay(app, store);
    let owner: Messages | undefined;
    let guest: Messages | undefined;
    try {
      const address = await app.listen({ host: '127.0.0.1', port: 0 });
      const url = `${address.replace(/^http/, 'ws')}/ws`;
      owner = new Messages(url);
      guest = new Messages(url);
      await owner.open();
      owner.send({ type: 'join', documentId: 'document', accessToken: 'access', ownerToken: 'owner', clientId: 'owner', name: 'Owner' });
      await owner.next(message => message.type === 'welcome');
      await guest.open();
      guest.send({ type: 'join', documentId: 'document', accessToken: 'access', clientId: 'guest', name: 'Guest' });
      await guest.next(message => message.type === 'welcome');

      guest.send({ type: 'drawing-preview', preview });
      expect(await owner.next(message => message.type === 'drawing-preview' && message.preview?.seq === 0))
        .toMatchObject({ clientId: 'guest', preview });
      guest.send({ type: 'drawing-preview', preview: { ...preview, seq: 1, points: [{ x: 10, y: 0 }] } });
      expect(await owner.next(message => message.type === 'drawing-preview' && message.preview?.seq === 1))
        .toMatchObject({ clientId: 'guest' });
      guest.send({ type: 'drawing-preview', preview: { ...preview, seq: 3 } });
      expect(await owner.next(message => message.type === 'drawing-preview' && message.preview === null))
        .toMatchObject({ clientId: 'guest', preview: null });
      guest.send({ type: 'drawing-preview', preview });
      await owner.next(message => message.type === 'drawing-preview' && message.preview?.seq === 0);
      guest.send({ type: 'drawing-preview', preview: { ...preview, points: Array.from({ length: 257 }, (_, x) => ({ x, y: 0 })) } });
      expect(await owner.next(message => message.type === 'drawing-preview' && message.preview === null))
        .toMatchObject({ clientId: 'guest', preview: null });

      const invalid = new Y.Doc();
      invalid.getMap<DrawingMeta>('drawings').set(meta.id, { ...meta, bounds: { minX: NaN, minY: 0, maxX: 1, maxY: 1 } });
      guest.send({ type: 'update', key: 'index', update: base64(invalid) });
      expect(await guest.next(message => message.type === 'error')).toMatchObject({ message: 'Invalid drawing index' });

      const index = new Y.Doc();
      index.getMap<DrawingMeta>('drawings').set(meta.id, meta);
      index.getMap<DrawingMeta>('drawings').set('draw2', {
        ...meta, id: 'draw2', bounds: { minX: 0, minY: 0, maxX: 1, maxY: 1 },
      });
      guest.send({ type: 'update', key: 'index', update: base64(index) });
      expect(await owner.next(message => message.type === 'update' && message.key === 'index')).toMatchObject({ key: 'index' });

      const malformed = new Y.Doc();
      malformed.getMap('geometry').set('version', 1);
      malformed.getMap('geometry').set('curves', new Uint8Array([1, 2, 3]));
      guest.send({ type: 'update', key: 'drawing:draw1', update: base64(malformed) });
      expect(await guest.next(message => message.type === 'error')).toMatchObject({ message: 'Invalid drawing geometry' });

      const body = new Y.Doc();
      body.transact(() => {
        body.getMap('geometry').set('version', 1);
        body.getMap('geometry').set('curves', encodeCurves(curves));
      });
      guest.send({ type: 'update', key: 'drawing:draw2', update: base64(body) });
      expect(await guest.next(message => message.type === 'error')).toMatchObject({ message: 'Invalid drawing geometry' });
      guest.send({ type: 'update', key: 'drawing:draw1', update: base64(body) });
      const ownerBody = await owner.next(message => message.type === 'update' && message.key === 'drawing:draw1');
      expect(ownerBody).toMatchObject({ key: 'drawing:draw1' });
      body.getMap('geometry').set('curves', encodeCurves([[0, 0, 5, 5, 15, 5, 20, 0]]));
      guest.send({ type: 'update', key: 'drawing:draw1', update: base64(body) });
      expect(await guest.next(message => message.type === 'error')).toMatchObject({ message: 'Drawing geometry is final' });

      index.getMap('drawings').delete(meta.id);
      guest.send({ type: 'update', key: 'index', update: base64(index) });
      await owner.next(message => message.type === 'update' && message.key === 'index');
      guest.send({ type: 'state', key: 'drawing:draw1', update: base64(body) });
      expect(await guest.next(message => message.type === 'error')).toMatchObject({ message: 'Unknown drawing' });
    } finally {
      owner?.close();
      guest?.close();
      await app.close();
    }
  });
});
