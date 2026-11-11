import { memo, useEffect, useRef, useState } from 'react';
import { getDocument, GlobalWorkerOptions, TextLayer } from 'pdfjs-dist';
import type { Destination, PageLayout, PageLink } from '../../../../packages/shared/src/index';
import { fetchPageBytes, fetchPageLinks } from '../lib/pageTransfers';
import type { LocalPdfSource } from '../lib/localPdf';

GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString();

// Each page document owns its PDF.js worker. The queue bounds concurrent workers,
// and the document is destroyed as soon as its canvas and text layer are ready.
const MAX_ACTIVE_PAGES = 2;
const ZOOM_SETTLE_MS = 180;
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
  ownerToken?: string;
  zoom: number;
  active: boolean;
  retain: boolean;
  onReady: (pageNumber: number) => void;
  onDestination: (destination: Destination) => void;
  localPdf?: LocalPdfSource;
}

type PageBytesRequest = { controller: AbortController; promise: Promise<Uint8Array>; failed: boolean };

export const PdfPage = memo(function PdfPage({ page, documentId, version, accessToken, ownerToken, zoom, active, retain, onReady, onDestination, localPdf }: PdfPageProps) {
  const canvasSlotRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const renderedRatio = useRef(0);
  const readyNotified = useRef(false);
  const linksLoaded = useRef(false);
  const linksController = useRef<AbortController | null>(null);
  const pageRequest = useRef<PageBytesRequest | null>(null);
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;
  const [links, setLinks] = useState<PageLink[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [retry, setRetry] = useState(0);
  const [settledZoom, setSettledZoom] = useState(zoom);

  // A changed page identity cannot inherit the previous page's retained DOM.
  useEffect(() => {
    renderedRatio.current = 0;
    readyNotified.current = false;
    linksLoaded.current = false;
    setLinks([]);
    setState('loading');
    canvasSlotRef.current?.replaceChildren();
    textRef.current?.replaceChildren();
    return () => {
      linksController.current?.abort();
      linksController.current = null;
    };
  }, [documentId, version, page.number, page.width, page.height, accessToken, ownerToken, localPdf]);

  // Desktop keeps completed pages mounted. Mobile can clear an inactive page
  // even if its parent has not yet unmounted it.
  useEffect(() => {
    if (active || retain) return;
    linksController.current?.abort();
    linksController.current = null;
    renderedRatio.current = 0;
    readyNotified.current = false;
    linksLoaded.current = false;
    setLinks([]);
    setState('loading');
    canvasSlotRef.current?.replaceChildren();
    textRef.current?.replaceChildren();
  }, [active, retain]);

  // Keep a nearby page's file request across zoom changes. PDF.js receives a
  // copy below because it may transfer its input buffer to a worker.
  useEffect(() => () => {
    pageRequest.current?.controller.abort();
    pageRequest.current = null;
  }, [active, documentId, version, page.number, accessToken, ownerToken, localPdf]);

  const pixelLimit = Math.sqrt(10_000_000 / Math.max(1, page.width * page.height));
  const pixelRatio = Math.max(0.1, Math.min((window.devicePixelRatio || 1) * settledZoom, 2.5, pixelLimit));

  useEffect(() => {
    if (!active || localPdf || renderedRatio.current >= pixelRatio - 0.001) return;
    if (pageRequest.current && !pageRequest.current.failed) return;
    pageRequest.current?.controller.abort();
    const controller = new AbortController();
    const request: PageBytesRequest = { controller, promise: Promise.resolve(new Uint8Array()), failed: false };
    request.promise = fetchPageBytes(documentId, version, page.number, accessToken, controller.signal, ownerToken)
      .catch(error => { request.failed = true; throw error; });
    // The render effect may still be waiting for a render slot when this fails.
    void request.promise.catch(() => undefined);
    pageRequest.current = request;
  }, [active, documentId, version, page.number, accessToken, ownerToken, localPdf, pixelRatio, retry]);

  useEffect(() => {
    // A completed desktop page can finish an already-started link request
    // offscreen; it then needs no new request when the user returns.
    if (!active && (!retain || !renderedRatio.current)) {
      linksController.current?.abort();
      linksController.current = null;
    }
  }, [active, retain]);

  useEffect(() => {
    if (!active || linksLoaded.current || linksController.current) return;
    const controller = new AbortController();
    linksController.current = controller;
    (localPdf ? localPdf.getPageLinks(page.number) : fetchPageLinks(documentId, page.number, accessToken, controller.signal))
      .then(value => {
        if (controller.signal.aborted) return;
        linksLoaded.current = true;
        setLinks(value);
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        linksLoaded.current = true;
        setLinks([]);
      })
      .finally(() => { if (linksController.current === controller) linksController.current = null; });
  }, [active, documentId, version, page.number, accessToken, localPdf]);

  useEffect(() => {
    if (!active || settledZoom === zoom) return;
    const timer = window.setTimeout(() => setSettledZoom(zoom), ZOOM_SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [active, zoom, settledZoom]);

  useEffect(() => {
    if (!active || settledZoom !== zoom) return;
    // A higher-resolution canvas continues to satisfy lower zoom levels.
    if (renderedRatio.current >= pixelRatio - 0.001) return;

    const controller = new AbortController();
    const canvasSlot = canvasSlotRef.current;
    const textContainer = textRef.current;
    if (!canvasSlot || !textContainer) return;
    let release: (() => void) | undefined;
    let loadingTask: ReturnType<typeof getDocument> | undefined;
    let renderTask: ReturnType<Awaited<ReturnType<Awaited<ReturnType<typeof getDocument>['promise']>['getPage']>>['render']> | undefined;
    let textLayer: TextLayer | undefined;
    let cleanupPage: (() => void) | undefined;
    let destroyPromise: Promise<void> | undefined;
    let stagedCanvas: HTMLCanvasElement | undefined;
    let committed = false;
    const destroyDocument = () => {
      if (loadingTask && !destroyPromise) destroyPromise = loadingTask.destroy().catch(() => {});
      return destroyPromise;
    };
    if (!renderedRatio.current) setState('loading');

    const render = async () => {
      try {
        const cachedBytes = localPdf ? undefined : await pageRequest.current?.promise;
        if (controller.signal.aborted) return;
        if (!localPdf && !cachedBytes) throw new Error('Page request was unavailable.');
        release = await acquirePage(controller.signal);
        let pdfPage;
        if (localPdf) {
          pdfPage = await localPdf.getPage(page.number);
        } else {
          // PDF.js transfers the input buffer to its worker; keep the cache copy intact.
          loadingTask = getDocument({
            data: new Uint8Array(cachedBytes!),
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
          pdfPage = await pdf.getPage(1);
        }
        if (controller.signal.aborted) return;
        cleanupPage = () => pdfPage.cleanup();
        const base = pdfPage.getViewport({ scale: 1 });
        const canonicalScale = page.width / base.width;
        const imageViewport = pdfPage.getViewport({ scale: canonicalScale * pixelRatio });
        stagedCanvas = document.createElement('canvas');
        stagedCanvas.width = Math.max(1, Math.ceil(imageViewport.width));
        stagedCanvas.height = Math.max(1, Math.ceil(imageViewport.height));
        stagedCanvas.className = 'pdf-canvas';
        renderTask = pdfPage.render({ canvas: stagedCanvas, viewport: imageViewport });
        await renderTask.promise;
        renderTask = undefined;
        if (controller.signal.aborted) return;

        // Text uses canonical coordinates. An image upgrade must not disturb
        // the visible text DOM or a user's current selection.
        let stagedText: HTMLDivElement | undefined;
        if (!renderedRatio.current) {
          const textViewport = pdfPage.getViewport({ scale: canonicalScale });
          stagedText = document.createElement('div');
          stagedText.className = textContainer.className;
          stagedText.style.setProperty('--total-scale-factor', String(textViewport.scale * textViewport.userUnit));
          textLayer = new TextLayer({ textContentSource: await pdfPage.getTextContent(), container: stagedText, viewport: textViewport });
          await textLayer.render();
          textLayer = undefined;
          if (controller.signal.aborted) return;
        }

        // Swap only after the replacement has rendered successfully. The DOM
        // mutations are synchronous, so there is no paint between them.
        canvasSlot.replaceChildren(stagedCanvas);
        committed = true;
        if (stagedText) {
          textContainer.style.cssText = stagedText.style.cssText;
          const rotation = stagedText.getAttribute('data-main-rotation');
          if (rotation) textContainer.setAttribute('data-main-rotation', rotation);
          else textContainer.removeAttribute('data-main-rotation');
          const textNodes = document.createDocumentFragment();
          while (stagedText.firstChild) textNodes.append(stagedText.firstChild);
          textContainer.replaceChildren(textNodes);
        }
        renderedRatio.current = pixelRatio;
        setState('ready');
        if (!readyNotified.current) {
          readyNotified.current = true;
          onReadyRef.current(page.number);
        }
      } catch {
        // A failed upgrade leaves the last completed page visible.
        if (!controller.signal.aborted && !renderedRatio.current) setState('error');
      } finally {
        try { await destroyDocument(); }
        finally {
          try { cleanupPage?.(); } catch { /* the document may already be destroyed */ }
          if (!committed && stagedCanvas) { stagedCanvas.width = 0; stagedCanvas.height = 0; }
          release?.();
          // The mounted page owns only its finished DOM, not PDF.js objects.
          release = undefined;
          loadingTask = undefined;
          renderTask = undefined;
          textLayer = undefined;
          cleanupPage = undefined;
          destroyPromise = undefined;
          stagedCanvas = undefined;
        }
      }
    };
    void render();
    return () => {
      controller.abort();
      renderTask?.cancel();
      textLayer?.cancel();
      void destroyDocument();
    };
  }, [active, documentId, version, page.number, page.width, page.height, accessToken, ownerToken, zoom, settledZoom, pixelRatio, retry, localPdf]);

  return <div className="pdf-page" data-page={page.number} style={{ left: page.x, top: page.y, width: page.width, height: page.height }}>
    <div ref={canvasSlotRef} style={{ width: '100%', height: '100%' }} aria-hidden="true" />
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
