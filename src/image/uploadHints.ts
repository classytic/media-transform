/**
 * The glue between @classytic/media-transform and @classytic/media-kit's
 * client-processed upload flow. media-kit's `confirmUpload()` /
 * `completeMultipartUpload()` / `upload()` accept client-computed DISPLAY
 * HINTS (`width`, `height`, `thumbhash` as base64 ≤128 chars, `dominantColor`
 * as `#rrggbb`) so the server can skip sharp entirely; this converts a
 * {@link CompressImageResult} into exactly that shape:
 *
 * ```ts
 * const out = await mt.compressImage(file, { ...PRESETS.chat, dominantColor: true });
 * // ...presigned PUT of out.blob...
 * await api.confirm({
 *   key, filename: file.name, mimeType: out.blob.type, size: out.bytes,
 *   ...toUploadHints(out),
 *   hashStrategy: 'sha256', // server verifies content hash — enables the existsByHash handshake
 * });
 * ```
 */
import type { CompressImageResult } from '../types.js';
import { bytesToBase64 } from './llmPayload.js';

/** media-kit's client-metadata display-hint fields, ready to spread into a confirm/upload input. */
export interface UploadHints {
  width: number;
  height: number;
  thumbhash?: string | undefined;
  dominantColor?: string | undefined;
}

/** Convert a compress result into media-kit display hints (thumbhash → base64). */
export function toUploadHints(result: CompressImageResult): UploadHints {
  return {
    width: result.width,
    height: result.height,
    ...(result.thumbhash ? { thumbhash: bytesToBase64(result.thumbhash) } : {}),
    ...(result.dominantColor ? { dominantColor: result.dominantColor } : {}),
  };
}
