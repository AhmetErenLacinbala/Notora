import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { Camera, CubicBezier, CursorPosition, Destination, DocumentManifest, DrawingShape, OutlineItem, PageLayout, Profile, TextNote } from '../../../../packages/shared/src/index';
import { MAX_NOTE_FONT_SIZE, MIN_NOTE_FONT_SIZE, NOTE_BORDER, NOTE_FONT_STEP, NOTE_PADDING, TEXT_FONT_SIZE, noteFontSize, noteHeight, noteIntersects, noteLineHeight, pageLayout, PAGE_GAP, STAGE_MARGIN } from '../../../../packages/shared/src/index';
import { canvasPoint, intersectsRect, selectionRect, wheelPixels, zoomCameraAt } from '../lib/canvasGeometry';
import type { CanvasPoint, CanvasRect } from '../lib/canvasGeometry';
import { drawingBounds, fitStroke, hitDrawing } from '../lib/drawingGeometry';
import type { LocalPdfSource } from '../lib/localPdf';
import { buildShareUrl } from '../lib/shareLink';
import type { SharedView } from '../lib/shareLink';
import { loadCamera, saveCamera } from '../lib/storage';
import { WorkspaceSession } from '../lib/workspace';
import { DrawingLayer } from './DrawingLayer';
import type { DrawingLayerHandle } from './DrawingLayer';
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
function validViewCoordinate(value: number | undefined): value is number { return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 10_000_000; }

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
  origins: Array<{ id: string; x: number; y: number }>;
  dx: number;
  dy: number;
}

interface MarqueeDrag {
  pointerId: number;
  start: CanvasPoint;
  clientX: number;
  clientY: number;
  moved: boolean;
}

interface PanDrag {
  pointerId: number;
  clientX: number;
  clientY: number;
  origin: Camera;
  moved: boolean;
}

type Tool = 'pen' | 'arrow' | 'eraser' | 'text' | null;

interface ActiveDrawing {
  pointerId: number;
  id: string;
  kind: 'stroke' | 'arrow';
  anchorPage: number;
  x: number;
  y: number;
  points: CursorPosition[];
  stagePoints: CursorPosition[];
  nextPreviewPoint: number;
  previewSeq: number;
  lastPreviewAt: number;
  minSampleDistance: number;
  previewResetPending: boolean;
  gesture: boolean;
  moved: boolean;
}

interface PressCandidate { at: number; x: number; y: number; pointerType: string }

interface PinchGesture { ids: [number, number]; worldX: number; worldY: number; distance: number; zoom: number }

export interface WorkspaceProps {
  manifest: DocumentManifest;
  accessToken: string;
  ownerToken?: string;
  profile: Profile;
  onHome: () => void;
  storageId?: string;
  localOnly?: boolean;
  localPdf?: LocalPdfSource;
  onUpload?: (beforeTransition?: () => Promise<void>) => Promise<void>;
  uploadState?: { status: 'uploading' | 'processing'; progress: number } | null;
  uploadError?: string;
  initialView?: SharedView;
}

export function Workspace(props: WorkspaceProps) {
  const identity = JSON.stringify([props.manifest.id, props.manifest.version, props.accessToken,
    props.ownerToken, props.profile.id, props.storageId, props.localOnly]);
  const [slot, setSlot] = useState<{ identity: string; session: WorkspaceSession } | null>(null);
  useEffect(() => {
    const active = new WorkspaceSession({ manifest: props.manifest, accessToken: props.accessToken, ownerToken: props.ownerToken, profile: props.profile, storageId: props.storageId, localOnly: props.localOnly });
    setSlot({ identity, session: active });
    active.connect();
    return () => {
      setSlot(current => current?.session === active ? null : current);
      void active.destroy();
    };
  }, [identity]);
  if (!slot || slot.identity !== identity) return <div className="workspace-init" role="status">Opening workspace…</div>;
  return <WorkspaceContent key={identity} {...props} session={slot.session} />;
}

function WorkspaceContent({ manifest, accessToken, onHome, storageId, localOnly, localPdf, onUpload, uploadState, uploadError, initialView, session }: WorkspaceProps & { session: WorkspaceSession }) {
  const snapshot = useSyncExternalStore(useCallback(listener => session.subscribe(listener), [session]), useCallback(() => session.getSnapshot(), [session]));
  const pages = useMemo(() => pageLayout(manifest.pages), [manifest.pages]);
  const size = useMemo(() => contentSize(pages, snapshot.notes), [pages, snapshot.notes]);
  const viewportRef = useRef<HTMLDivElement>(null);
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [shareCopied, setShareCopied] = useState(false);
  const [shareBusy, setShareBusy] = useState(false);
  const [shareActionError, setShareActionError] = useState<string | null>(null);
  const [tool, setTool] = useState<Tool>(null);
  const [camera, setCameraState] = useState<Camera>({ scrollLeft: 0, scrollTop: 0, zoom: 1 });
  const cameraRef = useRef(camera);
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });
  const [editingId, setEditingId] = useState<string | null>(null);
  const [nextNoteFontSize, setNextNoteFontSize] = useState(TEXT_FONT_SIZE);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const selectedIdsRef = useRef(selectedIds);
  const cameraReady = useRef(false);
  const newNoteIds = useRef(new Set<string>());
  const dragRef = useRef<NoteDrag | null>(null);
  const marqueeRef = useRef<MarqueeDrag | null>(null);
  const panRef = useRef<PanDrag | null>(null);
  const drawingLayerRef = useRef<DrawingLayerHandle>(null);
  const activeDrawing = useRef<ActiveDrawing | null>(null);
  const eraserPointer = useRef<number | null>(null);
  const erasedIds = useRef(new Set<string>());
  const pressCandidate = useRef<PressCandidate | null>(null);
  const suppressDoubleClickUntil = useRef(0);
  const touches = useRef(new Map<number, CanvasPoint>());
  const pinchRef = useRef<PinchGesture | null>(null);
  const touchGesture = useRef(false);
  const [marquee, setMarquee] = useState<CanvasRect | null>(null);
  const lastMarqueeEnd = useRef(0);
  const cameraTimer = useRef<number | undefined>(undefined);
  const cursorFrame = useRef<number | undefined>(undefined);
  const pendingCursor = useRef<CursorPosition | null>(null);
  const lastClientPointer = useRef<CanvasPoint | null>(null);
  const [desktop, setDesktop] = useState(() => window.matchMedia('(hover: hover) and (pointer: fine)').matches);
  const desktopRef = useRef(desktop);
  desktopRef.current = desktop;
  const [retainedPages, setRetainedPages] = useState<Set<number>>(() => new Set());
  const drawingsRef = useRef<DrawingShape[]>(snapshot.drawings);
  drawingsRef.current = snapshot.drawings;
  const cameraStorageId = storageId ?? manifest.id;

  const saveCurrentCamera = useCallback(() => {
    if (!cameraReady.current) return;
    if (cameraTimer.current) window.clearTimeout(cameraTimer.current);
    cameraTimer.current = window.setTimeout(() => {
      cameraTimer.current = undefined;
      void saveCamera(cameraStorageId, cameraRef.current);
    }, 450);
  }, [cameraStorageId]);

  const queuePointerCursor = useCallback((clientX: number, clientY: number) => {
    const element = viewportRef.current;
    if (!element) return;
    pendingCursor.current = canvasPoint({ x: clientX, y: clientY }, element.getBoundingClientRect(), cameraRef.current);
    if (!cursorFrame.current) cursorFrame.current = requestAnimationFrame(() => {
      cursorFrame.current = undefined;
      session.setCursor(pendingCursor.current);
    });
  }, [session]);

  const clearPointerCursor = useCallback(() => {
    if (cursorFrame.current) { cancelAnimationFrame(cursorFrame.current); cursorFrame.current = undefined; }
    lastClientPointer.current = null;
    pendingCursor.current = null;
    session.setCursor(null);
  }, [session]);

  const applyCamera = useCallback((next: Camera) => {
    const current = cameraRef.current;
    if (current.scrollLeft === next.scrollLeft && current.scrollTop === next.scrollTop && current.zoom === next.zoom) return;
    cameraRef.current = next;
    setCameraState(next);
    saveCurrentCamera();
    const pointer = lastClientPointer.current;
    if (pointer) queuePointerCursor(pointer.x, pointer.y);
  }, [queuePointerCursor, saveCurrentCamera]);

  useEffect(() => {
    let live = true;
    void loadCamera(cameraStorageId).then(camera => {
      if (!live) return;
      const requestedZoom = Number.isFinite(initialView?.zoom) ? initialView!.zoom! : camera?.zoom ?? 1;
      const initialZoom = clamp(requestedZoom, MIN_ZOOM, MAX_ZOOM);
      requestAnimationFrame(() => {
        if (!live || !viewportRef.current) return;
        const element = viewportRef.current;
        const first = pages[0];
        const defaultLeft = first ? (first.x + first.width / 2) * initialZoom - element.clientWidth / 2 : 0;
        let next = {
          scrollLeft: Number.isFinite(camera?.scrollLeft) ? camera!.scrollLeft : defaultLeft,
          scrollTop: Number.isFinite(camera?.scrollTop) ? camera!.scrollTop : 0,
          zoom: initialZoom,
        };
        const viewPage = initialView && Number.isSafeInteger(initialView.page) ? pages[initialView.page - 1] : undefined;
        if (viewPage) {
          const centerX = validViewCoordinate(initialView?.x) ? initialView!.x! : viewPage.width / 2;
          const centerY = validViewCoordinate(initialView?.y) ? initialView!.y! : element.clientHeight / (2 * initialZoom);
          next = {
            scrollLeft: (viewPage.x + centerX) * initialZoom - element.clientWidth / 2,
            scrollTop: (viewPage.y + centerY) * initialZoom - element.clientHeight / 2,
            zoom: initialZoom,
          };
        }
        applyCamera(next);
        cameraReady.current = true;
      });
    }).catch(() => {
      if (!live) return;
      requestAnimationFrame(() => {
        const element = viewportRef.current;
        if (!live || !element) return;
        const first = pages[0];
        const fallbackZoom = clamp(Number.isFinite(initialView?.zoom) ? initialView!.zoom! : 1, MIN_ZOOM, MAX_ZOOM);
        const viewPage = initialView && Number.isSafeInteger(initialView.page) ? pages[initialView.page - 1] : undefined;
        const next = viewPage ? {
          scrollLeft: (viewPage.x + (validViewCoordinate(initialView?.x) ? initialView!.x! : viewPage.width / 2)) * fallbackZoom - element.clientWidth / 2,
          scrollTop: (viewPage.y + (validViewCoordinate(initialView?.y) ? initialView!.y! : element.clientHeight / (2 * fallbackZoom))) * fallbackZoom - element.clientHeight / 2,
          zoom: fallbackZoom,
        } : { scrollLeft: first ? (first.x + first.width / 2) * fallbackZoom - element.clientWidth / 2 : 0, scrollTop: 0, zoom: fallbackZoom };
        applyCamera(next);
        cameraReady.current = true;
      });
    });
    return () => { live = false; };
  }, [cameraStorageId, pages, applyCamera, initialView?.page, initialView?.x, initialView?.y, initialView?.zoom]);

  useLayoutEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    const updateSize = () => setViewportSize(previous => {
      const width = element.clientWidth, height = element.clientHeight;
      return previous.width === width && previous.height === height ? previous : { width, height };
    });
    const observer = new ResizeObserver(updateSize);
    observer.observe(element);
    updateSize();
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const media = window.matchMedia('(hover: hover) and (pointer: fine)');
    const onChange = () => setDesktop(media.matches);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);

  useEffect(() => { setRetainedPages(new Set()); }, [manifest.id, manifest.version]);

  const onPageReady = useCallback((pageNumber: number) => {
    if (!desktopRef.current) return;
    setRetainedPages(previous => {
      if (previous.has(pageNumber)) return previous;
      const next = new Set(previous);
      next.add(pageNumber);
      return next;
    });
  }, []);

  useEffect(() => () => {
    if (cameraTimer.current) window.clearTimeout(cameraTimer.current);
    if (cursorFrame.current) cancelAnimationFrame(cursorFrame.current);
    if (cameraReady.current) void saveCamera(cameraStorageId, cameraRef.current);
    if (activeDrawing.current) session.sendDrawingPreview(null);
    session.setCursor(null);
  }, [cameraStorageId, session]);

  const changeZoom = (next: number) => {
    const element = viewportRef.current;
    if (!element) return;
    const value = clamp(next, MIN_ZOOM, MAX_ZOOM);
    applyCamera(zoomCameraAt(cameraRef.current, { x: element.clientWidth / 2, y: element.clientHeight / 2 }, value));
  };

  useEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      session.activity();
      pressCandidate.current = null;
      if (activeDrawing.current) {
        activeDrawing.current = null;
        drawingLayerRef.current?.clearActive();
        session.sendDrawingPreview(null);
      }
      eraserPointer.current = null;
      lastClientPointer.current = { x: event.clientX, y: event.clientY };
      const current = cameraRef.current;
      const dx = wheelPixels(event.deltaX, event.deltaMode, element.clientHeight);
      const dy = wheelPixels(event.deltaY, event.deltaMode, element.clientHeight);
      if (marqueeRef.current) {
        const pointerId = marqueeRef.current.pointerId;
        marqueeRef.current = null;
        setMarquee(null);
        selectedIdsRef.current = new Set();
        setSelectedIds(new Set());
        if (element.hasPointerCapture(pointerId)) element.releasePointerCapture(pointerId);
      }
      if (panRef.current) {
        const pointerId = panRef.current.pointerId;
        panRef.current = null;
        if (element.hasPointerCapture(pointerId)) element.releasePointerCapture(pointerId);
      }
      if (event.metaKey || event.ctrlKey) {
        const nextZoom = clamp(current.zoom * Math.exp(-dy * 0.0015), MIN_ZOOM, MAX_ZOOM);
        const rect = element.getBoundingClientRect();
        applyCamera(zoomCameraAt(current, { x: event.clientX - rect.left, y: event.clientY - rect.top }, nextZoom));
      } else {
        applyCamera({
          ...current,
          scrollLeft: current.scrollLeft + (event.shiftKey && !dx ? dy : dx),
          scrollTop: current.scrollTop + (event.shiftKey && !dx ? 0 : dy),
        });
      }
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => element.removeEventListener('wheel', onWheel);
  }, [applyCamera, session]);

  const zoom = camera.zoom;
  const canonicalTop = camera.scrollTop / zoom;
  const canonicalBottom = (camera.scrollTop + viewportSize.height) / zoom;
  const canonicalLeft = camera.scrollLeft / zoom;
  const canonicalRight = (camera.scrollLeft + viewportSize.width) / zoom;
  const overscan = Math.max(220, (viewportSize.height / zoom) * 0.6);
  const nearbyTop = canonicalTop - overscan;
  const nearbyBottom = canonicalBottom + overscan;
  const nearbyLeft = canonicalLeft - overscan;
  const nearbyRight = canonicalRight + overscan;
  const nearbyPages = pages.filter(page => page.y <= nearbyBottom && page.y + page.height >= nearbyTop && page.x <= nearbyRight && page.x + page.width >= nearbyLeft);
  const nearbyPageNumbers = new Set(nearbyPages.map(page => page.number));
  const renderedPages = desktop ? pages.filter(page => nearbyPageNumbers.has(page.number) || retainedPages.has(page.number)) : nearbyPages;
  const visibleNotes = snapshot.notes.filter(note => note.text !== null && (noteIntersects(note, pages, nearbyTop, nearbyBottom) || note.id === editingId || note.id === dragRef.current?.anchorId));

  const selectIds = (ids: Set<string>) => {
    selectedIdsRef.current = ids;
    setSelectedIds(ids);
  };

  const selectNote = (id: string) => selectIds(new Set([id]));

  const pointerOnCanvas = (clientX: number, clientY: number): CanvasPoint => {
    const viewport = viewportRef.current;
    if (!viewport) return { x: 0, y: 0 };
    return canvasPoint({ x: clientX, y: clientY }, viewport.getBoundingClientRect(), cameraRef.current);
  };

  const createNoteAt = (clientX: number, clientY: number) => {
    const { x, y } = pointerOnCanvas(clientX, clientY);
    const page = nearestPage(pages, y);
    if (!page) return;
    const id = session.createNote(page.number, x - page.x, y - page.y, nextNoteFontSize);
    newNoteIds.current.add(id);
    selectNote(id);
    setEditingId(id);
    session.setEditingNote(id);
    session.activity();
  };

  const clearDrawing = () => {
    if (!activeDrawing.current) return;
    activeDrawing.current = null;
    drawingLayerRef.current?.clearActive();
    session.sendDrawingPreview(null);
  };

  const beginDrawing = (event: React.PointerEvent<HTMLDivElement>, kind: 'stroke' | 'arrow', gesture: boolean) => {
    const stage = pointerOnCanvas(event.clientX, event.clientY);
    const page = nearestPage(pages, stage.y);
    if (!page) return;
    event.preventDefault();
    event.currentTarget.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture(event.pointerId);
    const active: ActiveDrawing = {
      pointerId: event.pointerId, id: crypto.randomUUID(), kind,
      anchorPage: page.number, x: stage.x - page.x, y: stage.y - page.y,
      points: [{ x: 0, y: 0 }], stagePoints: [stage],
      nextPreviewPoint: 1, previewSeq: 1, lastPreviewAt: performance.now(),
      minSampleDistance: 0.15 / cameraRef.current.zoom, previewResetPending: false,
      gesture, moved: false,
    };
    activeDrawing.current = active;
    drawingLayerRef.current?.updateActive(kind, active.stagePoints);
    session.sendDrawingPreview({
      id: active.id, kind, anchorPage: active.anchorPage, x: active.x, y: active.y,
      width: 2, seq: 0, points: [{ x: 0, y: 0 }],
    });
  };

  const restartPreview = (drawing: ActiveDrawing) => {
    const last = drawing.points.length - 1;
    const step = Math.max(1, Math.ceil(drawing.points.length / 255));
    const points = drawing.points.filter((_, index) => index % step === 0 || index === last);
    session.sendDrawingPreview({
      id: drawing.id, kind: drawing.kind, anchorPage: drawing.anchorPage, x: drawing.x, y: drawing.y,
      width: 2, seq: 0, points: points.slice(0, 256),
    });
    drawing.previewSeq = 1;
    drawing.nextPreviewPoint = drawing.points.length;
    drawing.previewResetPending = false;
    drawing.lastPreviewAt = performance.now();
  };

  const sendPreviewPoints = (drawing: ActiveDrawing) => {
    const elapsed = performance.now() - drawing.lastPreviewAt;
    if (elapsed < 40) return;
    if (drawing.previewResetPending || elapsed > 7_000) {
      restartPreview(drawing);
      return;
    }
    if (drawing.nextPreviewPoint >= drawing.points.length) return;
    const points = drawing.points.slice(drawing.nextPreviewPoint, drawing.nextPreviewPoint + 256);
    drawing.nextPreviewPoint += points.length;
    drawing.lastPreviewAt = performance.now();
    session.sendDrawingPreview({
      id: drawing.id, kind: drawing.kind, anchorPage: drawing.anchorPage, x: drawing.x, y: drawing.y,
      width: 2, seq: drawing.previewSeq++, points,
    });
  };

  const decimateDrawing = (drawing: ActiveDrawing) => {
    const last = drawing.points.length - 1;
    drawing.points = drawing.points.filter((_, index) => index % 2 === 0 || index === last);
    drawing.stagePoints = drawing.stagePoints.filter((_, index) => index % 2 === 0 || index === last);
    drawing.minSampleDistance *= 2;
    drawing.previewResetPending = true;
    drawing.nextPreviewPoint = drawing.points.length;
  };

  const sampleDrawing = (event: React.PointerEvent<HTMLDivElement>) => {
    const drawing = activeDrawing.current;
    if (!drawing || drawing.pointerId !== event.pointerId) return;
    const native = event.nativeEvent;
    const samples = native.getCoalescedEvents?.() ?? [native];
    for (const sample of samples.length ? samples : [native]) {
      const stage = pointerOnCanvas(sample.clientX, sample.clientY);
      const previous = drawing.stagePoints[drawing.stagePoints.length - 1];
      if (Math.hypot(stage.x - previous.x, stage.y - previous.y) < drawing.minSampleDistance) continue;
      if (drawing.points.length >= 4096) decimateDrawing(drawing);
      drawing.stagePoints.push(stage);
      drawing.points.push({ x: stage.x - drawing.stagePoints[0].x, y: stage.y - drawing.stagePoints[0].y });
      if (Math.hypot(stage.x - drawing.stagePoints[0].x, stage.y - drawing.stagePoints[0].y) >= 2 / cameraRef.current.zoom) {
        drawing.moved = true;
        if (drawing.gesture) suppressDoubleClickUntil.current = performance.now() + 700;
      }
    }
    drawingLayerRef.current?.updateActive(drawing.kind, drawing.stagePoints);
    sendPreviewPoints(drawing);
    session.activity();
  };

  const finishDrawing = (event: React.PointerEvent<HTMLDivElement>) => {
    const drawing = activeDrawing.current;
    if (!drawing || drawing.pointerId !== event.pointerId) return;
    if (event.type === 'pointerup') sampleDrawing(event);
    try {
      if (event.type !== 'pointerup') return;
      if (drawing.gesture && !drawing.moved) {
        suppressDoubleClickUntil.current = performance.now() + 700;
        createNoteAt(event.clientX, event.clientY);
        return;
      }
      if (drawing.kind === 'arrow' && !drawing.moved) return;
      const curves: CubicBezier[] = drawing.kind === 'arrow'
        ? (() => {
          const end = drawing.points[drawing.points.length - 1];
          return [[0, 0, end.x / 3, end.y / 3, end.x * 2 / 3, end.y * 2 / 3, end.x, end.y]] as CubicBezier[];
        })()
        : fitStroke(drawing.points, 0.75 / cameraRef.current.zoom);
      if (!curves.length) return;
      session.createDrawing({
        kind: drawing.kind, anchorPage: drawing.anchorPage, x: drawing.x, y: drawing.y,
        width: 2, bounds: drawingBounds(curves, 2, drawing.kind),
      }, curves, drawing.id);
      session.activity();
    } finally {
      clearDrawing();
    }
  };

  const eraseAt = (clientX: number, clientY: number) => {
    const stage = pointerOnCanvas(clientX, clientY);
    const radius = 6 / cameraRef.current.zoom;
    const hits: string[] = [];
    for (const drawing of drawingsRef.current) {
      if (!drawing.curves || erasedIds.current.has(drawing.id)) continue;
      const page = pages[drawing.anchorPage - 1];
      if (!page) continue;
      const local = { x: stage.x - page.x - drawing.x, y: stage.y - page.y - drawing.y };
      if (local.x < drawing.bounds.minX - radius || local.x > drawing.bounds.maxX + radius ||
          local.y < drawing.bounds.minY - radius || local.y > drawing.bounds.maxY + radius) continue;
      if (hitDrawing(drawing.curves, local, radius, drawing.kind, drawing.width)) {
        erasedIds.current.add(drawing.id);
        hits.push(drawing.id);
      }
    }
    if (hits.length) { session.deleteDrawings(hits); session.activity(); }
  };

  const startPinch = () => {
    const entries = [...touches.current.entries()];
    if (entries.length < 2) return;
    clearDrawing();
    eraserPointer.current = null;
    pressCandidate.current = null;
    touchGesture.current = true;
    marqueeRef.current = null;
    setMarquee(null);
    panRef.current = null;
    dragRef.current = null;
    const [[firstId, first], [secondId, second]] = entries;
    const viewport = viewportRef.current;
    if (!viewport) return;
    const rect = viewport.getBoundingClientRect();
    const middleX = (first.x + second.x) / 2 - rect.left;
    const middleY = (first.y + second.y) / 2 - rect.top;
    const current = cameraRef.current;
    pinchRef.current = {
      ids: [firstId, secondId],
      worldX: (middleX + current.scrollLeft) / current.zoom,
      worldY: (middleY + current.scrollTop) / current.zoom,
      distance: Math.max(1, Math.hypot(first.x - second.x, first.y - second.y)),
      zoom: current.zoom,
    };
  };

  const movePinch = () => {
    const pinch = pinchRef.current;
    const viewport = viewportRef.current;
    if (!pinch || !viewport) return;
    const first = touches.current.get(pinch.ids[0]);
    const second = touches.current.get(pinch.ids[1]);
    if (!first || !second) return;
    const rect = viewport.getBoundingClientRect();
    const middleX = (first.x + second.x) / 2 - rect.left;
    const middleY = (first.y + second.y) / 2 - rect.top;
    const zoom = clamp(pinch.zoom * Math.hypot(first.x - second.x, first.y - second.y) / pinch.distance, MIN_ZOOM, MAX_ZOOM);
    applyCamera({
      scrollLeft: pinch.worldX * zoom - middleX,
      scrollTop: pinch.worldY * zoom - middleY,
      zoom,
    });
  };

  const selectWithin = (rect: CanvasRect) => {
    const ids = new Set<string>();
    for (const note of snapshot.notes) {
      if (note.text === null) continue;
      const page = pages[note.anchorPage - 1];
      if (!page) continue;
      if (intersectsRect(rect, {
        x: page.x + note.x,
        y: page.y + note.y,
        width: noteWidth(note.text, noteFontSize(note)) + 2 * (NOTE_PADDING + NOTE_BORDER),
        height: noteHeight(note),
      })) ids.add(note.id);
    }
    const current = selectedIdsRef.current;
    if (ids.size !== current.size || [...ids].some(id => !current.has(id))) selectIds(ids);
  };

  const beginViewportPointer = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'touch') {
      touches.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (touches.current.size >= 2) {
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        startPinch();
        return;
      }
      touchGesture.current = false;
    }
    if (event.button === 1) {
      event.preventDefault();
      panRef.current = { pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY, origin: cameraRef.current, moved: false };
      event.currentTarget.setPointerCapture(event.pointerId);
      return;
    }
    if (event.button !== 0) return;
    if (tool === 'pen' || tool === 'arrow') {
      pressCandidate.current = null;
      beginDrawing(event, tool === 'pen' ? 'stroke' : 'arrow', false);
      return;
    }
    if (tool === 'eraser') {
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      eraserPointer.current = event.pointerId;
      erasedIds.current.clear();
      eraseAt(event.clientX, event.clientY);
      return;
    }
    if (tool === 'text') {
      event.preventDefault();
      suppressDoubleClickUntil.current = performance.now() + 700;
      createNoteAt(event.clientX, event.clientY);
      setTool(null);
      return;
    }
    const target = event.target as Element;
    if (target.closest('.note-item, button, a, input, textarea, [contenteditable], .pdf-text-layer span, .pdf-text-layer br') && event.pointerType !== 'touch') {
      pressCandidate.current = null;
      return;
    }
    if (target.closest('.note-item, button, a, input, textarea, [contenteditable]')) {
      pressCandidate.current = null;
      return;
    }
    const candidate = pressCandidate.current;
    if (candidate && candidate.pointerType === event.pointerType && performance.now() - candidate.at <= 420 &&
        Math.hypot(event.clientX - candidate.x, event.clientY - candidate.y) <= 18) {
      pressCandidate.current = null;
      beginDrawing(event, 'stroke', true);
      return;
    }
    pressCandidate.current = null;
    if (event.pointerType === 'touch') {
      panRef.current = { pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY, origin: cameraRef.current, moved: false };
      event.currentTarget.setPointerCapture(event.pointerId);
      return;
    }
    event.preventDefault();
    event.currentTarget.focus({ preventScroll: true });
    marqueeRef.current = { pointerId: event.pointerId, start: pointerOnCanvas(event.clientX, event.clientY), clientX: event.clientX, clientY: event.clientY, moved: false };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const moveViewportPointer = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'touch' && touches.current.has(event.pointerId)) {
      touches.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (pinchRef.current) { event.preventDefault(); movePinch(); return; }
    }
    if (activeDrawing.current?.pointerId === event.pointerId) {
      event.preventDefault();
      sampleDrawing(event);
      return;
    }
    if (eraserPointer.current === event.pointerId) {
      event.preventDefault();
      const samples = event.nativeEvent.getCoalescedEvents?.() ?? [event.nativeEvent];
      for (const sample of samples.length ? samples : [event.nativeEvent]) eraseAt(sample.clientX, sample.clientY);
      return;
    }
    const pan = panRef.current;
    if (pan?.pointerId === event.pointerId) {
      event.preventDefault();
      if (Math.hypot(event.clientX - pan.clientX, event.clientY - pan.clientY) >= 4) pan.moved = true;
      applyCamera({ ...cameraRef.current, scrollLeft: pan.origin.scrollLeft - (event.clientX - pan.clientX), scrollTop: pan.origin.scrollTop - (event.clientY - pan.clientY) });
      return;
    }
    const drag = marqueeRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (!drag.moved && Math.hypot(event.clientX - drag.clientX, event.clientY - drag.clientY) < 4) return;
    event.preventDefault();
    drag.moved = true;
    const rect = selectionRect(drag.start, pointerOnCanvas(event.clientX, event.clientY));
    setMarquee(rect);
    selectWithin(rect);
  };

  const endViewportPointer = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'touch') {
      touches.current.delete(event.pointerId);
      if (pinchRef.current) {
        pinchRef.current = null;
        const remaining = [...touches.current.entries()];
        if (remaining.length >= 2) startPinch();
        else if (remaining.length === 1) {
          const [id, point] = remaining[0];
          panRef.current = { pointerId: id, clientX: point.x, clientY: point.y, origin: cameraRef.current, moved: true };
        } else {
          panRef.current = null;
          touchGesture.current = false;
        }
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
        clearPointerCursor();
        return;
      }
    }
    if (activeDrawing.current?.pointerId === event.pointerId) finishDrawing(event);
    if (eraserPointer.current === event.pointerId) {
      if (event.type === 'pointerup') eraseAt(event.clientX, event.clientY);
      eraserPointer.current = null;
      erasedIds.current.clear();
    }
    const pan = panRef.current;
    if (pan?.pointerId === event.pointerId) {
      if (event.type === 'pointerup' && !pan.moved && !touchGesture.current && event.button !== 1 && !tool) {
        pressCandidate.current = { at: performance.now(), x: event.clientX, y: event.clientY, pointerType: event.pointerType };
      }
      panRef.current = null;
    }
    const drag = marqueeRef.current;
    if (drag?.pointerId === event.pointerId) {
      if (event.type === 'pointerup') {
        if (drag.moved) {
          const rect = selectionRect(drag.start, pointerOnCanvas(event.clientX, event.clientY));
          selectWithin(rect);
          lastMarqueeEnd.current = performance.now();
        } else {
          selectIds(new Set());
          if (!tool) pressCandidate.current = { at: performance.now(), x: event.clientX, y: event.clientY, pointerType: event.pointerType };
        }
      } else selectIds(new Set());
      marqueeRef.current = null;
      setMarquee(null);
    }
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (event.pointerType === 'touch' && touches.current.size === 0) touchGesture.current = false;
    if (event.pointerType === 'touch' || event.type === 'pointercancel') clearPointerCursor();
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
    if (target.closest('.note-font-controls, textarea')) return;
    event.preventDefault();
    if (!selectedIdsRef.current.has(note.id)) selectNote(note.id);
    event.currentTarget.focus({ preventScroll: true });
    const origins = snapshot.notes.filter(item => selectedIdsRef.current.has(item.id)).map(item => ({ id: item.id, x: item.x, y: item.y }));
    if (!origins.length) return;
    dragRef.current = { pointerId: event.pointerId, anchorId: note.id, clientX: event.clientX, clientY: event.clientY, zoom, origins, dx: 0, dy: 0 };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const moveNoteDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    const dx = (event.clientX - drag.clientX) / drag.zoom;
    const dy = (event.clientY - drag.clientY) / drag.zoom;
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
    if (viewportSize.height > 0) session.setVisibleRange(canonicalTop, canonicalBottom);
  }, [session, canonicalTop, canonicalBottom, viewportSize.height]);

  const moveTo = useCallback((destination: Destination) => {
    const element = viewportRef.current;
    const page = pages[destination.page - 1];
    if (!element || !page) return;
    const current = cameraRef.current;
    const viewportWorldWidth = element.clientWidth / current.zoom;
    const destinationX = Number.isFinite(destination.x) ? destination.x! : page.width / 2;
    const centeredX = page.width <= viewportWorldWidth
      ? page.width / 2
      : clamp(destinationX, viewportWorldWidth / 2, page.width - viewportWorldWidth / 2);
    applyCamera({ ...current,
      scrollLeft: (page.x + centeredX) * current.zoom - element.clientWidth / 2,
      scrollTop: (page.y + (destination.y ?? 0)) * current.zoom - 72,
    });
  }, [pages, applyCamera]);

  const jumpToCursor = (cursor: CursorPosition | null) => {
    const element = viewportRef.current;
    if (!element || !cursor) return;
    const current = cameraRef.current;
    applyCamera({ ...current,
      scrollLeft: cursor.x * current.zoom - element.clientWidth / 2,
      scrollTop: cursor.y * current.zoom - element.clientHeight / 2,
    });
  };

  const setPointerCursor = (event: React.PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) {
      clearPointerCursor();
      return;
    }
    lastClientPointer.current = { x: event.clientX, y: event.clientY };
    session.activity();
    queuePointerCursor(event.clientX, event.clientY);
  };

  const createAtPointer = (event: React.MouseEvent<HTMLDivElement>) => {
    if (tool || performance.now() < suppressDoubleClickUntil.current) return;
    const target = event.target as HTMLElement;
    if (target.closest('button, a, input, textarea, .pdf-text-layer span, .note-item')) return;
    if (lastMarqueeEnd.current && performance.now() - lastMarqueeEnd.current < 400) return;
    createNoteAt(event.clientX, event.clientY);
  };

  const currentShareView = (): SharedView => {
    const viewport = viewportRef.current;
    const current = cameraRef.current;
    const centerX = (current.scrollLeft + (viewport?.clientWidth ?? viewportSize.width) / 2) / current.zoom;
    const centerY = (current.scrollTop + (viewport?.clientHeight ?? viewportSize.height) / 2) / current.zoom;
    const page = nearestPage(pages, centerY) ?? pages[0];
    return page ? {
      page: page.number,
      x: clamp(centerX - page.x, -10_000_000, 10_000_000),
      y: clamp(centerY - page.y, -10_000_000, 10_000_000),
      zoom: current.zoom,
    } : { page: 1, zoom: current.zoom };
  };
  const shareUrl = localOnly ? '' : buildShareUrl(window.location.origin, manifest.id, accessToken, currentShareView());
  const copyShare = async () => {
    const currentUrl = buildShareUrl(window.location.origin, manifest.id, accessToken, currentShareView());
    try { await navigator.clipboard.writeText(currentUrl); setShareCopied(true); }
    catch { setShareCopied(false); setShareOpen(true); }
  };
  const uploadFromShare = async () => {
    if (!onUpload || shareBusy || uploadState) return;
    setShareBusy(true);
    setShareActionError(null);
    try {
      await session.flush();
      await saveCamera(cameraStorageId, cameraRef.current);
      await onUpload(async () => {
        await session.flush();
        await saveCamera(cameraStorageId, cameraRef.current);
      });
    } catch (error) {
      setShareActionError(error instanceof Error ? error.message : 'This file could not be uploaded.');
    } finally {
      setShareBusy(false);
    }
  };
  const toggleTool = (next: Exclude<Tool, null>) => {
    clearDrawing();
    pressCandidate.current = null;
    setTool(current => current === next ? null : next);
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

  return <div className="workspace-shell" onPointerDownCapture={() => session.activity()} onKeyDown={onWorkspaceKeyDown}>
    <header className="workspace-header">
      <div className="workspace-left"><button type="button" className="brand brand-button" onClick={onHome} aria-label="Back to home">notora<span>.</span></button><span className="topbar-separator" /><span className="document-title" title={manifest.title}>{manifest.title}</span></div>
      <div className="workspace-actions">
        <button type="button" className={`toolbar-button outline-toggle${outlineOpen ? ' is-active' : ''}`} aria-label="Toggle outline" aria-expanded={outlineOpen} onClick={() => setOutlineOpen(value => !value)}><OutlineIcon /><span>Outline</span></button>
        <div className="drawing-tools" role="group" aria-label="Drawing tools">
          {(['pen', 'arrow', 'eraser', 'text'] as const).map(value => <button key={value} type="button" className={`toolbar-button drawing-tool${tool === value ? ' is-active' : ''}`} aria-label={`${value[0].toUpperCase()}${value.slice(1)} tool`} aria-pressed={tool === value} onClick={() => toggleTool(value)}>{value[0].toUpperCase()}{value.slice(1)}</button>)}
        </div>
        <div className="zoom-group" aria-label="Zoom controls"><button type="button" aria-label="Zoom out" disabled={zoom <= MIN_ZOOM} onClick={() => changeZoom(zoom - ZOOM_STEP)}>−</button><span>{Math.round(zoom * 100)}%</span><button type="button" aria-label="Zoom in" disabled={zoom >= MAX_ZOOM} onClick={() => changeZoom(zoom + ZOOM_STEP)}>+</button></div>
        <div className="topbar-separator share-separator" />
        <div className="share-wrap"><button type="button" className="toolbar-button share-button" aria-expanded={shareOpen} onClick={() => { setShareOpen(value => !value); setShareCopied(false); setShareActionError(null); }}>Share</button>{shareOpen && <div className="share-popover"><strong>Share this PDF</strong>{localOnly ? <><p>Upload this file to create a link for collaborators.</p><button type="button" className="primary-button share-upload-button" disabled={!onUpload || shareBusy || !!uploadState} onClick={() => void uploadFromShare()}>Upload this file</button>{uploadState && <div className="share-upload-state" role="status">{uploadState.status === 'uploading' ? `Uploading… ${Math.round(uploadState.progress)}%` : 'Processing PDF…'}</div>}{(shareActionError || uploadError) && <p className="form-error share-error" role="alert">{shareActionError || uploadError}</p>}</> : <><p>Anyone with this link can read and write notes. The link opens at your current location.</p><div className="share-link-row"><input aria-label="Share link" readOnly value={shareUrl} onFocus={event => event.currentTarget.select()} /><button type="button" onClick={() => void copyShare()}>{shareCopied ? 'Copied' : 'Copy'}</button></div></>}</div>}</div>
      </div>
      <div className="workspace-presence"><div className="participant-list" aria-label="Participants">{snapshot.participants.map(participant => <button key={participant.clientId} type="button" className="participant-pill" title={participant.cursor ? `Jump to ${participant.name}` : participant.name} aria-label={participant.cursor ? `Jump to ${participant.name}` : participant.name} disabled={!participant.cursor} onClick={() => jumpToCursor(participant.cursor)}><span className="participant-avatar" style={{ backgroundColor: participant.color }}>{participant.name.slice(0, 1).toUpperCase()}</span><span className="participant-name">{participant.name}</span></button>)}</div><span className={`connection-indicator ${snapshot.connection}`} title={snapshot.connection} /><span className={`save-status ${snapshot.saveState}`} role="status" title={snapshot.error || undefined}>{saveLabel}</span></div>
    </header>
    <div className="workspace-main">
      {outlineOpen && <aside className="outline-panel"><div className="outline-heading"><h2>Outline</h2><button type="button" aria-label="Close outline" onClick={() => setOutlineOpen(false)}>×</button></div>{manifest.outline.length ? <nav aria-label="PDF outline"><OutlineList items={manifest.outline} depth={0} onDestination={moveTo} /></nav> : <p className="outline-empty">No outline in this PDF.</p>}</aside>}
      <div className="viewer-wrap"><div className="viewer-viewport" ref={viewportRef} tabIndex={-1} onPointerDown={beginViewportPointer} onPointerEnter={setPointerCursor} onPointerMove={event => { moveViewportPointer(event); setPointerCursor(event); }} onPointerUp={endViewportPointer} onPointerCancel={endViewportPointer} onLostPointerCapture={endViewportPointer} onPointerLeave={clearPointerCursor} onDoubleClick={createAtPointer} onAuxClick={event => { if (event.button === 1) event.preventDefault(); }} aria-label={`${manifest.title} pages`}>
          <div className="pdf-stage" style={{ width: size.width, height: size.height, transform: `translate(${-camera.scrollLeft}px, ${-camera.scrollTop}px) scale(${zoom})` }}>
            {renderedPages.map(page => <PdfPage key={`${manifest.version}:${page.number}`} page={page} documentId={manifest.id} version={manifest.version} accessToken={accessToken} localPdf={localPdf} zoom={zoom} active={nearbyPageNumbers.has(page.number)} retain={desktop} onReady={onPageReady} onDestination={moveTo} />)}
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
              onFontChange={delta => {
                const fontSize = clamp(noteFontSize(note) + delta, MIN_NOTE_FONT_SIZE, MAX_NOTE_FONT_SIZE);
                session.updateNote(note.id, { fontSize });
                setNextNoteFontSize(fontSize);
              }}
              onBorderPointerDown={event => beginNoteDrag(note, event)}
              onBorderPointerMove={moveNoteDrag}
              onBorderPointerEnd={endNoteDrag}
            />)}</div>
            <div className="cursors-layer" aria-hidden="true">{snapshot.participants.filter(participant => participant.cursor).map(participant => <div key={participant.clientId} className="remote-cursor" style={{ left: participant.cursor!.x, top: participant.cursor!.y, color: participant.color }}><span className="cursor-pointer" /><span className="cursor-name" style={{ backgroundColor: participant.color }}>{participant.name}</span></div>)}</div>
          </div>
          <DrawingLayer ref={drawingLayerRef} drawings={snapshot.drawings} previews={snapshot.drawingPreviews} pages={pages} camera={camera} width={viewportSize.width} height={viewportSize.height} />
          {tool && <div className={`tool-pointer-shield tool-${tool}`} aria-hidden="true" />}
          {marquee && <div className="selection-marquee" aria-hidden="true" style={{ left: marquee.x * zoom - camera.scrollLeft, top: marquee.y * zoom - camera.scrollTop, width: marquee.width * zoom, height: marquee.height * zoom }} />}
      </div>{!tool && snapshot.notes.length === 0 && snapshot.drawings.length === 0 && <div className="viewer-hint">Double-click to add a note</div>}</div>
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
  onBorderPointerDown: (event: React.PointerEvent<HTMLDivElement>) => void;
  onBorderPointerMove: (event: React.PointerEvent<HTMLDivElement>) => void;
  onBorderPointerEnd: (event: React.PointerEvent<HTMLDivElement>) => void;
}

function NoteEditor({ note, page, selected, editing, onTextFocus, onTextBlur, onText, onExit, onFontChange, onBorderPointerDown, onBorderPointerMove, onBorderPointerEnd }: NoteEditorProps) {
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
