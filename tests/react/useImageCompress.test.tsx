import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { CompressImageOptions, CompressImageResult, MediaTransform } from '../../src/types';
import { useImageCompress } from '../../src/react/useImageCompress';

const fakeResult = (bytes: number): CompressImageResult => ({
  blob: new Blob([new Uint8Array(bytes)], { type: 'image/webp' }),
  format: 'webp',
  width: 1600,
  height: 1200,
  bytes,
  sourceBytes: bytes * 10,
  passedThrough: false,
});

/** A fake MediaTransform whose timing/abort we control, so the hook is tested without a canvas. */
function makeTransform(impl?: MediaTransform['compressImage']): MediaTransform {
  return {
    compressImage:
      impl ??
      vi.fn(async (_s: Blob, o?: CompressImageOptions) => {
        if (o?.signal?.aborted) throw new DOMException('aborted', 'AbortError');
        return fakeResult(1000);
      }),
  };
}

const file = () => new Blob([new Uint8Array(10_000)], { type: 'image/jpeg' });

describe('useImageCompress', () => {
  it('starts idle', () => {
    const { result } = renderHook(() => useImageCompress(makeTransform()));
    expect(result.current.status).toBe('idle');
    expect(result.current.result).toBeNull();
    expect(result.current.error).toBeNull();
  });

  it('transitions idle → compressing → done and exposes the result', async () => {
    const { result } = renderHook(() => useImageCompress(makeTransform()));
    let out: CompressImageResult | null = null;
    await act(async () => {
      out = await result.current.compress(file(), { maxEdge: 1600 });
    });
    expect(out).not.toBeNull();
    expect(result.current.status).toBe('done');
    expect(result.current.result?.format).toBe('webp');
  });

  it('threads options + an abort signal through to the transform', async () => {
    const spy = vi.fn(async () => fakeResult(500));
    const { result } = renderHook(() => useImageCompress(makeTransform(spy)));
    await act(async () => {
      await result.current.compress(file(), { maxEdge: 800, format: 'avif' });
    });
    const [, opts] = spy.mock.calls[0]!;
    expect(opts?.maxEdge).toBe(800);
    expect(opts?.format).toBe('avif');
    expect(opts?.signal).toBeInstanceOf(AbortSignal);
  });

  it('surfaces a compression error as status "error"', async () => {
    const boom = vi.fn(async () => {
      throw new Error('decode failed');
    });
    const { result } = renderHook(() => useImageCompress(makeTransform(boom)));
    await act(async () => {
      await result.current.compress(file());
    });
    expect(result.current.status).toBe('error');
    expect(result.current.error?.message).toBe('decode failed');
  });

  it('a superseding compress aborts the first; the stale result is dropped', async () => {
    const seen: AbortSignal[] = [];
    const transform = makeTransform(async (_s, o) => {
      seen.push(o!.signal!);
      // Resolve only after a microtask so the second call can supersede.
      await Promise.resolve();
      if (o?.signal?.aborted) throw new DOMException('aborted', 'AbortError');
      return fakeResult(seen.length);
    });
    const { result } = renderHook(() => useImageCompress(transform));

    await act(async () => {
      const first = result.current.compress(file());
      const second = result.current.compress(file());
      const [a, b] = await Promise.all([first, second]);
      expect(a).toBeNull(); // first was superseded → dropped
      expect(b).not.toBeNull();
    });
    expect(seen[0]?.aborted).toBe(true);
    expect(result.current.status).toBe('done');
  });

  it('cancel() aborts an in-flight run and drops its result', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const transform = makeTransform(async (_s, o) => {
      await gate;
      if (o?.signal?.aborted) throw new DOMException('aborted', 'AbortError');
      return fakeResult(1);
    });
    const { result } = renderHook(() => useImageCompress(transform));

    let pending!: Promise<CompressImageResult | null>;
    act(() => {
      pending = result.current.compress(file());
    });
    act(() => result.current.cancel());
    await act(async () => {
      release();
      expect(await pending).toBeNull();
    });
    expect(result.current.result).toBeNull();
  });

  it('reset() clears state back to idle', async () => {
    const { result } = renderHook(() => useImageCompress(makeTransform()));
    await act(async () => {
      await result.current.compress(file());
    });
    expect(result.current.status).toBe('done');
    act(() => result.current.reset());
    expect(result.current.status).toBe('idle');
    expect(result.current.result).toBeNull();
  });

  it('aborts an in-flight compress on unmount (no post-unmount state write)', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let signalAtResolve: AbortSignal | undefined;
    const transform = makeTransform(async (_s, o) => {
      await gate;
      signalAtResolve = o?.signal;
      throw new DOMException('aborted', 'AbortError');
    });
    const { result, unmount } = renderHook(() => useImageCompress(transform));
    act(() => {
      void result.current.compress(file());
    });
    unmount();
    await act(async () => {
      release();
      await Promise.resolve();
    });
    expect(signalAtResolve?.aborted).toBe(true);
  });
});
