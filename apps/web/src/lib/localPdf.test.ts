import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { GlobalWorkerOptions } from 'pdfjs-dist';
import { openLocalPdf } from './localPdf';

function onePagePdf(): string {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << >> /Contents 4 0 R >>',
    '<< /Length 0 >>\nstream\n\nendstream',
  ];
  let text = '%PDF-1.4\n';
  const offsets = [0];
  for (let index = 0; index < objects.length; index++) {
    offsets.push(text.length);
    text += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xref = text.length;
  text += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) text += `${String(offset).padStart(10, '0')} 00000 n \n`;
  text += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return text;
}

describe('local PDF byte source', () => {
  it('reads page metadata and an absent outline without rendering a page or fetching the network', async () => {
    // This integration test executes the worker in Node 24, which needs PDF.js's
    // compatibility build for browser-only APIs such as Uint8Array.toHex.
    GlobalWorkerOptions.workerSrc = pathToFileURL(resolve('node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs')).toString();
    const reads: number[] = [];
    class TrackedBlob extends Blob {
      override slice(start?: number, end?: number, contentType?: string): Blob {
        const part = super.slice(start, end, contentType);
        reads.push(part.size);
        return part;
      }
      override arrayBuffer(): Promise<ArrayBuffer> { throw new Error('Whole-file read forbidden'); }
    }
    const blob = new TrackedBlob([onePagePdf()]);
    const source = await openLocalPdf(blob, 'local-test', 'Test', 'a'.repeat(64));
    try {
      expect(source.manifest.pages).toEqual([{ number: 1, width: 612, height: 792 }]);
      expect(source.manifest.outline).toEqual([]);
      expect(await source.getPageLinks(1)).toEqual([]);
      expect(reads.length).toBeGreaterThan(0);
      expect(reads.every(size => size <= 64 * 1024)).toBe(true);
    } finally {
      await source.destroy();
    }
  });
});
