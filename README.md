# Notora

A small shared PDF workspace. Open a PDF, double-click beside a page to write a note, and share its link to work together. Clicking a participant jumps to their cursor.

No accounts, drawing tools, or rich-text editor. Notes use plain text and literal newlines. They can extend outside a PDF page and across page boundaries.

## Storage

- **Server:** original PDF, individual page PDFs, page sizes, navigation metadata, and hashed access tokens. Docker stores these in the `notora-data` volume.
- **Browser:** display name, creator-only recent documents, camera position, requested PDF page cache, and Yjs note state in IndexedDB. Opening a shared link never adds it to the guest's recent list.
- **Live session:** note updates and cursor positions travel through WebSocket. The server holds shared note state only in memory and releases it when the last participant leaves.

Editing is immediate. Note persistence waits for **10 seconds without input**; hiding or closing the workspace attempts an earlier flush. Continuous input can postpone saving. A crash before a successful flush can lose unsaved changes.

PDFs remain available when the creator is offline, but notes can only be restored from a browser that has saved them. Clearing that browser's site data removes its notes and creator history. An access link grants reading and editing to anyone holding it; names do not establish ownership. The owner's additional token stays in their browser.

## Large PDFs

The server processes one PDF job at a time using qpdf and pypdf. It derives displayed page geometry (crop, rotation, and user units), outline destinations, and internal links before extracting standalone pages in a single qpdf pass.

The browser reads only requested cached pages, downloads missing pages, and renders a small visible neighborhood. At most two PDF load/render jobs run together; their workers are destroyed after rendering. Offscreen canvases and text layers are removed. All small page-size metadata is available for fast scrolling, while note bodies load by visible vertical intersection. The frontend never reconstructs a 150 MB source document in memory.

## Development

Requires Node.js 24+, qpdf, Python 3, and pypdf 7.0.1. A virtual environment is recommended:

```sh
npm ci
python3 -m venv .venv
.venv/bin/pip install pypdf==7.0.1
PYTHON_BIN=.venv/bin/python npm run dev
```

Run `npm run dev:web` separately. Vite uses port 5173 and proxies the API/WebSocket to port 3310. Both the development script and production build copy PDF.js's optional font, CMap, and WASM resources automatically.

```sh
npm run typecheck
npm test
npm run build
PORT=3310 PYTHON_BIN=.venv/bin/python npm start
```

Generate a 320-page fixture with outline, internal link, rotated page, and a cropped/UserUnit page:

```sh
node scripts/make-test-pdf.mjs
node scripts/make-test-pdf.mjs work/notora-large-book.pdf --large
```

The second fixture is approximately 154 MB. Generated fixtures stay in ignored `work/`.

## Docker deployment

The production Compose file expects the existing external `apps_web` network and Traefik's `le` HTTPS certificate resolver. The `notora.lacinbala.com` A record must point to the VPS. No database service or exposed host port is required.

```sh
cp .env.example .env
docker compose build
docker compose up -d
docker compose ps
```

Set `NOTORA_VERSION` and `REVISION` to the release commit when deploying. Defaults cap each upload at 256 MiB and total PDF storage at 2048 MiB; these can be changed in `.env`. Derived page PDFs can be larger in aggregate than the original because shared resources may be repeated. The service has bounded memory/CPU and log rotation.

`GET /healthz` returns status and the deployed revision. To back up PDFs, back up the `notora-data` volume; that volume does **not** contain browser-local notes. Never use `docker compose down -v` on a deployment whose PDFs should be preserved.

The shared types in `packages/shared/src/index.ts` and [implementation contract](docs/contract.md) define HTTP, WebSocket, note coordinates, and module ownership.

## Stack

React + TypeScript + Vite, PDF.js, IndexedDB (`idb`), Yjs, Fastify, WebSocket (`ws`), qpdf, and pypdf. One Node process serves the API, WebSocket, and built frontend from a single container.
