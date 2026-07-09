'use client';

/**
 * `useImageCompress` — a thin, transport-agnostic React hook over a
 * {@link MediaTransform}. It owns the compress lifecycle (status, result,
 * error), aborts a superseded/unmounted run, and drops stale results — but it
 * does NOT know how you upload. Compose it with any transport (media-kit
 * presigned, react-media's uploader, your own `fetch` PUT):
 *
 * ```tsx
 * const mt = useMemo(() => createBrowserMediaTransform(), []); // a Promise<MediaTransform>, or resolve once
 * const { compress, status, result } = useImageCompress(transform);
 * async function onPick(file: File) {
 *   const out = await compress(file, { maxEdge: 1600, thumbhash: true });
 *   if (out) await uploadBlob(out.blob); // your transport; render out.thumbhash instantly
 * }
 * ```
 *
 * The hook takes a resolved `MediaTransform` so it stays synchronous and
 * testable (inject a fake in tests). Build the transform once outside the hook
 * (`createBrowserMediaTransform()` feature-detects and is reusable).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { CompressImageOptions, CompressImageResult, MediaTransform } from '../types.js';

export type CompressStatus = 'idle' | 'compressing' | 'done' | 'error';

export interface UseImageCompress {
  /** Compress a file. Resolves to the result, or `null` if superseded/cancelled. */
  compress: (source: Blob, options?: CompressImageOptions) => Promise<CompressImageResult | null>;
  /** The most recent successful result. */
  result: CompressImageResult | null;
  status: CompressStatus;
  error: Error | null;
  /** Abort an in-flight compress (result/status unchanged). */
  cancel: () => void;
  /** Abort and clear all state back to idle. */
  reset: () => void;
}

function isAbort(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

export function useImageCompress(transform: MediaTransform): UseImageCompress {
  const [result, setResult] = useState<CompressImageResult | null>(null);
  const [status, setStatus] = useState<CompressStatus>('idle');
  const [error, setError] = useState<Error | null>(null);

  // Transient — the in-flight controller. A ref (not state) so superseding a
  // run doesn't itself trigger a render (skill 5.15: useRef for transient values).
  const abortRef = useRef<AbortController | null>(null);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  const reset = useCallback(() => {
    cancel();
    setResult(null);
    setStatus('idle');
    setError(null);
  }, [cancel]);

  // Abort on unmount so a resolving compress can't setState on a dead component.
  useEffect(() => () => abortRef.current?.abort(), []);

  const compress = useCallback(
    async (source: Blob, options?: CompressImageOptions): Promise<CompressImageResult | null> => {
      abortRef.current?.abort(); // supersede any in-flight run
      const controller = new AbortController();
      abortRef.current = controller;
      setStatus('compressing');
      setError(null);

      try {
        const out = await transform.compressImage(source, { ...options, signal: controller.signal });
        if (controller.signal.aborted) return null; // superseded/cancelled — drop the stale result
        setResult(out);
        setStatus('done');
        return out;
      } catch (err) {
        if (controller.signal.aborted || isAbort(err)) return null;
        setError(err as Error);
        setStatus('error');
        return null;
      } finally {
        if (abortRef.current === controller) abortRef.current = null;
      }
    },
    [transform],
  );

  return { compress, result, status, error, cancel, reset };
}
