export const SCHEMA_VERSION = 1;
export const PAGE_GAP = 28;
export const STAGE_MARGIN = 380;
export const TEXT_FONT_SIZE = 18;
export const TEXT_LINE_HEIGHT = 26;
export const MIN_NOTE_FONT_SIZE = 1;
export const MAX_NOTE_FONT_SIZE = 72;
export const NOTE_FONT_STEP = 2;
export const NOTE_PADDING = 2;
export const NOTE_BORDER = 1;
export const SAVE_IDLE_MS = 10_000;
export const REMOVED_CLOSE_CODE = 4403;
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
  contentHash?: string;
}
export interface DashboardDocument {
  id: string; title: string; hostName: string | null;
  uploadedAt: number | null; lastAccessedAt: number | null;
  sizeBytes: number; pageCount: number; status: DocumentManifest['status'];
}
export interface DashboardDocumentsResponse {
  documents: DashboardDocument[]; total: number; offset: number; limit: number;
}
export interface DashboardSession { username: string }
export interface UploadResult { documentId: string; accessToken: string; ownerToken: string }
export const MAX_UPLOAD_CHUNK_BYTES = 1024 * 1024;
export interface UploadSession { uploadId: string; uploadToken: string; offset: number }
export interface UploadStatus { offset: number; size: number }
export interface OwnedProject extends UploadResult { title: string; createdAt: number; lastOpenedAt: number; storageId?: string; contentHash?: string }
export interface Camera { scrollLeft: number; scrollTop: number; zoom: number }
// x/y relative to anchor page top-left, in unzoomed canonical CSS points.
// lineCount is rebuildable metadata for vertical visibility; never width/height.
export interface NoteMeta { id: string; anchorPage: number; x: number; y: number; lineCount: number; fontSize?: number }
export type NotePatch = Partial<Pick<NoteMeta, 'x' | 'y' | 'fontSize'>>;
export interface TextNote extends NoteMeta { text: string | null }
export interface CursorPosition { x: number; y: number }
export type CubicBezier = [number, number, number, number, number, number, number, number];
export interface DrawingBounds { minX: number; minY: number; maxX: number; maxY: number }
export interface DrawingMeta {
  id: string; kind: 'stroke' | 'arrow'; anchorPage: number; x: number; y: number;
  width: number; bounds: DrawingBounds;
}
export interface DrawingShape extends DrawingMeta { curves: CubicBezier[] | null }
export interface DrawingPreviewPacket {
  id: string; kind: 'stroke' | 'arrow'; anchorPage: number; x: number; y: number;
  width: number; seq: number; points: CursorPosition[];
}
export interface RemoteDrawingPreview extends DrawingPreviewPacket { clientId: string }
export const drawingKey = (id: string) => `drawing:${id}`;
export const MAX_DRAWING_SEGMENTS = 4096;
export const MAX_PREVIEW_POINTS = 256;
export interface Participant { clientId: string; name: string; color: string; cursor: CursorPosition | null; owner: boolean }
export type SaveState = 'saved' | 'pending' | 'saving' | 'error';
export interface WorkspaceSnapshot {
  notes: TextNote[]; drawings: DrawingShape[]; drawingPreviews: RemoteDrawingPreview[];
  participants: Participant[]; isAdmin: boolean; connection: 'connecting' | 'online' | 'offline' | 'local' | 'removed';
  saveState: SaveState; error: string | null;
}
export interface SessionOptions {
  manifest: DocumentManifest; accessToken: string; ownerToken?: string; profile: Profile;
  storageId?: string; localOnly?: boolean;
}
export interface WorkspaceSessionApi {
  connect(): void; destroy(): Promise<void>; subscribe(listener: () => void): () => void;
  getSnapshot(): WorkspaceSnapshot; setVisibleRange(top: number, bottom: number): void;
  setEditingNote(id: string | null): void;
  createNote(anchorPage: number, x: number, y: number, fontSize?: number): string;
  setNoteText(id: string, text: string): void; deleteNote(id: string): void;
  updateNote(id: string, patch: NotePatch): void; deleteNotes(ids: string[]): void;
  createDrawing(meta: Omit<DrawingMeta, 'id'>, curves: CubicBezier[], id?: string): string;
  updateDrawing(id: string, patch: { x?: number; y?: number }): void;
  deleteDrawings(ids: string[]): void;
  sendDrawingPreview(preview: DrawingPreviewPacket | null): void;
  kickParticipant(clientId: string): void;
  setCursor(cursor: CursorPosition | null): void; activity(): void; flush(): Promise<void>;
}
export type ClientMessage =
  | { type: 'join'; documentId: string; accessToken: string; ownerToken?: string; clientId: string; name: string }
  | { type: 'kick'; clientId: string }
  | { type: 'subscribe'; keys: string[] }
  | { type: 'update'; key: string; update: string }
  | { type: 'state'; key: string; update: string }
  | { type: 'drawing-preview'; preview: DrawingPreviewPacket | null }
  | { type: 'cursor'; cursor: CursorPosition | null };
export type ServerMessage =
  | { type: 'removed'; message: string }
  | { type: 'welcome'; clientId: string; participants: Participant[] }
  | { type: 'participants'; participants: Participant[] }
  | { type: 'update'; key: string; update: string }
  | { type: 'need-state'; keys: string[] }
  | { type: 'cursor'; clientId: string; cursor: CursorPosition | null }
  | { type: 'drawing-preview'; clientId: string; preview: DrawingPreviewPacket | null }
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
export function noteFontSize(meta: Pick<NoteMeta, 'fontSize'>): number {
  return typeof meta.fontSize === 'number' && Number.isFinite(meta.fontSize)
    ? Math.min(MAX_NOTE_FONT_SIZE, Math.max(MIN_NOTE_FONT_SIZE, meta.fontSize)) : TEXT_FONT_SIZE;
}
export function noteLineHeight(meta: Pick<NoteMeta, 'fontSize'>): number {
  return noteFontSize(meta) * TEXT_LINE_HEIGHT / TEXT_FONT_SIZE;
}
export function noteHeight(meta: NoteMeta): number {
  return Math.max(1, meta.lineCount) * noteLineHeight(meta) + 2 * (NOTE_PADDING + NOTE_BORDER);
}
export function noteIntersects(meta: NoteMeta, pages: PageLayout[], top: number, bottom: number): boolean {
  const y = noteTop(meta, pages);
  return y <= bottom && y + noteHeight(meta) >= top;
}
