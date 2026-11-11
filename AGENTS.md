# Notora project rules

- User scope is authoritative. Build only: name prompt, PDF upload and creator-only local history, lazy page viewer, PDF outline/internal links, plain text outside/over/across pages, live cursors and click-to-jump, shared text editing, local save after 10 seconds without input.
- No accounts, general shapes, rich text, AI, marketing pages, themes, search, extra dashboards, analytics, or cloud note persistence. User now authorized freehand Bézier drawing, arrows, whole-stroke eraser, text tool, double-press-and-drag handwriting, local PDF open with explicit Share upload and location links. Read docs/drawing-local-contract.md for current ownership/integration.
- PDF originals, derived single-page PDFs and manifests persist on the server. Notes persist in browser IndexedDB; server collaboration state is ephemeral RAM only.
- Read `docs/contract.md` and `packages/shared/src/index.ts` before editing. Shared contracts are root-agent owned; propose changes by message.
- English interface, concise labels, quiet neutral design with one accent. No decorative images or fonts loaded from external services.
- Text has no persisted width or height; preserve literal newlines and no automatic wrapping. The user authorized pink note boxes (10% fill/20% stroke), multi-selection/deletion, per-note font size buttons, and dragging notes by their border. Font size persists as optional metadata (old notes default to 18), with a minimum of 1. Keep the last locally changed font size in workspace UI state and use it for newly created notes; derive line height using shared helpers on all clients.
- Pages are immutable, versioned derivatives. Never concatenate fetched pages into a full client PDF. Fetch/decode new pages only when visible/nearby. On desktop, retain completed page canvases/text/links in the open workspace so revisiting a page does not reload it. Mobile keeps offscreen cleanup.
- The workspace uses a canvas camera: wheel/trackpad pans, Command/Ctrl + wheel zooms around the pointer, and dragging empty space draws a selection rectangle for notes. No modifier key is required for multi-selection. Preserve canonical note/page coordinates and existing saved cameras; no giant native horizontal scroll surface.
- No secrets in code, logs, URLs sent to HTTP logs, or tests. Capability tokens are validated by the server; names are not identity.
- Isolated file ownership: backend agent `apps/server/**`; data agent `apps/web/src/lib/**`; UI agent `apps/web/src/App.tsx`, `apps/web/src/components/**`, `apps/web/src/styles.css`; root owns shared files, configuration, deployment, and end-to-end integration.
- Do not change another owner's files, package manifests or lockfile without coordination. Do not commit/push/deploy from subagents.
- Use meaningful tests for persistence, authorization, page loading, and multi-client behavior. Root verifies UI and deployment.
- Work inside this repository. Production changes only target Notora; preserve every existing VPS application and volume.

## R2 storage update
The user now authorizes private R2 PDF storage, a protected Cloudflare quota gateway, a 9,000,000,000-byte cloud limit plus request budgets, bounded parallel page transfers, upload IP/country/profile metadata visible only to the operator, and dashboard file deletion. Read docs/r2-contract.md. Backend metadata and collaboration stay on the existing VPS; cloud gateway is the explicit exception to the single-container architecture. No paid Cloudflare upgrade. Preserve owner-only browser persistence and desktop canvas retention.
