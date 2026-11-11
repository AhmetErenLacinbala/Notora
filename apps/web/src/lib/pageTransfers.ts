import type { PageLink } from '../../../../packages/shared/src/index';
import { getPageBytes, getPageLinks } from './api';

function aborted(): DOMException {
  return new DOMException('Page is no longer visible', 'AbortError');
}

// Network transfers are independent of the two PDF.js render slots. A queued
// transfer never starts after its page leaves the nearby range.
export class RequestPool {
  private active = 0;
  private waiting: Array<{ signal: AbortSignal; start: () => void; cancel: () => void }> = [];

  constructor(readonly limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Invalid request pool limit.');
  }

  run<T>(signal: AbortSignal, task: () => Promise<T>): Promise<T> {
    if (signal.aborted) return Promise.reject(aborted());
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => {
        const index = this.waiting.indexOf(entry);
        if (index < 0) return;
        this.waiting.splice(index, 1);
        signal.removeEventListener('abort', onAbort);
        reject(aborted());
      };
      const entry = {
        signal,
        start: () => {
          signal.removeEventListener('abort', onAbort);
          this.active++;
          void Promise.resolve().then(task).then(resolve, reject).finally(() => {
            this.active--;
            this.pump();
          });
        },
        cancel: () => {
          signal.removeEventListener('abort', onAbort);
          reject(aborted());
        },
      };
      this.waiting.push(entry);
      signal.addEventListener('abort', onAbort, { once: true });
      this.pump();
    });
  }

  private pump(): void {
    while (this.active < this.limit && this.waiting.length) {
      const next = this.waiting.shift()!;
      if (next.signal.aborted) next.cancel();
      else next.start();
    }
  }
}

const transfers = new RequestPool(4);

export function fetchPageBytes(
  id: string, version: string, page: number, token: string, signal: AbortSignal, ownerToken?: string,
): Promise<Uint8Array> {
  return transfers.run(signal, () => getPageBytes(id, version, page, token, signal, ownerToken));
}

export function fetchPageLinks(id: string, page: number, token: string, signal: AbortSignal): Promise<PageLink[]> {
  return transfers.run(signal, () => getPageLinks(id, page, token, signal));
}
