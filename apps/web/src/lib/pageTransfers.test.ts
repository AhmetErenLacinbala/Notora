import { afterEach, describe, expect, it, vi } from 'vitest';
import { RequestPool, fetchPageBytes } from './pageTransfers';

describe('page transfer pool', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('fetches four PDF files in parallel and leaves a cancelled fifth off the network', async () => {
    const finish: Array<(response: Response) => void> = [];
    const fetchMock = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) => new Promise<Response>(resolve => {
      finish.push(resolve);
    }));
    vi.stubGlobal('fetch', fetchMock);
    const controllers = Array.from({ length: 5 }, () => new AbortController());
    const requests = controllers.map((controller, index) =>
      fetchPageBytes('doc', 'v1', index + 1, 'access', controller.signal));
    const cancelled = expect(requests[4]).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
    controllers[4].abort();
    await cancelled;
    expect(fetchMock).toHaveBeenCalledTimes(4);
    finish.forEach((resolve, index) => resolve(new Response(new Uint8Array([index + 1]))));
    expect((await Promise.all(requests.slice(0, 4))).map(bytes => bytes[0])).toEqual([1, 2, 3, 4]);
    expect(fetchMock.mock.calls.every(([, init]) => new Headers(init?.headers).get('Authorization') === 'Bearer access')).toBe(true);
  });

  it('starts four independent transfers and never starts an aborted queued page', async () => {
    const pool = new RequestPool(4);
    const controllers = Array.from({ length: 6 }, () => new AbortController());
    const finishes: Array<() => void> = [];
    const started: number[] = [];
    const requests = controllers.map((controller, index) => pool.run(controller.signal, () => {
      started.push(index);
      return new Promise<number>(resolve => { finishes[index] = () => resolve(index); });
    }));
    const cancelled = expect(requests[4]).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(started).toEqual([0, 1, 2, 3]));
    controllers[4].abort();
    await cancelled;
    expect(started).toEqual([0, 1, 2, 3]);
    finishes[0]();
    await vi.waitFor(() => expect(started).toEqual([0, 1, 2, 3, 5]));
    finishes[1](); finishes[2](); finishes[3](); finishes[5]();
    expect(await Promise.all([requests[0], requests[1], requests[2], requests[3], requests[5]])).toEqual([0, 1, 2, 3, 5]);
  });

  it('releases a transfer slot after an active request fails', async () => {
    const pool = new RequestPool(1);
    const active = pool.run(new AbortController().signal, async () => { throw new Error('gateway unavailable'); });
    const next = vi.fn(async () => 'next page');
    const queued = pool.run(new AbortController().signal, next);
    await expect(active).rejects.toThrow('gateway unavailable');
    await expect(queued).resolves.toBe('next page');
    expect(next).toHaveBeenCalledTimes(1);
  });
});
