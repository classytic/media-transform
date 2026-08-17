/**
 * The image-compression orchestrator — pure control flow over an
 * {@link ImageIOAdapter}. All the runtime-specific work (decode, resample,
 * encode, RGBA extraction) lives behind the adapter, so this function is
 * exercised in Node with a fake adapter and reused unchanged by the browser
 * adapter. The heavy ThumbHash peer is `await import()`-ed only when asked.
 */
import { averageColorHex } from '../algorithms/color.js';
import { resolveFormat } from '../algorithms/format.js';
import { canStripImageMetadata, stripImageMetadata } from '../algorithms/sanitize.js';
import { computeTargetSize, planDownscaleSteps } from '../algorithms/sizing.js';
import type { CompressImageOptions, CompressImageResult, ImageFormat } from '../types.js';
import type { DecodedImage, ImageIOAdapter } from './ImageIOAdapter.js';

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new DOMException('Image compression aborted', 'AbortError');
}

/**
 * Compress/resize a single image through the given adapter.
 *
 * Flow: decode (EXIF-oriented) → decide whether to pass through untouched →
 * compute target size (never enlarging) → plan a stepped downscale → resolve
 * an encodable format → resize + encode. Optionally emits a ThumbHash.
 */
export async function compressImage(
  adapter: ImageIOAdapter,
  source: Blob,
  options: CompressImageOptions = {},
): Promise<CompressImageResult> {
  throwIfAborted(options.signal);
  const image = await adapter.decode(source);
  try {
    return await compressDecoded(adapter, image, source, options);
  } finally {
    image.close();
  }
}

/**
 * The compression core, over an ALREADY-DECODED image.
 *
 * Split out of {@link compressImage} so a caller that needs several outputs
 * from one source decodes exactly once — see `compressImageSet`. Decoding is
 * the expensive step (a 12MP JPEG is ~48MB of RGBA); re-decoding per output
 * is what makes a naive "call compressImage three times" three times the work
 * and three times the peak memory.
 *
 * Does NOT close `image` — ownership stays with the caller, which is what lets
 * the set orchestrator reuse it across derivatives.
 */
export async function compressDecoded(
  adapter: ImageIOAdapter,
  image: DecodedImage,
  source: Blob,
  options: CompressImageOptions = {},
): Promise<CompressImageResult> {
  const { quality = 0.82, passthroughUnder = 0, stripMetadata = true, signal } = options;
  throwIfAborted(signal);
  {
    const sourceDims = { width: image.width, height: image.height };
    const target = computeTargetSize(sourceDims, options);
    const withinSize = target.width === image.width && target.height === image.height;

    // Passthrough: already small enough in BOTH dimensions and bytes → skip
    // the re-encode (no quality loss, no wasted CPU). This is the "don't
    // re-compress the thumbnail" fast path. The bytes are still losslessly
    // metadata-stripped by default: a re-encode drops EXIF/GPS implicitly, so
    // the fast path must not become the one that leaks the user's location.
    /**
     * Passthrough is only offered for formats this build can BOTH label and
     * sanitize — in practice JPEG/PNG/WebP.
     *
     * Two silent defects lived here. `mimeToFormat` fell back to `'jpeg'` for
     * anything unmapped, so a passed-through HEIC reported `format: 'jpeg'` and
     * a caller naming the stored file from that format wrote HEIC bytes to
     * `.jpg`. And the sanitizer returns HEIC/TIFF/BMP UNCHANGED, so
     * `stripMetadata: true` was accepted and did nothing — the fast path became
     * the one that leaks the user's location, which is precisely what its own
     * comment says it must never be.
     *
     * Anything else falls through to the normal re-encode, which produces a
     * truthful format and drops metadata implicitly. Slower for an exotic
     * format, correct for all of them.
     */
    const passthroughEligible =
      MIME_TO_FORMAT[source.type.toLowerCase().split(';')[0]?.trim() ?? ''] !== undefined &&
      (!stripMetadata || canStripImageMetadata(source.type));

    if (passthroughEligible && withinSize && passthroughUnder > 0 && source.size <= passthroughUnder) {
      let blob = source;
      if (stripMetadata) {
        const bytes = new Uint8Array(await source.arrayBuffer());
        throwIfAborted(signal);
        const cleaned = stripImageMetadata(bytes, source.type);
        if (cleaned !== bytes) blob = new Blob([cleaned as BlobPart], { type: source.type });
      }
      const extras = await computeExtras(adapter, image, options, signal);
      return {
        blob,
        format: mimeToFormat(source.type),
        width: image.width,
        height: image.height,
        bytes: blob.size,
        sourceBytes: source.size,
        passedThrough: true,
        ...extras,
      };
    }

    const format = resolveFormat(options.format, adapter.encodable);
    const steps = planDownscaleSteps(sourceDims, target);
    throwIfAborted(signal);

    const blob = await adapter.resizeAndEncode(image, target, steps, format, clampQuality(quality));
    throwIfAborted(signal);

    const extras = await computeExtras(adapter, image, options, signal);
    return {
      blob,
      format,
      width: target.width,
      height: target.height,
      bytes: blob.size,
      sourceBytes: source.size,
      passedThrough: false,
      ...extras,
    };
  }
}

export function clampQuality(q: number): number {
  if (Number.isNaN(q)) return 0.82;
  return Math.min(1, Math.max(0, q));
}

/**
 * ThumbHash (best-effort — optional peer) + dominantColor, computed from ONE
 * small RGBA extraction shared by both. Silently absent when unavailable.
 */
export async function computeExtras(
  adapter: ImageIOAdapter,
  image: Parameters<ImageIOAdapter['extractRgba']>[0],
  options: CompressImageOptions,
  signal: AbortSignal | undefined,
): Promise<{ thumbhash?: Uint8Array; dominantColor?: string }> {
  if (!options.thumbhash && !options.dominantColor) return {};
  const rgba = await adapter.extractRgba(image, 100);
  if (!rgba) return {};
  throwIfAborted(signal);

  const extras: { thumbhash?: Uint8Array; dominantColor?: string } = {};
  if (options.dominantColor) extras.dominantColor = averageColorHex(rgba.data);
  if (options.thumbhash) {
    try {
      const mod = (await import('thumbhash')) as {
        rgbaToThumbHash(w: number, h: number, rgba: Uint8Array): Uint8Array;
      };
      extras.thumbhash = mod.rgbaToThumbHash(rgba.width, rgba.height, rgba.data);
    } catch {
      // Peer not installed — ThumbHash is opt-in and best-effort.
    }
  }
  return extras;
}

const MIME_TO_FORMAT: Record<string, ImageFormat> = {
  'image/jpeg': 'jpeg',
  'image/jpg': 'jpeg',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/png': 'png',
};

function mimeToFormat(mime: string): ImageFormat {
  return MIME_TO_FORMAT[mime.toLowerCase()] ?? 'jpeg';
}
