# @classytic/media-transform

[![Sponsor](https://img.shields.io/github/sponsors/classytic?style=flat-square&label=Sponsor&logo=GitHub&color=EA4AAA)](https://github.com/sponsors/classytic)

Client-side media processing — compress, resize, and re-encode images in the browser **before**
upload (WhatsApp/Facebook style), so a Node backend can skip `sharp` on the hot path.

The perceived speed of chat apps comes from doing the heavy work on the device: the phone shrinks a
4 MB photo to ~100 KB, the tiny payload uploads in a blink, and the server just stores it. This
package is the browser half of that.

- **Runtime-agnostic pure core** (`./core`) — sizing math, format selection, downscale planning.
  No DOM; runs in the browser, Node, and React Native, and is the bulk of the test coverage.
- **Browser adapter** — `createImageBitmap` + `OffscreenCanvas` + `convertToBlob`, EXIF
  auto-orientation, stepped downscale (no blurry one-shot resample), feature-detected AVIF/WebP.
- **One `MediaTransform` contract** — a React Native adapter satisfies the same interface with
  native modules, so upload code compiles unchanged on web and native.

Zero runtime dependencies. Heavy encoders (`@jsquash/*`, `thumbhash`) are **optional peers**, loaded
via `await import()` only when used — a consumer that never asks for AVIF never pays for it.

## Install

```bash
npm install @classytic/media-transform
# optional — only if you want ThumbHash placeholders:
npm install thumbhash
```

AVIF/WebP encode uses the browser's native `convertToBlob` when available (feature-detected). A
`@jsquash` WASM fallback for browsers that can't encode those formats is on the roadmap.

## Quick start

```ts
import { createBrowserMediaTransform, isBrowserImageSupported } from '@classytic/media-transform';

const mt = await createBrowserMediaTransform();

// In your file <input> handler:
async function onPick(file: File) {
  if (!isBrowserImageSupported()) return uploadOriginal(file); // graceful fallback

  const { blob, format, width, height, thumbhash } = await mt.compressImage(file, {
    maxEdge: 1600,                 // WhatsApp-style longest-edge cap
    format: ['avif', 'webp', 'jpeg'], // first the browser can encode wins
    quality: 0.82,
    thumbhash: true,               // tiny blurred preview to render instantly
  });

  // blob → media-kit presigned upload; render `thumbhash` immediately (optimistic UI)
}
```

## Where it fits

- **`@classytic/media-kit`** stores what the client sends. Set `processing: { enabled: false }` (or
  per-upload `skipProcessing`) for browser-sourced uploads and the server skips `sharp` — it still
  content-type-sniffs and validates (never trust client pixels), but does no resizing. `sharp` stays
  for server-originated uploads and on-read transforms.
- **`@classytic/react-media`** / **`@classytic/react-media-native`** own the upload transport and can
  wrap this behind a hook.
- **`@classytic/vixel-ui`** shares the same WebCodecs encode family for its editor export.

## API — granular subpath exports (no barrels)

Per Vercel's "avoid barrel imports" guidance, there is no aggregating barrel: import each piece
directly from its subpath so a bundler loads only that leaf module. The root `.` is a small curated
entry (the factory + capability gates + types), not a re-export of everything.

| Subpath | Exports | Runs where |
|---|---|---|
| `.` | `createBrowserMediaTransform()`, `isBrowserImageSupported()`, `isWebCodecsVideoSupported()`, types | browser |
| `./algorithms/sizing` | `computeTargetSize`, `isWithinConstraints`, `planDownscaleSteps` | **anywhere** (pure) |
| `./algorithms/format` | `resolveFormat`, `FORMAT_MIME`, `FORMAT_EXT`, `supportsAlpha` | **anywhere** (pure) |
| `./algorithms/sanitize` | `stripImageMetadata` + per-format JPEG/PNG/WebP lossless EXIF/GPS strippers | **anywhere** (pure) |
| `./algorithms/presets` | `PRESETS` — named quality bundles: `chat`, `llm`, `ecom`, `editor`, `avatar`, `thumbnail` | **anywhere** (pure) |
| `./algorithms/hash` | `sha256Hex` — content hash for the dedup handshake (WebCrypto) | **anywhere** |
| `./image/llmPayload` | `toLlmImagePayload`, `blobToBase64`, `blobToDataUrl` — vision-LLM message content | anywhere |
| `./image/uploadHints` | `toUploadHints(result)` — media-kit confirm/upload display hints (thumbhash→base64) | anywhere |
| `./algorithms/color` | `averageColorHex` — `dominantColor` from RGBA | **anywhere** (pure) |
| `./image/compressImage` | `compressImage(adapter, source, options)` — the orchestrator | browser |
| `./image/BrowserImageAdapter` | `createBrowserImageAdapter()` — the browser `ImageIOAdapter` | browser |
| `./image/ImageIOAdapter` | `ImageIOAdapter`, `DecodedImage` (the adapter contract, type-only) | anywhere |
| `./image/workerProtocol` | `createWorkerMediaTransform(worker)` + the message protocol | browser |
| `./image/worker` | Worker ENTRY — point `new Worker(new URL(...))` here | worker |
| `./react/useImageCompress` | `useImageCompress(transform)` — compress-only hook | browser + React |
| `./react/useImageUpload` | `useImageUpload({ transform?, upload })` — the WhatsApp upload-on-pick flow | browser + React |
| `./capabilities` | `isBrowserImageSupported`, `isWebCodecsVideoSupported` | browser |
| `./types` | The full `MediaTransform` contract (type-only) | anywhere |

### Off-main-thread (worker)

```ts
import { createWorkerMediaTransform } from '@classytic/media-transform/image/workerProtocol';

const worker = new Worker(new URL('@classytic/media-transform/image/worker', import.meta.url), { type: 'module' });
const mt = createWorkerMediaTransform(worker); // same MediaTransform, main thread stays free
```

### Privacy: passthrough still strips EXIF/GPS

A re-encode drops metadata implicitly — but the `passthroughUnder` fast path skips re-encoding, so
it strips metadata **losslessly** instead (byte-level JPEG/PNG/WebP segment removal, pixels
untouched, ICC color kept). Default on; `stripMetadata: false` opts out. The small-image fast path
never becomes the one that leaks the photographer's location.

### Multimodal chat (vision LLMs)

Never send a 12MP DSLR/phone original to a bot — you pay tokens for pixels. `PRESETS.llm`
(1568px long edge, the Anthropic sweet spot, inside every provider's budget) + `toLlmImagePayload`
cover all three chat shapes:

```ts
import { PRESETS } from '@classytic/media-transform/algorithms/presets';
import { toLlmImagePayload } from '@classytic/media-transform/image/llmPayload';

// 1. STATELESS chat — no storage provider at all; image goes straight into the messages array:
const out = await mt.compressImage(file, PRESETS.llm);
const img = await toLlmImagePayload(out);
// Anthropic: { type:'image', source:{ type:'base64', media_type: img.mediaType, data: img.base64 } }
// OpenAI:    { type:'image_url', image_url:{ url: img.dataUrl } }

// 2. UPLOAD-FIRST, then chat — store via media-kit, feed the bot per turn with
//    getContextPayload() (server-side base64) or a long-TTL signed URL (URL-fetch providers).

// 3. HYBRID — compress once with PRESETS.llm, upload THAT (skip server processing), so the
//    stored asset and the bot payload are the same bytes (byte-stable = prompt-cache friendly).
```

Other presets pick the quality posture per product: `ecom` (2560px, q0.9 — zoomable product
detail), `editor` (4096px, q0.95, alpha kept — Canva-like pipelines), `chat`, `avatar`,
`thumbnail`. All spreadable: `{ ...PRESETS.ecom, maxEdge: 3000 }`.

### The upload-on-pick flow (`useImageUpload`)

The moment the user picks a file, it's compressed AND the upload starts — before they hit send.
Render `result.thumbhash` immediately; by send time the upload is usually already `ready`:

```tsx
const { pick, status, result, uploaded } = useImageUpload({
  transform,
  upload: async ({ blob }, { signal }) => {
    const { uploadUrl, key } = await api.presign(blob.type, { signal });
    await fetch(uploadUrl, { method: 'PUT', body: blob, signal });
    return key;
  },
});
// photo path: void pick(file, { maxEdge: 1600, thumbhash: true })
// "send as document" path: void pick(file, { process: false })
```

```ts
// Server (Node) reusing ONLY the pure sizing math — pulls no browser code:
import { computeTargetSize } from '@classytic/media-transform/algorithms/sizing';

// Browser, advanced (bring your own adapter loop):
import { compressImage } from '@classytic/media-transform/image/compressImage';
import { createBrowserImageAdapter } from '@classytic/media-transform/image/BrowserImageAdapter';
```

`compressImage` options: `maxEdge` · `maxWidth` · `maxHeight` · `maxPixels` · `format` · `quality`
· `passthroughUnder` (skip re-encoding already-small images) · `thumbhash` · `signal`.

### React

`useImageCompress` is a thin, transport-agnostic hook over a `MediaTransform` — it owns the compress
lifecycle (status/result/error), aborts a superseded or unmounted run, and drops stale results. It
does NOT know how you upload; compose it with any transport.

```tsx
'use client';
import { createBrowserMediaTransform } from '@classytic/media-transform';
import { useImageCompress } from '@classytic/media-transform/react/useImageCompress';

const transform = await createBrowserMediaTransform(); // build once, reuse

function Uploader({ transform }) {
  const { compress, status, result } = useImageCompress(transform);
  async function onPick(file: File) {
    const out = await compress(file, { maxEdge: 1600, thumbhash: true });
    if (out) await uploadBlob(out.blob); // your transport (media-kit presigned / react-media)
  }
  // render result.thumbhash instantly for an optimistic preview
}
```

## Source layout

Feature-first domain directories (PixiJS-style organization), one concept per file, no barrel
`index.ts` files. Tests live in a top-level `tests/` dir mirroring `src/` (classytic convention).

```
src/                             tests/                (mirrors src)
  index.ts                         algorithms/
  types.ts  capabilities.ts        image/
  algorithms/  sizing.ts format.ts react/
  image/                           capabilities.test.ts
    compressImage.ts   (orchestrator)
    ImageIOAdapter.ts  (web/native seam)
    BrowserImageAdapter.ts (Canvas impl)
  react/
    useImageCompress.ts  ('use client' hook)
```

## Roadmap

- **Video** — client transcode via WebCodecs `VideoEncoder` + `mp4-muxer` (aligned with
  `react-media`'s existing `webcodecs-segmenter` and `vixel-ui`'s export core), best-effort with a
  server-transcode fallback for unsupported browsers.
- **Native adapter** — the same `MediaTransform` over React Native native modules.

## License

MIT

## Trademark

The code is MIT-licensed. "Classytic"/"arc" names + logos are trademarks of Classytic LLC — see [TRADEMARK.md](TRADEMARK.md).
