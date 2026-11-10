import type { Camera } from '../../../../packages/shared/src/index';

export interface CanvasPoint { x: number; y: number }
export interface CanvasRect extends CanvasPoint { width: number; height: number }

/** Convert a client pointer into the same unzoomed stage coordinates as notes/cursors. */
export function canvasPoint(
  clientPoint: CanvasPoint, viewportRect: { left: number; top: number }, camera: Camera,
): CanvasPoint {
  return {
    x: (clientPoint.x - viewportRect.left + camera.scrollLeft) / camera.zoom,
    y: (clientPoint.y - viewportRect.top + camera.scrollTop) / camera.zoom,
  };
}

/** Keep the world point beneath a viewport pixel fixed when changing zoom. */
export function zoomCameraAt(camera: Camera, viewportPoint: CanvasPoint, nextZoom: number): Camera {
  const ratio = nextZoom / camera.zoom;
  return {
    scrollLeft: (camera.scrollLeft + viewportPoint.x) * ratio - viewportPoint.x,
    scrollTop: (camera.scrollTop + viewportPoint.y) * ratio - viewportPoint.y,
    zoom: nextZoom,
  };
}

export function selectionRect(start: CanvasPoint, end: CanvasPoint): CanvasRect {
  return {
    x: Math.min(start.x, end.x), y: Math.min(start.y, end.y),
    width: Math.abs(end.x - start.x), height: Math.abs(end.y - start.y),
  };
}

export function intersectsRect(a: CanvasRect, b: CanvasRect): boolean {
  return a.x <= b.x + b.width && a.x + a.width >= b.x &&
    a.y <= b.y + b.height && a.y + a.height >= b.y;
}

/** WheelEvent reports pixels (0), lines (1), or pages (2). */
export function wheelPixels(delta: number, deltaMode: number, viewportHeight: number): number {
  return delta * (deltaMode === 1 ? 16 : deltaMode === 2 ? viewportHeight : 1);
}
