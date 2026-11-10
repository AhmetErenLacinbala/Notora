# Notora project rules

- User scope is authoritative. Build only: name prompt, PDF upload and creator-only local history, lazy page viewer, PDF outline/internal links, plain text outside/over/across pages, live cursors and click-to-jump, shared text editing, local save after 10 seconds without input.
- No accounts, shapes, drawing tools, rich text, AI, marketing pages, themes, search, extra dashboards, analytics, or cloud note persistence.
- PDF originals, derived single-page PDFs and manifests persist on the server. Notes persist in browser IndexedDB; server collaboration state is ephemeral RAM only.
- Read `docs/contract.md` and `packages/shared/src/index.ts` before editing. Shared contracts are root-agent owned; propose changes by message.
- English interface, concise labels, quiet neutral design with one accent. No decorative images or fonts loaded from external services.
- Text has no persisted width or height; preserve literal newlines and no automatic wrapping. The user authorized pink note boxes (20% fill/40% stroke), multi-selection/deletion, per-note font size buttons, and dragging notes by their border. Font size persists as optional metadata (old notes default to 18); derive line height using shared helpers on all clients.
- Pages are immutable, versioned derivatives. Never concatenate fetched pages into a full client PDF. Fetch/decode new pages only when visible/nearby. On desktop, retain completed page canvases/text/links in the open workspace so revisiting a page does not reload it. Mobile keeps offscreen cleanup.
- The workspace uses a canvas camera: wheel/trackpad pans, Command/Ctrl + wheel zooms around the pointer, and dragging empty space draws a selection rectangle for notes. No modifier key is required for multi-selection. Preserve canonical note/page coordinates and existing saved cameras; no giant native horizontal scroll surface.
- No secrets in code, logs, URLs sent to HTTP logs, or tests. Capability tokens are validated by the server; names are not identity.
- Isolated file ownership: backend agent `apps/server/**`; data agent `apps/web/src/lib/**`; UI agent `apps/web/src/App.tsx`, `apps/web/src/components/**`, `apps/web/src/styles.css`; root owns shared files, configuration, deployment, and end-to-end integration.
- Do not change another owner's files, package manifests or lockfile without coordination. Do not commit/push/deploy from subagents.
- Use meaningful tests for persistence, authorization, page loading, and multi-client behavior. Root verifies UI and deployment.
- Work inside this repository. Production changes only target Notora; preserve every existing VPS application and volume.
