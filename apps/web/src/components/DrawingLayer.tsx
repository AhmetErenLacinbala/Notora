import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import type { Camera, CubicBezier, CursorPosition, DrawingShape, PageLayout, RemoteDrawingPreview } from '../../../../packages/shared/src/index';
import { drawArrowHead, traceCurves } from '../lib/drawingGeometry';

const INK = '#252925';
const MAX_PIXEL_RATIO = 2;

export interface DrawingLayerHandle {
  updateActive(kind: 'stroke' | 'arrow', points: CursorPosition[]): void;
  clearActive(): void;
}

interface DrawingLayerProps {
  drawings: DrawingShape[];
  previews: RemoteDrawingPreview[];
  pages: PageLayout[];
  camera: Camera;
  width: number;
  height: number;
}

function prepare(canvas: HTMLCanvasElement, width: number, height: number): { context: CanvasRenderingContext2D; ratio: number } | null {
  const context = canvas.getContext('2d');
  if (!context || width <= 0 || height <= 0) return null;
  const ratio = Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO);
  const pixelWidth = Math.max(1, Math.round(width * ratio));
  const pixelHeight = Math.max(1, Math.round(height * ratio));
  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
  }
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, pixelWidth, pixelHeight);
  return { context, ratio };
}

function setWorldTransform(context: CanvasRenderingContext2D, ratio: number, camera: Camera) {
  context.setTransform(ratio * camera.zoom, 0, 0, ratio * camera.zoom,
    -ratio * camera.scrollLeft, -ratio * camera.scrollTop);
  context.strokeStyle = INK;
  context.fillStyle = INK;
  context.lineJoin = 'round';
  context.lineCap = 'round';
}

function paintPolyline(context: CanvasRenderingContext2D, points: CursorPosition[], kind: 'stroke' | 'arrow', width: number) {
  if (!points.length) return;
  context.lineWidth = width;
  context.beginPath();
  context.moveTo(points[0].x, points[0].y);
  if (kind === 'arrow') {
    const last = points[points.length - 1];
    context.lineTo(last.x, last.y);
  } else {
    for (let index = 1; index < points.length; index++) context.lineTo(points[index].x, points[index].y);
  }
  if (kind === 'arrow' && points.length > 1) {
    const first = points[0];
    const last = points[points.length - 1];
    const end = { x: last.x - first.x, y: last.y - first.y };
    const curve: CubicBezier = [first.x, first.y, first.x + end.x / 3, first.y + end.y / 3,
      first.x + end.x * 2 / 3, first.y + end.y * 2 / 3, last.x, last.y];
    drawArrowHead(context, [curve], width);
  }
  if (points.length > 1) context.stroke();
  else {
    context.beginPath();
    context.arc(points[0].x, points[0].y, width / 2, 0, Math.PI * 2);
    context.fill();
  }
}

export const DrawingLayer = forwardRef<DrawingLayerHandle, DrawingLayerProps>(function DrawingLayer(
  { drawings, previews, pages, camera, width, height }, ref,
) {
  const staticCanvas = useRef<HTMLCanvasElement>(null);
  const activeCanvas = useRef<HTMLCanvasElement>(null);
  const active = useRef<{ kind: 'stroke' | 'arrow'; points: CursorPosition[] } | null>(null);
  const cameraRef = useRef(camera);
  const sizeRef = useRef({ width, height });
  const previewsRef = useRef(previews);
  const pagesRef = useRef(pages);
  const activeFrame = useRef(0);
  cameraRef.current = camera;
  sizeRef.current = { width, height };
  previewsRef.current = previews;
  pagesRef.current = pages;

  const paintActive = () => {
    activeFrame.current = 0;
    const canvas = activeCanvas.current;
    const current = active.current;
    if (!canvas) return;
    const size = sizeRef.current;
    const setup = prepare(canvas, size.width, size.height);
    if (!setup) return;
    setWorldTransform(setup.context, setup.ratio, cameraRef.current);
    for (const preview of previewsRef.current) {
      const page = pagesRef.current[preview.anchorPage - 1];
      if (!page || !preview.points.length) continue;
      setup.context.save();
      setup.context.translate(page.x + preview.x, page.y + preview.y);
      paintPolyline(setup.context, preview.points, preview.kind, preview.width);
      setup.context.restore();
    }
    if (current) paintPolyline(setup.context, current.points, current.kind, 2);
  };

  const scheduleActive = () => {
    if (!activeFrame.current) activeFrame.current = requestAnimationFrame(paintActive);
  };

  useImperativeHandle(ref, () => ({
    updateActive(kind, points) {
      active.current = { kind, points };
      scheduleActive();
    },
    clearActive() {
      active.current = null;
      scheduleActive();
    },
  }), []);

  useEffect(() => {
    const canvas = staticCanvas.current;
    if (!canvas) return;
    const frame = requestAnimationFrame(() => {
      const setup = prepare(canvas, width, height);
      if (!setup) return;
      const { context, ratio } = setup;
      setWorldTransform(context, ratio, camera);
      const visibleLeft = camera.scrollLeft / camera.zoom;
      const visibleTop = camera.scrollTop / camera.zoom;
      const visibleRight = visibleLeft + width / camera.zoom;
      const visibleBottom = visibleTop + height / camera.zoom;
      for (const drawing of drawings) {
        if (!drawing.curves?.length) continue;
        const page = pages[drawing.anchorPage - 1];
        if (!page) continue;
        const x = page.x + drawing.x, y = page.y + drawing.y;
        const bounds = drawing.bounds;
        if (x + bounds.maxX < visibleLeft || x + bounds.minX > visibleRight ||
            y + bounds.maxY < visibleTop || y + bounds.minY > visibleBottom) continue;
        context.save();
        context.translate(x, y);
        context.lineWidth = drawing.width;
        context.beginPath();
        traceCurves(context, drawing.curves);
        if (drawing.kind === 'arrow') drawArrowHead(context, drawing.curves, drawing.width);
        context.stroke();
        context.restore();
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [drawings, pages, camera, width, height]);

  useEffect(() => { scheduleActive(); }, [previews, camera, width, height]);
  useEffect(() => () => { if (activeFrame.current) cancelAnimationFrame(activeFrame.current); }, []);

  return <div className="drawing-layer" aria-hidden="true">
    <canvas className="drawing-canvas" ref={staticCanvas} style={{ width, height }} />
    <canvas className="drawing-canvas" ref={activeCanvas} style={{ width, height }} />
  </div>;
});
