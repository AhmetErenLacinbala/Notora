import { describe, expect, it } from 'vitest';
import { PAGE_GAP, pageLayout } from '../../../../packages/shared/src/index';
import type { Camera } from '../../../../packages/shared/src/index';
import { buildShareUrl, buildViewUrl, cameraForSharedView, parseSharedView, sharedViewFromCamera } from './shareLink';

const pages = pageLayout([
  { number: 1, width: 600, height: 800 },
  { number: 2, width: 400, height: 900 },
]);

function centeredCamera(x: number, y: number, zoom: number, viewport: { width: number; height: number }): Camera {
  return { scrollLeft: x * zoom - viewport.width / 2, scrollTop: y * zoom - viewport.height / 2, zoom };
}

function cameraCenter(camera: Camera, viewport: { width: number; height: number }): { x: number; y: number } {
  return {
    x: (camera.scrollLeft + viewport.width / 2) / camera.zoom,
    y: (camera.scrollTop + viewport.height / 2) / camera.zoom,
  };
}

describe('share location links', () => {
  it('round-trips page-relative location while keeping access capability out of requests', () => {
    const url = new URL(buildShareUrl('https://notora.example', 'abc', 'private-capability', { page: 37, x: -81.123456, y: 840, zoom: 1.25 }));
    expect(url.pathname).toBe('/r/abc');
    expect(url.hash).toBe('#private-capability');
    expect(url.search).not.toContain('private');
    expect(parseSharedView(url.search)).toEqual({ page: 37, x: -81.123, y: 840, zoom: 1.25 });
  });

  it('restores the same document point on a different viewport at several zoom levels', () => {
    const sender = { width: 1040, height: 720 };
    const recipient = { width: 620, height: 980 };
    const world = { x: pages[1].x + 100.1234, y: pages[1].y + 200.5678 };

    for (const zoom of [0.7, 1.75, 3]) {
      const initial = centeredCamera(world.x, world.y, zoom, sender);
      const view = sharedViewFromCamera(pages, initial, sender);
      expect(view.page).toBe(2);
      expect(view.x).toBeCloseTo(100.1234, 5);
      expect(view.y).toBeCloseTo(200.5678, 5);
      expect(view.zoom).toBe(zoom);

      const url = new URL(buildShareUrl('https://notora.example', 'abc', 'capability', view));
      const parsed = parseSharedView(url.search);
      expect(parsed).toEqual({ page: 2, x: 100.123, y: 200.568, zoom });
      const restored = cameraForSharedView(pages, parsed, recipient, zoom);
      expect(restored).toBeDefined();
      expect(restored?.zoom).toBe(zoom);
      const center = cameraCenter(restored!, recipient);
      expect(center.x).toBeCloseTo(world.x, 2);
      expect(center.y).toBeCloseTo(world.y, 2);
    }
  });

  it('keeps signed coordinates when the center is in the gap or outside a page', () => {
    const viewport = { width: 800, height: 600 };
    const zoom = 2;
    const nearSecond = centeredCamera(pages[1].x - 80, pages[1].y - 6, zoom, viewport);
    expect(sharedViewFromCamera(pages, nearSecond, viewport)).toEqual({ page: 2, x: -80, y: -6, zoom });

    const beyondLast = centeredCamera(pages[1].x + pages[1].width + 40, pages[1].y + pages[1].height + 32, zoom, viewport);
    expect(sharedViewFromCamera(pages, beyondLast, viewport)).toEqual({ page: 2, x: pages[1].width + 40, y: pages[1].height + 32, zoom });
  });

  it('switches the nearest page at the midpoint of the inter-page gap', () => {
    const viewport = { width: 800, height: 600 };
    const boundary = pages[0].y + pages[0].height + PAGE_GAP / 2;
    const x = pages[0].x + pages[0].width / 2;
    const before = sharedViewFromCamera(pages, centeredCamera(x, boundary - 1, 1, viewport), viewport);
    const after = sharedViewFromCamera(pages, centeredCamera(x, boundary + 1, 1, viewport), viewport);
    expect(before).toEqual({ page: 1, x: pages[0].width / 2, y: pages[0].height + PAGE_GAP / 2 - 1, zoom: 1 });
    expect(after).toEqual({ page: 2, x: x - pages[1].x, y: -PAGE_GAP / 2 + 1, zoom: 1 });
  });

  it('uses page-center x and a top-aligned page when a link has no coordinates', () => {
    const viewport = { width: 1000, height: 600 };
    const zoom = 2;
    const camera = cameraForSharedView(pages, { page: 2 }, viewport, zoom);
    expect(camera).toEqual(centeredCamera(pages[1].x + pages[1].width / 2, pages[1].y + viewport.height / (2 * zoom), zoom, viewport));
    expect(cameraForSharedView(pages, undefined, viewport, zoom)).toBeUndefined();
    expect(cameraForSharedView(pages, { page: 0 }, viewport, zoom)).toBeUndefined();
    expect(cameraForSharedView(pages, { page: 99 }, viewport, zoom)).toBeUndefined();
  });

  it('updates the current local URL without changing its route, unrelated query, or fragment', () => {
    const url = new URL(buildViewUrl('http://localhost:3310/local/stable-id?mode=read&page=1&x=1&y=2&zoom=3#local-fragment', {
      page: 2, x: -81.123456, y: 840.0009, zoom: 1.2511,
    }));
    expect(url.pathname).toBe('/local/stable-id');
    expect(url.searchParams.get('mode')).toBe('read');
    expect(url.hash).toBe('#local-fragment');
    expect(parseSharedView(url.search)).toEqual({ page: 2, x: -81.123, y: 840.001, zoom: 1.251 });
    expect(url.searchParams.getAll('page')).toEqual(['2']);

    const pageOnly = new URL(buildViewUrl(url.href, { page: 1 }));
    expect(pageOnly.searchParams.get('mode')).toBe('read');
    expect(pageOnly.searchParams.has('x')).toBe(false);
    expect(pageOnly.searchParams.has('y')).toBe(false);
    expect(pageOnly.searchParams.has('zoom')).toBe(false);
    expect(pageOnly.hash).toBe('#local-fragment');
  });

  it('rejects invalid pages and ignores unsafe coordinates', () => {
    for (const search of ['', '?page=0', '?page=-1', '?page=2.5', '?page=Infinity', '?page=1000001']) expect(parseSharedView(search)).toBeUndefined();
    expect(parseSharedView('?page=3&x=NaN&y=1e99&zoom=-1')).toEqual({ page: 3 });
    expect(parseSharedView('?page=3&x=&y=0&zoom=2')).toEqual({ page: 3, y: 0, zoom: 2 });
  });
});
