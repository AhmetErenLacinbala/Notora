import { describe, expect, it } from 'vitest';
import { decodeCurves, drawingBounds, encodeCurves, fitStroke, hitDrawing } from './drawingGeometry';
import type { CubicBezier } from '../../../../packages/shared/src/index';

describe('handwriting geometry', () => {
  it('fits a smooth sampled stroke compactly without losing the sampled shape', () => {
    const points = Array.from({ length: 501 }, (_, i) => ({ x: i / 2, y: 30 * Math.sin(i / 75) }));
    const curves = fitStroke(points, 0.75);
    expect(curves.length).toBeLessThan(20);
    expect(curves[0].slice(0, 2)).toEqual([0, 0]);
    expect(curves.at(-1)?.slice(-2)).toEqual([points.at(-1)!.x, points.at(-1)!.y]);
    for (const point of points) expect(hitDrawing(curves, point, 0.8, 'stroke', 0)).toBe(true);
  });
  it('keeps deliberate corners and closed loops, including duplicate input samples', () => {
    const corner = fitStroke([{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 50 }], 0.5);
    expect(corner).toHaveLength(2);
    expect(corner[0].slice(-2)).toEqual([50, 0]);
    expect(corner[1].slice(0, 2)).toEqual([50, 0]);
    const loop = Array.from({ length: 101 }, (_, i) => ({ x: 50 * Math.cos(i * Math.PI / 50), y: 50 * Math.sin(i * Math.PI / 50) }));
    const curves = fitStroke(loop, 0.5);
    expect(curves.length).toBeGreaterThan(1);
    for (const point of loop) expect(hitDrawing(curves, point, 0.6, 'stroke', 0)).toBe(true);
    expect(hitDrawing(curves, { x: 0, y: 0 }, 2, 'stroke', 2)).toBe(false);
  });
  it('preserves pen taps and bounds extremely long input', () => {
    const dot = fitStroke([{ x: 5, y: 6 }, { x: 5, y: 6 }], 0.75);
    expect(hitDrawing(dot, { x: 5, y: 6 }, 0, 'stroke', 2)).toBe(true);
    expect(fitStroke([], 0.75)).toEqual([]);
    expect(fitStroke([{ x: NaN, y: 0 }], 1)).toEqual([]);
    const zigzag = Array.from({ length: 20_000 }, (_, i) => ({ x: i, y: i % 2 }));
    const curves = fitStroke(zigzag, 0.1);
    expect(curves.length).toBeLessThanOrEqual(4096);
    expect(curves.at(-1)?.slice(-2)).toEqual([19999, 1]);
  });
  it('encodes bounded, finite float32 curves and rejects malformed bytes', () => {
    const curves: CubicBezier[] = [[-20, 3, 1.25, 4, 40, 50, 30, 80]];
    const bytes = encodeCurves(curves);
    expect(bytes.byteLength).toBe(40);
    expect(decodeCurves(bytes)).toEqual(curves);
    const padded = new Uint8Array(44); padded.set(bytes, 4);
    expect(decodeCurves(padded.subarray(4))).toEqual(curves);
    expect(decodeCurves(bytes.subarray(1))).toBeNull();
    expect(decodeCurves(new Uint8Array(40))).toBeNull();
    new DataView(bytes.buffer).setFloat32(8, Infinity, true);
    expect(decodeCurves(bytes)).toBeNull();
    expect(() => encodeCurves([[NaN, 0, 0, 0, 0, 0, 0, 0]])).toThrow();
  });
  it('includes arrowheads and over-page bulges in bounds and eraser hit tests', () => {
    const curve: CubicBezier[] = [[0, 0, 30, -80, 70, -80, 100, 0]];
    const bounds = drawingBounds(curve, 2, 'stroke');
    expect(bounds.minY).toBeLessThanOrEqual(-81);
    expect(hitDrawing(curve, { x: 50, y: -60 }, 1, 'stroke', 2)).toBe(true);
    expect(hitDrawing(curve, { x: 50, y: 0 }, 1, 'stroke', 2)).toBe(false);
    const arrow: CubicBezier[] = [[0, 0, 33, 0, 67, 0, 100, 0]];
    expect(hitDrawing(arrow, { x: 92, y: 4 }, 0.1, 'arrow', 2)).toBe(true);
    expect(hitDrawing(arrow, { x: 92, y: 4 }, 0.1, 'stroke', 2)).toBe(false);
    expect(drawingBounds(arrow, 2, 'arrow').maxY).toBeGreaterThanOrEqual(5);
  });
});
