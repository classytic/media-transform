/**
 * `@classytic/media-transform` — client-side media processing.
 *
 * Compress/resize/re-encode media in the browser BEFORE upload (WhatsApp/FB
 * style), so a Node backend can skip `sharp` on the hot path.
 *
 * This root is a small, CURATED entry — the primary factory, capability gates,
 * and the public types — NOT an aggregating barrel. Import the granular pieces
 * directly from their subpaths so a bundler loads only what you use (per
 * Vercel's "avoid barrel imports" guidance):
 *
 * ```ts
 * import { computeTargetSize } from '@classytic/media-transform/algorithms/sizing';
 * import { compressImage } from '@classytic/media-transform/image/compressImage';
 * import { createBrowserImageAdapter } from '@classytic/media-transform/image/BrowserImageAdapter';
 * ```
 */
import { createBrowserImageAdapter } from './image/BrowserImageAdapter.js';
import { compressImage } from './image/compressImage.js';
import type { CompressImageOptions, CompressImageResult, MediaTransform } from './types.js';
import {
  compressImageSet,
  type CompressImageSetOptions,
  type CompressImageSetResult,
} from './image/compressImageSet.js';

export type {
  MediaTransform,
  ImageSource,
  ImageFormat,
  SizeConstraints,
  Dimensions,
  CompressImageOptions,
  CompressImageResult,
} from './types.js';
export { isBrowserImageSupported, isWebCodecsVideoSupported } from './capabilities.js';

/**
 * Create a browser-backed {@link MediaTransform}. The adapter (with its
 * feature-detected encodable formats) is built once and reused across calls.
 *
 * ```ts
 * const mt = await createBrowserMediaTransform();
 * const { blob, thumbhash } = await mt.compressImage(file, { maxEdge: 1600, format: ['avif','webp','jpeg'] });
 * // upload `blob` via media-kit's presigned flow; render `thumbhash` instantly
 * ```
 */
export async function createBrowserMediaTransform(): Promise<MediaTransform> {
  const adapter = await createBrowserImageAdapter();
  return {
    compressImage(source: Blob, options?: CompressImageOptions): Promise<CompressImageResult> {
      return compressImage(adapter, source, options);
    },
    compressImageSet(source: Blob, options?: CompressImageSetOptions): Promise<CompressImageSetResult> {
      return compressImageSet(adapter, source, options);
    },
  };
}
