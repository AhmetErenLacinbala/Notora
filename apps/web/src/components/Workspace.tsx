import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { Camera, CursorPosition, Destination, DocumentManifest, OutlineItem, PageLayout, Profile, TextNote } from '../../../../packages/shared/src/index';
import { MAX_NOTE_FONT_SIZE, MIN_NOTE_FONT_SIZE, NOTE_BORDER, NOTE_FONT_STEP, NOTE_PADDING, noteFontSize, noteHeight, noteIntersects, noteLineHeight, pageLayout, PAGE_GAP, STAGE_MARGIN } from '../../../../packages/shared/src/index';
import { loadCamera, saveCamera } from '../lib/storage';
import { WorkspaceSession } from '../lib/workspace';
import { PdfPage } from './PdfPage';

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 2.5;
const ZOOM_STEP = 0.25;
let measureContext: CanvasRenderingContext2D | null = null;

function noteWidth(text: string, fontSize: number): number {
  if (!measureContext) measureContext = document.createElement('canvas').getContext('2d');
  if (!measureContext) return 60;
  measureContext.font = `${fontSize}px Arial, Helvetica, sans-serif`;
  let width = 32;
  for (const line of text.split('\n')) width = Math.max(width, Math.ceil(measureContext.measureText(line || ' ').width + 5));
  return width;
}

function clamp(value: number, min: number, max: number) { return Math.min(max, Math.max(min, value)); }

function stageSize(pages: PageLayout[]) {
  const maxWidth = pages.reduce((max, page) => Math.max(max, page.width), 0);
  const last = pages[pages.length - 1];
  return { width: maxWidth + STAGE_MARGIN * 2, height: last ? last.y + last.height + PAGE_GAP : 0 };
}

function contentSize(pages: PageLayout[], notes: TextNote[]) {
  const size = stageSize(pages);
  for (const note of notes) {
    const page = pages[note.anchorPage - 1];
    if (!page) continue;
    size.height = Math.max(size.height, page.y + note.y + noteHeight(note) + PAGE_GAP);
    if (note.text !== null) size.width = Math.max(size.width, page.x + note.x + noteWidth(note.text, noteFontSize(note)) + 2 * (NOTE_PADDING + NOTE_BORDER) + STAGE_MARGIN);
  }
  return size;
}

function shiftedSelection(before: string, after: string, selection: { start: number; end: number }) {
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++;
  let oldEnd = before.length, newEnd = after.length;
  while (oldEnd > prefix && newEnd > prefix && before[oldEnd - 1] === after[newEnd - 1]) { oldEnd--; newEnd--; }
  const map = (position: number) => position < prefix ? position : position >= oldEnd ? position + newEnd - oldEnd : newEnd;
  return { start: clamp(map(selection.start), 0, after.length), end: clamp(map(selection.end), 0, after.length) };
}

function nearestPage(pages: PageLayout[], y: number): PageLayout | undefined {
  if (!pages.length) return undefined;
  let low = 0, high = pages.length - 1;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (y > pages[mid].y + pages[mid].height + PAGE_GAP / 2) low = mid + 1;
    else high = mid;
  }
  return pages[low];
}

interface NoteDrag {
  pointerId: number;
  anchorId: string;
  clientX: number;
  clientY: number;
  zoom: number;
  origins: Array<{ id: string; x: number; y: number; left: number; top: number }>;
  dx: number;
  dy: number;
}

export interface WorkspaceProps {
  manifest: DocumentManifest;
  accessToken: string;
  ownerToken?: string;
  profile: Profile;
  onHome: () => void;
}

export function Workspace(props: WorkspaceProps) {
  const [session, setSession] = useState<WorkspaceSession | null>(null);
  useEffect(() => {
    const active = new WorkspaceSession({ manifest: props.manifest, accessToken: props.accessToken, ownerToken: props.ownerToken, profile: props.profile });
    setSession(active);
    active.connect();
    return () => {
      setSession(current => current === active ? null : current);
      void active.destroy();
    };
  }, [props.manifest.id, props.manifest.version, props.accessToken, props.ownerToken, props.profile.id]);
  if (!session) return <div className="workspace-init" role="status">Opening workspace…</div>;
  return <WorkspaceContent {...props} session={session} />;
}

function WorkspaceContent({ manifest, accessToken, profile, onHome, session }: WorkspaceProps & { session: WorkspaceSession }) {
  const snapshot = useSyncExternalStore(useCallback(listener => session.subscribe(listener), [session]), useCallback(() => session.getSnapshot(), [session]));
  const pages = useMemo(() => pageLayout(manifest.pages), [manifest.pages]);
  const pageSize = useMemo(() => stageSize(pages), [pages]);
  const size = useMemo(() => contentSize(pages, snapshot.notes), [pages, snapshot.notes]);
  const viewportRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [shareCopied, setShareCopied] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [view, setView] = useState({ left: 0, top: 0, width: 0, height: 0 });
  const [editingId, setEditingId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const selectedIdsRef = useRef(selectedIds);
  const [cameraReady, setCameraReady] = useState(false);
  const newNoteIds = useRef(new Set<string>());
  const dragRef = useRef<NoteDrag | null>(null);
  const cameraTimer = useRef<number | undefined>(undefined);
  const scrollFrame = useRef<number | undefined>(undefined);
  const cursorFrame = useRef<number | undefined>(undefined);
  const pendingCursor = useRef<CursorPosition | null>(null);
  const pendingZoomFocus = useRef<{ x: number; y: number } | null>(null);
  const latestZoom = useRef(zoom);
  const latestCameraReady = useRef(cameraReady);
  latestZoom.current = zoom;
  latestCameraReady.current = cameraReady;

  const updateView = useCallback(() => {
    const element = viewportRef.current;
    if (!element) return;
    setView({ left: element.scrollLeft, top: element.scrollTop, width: element.clientWidth, height: element.clientHeight });
  }, []);

  const saveCurrentCamera = useCallback(() => {
    const element = viewportRef.current;
    if (!element || !cameraReady) return;
    if (cameraTimer.current) window.clearTimeout(cameraTimer.current);
    cameraTimer.current = window.setTimeout(() => {
      const camera: Camera = { scrollLeft: element.scrollLeft, scrollTop: element.scrollTop, zoom };
      void saveCamera(manifest.id, camera);
    }, 450);
  }, [cameraReady, zoom, manifest.id]);

  useEffect(() => {
    let live = true;
    void loadCamera(manifest.id).then(camera => {
      if (!live) return;
      const initialZoom = clamp(camera?.zoom ?? 1, MIN_ZOOM, MAX_ZOOM);
      setZoom(initialZoom);
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (!live || !viewportRef.current) return;
        const element = viewportRef.current;
        element.scrollLeft = camera?.scrollLeft ?? Math.max(0, (pageSize.width * initialZoom - element.clientWidth) / 2);
        element.scrollTop = camera?.scrollTop ?? 0;
        updateView();
        setCameraReady(true);
      }));
    }).catch(() => {
      if (!live) return;
      requestAnimationFrame(() => {
        const element = viewportRef.current;
        if (element) element.scrollLeft = Math.max(0, (pageSize.width - element.clientWidth) / 2);
        updateView();
        setCameraReady(true);
      });
    });
    return () => { live = false; };
  }, [manifest.id, pageSize.width, updateView]);

  useEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    const observer = new ResizeObserver(() => updateView());
    observer.observe(element);
    updateView();
    return () => observer.disconnect();
  }, [updateView]);

  useEffect(() => () => {
    if (cameraTimer.current) window.clearTimeout(cameraTimer.current);
    if (scrollFrame.current) cancelAnimationFrame(scrollFrame.current);
    if (cursorFrame.current) cancelAnimationFrame(cursorFrame.current);
    const element = viewportRef.current;
    if (element && latestCameraReady.current) void saveCamera(manifest.id, { scrollLeft: element.scrollLeft, scrollTop: element.scrollTop, zoom: latestZoom.current });
    session.setCursor(null);
  }, [manifest.id, session]);

  const onScroll = () => {
    if (scrollFrame.current) cancelAnimationFrame(scrollFrame.current);
    scrollFrame.current = requestAnimationFrame(() => { scrollFrame.current = undefined; updateView(); });
    saveCurrentCamera();
  };

  const changeZoom = (next: number) => {
    const element = viewportRef.current;
    if (!element) return;
    const value = clamp(Math.round(next / ZOOM_STEP) * ZOOM_STEP, MIN_ZOOM, MAX_ZOOM);
    if (value === zoom) return;
    pendingZoomFocus.current = { x: (element.scrollLeft + element.clientWidth / 2) / zoom, y: (element.scrollTop + element.clientHeight / 2) / zoom };
    setZoom(value);
  };

  useLayoutEffect(() => {
    const focus = pendingZoomFocus.current;
    const element = viewportRef.current;
    if (!focus || !element) return;
    pendingZoomFocus.current = null;
    element.scrollLeft = focus.x * zoom - element.clientWidth / 2;
    element.scrollTop = focus.y * zoom - element.clientHeight / 2;
    updateView();
    saveCurrentCamera();
  }, [zoom, updateView, saveCurrentCamera]);

  const canonicalTop = view.top / zoom;
  const canonicalBottom = (view.top + view.height) / zoom;
  const overscan = Math.max(220, (view.height / zoom) * 0.6);
  const nearbyTop = canonicalTop - overscan;
  const nearbyBottom = canonicalBottom + overscan;
  const visiblePages = pages.filter(page => page.y <= nearbyBottom && page.y + page.height >= nearbyTop);
  const visibleNotes = snapshot.notes.filter(note => note.text !== null && (noteIntersects(note, pages, nearbyTop, nearbyBottom) || note.id === editingId || note.id === dragRef.current?.anchorId));

  const selectIds = (ids: Set<string>) => {
    selectedIdsRef.current = ids;
    setSelectedIds(ids);
  };

  const selectNote = (id: string, additive = false) => {
    if (!additive) { selectIds(new Set([id])); return; }
    const next = new Set(selectedIdsRef.current);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    selectIds(next);
  };

  useEffect(() => {
    const present = new Set(snapshot.notes.map(note => note.id));
    const next = new Set([...selectedIdsRef.current].filter(id => present.has(id)));
    if (next.size !== selectedIdsRef.current.size) selectIds(next);
  }, [snapshot.notes]);

  const deleteSelection = () => {
    const ids = [...selectedIdsRef.current];
    if (!ids.length) return;
    for (const id of ids) newNoteIds.current.delete(id);
    if (editingId && selectedIdsRef.current.has(editingId)) {
      setEditingId(null);
      session.setEditingNote(null);
    }
    selectIds(new Set());
    session.deleteNotes(ids);
  };

  const beginNoteDrag = (note: TextNote, event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const target = event.target as HTMLElement;
    const additive = event.shiftKey || event.metaKey || event.ctrlKey;
    if (target.closest('.note-font-controls') || (target.closest('textarea') && !additive)) return;
    event.preventDefault();
    if (additive) selectNote(note.id, true);
    else if (!selectedIdsRef.current.has(note.id)) selectNote(note.id);
    event.currentTarget.focus({ preventScroll: true });
    if (additive) return;
    const origins = snapshot.notes.filter(item => selectedIdsRef.current.has(item.id)).map(item => {
      const page = pages[item.anchorPage - 1];
      return { id: item.id, x: item.x, y: item.y, left: (page?.x ?? 0) + item.x, top: (page?.y ?? 0) + item.y };
    });
    if (!origins.length) return;
    dragRef.current = { pointerId: event.pointerId, anchorId: note.id, clientX: event.clientX, clientY: event.clientY, zoom, origins, dx: 0, dy: 0 };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const moveNoteDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    const minimumX = Math.max(...drag.origins.map(origin => -origin.left));
    const minimumY = Math.max(...drag.origins.map(origin => -origin.top));
    const dx = Math.max(minimumX, (event.clientX - drag.clientX) / drag.zoom);
    const dy = Math.max(minimumY, (event.clientY - drag.clientY) / drag.zoom);
    if (dx === drag.dx && dy === drag.dy) return;
    drag.dx = dx;
    drag.dy = dy;
    for (const origin of drag.origins) session.updateNote(origin.id, { x: origin.x + dx, y: origin.y + dy });
    session.activity();
  };

  const endNoteDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    if (event.type === 'pointerup') moveNoteDrag(event);
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  useEffect(() => {
    if (view.height > 0) session.setVisibleRange(canonicalTop, canonicalBottom);
  }, [session, canonicalTop, canonicalBottom, view.height]);

  const moveTo = useCallback((destination: Destination) => {
    const element = viewportRef.current;
    const page = pages[destination.page - 1];
    if (!element || !page) return;
    element.scrollLeft = Math.max(0, (page.x + (destination.x ?? page.width / 2)) * zoom - element.clientWidth / 2);
    element.scrollTop = Math.max(0, (page.y + (destination.y ?? 0)) * zoom - 72);
    updateView();
    saveCurrentCamera();
  }, [pages, zoom, updateView, saveCurrentCamera]);

  const jumpToCursor = (cursor: CursorPosition | null) => {
    const element = viewportRef.current;
    if (!element || !cursor) return;
    element.scrollLeft = Math.max(0, cursor.x * zoom - element.clientWidth / 2);
    element.scrollTop = Math.max(0, cursor.y * zoom - element.clientHeight / 2);
    updateView();
    saveCurrentCamera();
  };

  const setPointerCursor = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!stageRef.current) return;
    const rect = stageRef.current.getBoundingClientRect();
    pendingCursor.current = { x: (event.clientX - rect.left) / zoom, y: (event.clientY - rect.top) / zoom };
    session.activity();
    if (!cursorFrame.current) cursorFrame.current = requestAnimationFrame(() => {
      cursorFrame.current = undefined;
      session.setCursor(pendingCursor.current);
    });
  };

  const clearPointerCursor = () => {
    if (cursorFrame.current) { cancelAnimationFrame(cursorFrame.current); cursorFrame.current = undefined; }
    pendingCursor.current = null;
    session.setCursor(null);
  };

  const createAtPointer = (event: React.MouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (target.closest('button, a, input, textarea, .pdf-text-layer span, .note-item')) return;
    if (window.getSelection()?.toString()) return;
    const stage = stageRef.current;
    if (!stage) return;
    const rect = stage.getBoundingClientRect();
    const x = (event.clientX - rect.left) / zoom;
    const y = (event.clientY - rect.top) / zoom;
    const page = nearestPage(pages, y);
    if (!page) return;
    const id = session.createNote(page.number, x - page.x, y - page.y);
    newNoteIds.current.add(id);
    selectNote(id);
    setEditingId(id);
    session.setEditingNote(id);
    session.activity();
  };

  const shareUrl = `${window.location.origin}/r/${encodeURIComponent(manifest.id)}#${encodeURIComponent(accessToken)}`;
  const copyShare = async () => {
    try { await navigator.clipboard.writeText(shareUrl); setShareCopied(true); }
    catch { setShareCopied(false); setShareOpen(true); }
  };
  const saveLabel = snapshot.saveState === 'saved' ? 'Saved locally' : snapshot.saveState === 'saving' ? 'Saving locally…' : snapshot.saveState === 'pending' ? 'Waiting to save…' : 'Save failed';

  const onWorkspaceKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    session.activity();
    if (event.defaultPrevented || (event.key !== 'Delete' && event.key !== 'Backspace')) return;
    const target = event.target as HTMLElement;
    if (target.closest('input, textarea, [contenteditable]') || target.isContentEditable) return;
    if (!selectedIdsRef.current.size) return;
    event.preventDefault();
    deleteSelection();
  };

  return <div className="workspace-shell" onPointerDownCapture={event => {
    session.activity();
    if (!(event.target as Element).closest('.note-item')) selectIds(new Set());
  }} onKeyDown={onWorkspaceKeyDown}>
    <header className="workspace-header">
      <div className="workspace-left"><button type="button" className="brand brand-button" onClick={onHome} aria-label="Back to home">notora<span>.</span></button><span className="topbar-separator" /><span className="document-title" title={manifest.title}>{manifest.title}</span></div>
      <div className="workspace-actions">
        <button type="button" className={`toolbar-button outline-toggle${outlineOpen ? ' is-active' : ''}`} aria-label="Toggle outline" aria-expanded={outlineOpen} onClick={() => setOutlineOpen(value => !value)}><OutlineIcon /><span>Outline</span></button>
        <div className="zoom-group" aria-label="Zoom controls"><button type="button" aria-label="Zoom out" disabled={zoom <= MIN_ZOOM} onClick={() => changeZoom(zoom - ZOOM_STEP)}>−</button><span>{Math.round(zoom * 100)}%</span><button type="button" aria-label="Zoom in" disabled={zoom >= MAX_ZOOM} onClick={() => changeZoom(zoom + ZOOM_STEP)}>+</button></div>
        <div className="topbar-separator share-separator" />
        <div className="share-wrap"><button type="button" className="toolbar-button share-button" aria-expanded={shareOpen} onClick={() => { setShareOpen(value => !value); setShareCopied(false); }}>Share</button>{shareOpen && <div className="share-popover"><strong>Share this PDF</strong><p>Anyone with this link can read and write notes.</p><div className="share-link-row"><input aria-label="Share link" readOnly value={shareUrl} onFocus={event => event.currentTarget.select()} /><button type="button" onClick={() => void copyShare()}>{shareCopied ? 'Copied' : 'Copy'}</button></div></div>}</div>
      </div>
      <div className="workspace-presence"><div className="participant-list" aria-label="Participants">{snapshot.participants.map(participant => <button key={participant.clientId} type="button" className="participant-pill" title={participant.cursor ? `Jump to ${participant.name}` : participant.name} aria-label={participant.cursor ? `Jump to ${participant.name}` : participant.name} disabled={!participant.cursor} onClick={() => jumpToCursor(participant.cursor)}><span className="participant-avatar" style={{ backgroundColor: participant.color }}>{participant.name.slice(0, 1).toUpperCase()}</span><span className="participant-name">{participant.name}</span></button>)}</div><span className={`connection-indicator ${snapshot.connection}`} title={snapshot.connection} /><span className={`save-status ${snapshot.saveState}`} role="status" title={snapshot.error || undefined}>{saveLabel}</span></div>
    </header>
    <div className="workspace-main">
      {outlineOpen && <aside className="outline-panel"><div className="outline-heading"><h2>Outline</h2><button type="button" aria-label="Close outline" onClick={() => setOutlineOpen(false)}>×</button></div>{manifest.outline.length ? <nav aria-label="PDF outline"><OutlineList items={manifest.outline} depth={0} onDestination={moveTo} /></nav> : <p className="outline-empty">No outline in this PDF.</p>}</aside>}
      <div className="viewer-wrap"><div className="viewer-viewport" ref={viewportRef} onScroll={onScroll} onWheelCapture={() => session.activity()} onPointerMove={setPointerCursor} onPointerLeave={clearPointerCursor} aria-label={`${manifest.title} pages`}>
        <div className="stage-size" style={{ width: size.width * zoom, height: size.height * zoom }}>
          <div className="pdf-stage" ref={stageRef} style={{ width: size.width, height: size.height, transform: `scale(${zoom})` }} onDoubleClick={createAtPointer}>
            {visiblePages.map(page => <PdfPage key={`${manifest.version}:${page.number}:${zoom}`} page={page} documentId={manifest.id} version={manifest.version} accessToken={accessToken} zoom={zoom} onDestination={moveTo} />)}
            <div className="notes-layer" aria-label="Notes">{visibleNotes.map(note => <NoteEditor
              key={note.id}
              note={note}
              page={pages[note.anchorPage - 1]}
              selected={selectedIds.has(note.id)}
              editing={editingId === note.id}
              onTextFocus={() => { selectNote(note.id); setEditingId(note.id); session.setEditingNote(note.id); }}
              onTextBlur={() => { if (editingId === note.id) { setEditingId(null); session.setEditingNote(null); } }}
              onText={text => { session.setNoteText(note.id, text); session.activity(); }}
              onExit={text => {
                if (!newNoteIds.current.has(note.id)) return;
                newNoteIds.current.delete(note.id);
                if (!text.trim()) {
                  selectIds(new Set([...selectedIdsRef.current].filter(id => id !== note.id)));
                  session.deleteNote(note.id);
                }
              }}
              onFontChange={delta => session.updateNote(note.id, { fontSize: clamp(noteFontSize(note) + delta, MIN_NOTE_FONT_SIZE, MAX_NOTE_FONT_SIZE) })}
              onKeyboardSelect={additive => selectNote(note.id, additive)}
              onBorderPointerDown={event => beginNoteDrag(note, event)}
              onBorderPointerMove={moveNoteDrag}
              onBorderPointerEnd={endNoteDrag}
            />)}</div>
            <div className="cursors-layer" aria-hidden="true">{snapshot.participants.filter(participant => participant.cursor).map(participant => <div key={participant.clientId} className="remote-cursor" style={{ left: participant.cursor!.x, top: participant.cursor!.y, color: participant.color }}><span className="cursor-pointer" /><span className="cursor-name" style={{ backgroundColor: participant.color }}>{participant.name}</span></div>)}</div>
          </div>
        </div>
      </div>{snapshot.notes.length === 0 && <div className="viewer-hint">Double-click to add a note</div>}</div>
    </div>
  </div>;
}

interface NoteEditorProps {
  note: TextNote;
  page?: PageLayout;
  selected: boolean;
  editing: boolean;
  onTextFocus: () => void;
  onTextBlur: () => void;
  onText: (text: string) => void;
  onExit: (text: string) => void;
  onFontChange: (delta: number) => void;
  onKeyboardSelect: (additive: boolean) => void;
  onBorderPointerDown: (event: React.PointerEvent<HTMLDivElement>) => void;
  onBorderPointerMove: (event: React.PointerEvent<HTMLDivElement>) => void;
  onBorderPointerEnd: (event: React.PointerEvent<HTMLDivElement>) => void;
}

function NoteEditor({ note, page, selected, editing, onTextFocus, onTextBlur, onText, onExit, onFontChange, onKeyboardSelect, onBorderPointerDown, onBorderPointerMove, onBorderPointerEnd }: NoteEditorProps) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const previousText = useRef(note.text ?? '');
  const localInput = useRef<string | null>(null);
  const selection = useRef({ start: 0, end: 0, direction: 'none' as 'forward' | 'backward' | 'none' });
  useEffect(() => { if (editing && ref.current && document.activeElement !== ref.current) ref.current.focus(); }, [editing]);
  const text = note.text ?? '';
  const fontSize = noteFontSize(note);
  const lineHeight = noteLineHeight(note);
  const width = useMemo(() => noteWidth(text, fontSize), [text, fontSize]);
  useLayoutEffect(() => {
    const textarea = ref.current;
    const before = localInput.current ?? previousText.current;
    if (textarea && document.activeElement === textarea && before !== text) {
      const shifted = shiftedSelection(before, text, selection.current);
      textarea.setSelectionRange(shifted.start, shifted.end, selection.current.direction);
      selection.current = { ...shifted, direction: selection.current.direction };
    }
    previousText.current = text;
    localInput.current = null;
  }, [text]);
  const rememberSelection = () => {
    const textarea = ref.current;
    if (textarea) selection.current = { start: textarea.selectionStart, end: textarea.selectionEnd, direction: textarea.selectionDirection as 'forward' | 'backward' | 'none' };
  };
  if (!page) return null;
  const lines = Math.max(1, text.split('\n').length);
  return <div
    className={`note-item${selected ? ' is-selected' : ''}`}
    role="group"
    aria-label={`Note box on page ${note.anchorPage}${selected ? ', selected' : ''}`}
    tabIndex={0}
    style={{ left: page.x + note.x, top: page.y + note.y }}
    onPointerDown={onBorderPointerDown}
    onPointerMove={onBorderPointerMove}
    onPointerUp={onBorderPointerEnd}
    onPointerCancel={onBorderPointerEnd}
    onLostPointerCapture={onBorderPointerEnd}
    onKeyDown={event => {
      if (event.target !== event.currentTarget || (event.key !== 'Enter' && event.key !== ' ')) return;
      event.preventDefault();
      onKeyboardSelect(event.key === ' ' && event.shiftKey);
    }}
    onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) onExit(ref.current?.value ?? text); }}
  >
    {selected && <div className={`note-font-controls${page.y + note.y < 35 ? ' near-stage-top' : ''}`} role="group" aria-label="Note font size">
      <button type="button" aria-label="Decrease note font size" disabled={fontSize <= MIN_NOTE_FONT_SIZE} onPointerDown={event => event.preventDefault()} onClick={() => onFontChange(-NOTE_FONT_STEP)}>A−</button>
      <button type="button" aria-label="Increase note font size" disabled={fontSize >= MAX_NOTE_FONT_SIZE} onPointerDown={event => event.preventDefault()} onClick={() => onFontChange(NOTE_FONT_STEP)}>A+</button>
    </div>}
    <span className="note-drag-handle note-drag-top" aria-hidden="true" />
    <span className="note-drag-handle note-drag-right" aria-hidden="true" />
    <span className="note-drag-handle note-drag-bottom" aria-hidden="true" />
    <span className="note-drag-handle note-drag-left" aria-hidden="true" />
    <textarea ref={ref} className="note-text" aria-label={`Note on page ${note.anchorPage}`} value={text} rows={lines} wrap="off" spellCheck={false} style={{ width, height: lines * lineHeight, fontSize, lineHeight: `${lineHeight}px` }} onFocus={onTextFocus} onSelect={rememberSelection} onKeyUp={rememberSelection} onPointerUp={rememberSelection} onChange={event => { localInput.current = event.target.value; rememberSelection(); onText(event.target.value); }} onBlur={onTextBlur} />
  </div>;
}

function OutlineList({ items, depth, onDestination }: { items: OutlineItem[]; depth: number; onDestination: (destination: Destination) => void }) {
  return <ul className="outline-list">{items.map((item, index) => <li key={`${depth}-${index}`}><button type="button" disabled={!item.destination} style={{ paddingLeft: 16 + Math.min(depth, 6) * 14 }} onClick={() => item.destination && onDestination(item.destination)} title={item.title}>{item.title}</button>{item.items.length > 0 && <OutlineList items={item.items} depth={depth + 1} onDestination={onDestination} />}</li>)}</ul>;
}

function OutlineIcon() { return <svg width="15" height="15" viewBox="0 0 15 15" fill="none" aria-hidden="true"><rect x="2" y="2.2" width="11" height="10.6" rx="1.2" stroke="currentColor" strokeWidth="1.2" /><path d="M5.6 2.5v10M7.8 5.5h3M7.8 8h3" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" /></svg>; }
