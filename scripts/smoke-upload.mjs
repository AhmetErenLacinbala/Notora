import assert from 'node:assert/strict';
import { open, mkdir, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const origin = process.argv[2] || 'http://127.0.0.1:3312';
const fixture = process.argv[3] || 'work/notora-test-book.pdf';
const bytesPerSecond = Number(process.argv[4] || 0);
const file = await open(fixture, 'r');
const { size } = await file.stat();
const started = performance.now();
const request = (path, init = {}) => fetch(`${origin}${path}`, { ...init, signal: AbortSignal.timeout(45_000) });
const created = await request('/api/uploads', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ filename: basename(fixture), size }),
});
assert.equal(created.status, 201, await created.clone().text());
const session = await created.json();
const path = `/api/uploads/${session.uploadId}`;
const headers = { Authorization: `Bearer ${session.uploadToken}` };
assert.equal((await request(path)).status, 401);
let offset = 0;
let chunks = 0;
let maxRequestMs = 0;
const chunkSize = bytesPerSecond ? 16 * 1024 : 1024 * 1024;
try {
  while (offset < size) {
    const bytes = Buffer.alloc(Math.min(chunkSize, size - offset));
    const { bytesRead } = await file.read(bytes, 0, bytes.length, offset);
    assert.equal(bytesRead, bytes.length);
    const body = bytesPerSecond ? (async function* () {
      for (let at = 0; at < bytes.length; at += 4096) {
        const part = bytes.subarray(at, at + 4096);
        await delay(part.length / bytesPerSecond * 1000);
        yield part;
      }
    })() : bytes;
    const before = performance.now();
    const response = await request(path, {
      method: 'PUT', headers: { ...headers, 'Upload-Offset': String(offset), 'Content-Type': 'application/octet-stream', 'Content-Length': String(bytes.length) },
      body, ...(bytesPerSecond ? { duplex: 'half' } : {}),
    });
    assert.equal(response.status, 200, await response.clone().text());
    offset += bytes.length;
    assert.equal((await response.json()).offset, offset);
    maxRequestMs = Math.max(maxRequestMs, performance.now() - before);
    chunks++;
  }
} finally { await file.close(); }
assert.deepEqual(await (await request(path, { headers })).json(), { offset: size, size });
const completed = await request(`${path}/complete`, { method: 'POST', headers });
assert.equal(completed.status, 202, await completed.clone().text());
const result = await completed.json();
const replay = await request(`${path}/complete`, { method: 'POST', headers });
assert.equal(replay.status, 202);
assert.deepEqual(await replay.json(), result);
const uploadMs = Math.round(performance.now() - started);
const documentPath = `/api/documents/${result.documentId}`;
const access = { Authorization: `Bearer ${result.accessToken}` };
let manifest;
for (let attempt = 0; attempt < 180; attempt++) {
  const response = await request(documentPath, { headers: access });
  assert.equal(response.status, 200);
  manifest = await response.json();
  if (manifest.status !== 'processing') break;
  await delay(1000);
}
assert.equal(manifest.status, 'ready', manifest.error);
assert.equal(manifest.pageCount, 320);
const page = await request(`${documentPath}/pages/37.pdf`, { headers: access });
assert.equal(page.status, 200);
assert.equal(Buffer.from(await page.arrayBuffer()).subarray(0, 5).toString(), '%PDF-');
const report = {
  origin, sourceBytes: size, chunks, bytesPerSecond, uploadMs,
  maxRequestMs: Math.round(maxRequestMs), readyMs: Math.round(performance.now() - started),
  pageCount: manifest.pageCount,
  checks: ['upload capability', 'sequential offset', 'idempotent completion', 'PDF ready', 'page 37 download'],
};
await mkdir('work', { recursive: true });
const label = `${basename(fixture, '.pdf')}-chunk${bytesPerSecond ? '-slow' : ''}`;
await writeFile(`work/${label}-report.json`, JSON.stringify(report, null, 2));
await writeFile(`work/${label}-session.json`, JSON.stringify({ origin, ...result }), { mode: 0o600 });
console.log(JSON.stringify(report, null, 2));
