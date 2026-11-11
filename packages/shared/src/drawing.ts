import { MAX_DRAWING_SEGMENTS, type CubicBezier } from './index.ts';

const MAGIC = 0x3152544e; // NTR1, little-endian count and float32 cubics.

export function encodeCurves(curves: CubicBezier[]): Uint8Array {
  if (!curves.length || curves.length > MAX_DRAWING_SEGMENTS || curves.some(c => c.length !== 8 || c.some(n => !Number.isFinite(n) || Math.abs(n) > 10_000_000))) throw new Error('Invalid drawing geometry');
  const bytes = new Uint8Array(8 + curves.length * 32);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, MAGIC, true); view.setUint32(4, curves.length, true);
  let offset = 8;
  for (const curve of curves) for (const n of curve) { view.setFloat32(offset, n, true); offset += 4; }
  return bytes;
}

export function decodeCurves(bytes: Uint8Array): CubicBezier[] | null {
  if (!(bytes instanceof Uint8Array) || bytes.length < 40) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint32(4, true);
  if (view.getUint32(0, true) !== MAGIC || !count || count > MAX_DRAWING_SEGMENTS || bytes.length !== 8 + count * 32) return null;
  const curves: CubicBezier[] = [];
  for (let i = 0; i < count; i++) {
    const c = Array.from({ length: 8 }, (_, j) => view.getFloat32(8 + i * 32 + j * 4, true)) as CubicBezier;
    if (c.some(n => !Number.isFinite(n) || Math.abs(n) > 10_000_000)) return null;
    curves.push(c);
  }
  return curves;
}

