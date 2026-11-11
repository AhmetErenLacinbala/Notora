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

export function buildShareUrl(origin: string, id: string, token: string, view: SharedView): string {
  const url = new URL(`/r/${encodeURIComponent(id)}`, origin);
  url.searchParams.set('page', String(Number.isSafeInteger(view.page) && view.page > 0 ? view.page : 1));
  for (const key of ['x', 'y', 'zoom'] as const) {
    const value = view[key];
    if (finiteCoordinate(value) && (key !== 'zoom' || value > 0)) {
      url.searchParams.set(key, String(Math.round(value * 1000) / 1000));
    }
  }
  url.hash = token;
  return url.toString();
}
