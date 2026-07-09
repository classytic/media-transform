import { describe, expect, it, vi } from 'vitest';
import type { DecodedImage, ImageIOAdapter } from '../../src/image/ImageIOAdapter';
import {
  createWorkerMediaTransform,
  handleCompressRequest,
  isCompressWorkerRequest,
  isCompressWorkerResponse,
  type CompressWorkerRequest,
  type WorkerLike,
} from '../../src/image/workerProtocol';

/** Fake adapter — same shape the compressImage tests use. */
function makeFakeAdapter(opts: { width: number; height: number; fail?: boolean }): ImageIOAdapter {
  const decoded: DecodedImage = { handle: {}, width: opts.width, height: opts.height, close: vi.fn() };
  return {
    encodable: new Set(['jpeg', 'webp']),
    decode: async () => decoded,
    resizeAndEncode: async (_i, _t, _s, format) => {
      if (opts.fail) throw new Error('encode boom');
      return new Blob([new Uint8Array(100)], { type: `image/${format}` });
    },
    extractRgba: async () => null,
  };
}

/**
 * A loopback fake Worker: `postMessage` runs `handleCompressRequest` against
 * the fake adapter and dispatches the response to registered listeners —
 * i.e. the REAL worker entry's behavior, minus the thread.
 */
function makeLoopbackWorker(adapter: ImageIOAdapter): WorkerLike {
  const listeners = new Set<(e: { data: unknown }) => void>();
  return {
    postMessage(message: unknown) {
      if (!isCompressWorkerRequest(message)) return;
      void handleCompressRequest(adapter, message).then((response) => {
        for (const l of listeners) l({ data: response });
      });
    },
    addEventListener: (_t, l) => listeners.add(l),
    removeEventListener: (_t, l) => listeners.delete(l),
  };
}

const file = () => new Blob([new Uint8Array(10_000)], { type: 'image/jpeg' });

describe('message guards', () => {
  it('identify requests/responses and reject noise', () => {
    expect(isCompressWorkerRequest({ __mt: 'compress', id: 1, source: file() })).toBe(true);
    expect(isCompressWorkerRequest({ id: 1 })).toBe(false);
    expect(isCompressWorkerRequest(null)).toBe(false);
    expect(isCompressWorkerResponse({ __mt: 'compress:result', id: 1, ok: true })).toBe(true);
    expect(isCompressWorkerResponse('nope')).toBe(false);
  });
});

describe('handleCompressRequest', () => {
  it('returns an ok response with the compress result', async () => {
    const req: CompressWorkerRequest = { __mt: 'compress', id: 7, source: file(), options: { maxEdge: 1000 } };
    const res = await handleCompressRequest(makeFakeAdapter({ width: 4000, height: 3000 }), req);
    expect(res.id).toBe(7);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.result.width).toBe(1000);
  });

  it('serializes errors instead of throwing', async () => {
    const req: CompressWorkerRequest = { __mt: 'compress', id: 8, source: file(), options: { maxEdge: 10 } };
    const res = await handleCompressRequest(makeFakeAdapter({ width: 4000, height: 3000, fail: true }), req);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.message).toBe('encode boom');
  });
});

describe('createWorkerMediaTransform', () => {
  it('round-trips a compression through the worker', async () => {
    const mt = createWorkerMediaTransform(makeLoopbackWorker(makeFakeAdapter({ width: 4000, height: 3000 })));
    const out = await mt.compressImage(file(), { maxEdge: 1600 });
    expect(out.width).toBe(1600);
    expect(out.height).toBe(1200);
  });

  it('correlates concurrent requests by id', async () => {
    const mt = createWorkerMediaTransform(makeLoopbackWorker(makeFakeAdapter({ width: 2000, height: 1000 })));
    const [a, b] = await Promise.all([
      mt.compressImage(file(), { maxEdge: 500 }),
      mt.compressImage(file(), { maxEdge: 1000 }),
    ]);
    expect(a.width).toBe(500);
    expect(b.width).toBe(1000);
  });

  it('propagates worker-side errors as rejections', async () => {
    const mt = createWorkerMediaTransform(makeLoopbackWorker(makeFakeAdapter({ width: 100, height: 100, fail: true })));
    await expect(mt.compressImage(file(), { maxEdge: 10 })).rejects.toThrow('encode boom');
  });

  it('abort rejects locally and drops the eventual worker result', async () => {
    const mt = createWorkerMediaTransform(makeLoopbackWorker(makeFakeAdapter({ width: 4000, height: 3000 })));
    const controller = new AbortController();
    const promise = mt.compressImage(file(), { maxEdge: 1600, signal: controller.signal });
    controller.abort();
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('a pre-aborted signal rejects without posting', async () => {
    const post = vi.fn();
    const worker: WorkerLike = { postMessage: post, addEventListener: vi.fn(), removeEventListener: vi.fn() };
    const mt = createWorkerMediaTransform(worker);
    const controller = new AbortController();
    controller.abort();
    await expect(mt.compressImage(file(), { signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(post).not.toHaveBeenCalled();
  });

  it('dispose() rejects pending requests and detaches the listener', async () => {
    const listeners = new Set<(e: { data: unknown }) => void>();
    const worker: WorkerLike = {
      postMessage: vi.fn(), // never responds
      addEventListener: (_t, l) => listeners.add(l),
      removeEventListener: (_t, l) => listeners.delete(l),
    };
    const mt = createWorkerMediaTransform(worker);
    const pending = mt.compressImage(file());
    mt.dispose();
    await expect(pending).rejects.toThrow('disposed');
    expect(listeners.size).toBe(0);
  });
});
