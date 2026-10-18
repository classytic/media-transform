/**
 * Abort errors that work in every runtime this package targets.
 *
 * `DOMException` is a browser/worker/Node global but NOT a React Native one
 * (RN 0.83 keeps it private to its own web-API shims). `new DOMException(...)`
 * there is a `ReferenceError`, and `err instanceof DOMException` inside a
 * `catch` is a `ReferenceError` thrown from the error handler itself: one
 * failed derivative would take down the whole upload instead of being reported
 * in `skipped`.
 *
 * So: build a real `DOMException` when the runtime has one (browser callers
 * keep the exact error they always got), else a plain `Error` named
 * `AbortError`, and recognise an abort by its NAME, which both shapes carry.
 */

/** An `AbortError`: a `DOMException` where the runtime has one, else an `Error` with that name. */
export function createAbortError(message = 'Image compression aborted'): Error {
  if (typeof DOMException === 'function') return new DOMException(message, 'AbortError');
  const err = new Error(message);
  err.name = 'AbortError';
  return err;
}

/** True for any abort error, whichever runtime built it. */
export function isAbortError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { name?: unknown }).name === 'AbortError';
}
