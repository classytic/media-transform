/**
 * The browser I/O seam. `compressImage()` orchestrates the pure core against
 * this small interface; the real browser adapter implements it with
 * `createImageBitmap` + `OffscreenCanvas`, and tests inject a fake so the
 * orchestration logic is verified in Node without a headless browser. A React
 * Native adapter would implement the equivalent seam over native modules.
 */
import type { Dimensions, ImageFormat } from '../types.js';

/** A decoded image plus its intrinsic dimensions (EXIF orientation already applied). */
export interface DecodedImage extends Dimensions {
  /** Opaque handle the adapter understands (an `ImageBitmap`, canvas, etc.). */
  readonly handle: unknown;
  /** Release any GPU/native resources. */
  close(): void;
}

export interface ImageIOAdapter {
  /** Formats this runtime can ENCODE (feature-detected once, at construction). */
  readonly encodable: ReadonlySet<ImageFormat>;

  /**
   * Decode source bytes, auto-applying EXIF orientation so downstream sizing
   * works on display dimensions (a portrait phone photo reports portrait).
   */
  decode(source: Blob): Promise<DecodedImage>;

  /**
   * Draw `image` resampled to `target` and encode it. `steps` is the pure
   * core's stepped-downscale plan (may be empty for a straight re-encode); the
   * adapter resamples through each step to keep the result sharp.
   */
  resizeAndEncode(
    image: DecodedImage,
    target: Dimensions,
    steps: readonly Dimensions[],
    format: ImageFormat,
    quality: number,
  ): Promise<Blob>;

  /** Extract RGBA at a small size for ThumbHash. `null` if unavailable. */
  extractRgba(image: DecodedImage, max: number): Promise<{ data: Uint8Array; width: number; height: number } | null>;
}
