# Notora

A small shared PDF workspace. Open a PDF locally, write or draw beside its pages, and choose **Share → Upload this file** when you want to work together. Clicking a participant jumps to their cursor. Shared links open at the sender's page, position and zoom.

No accounts or rich-text editor. Notes use plain text and literal newlines. Notes and drawings can extend outside a PDF page and across page boundaries. The toolbar contains pen, arrow, eraser and text tools; the eraser removes whole strokes/arrows. With no tool selected, click once, then press and drag on the second click to handwrite. A quick double-click without dragging creates a text note.

Notes have a translucent pink fill and border. Select a note to show its two font-size buttons; drag its border to move it. Drag empty space to select multiple boxes, then drag a selected border to move them together. Delete/Backspace removes selected boxes when focus is outside their text; inside a note it edits text normally.

The workspace behaves like a canvas. Scroll or use a trackpad to pan; Command/Ctrl + scroll zooms around the pointer. The zoom buttons use the center of the viewport. No oversized native horizontal scrollbar is needed.

## Storage

- **Private R2 storage (after explicit upload):** original PDF, individual page PDFs, page sizes, navigation metadata and private upload provenance under `notora/<document-id>/`. The VPS processes one PDF at a time, publishes its objects with at most three concurrent transfers, then removes the local binary files after verified publication. Small document records, hashed capabilities, quota accounting and the dashboard SQLite database remain in the `notora-data` volume. Without R2 configuration, local development retains files in that volume.
- **Creator browser:** local PDF Blobs, display name, creator-only recent documents, camera position, requested PDF page cache, and Yjs note/drawing state in IndexedDB. Guests keep document data in session RAM and retain only their small display-name profile; opening a shared link never adds it to their recent list. Local PDF metadata is stored separately from its Blob, so listing history does not load the files. SHA-256 content identity reuses an earlier local/shared session even if the filename changes.
- **Live session:** text, final drawing updates, transient stroke previews and cursor positions travel through WebSocket. The server holds shared annotation state only in memory and releases it when the last participant leaves.

Editing is immediate. Annotation persistence waits for **10 seconds without input**; hiding or closing the workspace attempts an earlier flush. Continuous input can postpone saving. A crash before a successful flush can lose unsaved changes. Freehand samples are fitted to piecewise cubic Bézier curves on release using least squares, bounded refinement and recursive error splitting. Final geometry is stored as compact float32 bytes; in-progress samples are transient and never saved as a second copy.

Uploaded PDFs remain available when the creator is offline, but annotations can only be restored from a browser that has saved them. Clearing that browser's site data removes its local PDFs, annotations and creator history. An access link grants reading and editing to anyone holding it; names do not establish ownership. The owner's additional token stays in their browser.

## Private dashboard

Open `/dashboard` directly to sign in to the operator panel. It lists uploaded PDFs, the creator/host name and profile ID, upload IP and country when available, upload and last access times, and source/derived storage sizes. The protected panel also shows storage/operation budgets and can delete a complete document after confirmation. Profile IDs and names are informational; owner capability tokens remain the authorization mechanism. Times use the browser's local time zone. Historic host names and access timestamps that were not recorded appear as **Not recorded**; a subsequent verified owner visit fills the host name. A guest cannot replace it. The operator login is separate from document-owner permissions and never grants document capabilities to visitors.

Configure `DASHBOARD_USERNAME` and `DASHBOARD_PASSWORD_HASH` only in the VPS `.env`. The hash format is `scrypt:<salt hex>:<digest hex>`: 16 random salt bytes, decoded from hex before deriving a 64-byte key with Node's default scrypt parameters (N=16384, r=8, p=1). Keep the file private and never commit credentials. Login fails closed when configuration is absent. `PUBLIC_ORIGIN` identifies the allowed browser origin; Compose already sets the production HTTPS origin.

Sessions use expiring HttpOnly cookies, Secure in production, and are revoked on logout or server restart. Dashboard metadata is stored in `/data/dashboard.sqlite3` inside the existing volume. It contains no PDF bytes or annotations. Back up the whole volume consistently, including SQLite sidecar files, or use a SQLite backup while the service is running.

## Large PDFs

Opening a file does not upload it. The local PDF reader supplies bounded Blob ranges to one PDF.js document/worker, reads page dimensions without rasterizing every page, and renders only nearby pages. Content hashing also uses bounded Blob slices. Opening Share alone still sends no PDF bytes; uploading starts only after its explicit button is pressed.

Uploads use sequential, adaptive HTTP chunks (16 KiB–1 MiB) written into one temporary file. Each request stays short enough for the shared proxy, with bounded retries and an offset check after interrupted requests. No full-file browser buffer or permanent chunk files are created. Upload reservations grow with received bytes. Status polls never extend a session. Sessions have separate first-data, idle-progress and absolute deadlines; a server restart requires restarting an unfinished upload.

The server processes one PDF job at a time using qpdf and pypdf. It derives displayed page geometry (crop, rotation, and user units), outline destinations, and internal links before extracting standalone pages in a single qpdf pass.

The browser reads only requested cached pages, downloads missing pages, and starts rendering a small visible neighborhood. A four-slot transfer queue fetches missing page data independently of the two-slot rendering queue; remote page workers are destroyed after rendering. Queued offscreen work is cancelled. On desktop, completed canvases, text layers and links stay in memory for the open document, so returning to a page does not reload it. Memory use therefore grows with the pages visited. Touch/mobile devices still release offscreen pages. Zoom keeps the previous canvas visible until its replacement is ready. All small page-size metadata is available for navigation, while note and drawing bodies load by visible vertical intersection. The frontend never reconstructs a 150 MB source document in memory.

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

GitHub Actions validates every pull request and every `main` push. After the checks pass on `main`, it deploys the private Cloudflare storage gateway, then builds the Linux amd64 image and publishes it to GitHub Container Registry:

- `ghcr.io/ahmeterenlacinbala/notora:latest` for automatic releases.
- `ghcr.io/ahmeterenlacinbala/notora:sha-<full-commit-sha>` for an exact release or rollback.

Container publication uses the repository's `GITHUB_TOKEN`; it needs no VPS SSH key or long-lived registry publishing secret. Gateway deployment uses the account-scoped `CLOUDFLARE_API_TOKEN` GitHub Actions secret and `CLOUDFLARE_ACCOUNT_ID` repository variable. The separate gateway bearer secret is configured in Cloudflare and the VPS only. The image embeds the full commit SHA in its OCI label and `/healthz` response. Publication is serialized so concurrent pushes cannot overwrite `latest` out of order.

The production Compose file pulls this image; it no longer builds source on the VPS. It expects the existing external `apps_web` network and Traefik's `le` HTTPS certificate resolver. The `notora.lacinbala.com` A record must point to the VPS. No database service or exposed host port is required.

For initial installation, copy `docker-compose.yml` and `.env.example` to `/srv/apps/notora`, then:

```sh
cd /srv/apps/notora
cp .env.example .env
docker compose pull app
docker compose up -d --no-build app
docker compose ps
```

For an existing installation, back up `.env`, Compose, and the PDF volume first. Keep existing upload/storage limits, change `NOTORA_VERSION` to `latest`, set `NOTORA_AUTO_UPDATE=true`, and remove the obsolete `NOTORA_REVISION` setting. The revision now comes from the built image. Keep Compose project name `notora` and volume `notora_notora-data` so uploaded PDFs remain available.

The VPS's existing Watchtower checks for images every 60 seconds and watches the running Notora container through its enable label. It pulls a changed `latest` image and recreates only that container with its existing volume, network and Traefik configuration. Compose alone does not poll the registry. Future application pushes need no SSH deployment step. Changes to Compose itself still need to be copied to the VPS and applied with `docker compose up -d --no-build app`.

GHCR packages start private. The VPS must be able to pull the package, and Watchtower must have the same registry access. This VPS already mounts `/root/.docker/config.json` into Watchtower at `/config.json:ro`; keep credentials out of the repository and workflow logs. See [GitHub's registry authentication guide](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry) and [Watchtower's registry configuration](https://containrrr.dev/watchtower/private-registries/).

After migration, rollback must target an R2-capable image with the gateway environment intact. A pre-R2 image requires restoring the matching pre-migration volume backup as well. To roll back, edit the VPS `.env` to set `NOTORA_VERSION=sha-<known-good-full-commit-sha>` and `NOTORA_AUTO_UPDATE=false`, then run `docker compose pull app` and `docker compose up -d --no-build app`. To resume automatic releases, restore `NOTORA_VERSION=latest` and `NOTORA_AUTO_UPDATE=true` and run those commands again.

Defaults cap each upload at 256 MiB and local PDF scratch storage at 2048 MiB; these can be changed in `.env`. Cloud storage has an independent 9,000,000,000-byte ceiling including originals, derivatives and in-flight writes. Derived page PDFs can be larger in aggregate than the original because shared resources may be repeated. The service has bounded memory/CPU and log rotation.

`GET /healthz` returns status and the deployed revision. Verify both the running revision and Docker health after a release. Back up the `notora_notora-data` volume for document capabilities and SQLite records. Once migrated to R2, PDF bytes reside in the private bucket and require a separate object backup; the volume contains neither those binaries nor browser-local notes. Never use `docker compose down -v` on a deployment whose PDFs should be preserved.

The shared types in `packages/shared/src/index.ts` and [implementation contract](docs/contract.md) define HTTP, WebSocket, note coordinates, and module ownership.

## R2 gateway and migration

R2 has no native per-bucket hard spending stop. Notora therefore keeps its bucket private and routes every operation through a Workers Free + SQLite Durable Object gateway. Both the backend and the gateway enforce the 9 GB limit. Requests fail closed when storage or operation budgets are exhausted; no public bucket or signed URL can bypass the gateway. Downloads stream through the VPS with bounded buffers rather than loading a complete source PDF into VPS RAM.

The gateway limits Class A operations to 20,000 per UTC day and 800,000 per UTC month, and Class B to 200,000 per UTC day and 8,000,000 per UTC month. Daily caps leave headroom across non-calendar billing periods. These controls cover Notora's gateway traffic, not manual operations, other projects or pre-existing account usage. Keep Workers on the Free plan; upgrading a plan changes its billing behavior. See [R2 pricing](https://developers.cloudflare.com/r2/pricing/) and [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/).

Create the private `notora-documents` Standard bucket. Deploy `cloudflare/wrangler.jsonc`, and store a random `GATEWAY_SECRET` with `wrangler secret put GATEWAY_SECRET --config cloudflare/wrangler.jsonc`. Set `R2_GATEWAY_URL` and the same value as `R2_GATEWAY_SECRET` in the VPS's private `.env`. Do not place a Cloudflare management token in the browser or application environment. `TRUST_PROXY` must name only the actual reverse proxy; country lookup is local, and unknown legacy IP/country values stay empty.

For an existing deployment, make a verified volume/config backup first. Run `npm run r2:migrate` once using the deployment's data volume and gateway environment while the normal application is stopped, so two processes never modify the accounting database concurrently. It preserves document IDs and capability hashes, reports migrated/skipped/failed counts, and keeps local binaries on an unsuccessful publication. Resume the app and verify old links and the dashboard before removing any backup. Do not delete objects manually to free application quota; use the dashboard so both ledgers stay consistent.

The exact object layout and gateway protocol are in [the R2 contract](docs/r2-contract.md).

## Stack

React + TypeScript + Vite, PDF.js, IndexedDB (`idb`), incremental SHA-256 (`@noble/hashes`), Yjs, Fastify, WebSocket (`ws`), Node's built-in SQLite, qpdf, and pypdf. One Node process serves the API, WebSocket, and built frontend from a single container.
