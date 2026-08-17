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
    try {
      /**
       * Adapter creation is INSIDE the try, and that is the whole point.
       *
       * `handleCompressRequest` serialises its own failures into a response, but
       * building the adapter happened before it — so a runtime that cannot
       * provide `OffscreenCanvas`/`createImageBitmap` rejected here, posted
       * NOTHING, and the caller's promise stayed pending forever. Not an error,
       * not a timeout: the one outcome indistinguishable from "still working".
       */
      adapterPromise ??= createBrowserImageAdapter();
      const adapter = await adapterPromise;
      scope.postMessage(await handleCompressRequest(adapter, request));
    } catch (err) {
      /**
       * Do not cache a REJECTED adapter promise. `??=` would keep handing the
       * same rejection to every later request, so one transient failure
       * disabled the worker for the page's lifetime while each request still
       * looked individually reasonable.
       */
      adapterPromise = null;
      const e = err instanceof Error ? err : new Error(String(err));
      // Correlated by id, so the caller rejects THIS request rather than
      // waiting on a worker that will never answer it.
      scope.postMessage({
        __mt: 'compress:result',
        id: request.id,
        ok: false,
        error: { name: e.name, message: e.message },
      });
    }
  })();
});
