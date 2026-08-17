/**
 * Construct the compression Worker — from INSIDE the package, so the URL is
 * relative and a bundler can actually see it.
 *
 * ## Why a consumer must not build this URL itself
 *
 * The documented, bundler-analyzable form is `new URL('./worker.js',
 * import.meta.url)` — a RELATIVE specifier. A consumer writing
 * `new URL('@classytic/media-transform/image/worker', import.meta.url)` is
 * using a BARE package specifier, which Node's resolver handles but webpack and
 * Turbopack are not documented to. When the bundler cannot resolve it the
 * Worker constructor throws at runtime, the caller falls back to the main
 * thread, and everything keeps working — just on the UI thread, janking every
 * 12MP photo, with no error anywhere to say the off-thread path was lost.
 *
 * That is the failure mode worth designing out: not a crash, a silent
 * downgrade. Here the specifier is relative to THIS module, which is the form
 * every bundler documents, and the path stops being the consumer's problem.
 *
 * ```ts
 * import { createImageWorker } from '@classytic/media-transform/image/createWorker';
 * import { createWorkerMediaTransform } from '@classytic/media-transform/image/workerProtocol';
 *
 * const worker = createImageWorker();
 * const mt = createWorkerMediaTransform(worker);
 * ```
 *
 * THROWS when the environment has no `Worker` or the bundler could not emit the
 * chunk. Callers should catch and fall back to `createBrowserMediaTransform()`
 * — the same degradation ladder, but now entered deliberately.
 */
export function createImageWorker(): Worker {
  return new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
}

/**
 * `true` when this runtime can construct a module Worker at all.
 *
 * Cheap pre-check so a caller can choose the main-thread adapter without
 * catching a throw. It does NOT promise the bundler emitted the chunk — only
 * actually constructing one proves that, which is why `createImageWorker`
 * still throws rather than returning null.
 */
export function isWorkerSupported(): boolean {
  return typeof Worker !== 'undefined';
}
