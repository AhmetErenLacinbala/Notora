import { describe, expect, it } from 'vitest';
import { canvasPoint, intersectsRect, selectionRect, wheelPixels, zoomCameraAt } from './canvasGeometry';

describe('canvas camera and selection geometry', () => {
  it('keeps the point under the pointer fixed when zooming at a noncentral point', () => {
    const viewport = { left: 90, top: 80 };
    const client = { x: 270, y: 420 };
    const camera = { scrollLeft: 480, scrollTop: 3000, zoom: 1.25 };
    const before = canvasPoint(client, viewport, camera);
    const next = zoomCameraAt(camera, { x: client.x - viewport.left, y: client.y - viewport.top }, 2.2);
    const after = canvasPoint(client, viewport, next);
    expect(after.x).toBeCloseTo(before.x);
    expect(after.y).toBeCloseTo(before.y);
    const restored = zoomCameraAt(next, { x: 180, y: 340 }, camera.zoom);
    expect(restored.scrollLeft).toBeCloseTo(camera.scrollLeft);
    expect(restored.scrollTop).toBeCloseTo(camera.scrollTop);
  });

  it('allows panning past stage edges without losing canonical note coordinates', () => {
    const camera = { scrollLeft: -300, scrollTop: -100, zoom: 0.5 };
    expect(canvasPoint({ x: 330, y: 160 }, { left: 30, top: 60 }, camera)).toEqual({ x: 0, y: 0 });
    const next = zoomCameraAt(camera, { x: 0, y: 0 }, 1);
    expect(next).toEqual({ scrollLeft: -600, scrollTop: -200, zoom: 1 });
  });

  it('selects intersecting notes for reverse-direction drags at fractional zoom', () => {
    const camera = { scrollLeft: -120, scrollTop: 870, zoom: 0.8 };
    const viewport = { left: 0, top: 100 };
    const start = canvasPoint({ x: 440, y: 500 }, viewport, camera);
    const end = canvasPoint({ x: 200, y: 180 }, viewport, camera);
    const rectangle = selectionRect(start, end);
    expect(rectangle).toEqual({ x: 100, y: 1187.5, width: 300, height: 400 });
    // A note anchored on a preceding page can overlap this rectangle.
    expect(intersectsRect(rectangle, { x: 50, y: 1100, width: 80, height: 150 })).toBe(true);
    expect(intersectsRect(rectangle, { x: 401, y: 1200, width: 90, height: 40 })).toBe(false);
    expect(intersectsRect(rectangle, { x: 100, y: 1600, width: 80, height: 30 })).toBe(false);
    expect(selectionRect(end, start)).toEqual(rectangle);
  });

  it('normalizes pixel, line and page wheel inputs consistently', () => {
    expect(wheelPixels(-2.5, 0, 800)).toBe(-2.5);
    expect(wheelPixels(3, 1, 800)).toBe(48);
    expect(wheelPixels(1, 2, 800)).toBe(800);
  });
});
