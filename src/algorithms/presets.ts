/**
 * Named compression presets — coherent quality/size bundles per use case, so
 * hosts pick a posture instead of hand-tuning five knobs. Pure data; spread
 * and override freely: `{ ...PRESETS.chat, quality: 0.9 }`.
 *
 * Sizing rationale (why these numbers):
 * - `llm` targets the vision-model sweet spots: Anthropic downscales anything
 *   past ~1568px on the long edge (and hard-caps 8000px / 5MB per image);
 *   OpenAI high-detail tiles at 768×2048 max; Gemini at ~3072px. 1568px keeps
 *   full fidelity on Anthropic while comfortably inside every provider's
 *   budget, and the aggressive quality keeps payloads tiny — you pay tokens
 *   for PIXELS, not bytes, so bytes only cost latency.
 * - `chat` is the WhatsApp posture: ~1600px longest edge, visually-clean
 *   quality, thumbhash for the instant preview. A 12MP phone photo lands
 *   around 100–300KB.
 * - `ecom` keeps zoomable product detail (2560px covers retina PDP zoom)
 *   at a quality where JPEG/WebP artifacts don't touch fabric/texture.
 * - `editor` is the Canva-like posture: assets re-enter an editing pipeline,
 *   so headroom matters — 4096px bound (common GPU-texture/canvas budget),
 *   near-lossless quality, alpha-capable formats first, and small files pass
 *   through untouched.
 */
import type { CompressImageOptions } from '../types.js';

export const PRESETS = {
  /** Chat/social attachments — the WhatsApp posture. */
  chat: {
    maxEdge: 1600,
    quality: 0.82,
    format: ['webp', 'jpeg'],
    passthroughUnder: 150_000,
    thumbhash: true,
  },
  /** Vision-LLM input (stateless base64 chats or upload-then-chat). */
  llm: {
    maxEdge: 1568,
    quality: 0.8,
    format: ['webp', 'jpeg'],
    passthroughUnder: 0, // always normalize — byte-stable output helps prompt caching
    thumbhash: false,
  },
  /** E-commerce product imagery — zoomable detail, no visible artifacts. */
  ecom: {
    maxEdge: 2560,
    quality: 0.9,
    format: ['webp', 'jpeg'],
    passthroughUnder: 0,
    thumbhash: true,
  },
  /** Editor/canvas assets (Canva-like) — near-lossless, alpha kept. */
  editor: {
    maxEdge: 4096,
    quality: 0.95,
    format: ['webp', 'png'],
    passthroughUnder: 2_000_000,
    thumbhash: false,
  },
  /** Profile pictures. */
  avatar: {
    maxEdge: 512,
    quality: 0.85,
    format: ['webp', 'jpeg'],
    passthroughUnder: 30_000,
    thumbhash: true,
  },
  /** List/grid thumbnails. */
  thumbnail: {
    maxEdge: 320,
    quality: 0.8,
    format: ['webp', 'jpeg'],
    passthroughUnder: 15_000,
    thumbhash: false,
  },
} as const satisfies Record<string, CompressImageOptions>;

export type PresetName = keyof typeof PRESETS;
