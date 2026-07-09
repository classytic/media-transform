/**
 * Turn compressed output into vision-LLM message content — the STATELESS
 * chat path where the image goes straight into the messages array as base64
 * and never touches a storage provider:
 *
 * ```ts
 * const out = await mt.compressImage(file, PRESETS.llm);
 * const payload = await toLlmImagePayload(out);
 * // Anthropic: { type:'image', source:{ type:'base64', media_type: payload.mediaType, data: payload.base64 } }
 * // OpenAI:    { type:'image_url', image_url:{ url: payload.dataUrl } }
 * ```
 *
 * For persistent chats, upload first and use media-kit's `getContextPayload`
 * (server-side) or a long-TTL signed URL instead — see the README's
 * multimodal-chat section. Base64 output is byte-stable for identical input,
 * which keeps LLM prompt-cache prefixes intact across turns.
 *
 * The encoder is hand-rolled (no `btoa`/`Buffer`) so it runs identically in
 * the browser, workers, Node and React Native, and handles large images
 * without the call-stack limits of `String.fromCharCode(...bytes)` tricks.
 */
import type { CompressImageResult } from '../types.js';

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Base64-encode raw bytes (pure, chunk-free, runtime-agnostic). */
export function bytesToBase64(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + B64[(n >> 6) & 63]! + B64[n & 63]!;
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = bytes[i]! << 16;
    out += `${B64[(n >> 18) & 63]!}${B64[(n >> 12) & 63]!}==`;
  } else if (rest === 2) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8);
    out += `${B64[(n >> 18) & 63]!}${B64[(n >> 12) & 63]!}${B64[(n >> 6) & 63]!}=`;
  }
  return out;
}

/** Base64 of a Blob's bytes. */
export async function blobToBase64(blob: Blob): Promise<string> {
  return bytesToBase64(new Uint8Array(await blob.arrayBuffer()));
}

/** `data:<type>;base64,...` URL of a Blob. */
export async function blobToDataUrl(blob: Blob): Promise<string> {
  return `data:${blob.type};base64,${await blobToBase64(blob)}`;
}

export interface LlmImagePayload {
  /** Raw base64 (Anthropic `source.data`). */
  base64: string;
  /** `data:` URL (OpenAI `image_url.url`). */
  dataUrl: string;
  /** MIME type (Anthropic `source.media_type`). */
  mediaType: string;
  width: number;
  height: number;
  bytes: number;
}

/** Package a {@link CompressImageResult} for a vision-LLM message. */
export async function toLlmImagePayload(result: CompressImageResult): Promise<LlmImagePayload> {
  const base64 = await blobToBase64(result.blob);
  return {
    base64,
    dataUrl: `data:${result.blob.type};base64,${base64}`,
    mediaType: result.blob.type,
    width: result.width,
    height: result.height,
    bytes: result.bytes,
  };
}
