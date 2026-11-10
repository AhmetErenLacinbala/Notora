import { memo, useEffect, useRef, useState } from 'react';
import { getDocument, GlobalWorkerOptions, TextLayer } from 'pdfjs-dist';
import type { Destination, PageLayout, PageLink } from '../../../../packages/shared/src/index';
import { getPageBytes, getPageLinks } from '../lib/api';

GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString();

// Each page document owns its PDF.js worker. The queue bounds concurrent workers,
// and the document is destroyed as soon as its canvas and text layer are ready.
const MAX_ACTIVE_PAGES = 2;
let activePages = 0;
const waiting: Array<{ signal: AbortSignal; resolve: (release: () => void) => void; reject: (error: Error) => void; onAbort: () => void }> = [];

function abortError() { return new DOMException('Page is no longer visible', 'AbortError'); }

function pumpPages() {
  while (activePages < MAX_ACTIVE_PAGES && waiting.length) {
    const next = waiting.shift()!;
    next.signal.removeEventListener('abort', next.onAbort);
    if (next.signal.aborted) { next.reject(abortError()); continue; }
    activePages++;
    next.resolve(() => { activePages--; pumpPages(); });
  }
}

function acquirePage(signal: AbortSignal): Promise<() => void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(abortError()); return; }
    const onAbort = () => {
      const index = waiting.indexOf(entry);
      if (index !== -1) { waiting.splice(index, 1); reject(abortError()); }
    };
    const entry = { signal, resolve, reject, onAbort };
    waiting.push(entry);
    signal.addEventListener('abort', onAbort, { once: true });
    pumpPages();
  });
}

function validExternalUrl(url: string): boolean {
  try { return ['http:', 'https:', 'mailto:'].includes(new URL(url).protocol); }
  catch { return false; }
}

export interface PdfPageProps {
  page: PageLayout;
  documentId: string;
  version: string;
  accessToken: string;
  zoom: number;
  onDestination: (destination: Destination) => void;
}

export const PdfPage = memo(function PdfPage({ page, documentId, version, accessToken, zoom, onDestination }: PdfPageProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const [links, setLinks] = useState<PageLink[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLinks([]);
    getPageLinks(documentId, page.number, accessToken, controller.signal)
      .then(value => { if (!controller.signal.aborted) setLinks(value); })
      .catch(() => { if (!controller.signal.aborted) setLinks([]); });
    return () => controller.abort();
  }, [documentId, page.number, accessToken]);

  useEffect(() => {
    const controller = new AbortController();
    const canvas = canvasRef.current;
    const textContainer = textRef.current;
    if (!canvas || !textContainer) return;
    let release: (() => void) | undefined;
    let loadingTask: ReturnType<typeof getDocument> | undefined;
    let renderTask: ReturnType<Awaited<ReturnType<Awaited<ReturnType<typeof getDocument>['promise']>['getPage']>>['render']> | undefined;
    let textLayer: TextLayer | undefined;
    let cleanupPage: (() => void) | undefined;
    let destroyPromise: Promise<void> | undefined;
    const destroyDocument = () => {
      if (loadingTask && !destroyPromise) destroyPromise = loadingTask.destroy().catch(() => {});
      return destroyPromise;
    };
    setState('loading');
    textContainer.replaceChildren();

    const render = async () => {
      try {
        release = await acquirePage(controller.signal);
        const cachedBytes = await getPageBytes(documentId, version, page.number, accessToken, controller.signal);
        if (controller.signal.aborted) return;
        // PDF.js transfers the input buffer to its worker; keep the cache copy intact.
        loadingTask = getDocument({
          data: new Uint8Array(cachedBytes),
          disableAutoFetch: true,
          disableStream: true,
          cMapUrl: '/pdf-assets/cmaps/',
          cMapPacked: true,
          standardFontDataUrl: '/pdf-assets/standard_fonts/',
          wasmUrl: '/pdf-assets/wasm/',
          iccUrl: '/pdf-assets/iccs/',
          useSystemFonts: true,
        });
        const pdf = await loadingTask.promise;
        if (controller.signal.aborted) return;
        const pdfPage = await pdf.getPage(1);
        cleanupPage = () => pdfPage.cleanup();
        const base = pdfPage.getViewport({ scale: 1 });
        const canonicalScale = page.width / base.width;
        const textViewport = pdfPage.getViewport({ scale: canonicalScale });
        textContainer.style.setProperty('--total-scale-factor', String(textViewport.scale * textViewport.userUnit));
        const pixelLimit = Math.sqrt(10_000_000 / Math.max(1, page.width * page.height));
        const pixelRatio = Math.max(0.1, Math.min((window.devicePixelRatio || 1) * zoom, 2.5, pixelLimit));
        const imageViewport = pdfPage.getViewport({ scale: canonicalScale * pixelRatio });
        canvas.width = Math.max(1, Math.ceil(imageViewport.width));
        canvas.height = Math.max(1, Math.ceil(imageViewport.height));
        canvas.style.width = `${page.width}px`;
        canvas.style.height = `${page.height}px`;
        renderTask = pdfPage.render({ canvas, viewport: imageViewport });
        await renderTask.promise;
        if (controller.signal.aborted) return;
        textLayer = new TextLayer({ textContentSource: await pdfPage.getTextContent(), container: textContainer, viewport: textViewport });
        await textLayer.render();
        if (!controller.signal.aborted) setState('ready');
      } catch {
        if (!controller.signal.aborted) setState('error');
      } finally {
        try { await destroyDocument(); }
        finally {
          try { cleanupPage?.(); } catch { /* the document may already be destroyed */ }
          release?.();
        }
      }
    };
    void render();
    return () => {
      controller.abort();
      renderTask?.cancel();
      textLayer?.cancel();
      void destroyDocument();
      textContainer.replaceChildren();
      canvas.width = 0;
      canvas.height = 0;
    };
  }, [documentId, version, page.number, page.width, page.height, accessToken, zoom, retry]);

  return <div className="pdf-page" data-page={page.number} style={{ left: page.x, top: page.y, width: page.width, height: page.height }}>
    <canvas className="pdf-canvas" ref={canvasRef} aria-hidden="true" />
    <div className="pdf-text-layer textLayer" ref={textRef} aria-label={`Page ${page.number} text`} />
    <div className="pdf-link-layer" aria-label={`Page ${page.number} links`}>{links.map((link, index) => {
      const [x1, y1, x2, y2] = link.rect;
      const style = { left: x1, top: y1, width: Math.max(0, x2 - x1), height: Math.max(0, y2 - y1) };
      if (link.destination) return <button key={index} className="pdf-link" type="button" style={style} aria-label={`Go to page ${link.destination.page}`} onClick={() => onDestination(link.destination!)} />;
      if (link.url && validExternalUrl(link.url)) return <a key={index} className="pdf-link" style={style} href={link.url} target="_blank" rel="noopener noreferrer" aria-label={`Open link: ${link.url}`} />;
      return null;
    })}</div>
    {state !== 'ready' && <div className="page-fallback" aria-live="polite">{state === 'loading' ? <span className="page-loading-mark" /> : <button type="button" onClick={() => setRetry(value => value + 1)}>Retry page {page.number}</button>}</div>}
  </div>;
});
