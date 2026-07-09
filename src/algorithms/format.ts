/**
 * Pure output-format selection. Given a preference (single or ordered list)
 * and the set of formats the runtime can actually ENCODE, pick the winner —
 * falling back to a universally-encodable format so a compress call never
 * fails just because the browser can't emit AVIF.
 */
import type { ImageFormat } from '../types.js';

/** MIME type for an image format. */
export const FORMAT_MIME: Record<ImageFormat, string> = {
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  avif: 'image/avif',
  png: 'image/png',
};

/** File extension for an image format (no leading dot). */
export const FORMAT_EXT: Record<ImageFormat, string> = {
  jpeg: 'jpg',
  webp: 'webp',
  avif: 'avif',
  png: 'png',
};

/**
 * JPEG is the universal floor — every canvas/encoder can emit it, so it is the
 * guaranteed fallback when nothing in the preference list is encodable.
 */
export const FALLBACK_FORMAT: ImageFormat = 'jpeg';

const DEFAULT_PREFERENCE: readonly ImageFormat[] = ['webp', 'jpeg'];

/**
 * Resolve the output format.
 *
 * @param preference  A single format, an ordered list, or `undefined` (→ `['webp','jpeg']`).
 * @param encodable   Formats the runtime can encode (feature-detected by the adapter).
 * @returns The first preferred format that is encodable, else the first encodable
 *          format at all, else the JPEG fallback.
 */
export function resolveFormat(
  preference: ImageFormat | readonly ImageFormat[] | undefined,
  encodable: ReadonlySet<ImageFormat>,
): ImageFormat {
  const prefs = preference === undefined ? DEFAULT_PREFERENCE : Array.isArray(preference) ? preference : [preference];

  for (const fmt of prefs) {
    if (encodable.has(fmt)) return fmt;
  }
  // No preferred format is encodable — prefer any encodable one in a sensible
  // order (smaller-first), else the hard JPEG floor.
  for (const fmt of ['avif', 'webp', 'jpeg', 'png'] as const) {
    if (encodable.has(fmt)) return fmt;
  }
  return FALLBACK_FORMAT;
}

/** Whether a format keeps an alpha channel (lossless transparency matters for PNG/WebP/AVIF). */
export function supportsAlpha(format: ImageFormat): boolean {
  return format !== 'jpeg';
}
