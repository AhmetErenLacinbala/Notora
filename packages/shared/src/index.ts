export const SCHEMA_VERSION = 1;
export const PAGE_GAP = 28;
export const STAGE_MARGIN = 380;
export const TEXT_FONT_SIZE = 18;
export const TEXT_LINE_HEIGHT = 26;
export const SAVE_IDLE_MS = 10_000;
export const INDEX_KEY = 'index';
export const noteKey = (id: string) => `note:${id}`;

export interface Profile { id: string; name: string }
export interface PageInfo { number: number; width: number; height: number }
export interface Destination { page: number; x?: number; y?: number }
export interface OutlineItem { title: string; destination: Destination | null; items: OutlineItem[] }
export interface PageLink { rect: [number, number, number, number]; destination?: Destination; url?: string }
export interface DocumentManifest {
  schemaVersion: 1; id: string; version: string; title: string; status: 'processing' | 'ready' | 'error';
  pageCount: number; pages: PageInfo[]; outline: OutlineItem[]; error?: string;
}
export interface UploadResult { documentId: string; accessToken: string; ownerToken: string }
export interface OwnedProject extends UploadResult { title: string; createdAt: number; lastOpenedAt: number }
export interface Camera { scrollLeft: number; scrollTop: number; zoom: number }
// x/y relative to anchor page top-left, in unzoomed canonical CSS points.
// lineCount is rebuildable metadata for vertical visibility; never width/height.
export interface NoteMeta { id: string; anchorPage: number; x: number; y: number; lineCount: number }
export interface TextNote extends NoteMeta { text: string | null }
export interface CursorPosition { x: number; y: number }
export interface Participant { clientId: string; name: string; color: string; cursor: CursorPosition | null; owner: boolean }
export type SaveState = 'saved' | 'pending' | 'saving' | 'error';
export interface WorkspaceSnapshot {
  notes: TextNote[]; participants: Participant[]; connection: 'connecting' | 'online' | 'offline';
  saveState: SaveState; error: string | null;
}
export interface SessionOptions {
  manifest: DocumentManifest; accessToken: string; ownerToken?: string; profile: Profile;
}
export interface WorkspaceSessionApi {
  connect(): void; destroy(): Promise<void>; subscribe(listener: () => void): () => void;
  getSnapshot(): WorkspaceSnapshot; setVisibleRange(top: number, bottom: number): void;
  setEditingNote(id: string | null): void;
  createNote(anchorPage: number, x: number, y: number): string;
  setNoteText(id: string, text: string): void; deleteNote(id: string): void;
  setCursor(cursor: CursorPosition | null): void; activity(): void; flush(): Promise<void>;
}
export type ClientMessage =
  | { type: 'join'; documentId: string; accessToken: string; ownerToken?: string; clientId: string; name: string }
  | { type: 'subscribe'; keys: string[] }
  | { type: 'update'; key: string; update: string }
  | { type: 'state'; key: string; update: string }
  | { type: 'cursor'; cursor: CursorPosition | null };
export type ServerMessage =
  | { type: 'welcome'; clientId: string; participants: Participant[] }
  | { type: 'participants'; participants: Participant[] }
  | { type: 'update'; key: string; update: string }
  | { type: 'need-state'; keys: string[] }
  | { type: 'cursor'; clientId: string; cursor: CursorPosition | null }
  | { type: 'error'; message: string };

export interface PageLayout extends PageInfo { x: number; y: number }
export function pageLayout(pages: PageInfo[]): PageLayout[] {
  const maxWidth = pages.reduce((max, p) => Math.max(max, p.width), 0);
  let y = PAGE_GAP;
  return pages.map(page => { const result = { ...page, x: STAGE_MARGIN + (maxWidth - page.width) / 2, y }; y += page.height + PAGE_GAP; return result; });
}
export function noteTop(meta: NoteMeta, pages: PageLayout[]): number {
  return (pages[meta.anchorPage - 1]?.y ?? 0) + meta.y;
}
export function noteIntersects(meta: NoteMeta, pages: PageLayout[], top: number, bottom: number): boolean {
  const y = noteTop(meta, pages);
  return y <= bottom && y + Math.max(1, meta.lineCount) * TEXT_LINE_HEIGHT >= top;
}
