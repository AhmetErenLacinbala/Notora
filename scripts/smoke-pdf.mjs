import assert from 'node:assert/strict';
import { openAsBlob } from 'node:fs';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';

const origin = process.argv[2] || 'http://127.0.0.1:3310';
const fixture = process.argv[3] || 'work/notora-test-book.pdf';
const started = performance.now();
const health = await fetch(`${origin}/healthz`);
assert.equal(health.status, 200);
const data = new FormData();
data.set('file', await openAsBlob(fixture, { type: 'application/pdf' }), basename(fixture));
const response = await fetch(`${origin}/api/documents`, { method: 'POST', body: data });
assert.equal(response.status, 202, await response.clone().text());
const uploaded = await response.json();
const uploadMs = Math.round(performance.now() - started);
const headers = { Authorization: `Bearer ${uploaded.accessToken}` };
const url = `${origin}/api/documents/${uploaded.documentId}`;
assert.equal((await fetch(url)).status, 401);
assert.equal((await fetch(url, { headers: { Authorization: 'Bearer incorrect' } })).status, 404);
let manifest;
for (let attempt = 0; attempt < 300; attempt++) {
  manifest = await (await fetch(url, { headers })).json();
  if (manifest.status !== 'processing') break;
  await new Promise(resolve => setTimeout(resolve, 1000));
}
assert.equal(manifest.status, 'ready', manifest.error);
assert.equal(manifest.pageCount, 320);
assert.deepEqual(manifest.pages[1], { number: 2, width: 842, height: 595 });
assert.deepEqual(manifest.pages[2], { number: 3, width: 1110, height: 1560 });
assert.equal(manifest.outline[0].destination.page, 37);
const links = await (await fetch(`${url}/pages/1/links`, { headers })).json();
assert.equal(links[0].destination.page, 37);
const pageResponse = await fetch(`${url}/pages/37.pdf?v=${manifest.version}`, { headers });
assert.equal(pageResponse.status, 200);
const page = new Uint8Array(await pageResponse.arrayBuffer());
assert.equal(new TextDecoder().decode(page.subarray(0, 5)), '%PDF-');
const etag = pageResponse.headers.get('etag');
assert.equal((await fetch(`${url}/pages/37.pdf`, { headers: { ...headers, 'If-None-Match': etag } })).status, 304);
assert.equal((await fetch(`${url}/pages/321.pdf`, { headers })).status, 404);
assert.equal((await fetch(`${url}/pages/37.pdf?v=wrong`, { headers })).status, 404);
const report = {
  fixture: basename(fixture), sourceBytes: (await stat(fixture)).size,
  pageCount: manifest.pageCount, onePageBytes: page.length,
  uploadMs, readyMs: Math.round(performance.now() - started),
  checks: ['capability auth', 'page isolation', 'rotation', 'crop and UserUnit', 'outline', 'internal link', 'ETag', 'page/version bounds'],
};
await mkdir('work', { recursive: true });
await writeFile(`work/${basename(fixture, '.pdf')}-session.json`, JSON.stringify({ origin, ...uploaded }), { mode: 0o600 });
await writeFile(`work/${basename(fixture, '.pdf')}-report.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
