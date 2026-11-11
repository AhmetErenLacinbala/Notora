import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDB } from 'idb';
import type { Profile } from '../../../../packages/shared/src/index';

vi.mock('idb', () => ({ openDB: vi.fn() }));

const profile: Profile = { id: 'user-1', name: 'Existing reader' };

describe('IndexedDB startup deadlines', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(openDB).mockReset();
    vi.resetModules();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('times out an unresponsive open and reuses its request when it later succeeds', async () => {
    let finishOpen!: (db: { get: () => Promise<Profile> }) => void;
    vi.mocked(openDB).mockReturnValue(new Promise(resolve => { finishOpen = resolve; }) as never);
    const storage = await import('./storage');

    const first = storage.getProfile();
    const rejected = expect(first).rejects.toMatchObject({
      name: 'StorageConnectionError',
      reason: 'timeout',
    });
    await vi.advanceTimersByTimeAsync(10_000);
    await rejected;

    const retry = storage.getProfile();
    expect(openDB).toHaveBeenCalledTimes(1);
    finishOpen({ get: async () => profile });
    await expect(retry).resolves.toEqual(profile);
  });

  it('times out a stalled profile read and allows another read on the same connection', async () => {
    const get = vi.fn()
      .mockImplementationOnce(() => new Promise<Profile>(() => {}))
      .mockResolvedValue(profile);
    vi.mocked(openDB).mockResolvedValue({ get } as never);
    const storage = await import('./storage');

    const first = storage.getProfile();
    const rejected = expect(first).rejects.toMatchObject({
      name: 'StorageConnectionError',
      reason: 'timeout',
    });
    await vi.advanceTimersByTimeAsync(10_000);
    await rejected;

    await expect(storage.getProfile()).resolves.toEqual(profile);
    expect(openDB).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledTimes(2);
  });
});
