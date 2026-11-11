import { getDocument, GlobalWorkerOptions, PDFDataRangeTransport, PDFWorker } from 'pdfjs-dist';
import type { PDFDocumentLoadingTask, PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import type { Destination, DocumentManifest, OutlineItem, PageLink } from '../../../../packages/shared/src/index';

const RANGE_BYTES = 64 * 1024;
const MAX_PAGES = 20_000;
const MAX_OUTLINE_ITEMS = 20_000;
const MAX_LINKS_PER_PAGE = 50_000;

GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString();

// One PDF.js worker is shared by all local sources. The worker lives only
// while at least one local PDF is open.
let sharedWorker: PDFWorker | undefined;
let workerUsers = 0;
function acquireWorker(): PDFWorker {
  sharedWorker ??= PDFWorker.create({ name: 'notora-local-pdf' });
  workerUsers++;
  return sharedWorker;
}
function releaseWorker(): void {
  workerUsers--;
  if (workerUsers === 0) {
    sharedWorker?.destroy();
    sharedWorker = undefined;
  }
}

class BlobRangeTransport extends PDFDataRangeTransport {
  private closed = false;
  constructor(private readonly blob: Blob, initial: Uint8Array, private readonly onReadError: (error: unknown) => void) {
    super(blob.size, initial, false);
  }
  private fail(error: unknown): void {
    if (this.closed) return;
    this.closed = true;
    this.onReadError(error);
  }
  override requestDataRange(begin: number, end: number): void {
    if (this.closed) return;
    if (!Number.isSafeInteger(begin) || !Number.isSafeInteger(end) || begin < 0 || end > this.blob.size || end <= begin) {
      this.fail(new Error('Invalid PDF byte range.'));
      return;
    }
    // PDF.js expects one answer per range request. Keep individual Blob reads
    // bounded even if it asks for several adjacent chunks at once.
    const read = async () => {
      const result = new Uint8Array(end - begin);
      for (let offset = begin; offset < end; offset += RANGE_BYTES) {
        const bytes = new Uint8Array(await this.blob.slice(offset, Math.min(end, offset + RANGE_BYTES)).arrayBuffer());
        if (this.closed) return;
        result.set(bytes, offset - begin);
      }
      if (!this.closed) this.onDataRange(begin, result);
    };
    void read().catch(error => this.fail(error));
  }
  override abort(): void { this.closed = true; }
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function safeUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 4096 || /[\u0000-\u001f\u007f]/.test(value)) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' || parsed.protocol === 'mailto:';
  } catch { return false; }
}

function pageNumber(pdf: PDFDocumentProxy, ref: unknown): Promise<number | undefined> {
  if (Number.isSafeInteger(ref) && typeof ref === 'number' && ref >= 0 && ref < pdf.numPages) return Promise.resolve(ref + 1);
  if (typeof ref !== 'object' || ref === null || !('num' in ref) || !('gen' in ref) ||
      !Number.isSafeInteger(ref.num) || !Number.isSafeInteger(ref.gen)) return Promise.resolve(undefined);
  return pdf.getPageIndex(ref as { num: number; gen: number }).then(index => index + 1).catch(() => undefined);
}

async function resolveDestination(pdf: PDFDocumentProxy, raw: unknown): Promise<Destination | null> {
  const spec = typeof raw === 'string' ? await pdf.getDestination(raw).catch(() => null) : raw;
  if (!Array.isArray(spec) || spec.length < 2) return null;
  const number = await pageNumber(pdf, spec[0]);
  if (!number || number > pdf.numPages) return null;
  const destination: Destination = { page: number };
  const mode = typeof spec[1] === 'object' && spec[1] !== null && 'name' in spec[1] ? spec[1].name : undefined;
  let x: unknown;
  let y: unknown;
  if (mode === 'XYZ') { x = spec[2]; y = spec[3]; }
  else if (mode === 'FitH' || mode === 'FitBH') y = spec[2];
  else if (mode === 'FitV' || mode === 'FitBV') x = spec[2];
  if (finite(x) || finite(y)) {
    const page = await pdf.getPage(number);
    const view = page.view;
    const viewport = page.getViewport({ scale: 1 });
    const [px, py] = viewport.convertToViewportPoint(finite(x) ? x : view[0], finite(y) ? y : view[3]);
    if (finite(px) && finite(py)) {
      destination.x = Math.max(0, Math.min(viewport.width, px));
      destination.y = Math.max(0, Math.min(viewport.height, py));
    }
  }
  return destination;
}

async function readOutline(pdf: PDFDocumentProxy): Promise<OutlineItem[]> {
  const outline = await pdf.getOutline();
  if (!outline) return [];
  let count = 0;
  const walk = async (nodes: Awaited<ReturnType<PDFDocumentProxy['getOutline']>>): Promise<OutlineItem[]> => {
    const results: OutlineItem[] = [];
    for (const node of nodes) {
      if (++count > MAX_OUTLINE_ITEMS) throw new Error('This PDF has too many outline entries.');
      results.push({
        title: String(node.title ?? '').slice(0, 1024),
        destination: await resolveDestination(pdf, node.dest),
        items: await walk(node.items ?? []),
      });
    }
    return results;
  };
  return walk(outline);
}

export interface LocalPdfSource {
  readonly manifest: DocumentManifest;
  getPage(pageNumber: number): Promise<PDFPageProxy>;
  getPageLinks(pageNumber: number): Promise<PageLink[]>;
  destroy(): Promise<void>;
}

class OpenLocalPdf implements LocalPdfSource {
  private closed = false;
  private readonly links = new Map<number, Promise<PageLink[]>>();
  constructor(
    readonly manifest: DocumentManifest,
    private readonly pdf: PDFDocumentProxy,
    private readonly task: PDFDocumentLoadingTask,
  ) {}
  getPage(pageNumber: number): Promise<PDFPageProxy> {
    if (this.closed || !Number.isSafeInteger(pageNumber) || pageNumber < 1 || pageNumber > this.pdf.numPages) {
      return Promise.reject(new Error('This PDF page is unavailable.'));
    }
    return this.pdf.getPage(pageNumber);
  }
  getPageLinks(pageNumber: number): Promise<PageLink[]> {
    if (!this.links.has(pageNumber)) this.links.set(pageNumber, this.readPageLinks(pageNumber));
    return this.links.get(pageNumber)!;
  }
  private async readPageLinks(pageNumber: number): Promise<PageLink[]> {
    const page = await this.getPage(pageNumber);
    const viewport = page.getViewport({ scale: 1 });
    const annotations = await page.getAnnotations({ intent: 'display' });
    const links: PageLink[] = [];
    for (const annotation of annotations) {
      if (annotation.subtype !== 'Link' || !Array.isArray(annotation.rect) || annotation.rect.length !== 4) continue;
      const [x1, y1] = viewport.convertToViewportPoint(annotation.rect[0], annotation.rect[1]);
      const [x2, y2] = viewport.convertToViewportPoint(annotation.rect[2], annotation.rect[3]);
      if (![x1, y1, x2, y2].every(finite)) continue;
      const rect: [number, number, number, number] = [
        Math.max(0, Math.min(viewport.width, Math.min(x1, x2))),
        Math.max(0, Math.min(viewport.height, Math.min(y1, y2))),
        Math.max(0, Math.min(viewport.width, Math.max(x1, x2))),
        Math.max(0, Math.min(viewport.height, Math.max(y1, y2))),
      ];
      if (rect[2] <= rect[0] || rect[3] <= rect[1]) continue;
      const destination = await resolveDestination(this.pdf, annotation.dest);
      if (destination) links.push({ rect, destination });
      else if (safeUrl(annotation.url)) links.push({ rect, url: annotation.url });
      if (links.length > MAX_LINKS_PER_PAGE) throw new Error('This PDF has too many links on one page.');
    }
    return links;
  }
  async destroy(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try { await this.task.destroy(); }
    finally { releaseWorker(); }
  }
}

export async function openLocalPdf(
  blob: Blob, id: string, title: string, contentHash: string, cachedManifest?: DocumentManifest,
): Promise<LocalPdfSource> {
  if (blob.size < 5) throw new Error('Choose a valid PDF file.');
  const initial = new Uint8Array(await blob.slice(0, Math.min(RANGE_BYTES, blob.size)).arrayBuffer());
  if (String.fromCharCode(...initial.subarray(0, 5)) !== '%PDF-') throw new Error('Choose a valid PDF file.');
  let task: PDFDocumentLoadingTask | undefined;
  let readError: unknown;
  const range = new BlobRangeTransport(blob, initial, error => {
    readError = error;
    void task?.destroy();
  });
  const worker = acquireWorker();
  try {
    task = getDocument({
      range,
      worker,
      rangeChunkSize: RANGE_BYTES,
      disableAutoFetch: true,
      disableStream: true,
      stopAtErrors: true,
      cMapUrl: '/pdf-assets/cmaps/',
      cMapPacked: true,
      standardFontDataUrl: '/pdf-assets/standard_fonts/',
      wasmUrl: '/pdf-assets/wasm/',
      iccUrl: '/pdf-assets/iccs/',
      useSystemFonts: true,
    });
    const pdf = await task.promise;
    if (pdf.numPages < 1 || pdf.numPages > MAX_PAGES) throw new Error('PDF page count is outside the supported range.');
    let manifest: DocumentManifest;
    if (cachedManifest?.status === 'ready' && cachedManifest.contentHash === contentHash &&
        cachedManifest.pageCount === pdf.numPages && cachedManifest.pages.length === pdf.numPages) {
      manifest = cachedManifest;
    } else {
      const pages: DocumentManifest['pages'] = [];
      // Read page geometry only. No page content or raster canvas is created.
      for (let number = 1; number <= pdf.numPages; number++) {
        const page = await pdf.getPage(number);
        const viewport = page.getViewport({ scale: 1 });
        if (!finite(viewport.width) || !finite(viewport.height) || viewport.width <= 0 || viewport.height <= 0 ||
            viewport.width > 1_000_000 || viewport.height > 1_000_000) throw new Error('This PDF has invalid page dimensions.');
        pages.push({ number, width: viewport.width, height: viewport.height });
        page.cleanup();
      }
      manifest = {
        schemaVersion: 1, id, version: contentHash, title, status: 'ready',
        pageCount: pdf.numPages, pages, outline: await readOutline(pdf), contentHash,
      };
    }
    return new OpenLocalPdf(manifest, pdf, task);
  } catch (error) {
    try { await task?.destroy(); } finally { releaseWorker(); }
    throw readError ?? error;
  }
}
