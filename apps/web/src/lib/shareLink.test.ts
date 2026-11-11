import { describe, expect, it } from 'vitest';
import { buildShareUrl, parseSharedView } from './shareLink';

describe('share location links', () => {
  it('round-trips page-relative location while keeping access capability out of requests', () => {
    const url = new URL(buildShareUrl('https://notora.example', 'abc', 'private-capability', { page: 37, x: -81.123456, y: 840, zoom: 1.25 }));
    expect(url.pathname).toBe('/r/abc');
    expect(url.hash).toBe('#private-capability');
    expect(url.search).not.toContain('private');
    expect(parseSharedView(url.search)).toEqual({ page: 37, x: -81.123, y: 840, zoom: 1.25 });
  });
  it('rejects invalid pages and ignores unsafe coordinates', () => {
    for (const search of ['', '?page=0', '?page=-1', '?page=2.5', '?page=Infinity', '?page=1000001']) expect(parseSharedView(search)).toBeUndefined();
    expect(parseSharedView('?page=3&x=NaN&y=1e99&zoom=-1')).toEqual({ page: 3 });
    expect(parseSharedView('?page=3&x=&y=0&zoom=2')).toEqual({ page: 3, y: 0, zoom: 2 });
  });
});
