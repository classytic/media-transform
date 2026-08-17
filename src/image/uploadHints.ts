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

const FORMAT_EXT: Record<string, string> = {
  jpeg: 'jpg',
  webp: 'webp',
  avif: 'avif',
  png: 'png',
  gif: 'gif',
};

/**
 * The name to STORE the encoded bytes under — original stem, extension matching
 * what was actually encoded.
 *
 * A picked `photo.jpg` re-encoded to WebP is `image/webp` bytes. Uploading it as
 * `photo.jpg` makes the filename disagree with the content type, and since the
 * storage key is generated FROM the filename, the object ends up named `.jpg`
 * while holding WebP. Everything works — the server reads the content type —
 * right up until something trusts the extension: a CDN sniffing by suffix, a
 * bulk export, an operator downloading the file.
 *
 * Keep the user's original name separately for display; this is only the stored
 * one. Returns the name unchanged when the format is unknown, because inventing
 * an extension would be worse than keeping the one the user chose.
 */
export function storedFilename(originalName: string, format: string): string {
  const ext = FORMAT_EXT[format.toLowerCase()];
  if (!ext) return originalName;
  const stem = originalName.replace(/\.[^./\\]+$/, '') || originalName;
  return `${stem}.${ext}`;
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
