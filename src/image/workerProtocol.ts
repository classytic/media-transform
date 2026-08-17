/**
 * Web Worker offload for image compression. Compressing a 12MP photo on the
 * main thread janks the UI right when the user is interacting — the
 * WhatsApp-grade answer is to do it off-thread. `OffscreenCanvas` +
 * `createImageBitmap` work in workers, so the SAME BrowserImageAdapter runs
 * there; this module is only the message plumbing.
 *
 * Split for testability: the protocol (types + `handleCompressRequest` +
 * `createWorkerMediaTransform`) is pure over injected pieces and fully tested
 * in Node with a fake worker; the thin `worker.js` entry (see `./worker.js`)
 * wires it to the real adapter inside an actual Worker.
 *
 * Host usage:
 * ```ts
 * const worker = new Worker(
 *   new URL('@classytic/media-transform/image/worker', import.meta.url),
 *   { type: 'module' },
 * );
 * const mt = createWorkerMediaTransform(worker);
 * const out = await mt.compressImage(file, { maxEdge: 1600 }); // main thread stays free
 * ```
 */
import type { CompressImageOptions, CompressImageResult, MediaTransform } from '../types.js';
import { compressImageSet, type CompressImageSetOptions, type CompressImageSetResult } from './compressImageSet.js';
import type { ImageIOAdapter } from './ImageIOAdapter.js';

/**
 * Options that survive structured clone (AbortSignal cannot cross threads).
 *
 * The SET options, not the single-image ones: the worker always runs
 * `compressImageSet` and returns derivatives (possibly empty), so
 * `compressImage` is the degenerate case of one protocol rather than a second
 * message type. Two message kinds would mean two code paths that can drift, and
 * the worker is where a drift is least visible.
 */
export type WorkerCompressOptions = Omit<CompressImageSetOptions, 'signal'>;

export interface CompressWorkerRequest {
  readonly __mt: 'compress';
  readonly id: number;
  readonly source: Blob;
  readonly options?: WorkerCompressOptions | undefined;
}

export type CompressWorkerResponse =
  | {
      readonly __mt: 'compress:result';
      readonly id: number;
      readonly ok: true;
      readonly result: CompressImageSetResult;
    }
  | {
      readonly __mt: 'compress:result';
      readonly id: number;
      readonly ok: false;
      readonly error: { name: string; message: string };
    };

export function isCompressWorkerRequest(data: unknown): data is CompressWorkerRequest {
  return typeof data === 'object' && data !== null && (data as { __mt?: unknown }).__mt === 'compress';
}

export function isCompressWorkerResponse(data: unknown): data is CompressWorkerResponse {
  return typeof data === 'object' && data !== null && (data as { __mt?: unknown }).__mt === 'compress:result';
}

/**
 * Worker-side: run one request through the adapter, never throw — errors are
 * serialized into the response (a worker exception would otherwise surface as
 * a useless global `error` event).
 */
export async function handleCompressRequest(
  adapter: ImageIOAdapter,
  request: CompressWorkerRequest,
): Promise<CompressWorkerResponse> {
  try {
    const result = await compressImageSet(adapter, request.source, request.options);
    return { __mt: 'compress:result', id: request.id, ok: true, result };
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err));
    return { __mt: 'compress:result', id: request.id, ok: false, error: { name: e.name, message: e.message } };
  }
}

/** The tiny slice of the Worker interface the client wrapper needs (fake-able in tests). */
export interface WorkerLike {
  postMessage(message: unknown): void;
  /**
   * `error` and `messageerror` are part of the contract, not extras.
   *
   * Only `message` was listened for, so a worker that failed to LOAD (a bad
   * bundle URL, a CSP refusal) or a response that failed to deserialise emitted
   * an event nobody heard — and every pending promise stayed pending forever.
   * The upload row just span. No rejection, no timeout, no error: the one
   * outcome with no observable difference from "still working".
   */
  addEventListener(type: 'message' | 'error' | 'messageerror', listener: (event: unknown) => void): void;
  removeEventListener(type: 'message' | 'error' | 'messageerror', listener: (event: unknown) => void): void;
}

interface Pending {
  resolve(result: CompressImageSetResult): void;
  reject(err: Error): void;
}

/**
 * Main-thread side: wrap a Worker running the `./worker.js` entry into a
 * {@link MediaTransform}. Requests are correlated by id, so concurrent
 * compressions over one worker are fine (they queue inside the worker).
 *
 * `signal` is honored LOCALLY: aborting rejects this promise and discards the
 * eventual worker result — the in-flight computation itself is not
 * interrupted (an acceptable cost; compressions are seconds at most).
 * `dispose()` detaches the listener and rejects anything still pending — the
 * caller owns the Worker's lifecycle (`worker.terminate()`).
 */
export function createWorkerMediaTransform(worker: WorkerLike): MediaTransform & { dispose(): void } {
  const pending = new Map<number, Pending>();
  let nextId = 1;

  /**
   * Reject everything in flight. A worker-level failure is not per-request: the
   * worker is gone, so nothing outstanding can ever be answered.
   */
  const failAll = (reason: string): void => {
    for (const [, entry] of pending) entry.reject(new Error(`[media-transform] ${reason}`));
    pending.clear();
  };

  const onError = (event: unknown): void => {
    const detail = (event as { message?: string } | null)?.message;
    failAll(`worker error${detail ? `: ${detail}` : ''}`);
  };
  const onMessageError = (): void => {
    // The worker answered but the payload could not be structured-cloned back.
    failAll('worker sent a message that could not be deserialised');
  };

  const onMessage = (rawEvent: unknown): void => {
    const event = rawEvent as { data: unknown };
    if (!isCompressWorkerResponse(event.data)) return;
    const entry = pending.get(event.data.id);
    if (!entry) return; // aborted locally — drop the stale result
    pending.delete(event.data.id);
    if (event.data.ok) {
      entry.resolve(event.data.result);
    } else {
      const err = new Error(event.data.error.message);
      err.name = event.data.error.name;
      entry.reject(err);
    }
  };
  worker.addEventListener('message', onMessage);
  worker.addEventListener('error', onError);
  worker.addEventListener('messageerror', onMessageError);

  /** One request/response round trip; the caller decides what to keep. */
  const run = (source: Blob, options?: CompressImageSetOptions): Promise<CompressImageSetResult> => {
    const { signal, ...rest } = options ?? {};
    if (signal?.aborted) {
      return Promise.reject(new DOMException('Image compression aborted', 'AbortError'));
    }
    const id = nextId++;
    return new Promise<CompressImageSetResult>((resolve, reject) => {
      const entry: Pending = { resolve, reject };
      pending.set(id, entry);
      signal?.addEventListener(
        'abort',
        () => {
          if (pending.delete(id)) reject(new DOMException('Image compression aborted', 'AbortError'));
        },
        { once: true },
      );
      const request: CompressWorkerRequest = { __mt: 'compress', id, source, options: rest };
      worker.postMessage(request);
    });
  };

  return {
    compressImageSet: run,
    /**
     * The single-output view of the same call. Derivatives are simply not
     * requested, so nothing extra is encoded — this is not a wasteful wrapper.
     */
    async compressImage(source: Blob, options?: CompressImageOptions): Promise<CompressImageResult> {
      return run(source, options as CompressImageSetOptions);
    },
    dispose(): void {
      worker.removeEventListener('message', onMessage);
      worker.removeEventListener('error', onError);
      worker.removeEventListener('messageerror', onMessageError);
      failAll('worker transform disposed');
    },
  };
}
