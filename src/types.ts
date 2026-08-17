/**
 * Public contract for `@classytic/media-transform`.
 *
 * The `MediaTransform` interface is the seam that keeps the capability
 * portable: the browser adapter implements it with Canvas/WebCodecs/WASM, and
 * a React Native adapter implements the SAME interface with native modules.
 * Hosts (and `@classytic/react-media`) target the interface, not an
 * implementation — so the same upload code compiles on web and native.
 */

/** A source of image bytes. `Blob`/`File` in the browser; adapters may widen. */
export type ImageSource = Blob;

/** Output container format for a re-encoded image. */
export type ImageFormat = 'jpeg' | 'webp' | 'avif' | 'png';

/**
 * How to bound the output dimensions. All optional; the most restrictive
 * constraint wins. Never enlarges — a source already within bounds is only
 * re-encoded (or skipped entirely; see {@link CompressImageOptions.skipIfSmaller}).
 */
export interface SizeConstraints {
  /** Longest edge in pixels (the WhatsApp-style knob). */
  maxEdge?: number | undefined;
  /** Hard width cap in pixels. */
  maxWidth?: number | undefined;
  /** Hard height cap in pixels. */
  maxHeight?: number | undefined;
  /** Total pixel-count cap (w*h) — guards pathological aspect ratios. */
  maxPixels?: number | undefined;
}

/** Pixel dimensions. */
export interface Dimensions {
  width: number;
  height: number;
}

export interface CompressImageOptions extends SizeConstraints {
  /**
   * Preferred output format, or an ordered preference list. The first entry
   * the runtime can actually ENCODE wins (feature-detected); falls back to a
   * universally-supported format (JPEG) otherwise. Default: `['webp', 'jpeg']`.
   */
  format?: ImageFormat | ImageFormat[] | undefined;
  /** Encoder quality, 0..1. Default 0.82 (visually lossless-ish, big savings). */
  quality?: number | undefined;
  /**
   * When the source is already within all size constraints AND its byte size
   * is below this threshold, skip the re-encode (no quality loss, no CPU).
   * Default: `0` (always re-encode). Set e.g. `200_000` to pass small images
   * through. Passed-through bytes are still metadata-stripped (see
   * {@link CompressImageOptions.stripMetadata}) — a re-encode drops EXIF/GPS
   * implicitly, so the fast path must not become a location leak.
   */
  passthroughUnder?: number | undefined;
  /**
   * Losslessly strip identifying metadata (EXIF incl. GPS, XMP, IPTC,
   * comments) from PASSED-THROUGH images (JPEG/PNG/WebP byte-level segment
   * removal — pixels untouched, ICC color profiles kept). Re-encoded output
   * never carries source metadata regardless of this flag. Default `true`.
   */
  stripMetadata?: boolean | undefined;
  /**
   * Generate a ThumbHash placeholder (tiny blurred preview) alongside the
   * output. Requires the optional `thumbhash` peer. Default `false`.
   */
  thumbhash?: boolean | undefined;
  /**
   * Compute the alpha-weighted average color (`#rrggbb`) — the same
   * `dominantColor` display hint media-kit's server processing derives.
   * Default `false`.
   */
  dominantColor?: boolean | undefined;
  /** Abort in-flight work. */
  signal?: AbortSignal | undefined;
}

export interface CompressImageResult {
  /** The compressed image bytes. */
  blob: Blob;
  format: ImageFormat;
  width: number;
  height: number;
  /** Output byte size (== `blob.size`, surfaced for convenience). */
  bytes: number;
  /** Source byte size, for reporting the savings ratio. */
  sourceBytes: number;
  /** `true` when the source was passed through untouched (see `passthroughUnder`). */
  passedThrough: boolean;
  /** ThumbHash bytes when `options.thumbhash` was set and the peer is present. */
  thumbhash?: Uint8Array | undefined;
  /** `#rrggbb` average color when `options.dominantColor` was set. */
  dominantColor?: string | undefined;
}

/** The portable capability contract — implemented per runtime. */
export interface MediaTransform {
  compressImage(source: ImageSource, options?: CompressImageOptions): Promise<CompressImageResult>;
  /**
   * Primary + named derivatives from ONE decode.
   *
   * Part of the core contract rather than a worker-only extra: a caller that
   * has a `MediaTransform` must be able to ask for a set regardless of which
   * adapter it got, otherwise "does this runtime support derivatives?" becomes
   * a question with no answer at the type level and a silent no at runtime.
   */
  compressImageSet(
    source: ImageSource,
    options?: import('./image/compressImageSet.js').CompressImageSetOptions,
  ): Promise<import('./image/compressImageSet.js').CompressImageSetResult>;
}
