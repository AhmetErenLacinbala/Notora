import { MAX_DRAWING_SEGMENTS, type CubicBezier, type CursorPosition as Point, type DrawingBounds } from '../../../../packages/shared/src/index';

export { encodeCurves, decodeCurves } from '../../../../packages/shared/src/drawing';

const EPS = 1e-10;
const sub = (a: Point, b: Point): Point => ({ x: a.x - b.x, y: a.y - b.y });
const dot = (a: Point, b: Point): number => a.x * b.x + a.y * b.y;
const length = (a: Point): number => Math.hypot(a.x, a.y);
const scale = (a: Point, s: number): Point => ({ x: a.x * s, y: a.y * s });
const unit = (a: Point): Point => scale(a, 1 / (length(a) || 1));
const distance2 = (a: Point, b: Point): number => (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
const finitePoint = (p: Point) => Number.isFinite(p.x) && Number.isFinite(p.y) && Math.abs(p.x) <= 10_000_000 && Math.abs(p.y) <= 10_000_000;

function evaluate(c: CubicBezier, t: number): Point {
  const s = 1 - t;
  return {
    x: s ** 3 * c[0] + 3 * s * s * t * c[2] + 3 * s * t * t * c[4] + t ** 3 * c[6],
    y: s ** 3 * c[1] + 3 * s * s * t * c[3] + 3 * s * t * t * c[5] + t ** 3 * c[7],
  };
}

function cubic(a: Point, b: Point, left: Point, right: Point, alpha: number, beta: number): CubicBezier {
  return [a.x, a.y, a.x + left.x * alpha, a.y + left.y * alpha, b.x + right.x * beta, b.y + right.y * beta, b.x, b.y];
}

function parameters(points: Point[], start: number, end: number): number[] {
  const u = [0];
  for (let i = start + 1; i <= end; i++) u.push(u[u.length - 1] + length(sub(points[i], points[i - 1])));
  const total = u[u.length - 1];
  return u.map(value => value / total);
}

// Endpoints and tangent directions are fixed. Only the two handle lengths
// remain unknown, so least squares reduces to a 2x2 linear system.
function fit(points: Point[], start: number, end: number, u: number[], left: Point, right: Point): CubicBezier {
  const a = points[start], b = points[end];
  let m00 = 0, m01 = 0, m11 = 0, v0 = 0, v1 = 0;
  for (let i = start; i <= end; i++) {
    const t = u[i - start], s = 1 - t;
    const b0 = s ** 3, b1 = 3 * s * s * t, b2 = 3 * s * t * t, b3 = t ** 3;
    const l = scale(left, b1), r = scale(right, b2);
    const residual = { x: points[i].x - (b0 + b1) * a.x - (b2 + b3) * b.x, y: points[i].y - (b0 + b1) * a.y - (b2 + b3) * b.y };
    m00 += dot(l, l); m01 += dot(l, r); m11 += dot(r, r);
    v0 += dot(l, residual); v1 += dot(r, residual);
  }
  const determinant = m00 * m11 - m01 * m01;
  const chord = length(sub(b, a));
  let alpha = (v0 * m11 - v1 * m01) / determinant;
  let beta = (m00 * v1 - m01 * v0) / determinant;
  if (Math.abs(determinant) < EPS || !Number.isFinite(alpha + beta) || alpha < chord * 1e-6 || beta < chord * 1e-6) alpha = beta = chord / 3;
  return cubic(a, b, left, right, alpha, beta);
}

function residual(points: Point[], start: number, end: number, curve: CubicBezier, u: number[]): { error: number; split: number } {
  let error = -1, split = (start + end) >> 1;
  for (let i = start + 1; i < end; i++) {
    const next = distance2(evaluate(curve, u[i - start]), points[i]);
    if (next > error) { error = next; split = i; }
  }
  return { error, split };
}

function reparameterize(points: Point[], start: number, end: number, c: CubicBezier, parameters: number[]): number[] | null {
  const next = [0];
  for (let i = start + 1; i < end; i++) {
    const t = parameters[i - start], s = 1 - t;
    const difference = sub(evaluate(c, t), points[i]);
    const first = {
      x: 3 * (s * s * (c[2] - c[0]) + 2 * s * t * (c[4] - c[2]) + t * t * (c[6] - c[4])),
      y: 3 * (s * s * (c[3] - c[1]) + 2 * s * t * (c[5] - c[3]) + t * t * (c[7] - c[5])),
    };
    const second = { x: 6 * (s * (c[4] - 2 * c[2] + c[0]) + t * (c[6] - 2 * c[4] + c[2])), y: 6 * (s * (c[5] - 2 * c[3] + c[1]) + t * (c[7] - 2 * c[5] + c[3])) };
    const denominator = dot(first, first) + dot(difference, second);
    const value = Math.abs(denominator) > EPS ? t - dot(difference, first) / denominator : t;
    // A fold in the parameter order would reverse part of the handwriting.
    if (!Number.isFinite(value) || value <= next[next.length - 1] || value >= 1) return null;
    next.push(value);
  }
  next.push(1);
  return next;
}

/** Schneider-style piecewise cubic fitting: fit, refine parameters, split at worst residual. */
export function fitStroke(input: Point[], tolerance: number): CubicBezier[] {
  let points: Point[] = [];
  for (const p of input) if (finitePoint(p) && (!points.length || distance2(p, points[points.length - 1]) > EPS)) points.push({ x: p.x, y: p.y });
  if (!points.length) return [];
  if (points.length === 1) { const { x, y } = points[0]; return [[x, y, x, y, x, y, x, y]]; }
  // Bound worst-case work/storage for a very long, never-lifted gesture.
  if (points.length > MAX_DRAWING_SEGMENTS + 1) {
    const source = points;
    points = Array.from({ length: MAX_DRAWING_SEGMENTS + 1 }, (_, i) => source[Math.round(i * (source.length - 1) / MAX_DRAWING_SEGMENTS)]);
  }
  const threshold = (Number.isFinite(tolerance) ? Math.max(0.01, tolerance) : 0.75) ** 2;
  const output: CubicBezier[] = [];
  function segment(start: number, end: number, left: Point, right: Point, depth: number): void {
    if (end - start === 1) {
      const handle = length(sub(points[end], points[start])) / 3;
      output.push(cubic(points[start], points[end], left, right, handle, handle)); return;
    }
    if (depth >= 32) {
      for (let i = start; i < end; i++) {
        const direction = sub(points[i + 1], points[i]);
        output.push(cubic(points[i], points[i + 1], direction, scale(direction, -1), 1 / 3, 1 / 3));
      }
      return;
    }
    let u = parameters(points, start, end);
    let curve = fit(points, start, end, u, left, right);
    let worst = residual(points, start, end, curve, u);
    if (worst.error <= threshold) { output.push(curve); return; }
    if (worst.error <= threshold * 16) {
      for (let iteration = 0; iteration < 4; iteration++) {
        const next = reparameterize(points, start, end, curve, u);
        if (!next) break;
        u = next;
        curve = fit(points, start, end, u, left, right);
        worst = residual(points, start, end, curve, u);
        if (worst.error <= threshold) { output.push(curve); return; }
      }
    }
    const k = worst.split;
    let backward = unit(sub(points[k - 1], points[k + 1]));
    if (length(backward) < EPS) backward = unit(sub(points[k - 1], points[k]));
    segment(start, k, left, backward, depth + 1);
    segment(k, end, scale(backward, -1), right, depth + 1);
  }
  // Keep deliberate corners/cusps sharp instead of forcing a shared tangent.
  let start = 0;
  for (let i = 1; i < points.length; i++) {
    const corner = i < points.length - 1 && dot(unit(sub(points[i], points[i - 1])), unit(sub(points[i + 1], points[i]))) < 0.5;
    if (corner || i === points.length - 1) {
      segment(start, i, unit(sub(points[start + 1], points[start])), unit(sub(points[i - 1], points[i])), 0);
      start = i;
    }
  }
  return output;
}

function arrowHead(curves: CubicBezier[], width: number): Point[] {
  const c = curves[curves.length - 1];
  if (!c) return [];
  const tip = { x: c[6], y: c[7] };
  let direction = sub(tip, { x: c[4], y: c[5] });
  if (length(direction) < EPS) direction = sub(tip, { x: c[0], y: c[1] });
  if (length(direction) < EPS) return [];
  const tangent = unit(direction), size = Math.max(8, width * 4);
  const back = { x: tip.x - tangent.x * size, y: tip.y - tangent.y * size };
  return [{ x: back.x - tangent.y * size * 0.5, y: back.y + tangent.x * size * 0.5 }, tip, { x: back.x + tangent.y * size * 0.5, y: back.y - tangent.x * size * 0.5 }];
}

/** Control hull is conservative, so off-page bulges and arrowheads never get culled. */
export function drawingBounds(curves: CubicBezier[], width: number, kind: 'stroke' | 'arrow'): DrawingBounds {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const include = (x: number, y: number) => { minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); };
  for (const c of curves) for (let i = 0; i < 8; i += 2) include(c[i], c[i + 1]);
  if (kind === 'arrow') for (const p of arrowHead(curves, width)) include(p.x, p.y);
  if (!curves.length) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  const padding = Math.max(0, width) / 2;
  return { minX: minX - padding, minY: minY - padding, maxX: maxX + padding, maxY: maxY + padding };
}

function segmentDistance2(p: Point, a: Point, b: Point): number {
  const ab = sub(b, a), denominator = dot(ab, ab);
  const t = denominator ? Math.max(0, Math.min(1, dot(sub(p, a), ab) / denominator)) : 0;
  return distance2(p, { x: a.x + t * ab.x, y: a.y + t * ab.y });
}

function hitCurve(c: CubicBezier, point: Point, radius: number, depth = 0): boolean {
  const xs = [c[0], c[2], c[4], c[6]], ys = [c[1], c[3], c[5], c[7]];
  if (point.x < Math.min(...xs) - radius || point.x > Math.max(...xs) + radius || point.y < Math.min(...ys) - radius || point.y > Math.max(...ys) + radius) return false;
  const a = { x: c[0], y: c[1] }, b = { x: c[6], y: c[7] };
  const flatness = Math.max(segmentDistance2({ x: c[2], y: c[3] }, a, b), segmentDistance2({ x: c[4], y: c[5] }, a, b));
  const accuracy = Math.max(0.05, Math.min(0.25, radius / 4));
  if (depth >= 12 || flatness <= accuracy ** 2) return segmentDistance2(point, a, b) <= (radius + accuracy) ** 2;
  const x01 = (c[0] + c[2]) / 2, y01 = (c[1] + c[3]) / 2;
  const x12 = (c[2] + c[4]) / 2, y12 = (c[3] + c[5]) / 2;
  const x23 = (c[4] + c[6]) / 2, y23 = (c[5] + c[7]) / 2;
  const x012 = (x01 + x12) / 2, y012 = (y01 + y12) / 2, x123 = (x12 + x23) / 2, y123 = (y12 + y23) / 2;
  const midX = (x012 + x123) / 2, midY = (y012 + y123) / 2;
  return hitCurve([c[0], c[1], x01, y01, x012, y012, midX, midY], point, radius, depth + 1)
    || hitCurve([midX, midY, x123, y123, x23, y23, c[6], c[7]], point, radius, depth + 1);
}

export function hitDrawing(curves: CubicBezier[], point: Point, radius: number, kind: 'stroke' | 'arrow', width: number): boolean {
  const reach = Math.max(0, radius) + width / 2;
  if (curves.some(c => hitCurve(c, point, reach))) return true;
  const head = kind === 'arrow' ? arrowHead(curves, width) : [];
  return head.some((p, i) => i > 0 && segmentDistance2(point, head[i - 1], p) <= reach ** 2);
}

/** Appends a path; callers own beginPath/stroke and world/camera transforms. */
export function traceCurves(context: CanvasRenderingContext2D, curves: CubicBezier[]): void {
  for (const c of curves) {
    context.moveTo(c[0], c[1]);
    if (c.every((n, i) => n === c[i % 2])) {
      context.lineTo(c[0] + 0.001, c[1]); // Round cap makes a stationary pen tap visible.
    } else context.bezierCurveTo(c[2], c[3], c[4], c[5], c[6], c[7]);
  }
}

/** Appends the two open arrowhead lines; caller strokes with round caps/joins. */
export function drawArrowHead(context: CanvasRenderingContext2D, curves: CubicBezier[], width: number): void {
  const head = arrowHead(curves, width);
  if (!head.length) return;
  context.moveTo(head[0].x, head[0].y);
  context.lineTo(head[1].x, head[1].y); context.lineTo(head[2].x, head[2].y);
}
