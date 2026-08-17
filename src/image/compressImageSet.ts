/**
 * Derivative SETS — one decode, many encodes.
 *
 * This is the posture WhatsApp, Amazon and every serious image pipeline take:
 * the device that already holds the decoded bitmap produces every size the
 * product needs, and the server stores bytes instead of computing them. Calling
 * {@link compressImage} once per size would decode the source once per size —
 * on a 12MP phone photo that is ~48MB of RGBA decoded three times, on the
 * user's phone, for no benefit.
 *
 * ## Why the server can then skip `sharp` entirely
 *
 * A presigned upload sends bytes browser → storage directly; the API never sees
 * them. If the client also produces the derivatives, there is nothing left for
 * a server-side image processor to do on the hot path. The server's job becomes
 * registering what arrived — which is why `media-kit` accepts client-declared
 * variants rather than re-deriving them.
 *
 * ## What this deliberately does NOT do
 *
 * It never UPSCALES. A 200px thumbnail of a 150px source would be a bigger file
 * carrying no more information, so such a derivative is SKIPPED and reported as
 * skipped — see {@link SkippedDerivative}. Silently emitting an upscaled copy is
 * how a "thumbnail" ends up larger than its original, and nothing would have
 * complained.
 */

import { computeTargetSize, planDownscaleSteps } from '../algorithms/sizing.js';
import { resolveFormat } from '../algorithms/format.js';
import type { CompressImageOptions, CompressImageResult, ImageFormat } from '../types.js';
import { clampQuality, compressDecoded } from './compressImage.js';
import type { ImageIOAdapter } from './ImageIOAdapter.js';

/**
 * One requested derivative.
 *
 * `name` is an IDENTITY, not a label: the server registers the variant under it
 * and readers look it up by it (`variants.find(v => v.name === 'thumbnail')`).
 * Renaming one silently orphans every consumer, so it belongs in the host's
 * policy rather than in a UI.
 */
export interface DerivativeSpec {
  name: string;
  /** Longest-edge bound, in px. Never enlarges. */
  maxEdge: number;
  /** Encoder quality 0..1. Defaults to the primary's quality. */
  quality?: number | undefined;
  /** Format preference list; falls back to what the runtime can encode. */
  format?: ImageFormat | ImageFormat[] | undefined;
}

export interface Derivative {
  name: string;
  blob: Blob;
  format: ImageFormat;
  width: number;
  height: number;
  bytes: number;
}

/**
 * A derivative that was ASKED FOR and deliberately not produced.
 *
 * Reported rather than omitted: "absent because the source was smaller" and
 * "absent because encoding failed" are different facts, and a consumer that
 * cannot tell them apart will either re-request forever or silently serve the
 * full-size original believing it asked correctly.
 */
export interface SkippedDerivative {
  name: string;
  reason: 'source-smaller' | 'redundant-with-primary' | 'encode-failed';
  detail?: string;
}

export interface CompressImageSetOptions extends CompressImageOptions {
  derivatives?: readonly DerivativeSpec[] | undefined;
}

export interface CompressImageSetResult extends CompressImageResult {
  /** Produced derivatives, in the order requested. */
  derivatives: Derivative[];
  /** Requested-but-not-produced, each with why. Empty when all were produced. */
  skipped: SkippedDerivative[];
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new DOMException('Image compression aborted', 'AbortError');
}

/**
 * Compress a source into a primary output plus named derivatives, decoding once.
 *
 * The primary is exactly what {@link compressImage} would produce for the same
 * options — same passthrough rule, same sizing, same extras — so adding
 * derivatives never changes the main asset. Derivatives are encoded from the
 * SAME decoded bitmap and are independent of whether the primary passed
 * through: a small source still deserves a thumbnail.
 *
 * A single derivative that fails to encode does NOT fail the upload. The
 * primary is the asset; a missing 200px preview is a degraded experience, while
 * throwing here would lose the photo the user actually took. Failures surface
 * in `skipped` so the caller can decide, and the server can still derive that
 * one later if it cares.
 */
export async function compressImageSet(
  adapter: ImageIOAdapter,
  source: Blob,
  options: CompressImageSetOptions = {},
): Promise<CompressImageSetResult> {
  throwIfAborted(options.signal);
  const image = await adapter.decode(source);
  try {
    const primary = await compressDecoded(adapter, image, source, options);

    const derivatives: Derivative[] = [];
    const skipped: SkippedDerivative[] = [];
    const sourceDims = { width: image.width, height: image.height };

    for (const spec of options.derivatives ?? []) {
      throwIfAborted(options.signal);

      const target = computeTargetSize(sourceDims, { maxEdge: spec.maxEdge });

      // `computeTargetSize` never enlarges, so a target equal to the source
      // means the source was already at or under the bound.
      if (target.width === sourceDims.width && target.height === sourceDims.height) {
        skipped.push({
          name: spec.name,
          reason: 'source-smaller',
          detail: `source ${sourceDims.width}x${sourceDims.height} is within maxEdge ${spec.maxEdge}`,
        });
        continue;
      }

      // Same pixels as the primary ⇒ a second copy of one image under two
      // names. The consumer's `find(name)` would succeed and it would download
      // exactly what it was trying to avoid.
      if (target.width === primary.width && target.height === primary.height) {
        skipped.push({
          name: spec.name,
          reason: 'redundant-with-primary',
          detail: `primary is already ${primary.width}x${primary.height}`,
        });
        continue;
      }

      try {
        const format = resolveFormat(spec.format ?? options.format, adapter.encodable);
        const steps = planDownscaleSteps(sourceDims, target);
        const blob = await adapter.resizeAndEncode(
          image,
          target,
          steps,
          format,
          clampQuality(spec.quality ?? options.quality ?? 0.82),
        );
        derivatives.push({
          name: spec.name,
          blob,
          format,
          width: target.width,
          height: target.height,
          bytes: blob.size,
        });
      } catch (err) {
        // An AbortError is the CALLER cancelling, not this derivative failing —
        // swallowing it here would keep grinding through the remaining sizes
        // after the user navigated away.
        if (err instanceof DOMException && err.name === 'AbortError') throw err;
        skipped.push({
          name: spec.name,
          reason: 'encode-failed',
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return { ...primary, derivatives, skipped };
  } finally {
    image.close();
  }
}
