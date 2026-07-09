/**
 * Worker ENTRY — the module a host points its Worker at:
 *
 * ```ts
 * const worker = new Worker(
 *   new URL('@classytic/media-transform/image/worker', import.meta.url),
 *   { type: 'module' },
 * );
 * const mt = createWorkerMediaTransform(worker);
 * ```
 *
 * Thin by design: all logic lives in `workerProtocol.ts` (tested in Node) and
 * the shared BrowserImageAdapter (OffscreenCanvas works in workers). The
 * adapter is created lazily on the first request so constructing the Worker
 * costs nothing until a compression actually runs.
 */
import { createBrowserImageAdapter } from './BrowserImageAdapter.js';
import type { ImageIOAdapter } from './ImageIOAdapter.js';
import { handleCompressRequest, isCompressWorkerRequest } from './workerProtocol.js';

interface WorkerScope {
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  postMessage(message: unknown): void;
}

const scope = globalThis as unknown as WorkerScope;
let adapterPromise: Promise<ImageIOAdapter> | null = null;

scope.addEventListener('message', (event) => {
  if (!isCompressWorkerRequest(event.data)) return;
  const request = event.data;
  void (async () => {
    adapterPromise ??= createBrowserImageAdapter();
    const response = await handleCompressRequest(await adapterPromise, request);
    scope.postMessage(response);
  })();
});
