'use client';

/**
 * `useImageUpload` — the WhatsApp "upload-on-pick" flow as one hook: the
 * moment the user picks a file it is compressed (optional) and the upload
 * STARTS, before they ever hit send. By send time the media is usually
 * already `ready` and "sending" is just committing a reference — that, plus
 * rendering `result.thumbhash` immediately, is most of the perceived speed
 * of chat apps.
 *
 * Transport-agnostic: you supply `upload` (media-kit presigned PUT+confirm,
 * react-media's uploader, a bare fetch — anything). The hook owns the
 * lifecycle: processing → uploading → ready, supersession, cancellation.
 *
 * Both upload modes are first-class:
 * - WITH processing (default when a `transform` is given) — the photo path.
 * - WITHOUT (`pick(file, { process: false })`, or no `transform`) — the
 *   "send as document/original" path.
 *
 * ```tsx
 * const { pick, status, result, uploaded } = useImageUpload({
 *   transform,
 *   upload: async ({ blob }, { signal }) => {
 *     const { uploadUrl, key } = await api.presign(blob.type, { signal });
 *     await fetch(uploadUrl, { method: 'PUT', body: blob, signal });
 *     return key; // your reference — confirmed server-side at send time
 *   },
 * });
 * // onPick: void pick(file, { maxEdge: 1600, thumbhash: true });
 * // render result?.thumbhash immediately; onSend: use `uploaded` (await pick's promise if still in flight)
 * ```
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { sha256Hex } from '../algorithms/hash.js';
import type { CompressImageOptions, CompressImageResult, MediaTransform } from '../types.js';

export type ImageUploadStatus = 'idle' | 'processing' | 'uploading' | 'ready' | 'error';

/** What your `upload` function receives. */
export interface ImageUploadPayload {
  /** The bytes to upload — compressed output, or the original when unprocessed. */
  blob: Blob;
  /** Compression result (dimensions, thumbhash, savings) — `null` when unprocessed. */
  result: CompressImageResult | null;
  /** The original picked file, always available (e.g. for filename/type). */
  source: Blob;
  /**
   * SHA-256 hex of `blob`, present when `dedupe` is configured. Matches what
   * media-kit stores for `hashStrategy: 'sha256'` — forward it on confirm so
   * the server record carries the real content hash.
   */
  hash?: string | undefined;
}

/**
 * The pre-upload dedup handshake (WhatsApp "forward is instant"): hash the
 * outgoing bytes, ask the server, and on a hit skip the upload AND the
 * server's processing entirely — the cheapest request is the one never made.
 */
export interface DedupeConfig<TRef> {
  /**
   * Ask the server (e.g. an authenticated endpoint over media-kit's
   * `existsByHash`). Return the existing reference to SKIP the upload, or
   * `null` to proceed normally. Errors here fail open (upload proceeds).
   */
  check: (hash: string, payload: ImageUploadPayload) => Promise<TRef | null>;
  /** Override the hasher (default: SHA-256 via WebCrypto). */
  hash?: ((blob: Blob) => Promise<string>) | undefined;
}

export interface PickOptions extends CompressImageOptions {
  /** `false` = upload the original untouched (the "send as document" path). */
  process?: boolean | undefined;
}

export interface UseImageUploadConfig<TRef> {
  /** Client-side processor. Omit to always upload originals. */
  transform?: MediaTransform | undefined;
  /** Your transport. Runs immediately after processing; honor the signal. */
  upload: (payload: ImageUploadPayload, ctx: { signal: AbortSignal }) => Promise<TRef>;
  /** Optional pre-upload dedup handshake — see {@link DedupeConfig}. */
  dedupe?: DedupeConfig<TRef> | undefined;
}

export interface UseImageUpload<TRef> {
  /**
   * Process (optional) + upload a picked file immediately. Resolves to the
   * upload reference, or `null` if superseded/cancelled/failed (state carries
   * the error). Calling again supersedes the previous pick.
   */
  pick: (source: Blob, options?: PickOptions) => Promise<TRef | null>;
  status: ImageUploadStatus;
  /** Compression result of the CURRENT pick (thumbhash for instant preview). */
  result: CompressImageResult | null;
  /** The upload reference once `ready`. */
  uploaded: TRef | null;
  error: Error | null;
  /** Abort the in-flight pick (processing or uploading). */
  cancel: () => void;
  /** Abort and clear back to idle. */
  reset: () => void;
}

function isAbort(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

export function useImageUpload<TRef>(config: UseImageUploadConfig<TRef>): UseImageUpload<TRef> {
  const { transform, upload, dedupe } = config;
  const [status, setStatus] = useState<ImageUploadStatus>('idle');
  const [result, setResult] = useState<CompressImageResult | null>(null);
  const [uploaded, setUploaded] = useState<TRef | null>(null);
  const [error, setError] = useState<Error | null>(null);

  // Transient in-flight controller — a ref so supersession doesn't re-render.
  const abortRef = useRef<AbortController | null>(null);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  const reset = useCallback(() => {
    cancel();
    setStatus('idle');
    setResult(null);
    setUploaded(null);
    setError(null);
  }, [cancel]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const pick = useCallback(
    async (source: Blob, options?: PickOptions): Promise<TRef | null> => {
      abortRef.current?.abort(); // supersede
      const controller = new AbortController();
      abortRef.current = controller;
      const { process = true, ...compressOptions } = options ?? {};
      setError(null);
      setUploaded(null);

      try {
        // 1. Process (the photo path) or skip (the document path).
        let payload: ImageUploadPayload;
        if (transform && process) {
          setStatus('processing');
          setResult(null);
          const out = await transform.compressImage(source, { ...compressOptions, signal: controller.signal });
          if (controller.signal.aborted) return null;
          setResult(out); // thumbhash/dimensions available NOW — render the preview
          payload = { blob: out.blob, result: out, source };
        } else {
          setResult(null);
          payload = { blob: source, result: null, source };
        }

        // 2. Dedup handshake — on a hit the upload (and the server's whole
        // processing pipeline) is skipped. Fails OPEN: a broken dedup
        // endpoint must never block a send.
        if (dedupe) {
          try {
            const hash = await (dedupe.hash ?? sha256Hex)(payload.blob);
            if (controller.signal.aborted) return null;
            payload = { ...payload, hash };
            const existing = await dedupe.check(hash, payload);
            if (controller.signal.aborted) return null;
            if (existing !== null) {
              setUploaded(existing);
              setStatus('ready');
              return existing;
            }
          } catch {
            // fail open — proceed to a normal upload
          }
        }

        // 3. Upload immediately — before the user hits send.
        setStatus('uploading');
        const ref = await upload(payload, { signal: controller.signal });
        if (controller.signal.aborted) return null;
        setUploaded(ref);
        setStatus('ready');
        return ref;
      } catch (err) {
        if (controller.signal.aborted || isAbort(err)) return null;
        setError(err as Error);
        setStatus('error');
        return null;
      } finally {
        if (abortRef.current === controller) abortRef.current = null;
      }
    },
    [transform, upload, dedupe],
  );

  return { pick, status, result, uploaded, error, cancel, reset };
}
