import { PAGE_GAP, type Camera, type PageLayout } from '../../../../packages/shared/src/index';

export interface SharedView { page: number; x?: number; y?: number; zoom?: number }

const MAX_COORDINATE = 10_000_000;
const finiteCoordinate = (value: number | undefined): value is number =>
  typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= MAX_COORDINATE;

export function parseSharedView(search: string): SharedView | undefined {
  const query = new URLSearchParams(search);
  const rawPage = query.get('page');
  if (!rawPage || !/^[1-9]\d*$/.test(rawPage)) return undefined;
  const page = Number(rawPage);
  if (!Number.isSafeInteger(page) || page > 1_000_000) return undefined;
  const view: SharedView = { page };
  for (const key of ['x', 'y', 'zoom'] as const) {
    const raw = query.get(key);
    if (raw === null || raw.trim() === '') continue;
    const value = Number(raw);
    if (!finiteCoordinate(value) || (key === 'zoom' && value <= 0)) continue;
    view[key] = value;
  }
  return view;
}

/** Keep the same canonical center when a recipient has a different viewport size. */
export function sharedViewFromCamera(
  pages: PageLayout[], camera: Camera, viewport: { width: number; height: number },
): SharedView {
  const centerX = (camera.scrollLeft + viewport.width / 2) / camera.zoom;
  const centerY = (camera.scrollTop + viewport.height / 2) / camera.zoom;
  let low = 0, high = pages.length - 1;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (centerY > pages[mid].y + pages[mid].height + PAGE_GAP / 2) low = mid + 1;
    else high = mid;
  }
  const page = pages[low];
  const bound = (value: number) => Math.min(MAX_COORDINATE, Math.max(-MAX_COORDINATE, value));
  return page ? { page: page.number, x: bound(centerX - page.x), y: bound(centerY - page.y), zoom: camera.zoom }
    : { page: 1, zoom: camera.zoom };
}

export function cameraForSharedView(
  pages: PageLayout[], view: SharedView | undefined, viewport: { width: number; height: number }, zoom: number,
): Camera | undefined {
  const page = view && Number.isSafeInteger(view.page) ? pages[view.page - 1] : undefined;
  if (!page) return undefined;
  const x = finiteCoordinate(view?.x) ? view.x : page.width / 2;
  const y = finiteCoordinate(view?.y) ? view.y : viewport.height / (2 * zoom);
  return {
    scrollLeft: (page.x + x) * zoom - viewport.width / 2,
    scrollTop: (page.y + y) * zoom - viewport.height / 2,
    zoom,
  };
}

export function buildViewUrl(href: string, view: SharedView): string {
  const url = new URL(href);
  url.searchParams.set('page', String(Number.isSafeInteger(view.page) && view.page > 0 && view.page <= 1_000_000 ? view.page : 1));
  for (const key of ['x', 'y', 'zoom'] as const) {
    const value = view[key];
    if (finiteCoordinate(value) && (key !== 'zoom' || value > 0)) {
      url.searchParams.set(key, String(Math.round(value * 1000) / 1000));
    } else {
      url.searchParams.delete(key);
    }
  }
  return url.toString();
}

export function buildShareUrl(origin: string, id: string, token: string, view: SharedView): string {
  const url = new URL(`/r/${encodeURIComponent(id)}`, origin);
  url.hash = token;
  return buildViewUrl(url.toString(), view);
}
