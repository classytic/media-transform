# Changelog

Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
adhering to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0] - 2026-10-18

React Native / Expo adapter. The web path is unchanged.

### Added

- **`./native/ExpoImageAdapter`**: `createExpoMediaTransform()` (synchronous; Expo modules load on
  first use, a failed load is retried) and `createExpoImageAdapter()`, implementing the same
  `ImageIOAdapter` / `MediaTransform` contract over Expo SDK 55 modules. The core orchestrator,
  presets, policy, passthrough, metadata stripping and format fallback run unchanged.
  - decode / resize / encode with `expo-image-manipulator`'s contextual API
    (`ImageManipulator.manipulate(uri).resize().renderAsync()`, `ImageRef.saveAsync({ format, compress })`);
    the deprecated `manipulateAsync` is not used. The core's halving plan becomes chained `resize()` calls.
  - files via `expo-file-system`'s `File` / `Paths` (results carry `uri`; `blob` is the `File`).
  - `sha256(source)` for the dedup handshake: `expo-crypto` `digest`, else WebCrypto, else a clear error.
  - `bytes(source)`: the bytes to PUT (React Native's global `fetch` cannot send a `File` body).
  - `describe(source, folder?)` returns `TransformFacts` for `resolveTransformPlan`.
  - `discard(result)` deletes only cache files the adapter produced, never the caller's source.
  - Encodable formats: JPEG, PNG, and WebP when `SaveFormat.WEBP` exists (canvas-probed on Expo web).
    AVIF is never claimed. `detectExpoEncodable()` exported; `encodable` override option.
  - EXIF/GPS: verified in the 55.0.x native sources that re-encoded output carries no source EXIF
    (iOS `UIImage` encoders; Android `Bitmap.compress`) and is display-oriented; passed-through
    files are stripped by the core sanitizer and written to a new cache file.
- **`./algorithms/png`**: `decodePngToRgba` / `zlibInflate`, a pure PNG decoder with its own inflate
  (Hermes has no zlib or `DecompressionStream`). Feeds ThumbHash / `dominantColor` on native, where
  pixels cannot be read back from a canvas.
- **`ImageIOAdapter.fromBytes?`** (optional): lets an adapter materialise orchestrator-produced bytes
  (the stripped passthrough). React Native's Blob cannot be built from bytes; absent, the core keeps
  `new Blob([bytes])`.
- Optional peers: `expo-image-manipulator` (>=13), `expo-file-system` (>=19), `expo-crypto` (>=14).
  Each import sits in its own `try`, so Expo's Metro (`allowOptionalDependencies`) bundles without them.

### Fixed

- Abort errors and abort detection no longer require a `DOMException` global (React Native has none):
  `createAbortError()` / `isAbortError()` in `compressImage` and `compressImageSet`. Before, on React
  Native a single failed derivative threw a `ReferenceError` from the `catch` instead of landing in
  `skipped`, and an abort threw a `ReferenceError` instead of an `AbortError`. Browser behaviour is
  identical (still a `DOMException`).

## [0.1.0] — 2026-07-07

Initial release — browser image compression.

### Added

- **Pure runtime-agnostic core** (`@classytic/media-transform/core`): `computeTargetSize`
  (aspect-preserving, never-enlarging, most-restrictive-constraint-wins), `isWithinConstraints`,
  `planDownscaleSteps` (halving-step plan for a sharp resample), `resolveFormat` (first encodable
  format from a preference list, JPEG floor), and the `FORMAT_MIME`/`FORMAT_EXT` tables. No DOM —
  runs in the browser, Node, and React Native; exhaustively unit-tested.
- **Browser image compression** (main + `./image`): `createBrowserMediaTransform()` and the
  lower-level `compressImage(adapter, source, options)` orchestrator over an injectable
  `ImageIOAdapter`. The browser adapter uses `createImageBitmap` (EXIF `from-image` auto-orient) +
  `OffscreenCanvas` stepped resample + `convertToBlob`, with feature-detected AVIF/WebP encoding.
  Options: `maxEdge`/`maxWidth`/`maxHeight`/`maxPixels`, `format` (single or ordered preference),
  `quality`, `passthroughUnder` (skip re-encoding already-small images), `thumbhash`, `signal`.
- **`MediaTransform` contract** — the portable seam a future React Native adapter implements with
  native modules; hosts target the interface, not an implementation.
- **React binding** (`./react/useImageCompress`) — a thin, transport-agnostic hook over a
  `MediaTransform`: owns the compress lifecycle (status/result/error), aborts a superseded or
  unmounted run, drops stale results. React is an OPTIONAL peer — the core subpaths stay React-free.
  Ships a `"use client"` directive for Next.js RSC.
- **Capability gates** — `isBrowserImageSupported()` / `isWebCodecsVideoSupported()` for
  graceful "upload the original / let the server handle it" fallbacks.
- **ThumbHash** — opt-in blurred-placeholder generation via the optional `thumbhash` peer
  (`await import()`-ed, best-effort — absent peer degrades silently).
- **Lossless metadata stripping** (`./algorithms/sanitize`) — pure byte-level JPEG/PNG/WebP
  strippers removing EXIF (incl. GPS), XMP, IPTC and comments WITHOUT re-encoding (pixels
  untouched, ICC color kept). Wired into the `passthroughUnder` fast path by default
  (`stripMetadata: false` opts out) so skipping the re-encode never leaks location data.
- **Worker offload** (`./image/workerProtocol` + `./image/worker`) — run compression off the main
  thread: point a module Worker at the `worker` entry and wrap it with
  `createWorkerMediaTransform(worker)` for the same `MediaTransform` interface. Protocol is
  id-correlated (concurrent requests fine); abort is honored locally (result discarded). The
  protocol layer is fully tested in Node via a loopback fake worker.
- **`useImageUpload`** (`./react/useImageUpload`) — the WhatsApp "upload-on-pick" flow as one
  transport-agnostic hook: pick → compress (optional) → upload starts IMMEDIATELY (before send),
  thumbhash available for instant preview, supersession/cancel/unmount-abort handled. Both modes
  first-class: processed (photo path) and `process: false` (send-as-document/original path).
  Optional `dedupe` config wires the pre-upload hash handshake: SHA-256 the outgoing bytes,
  ask the server (media-kit `existsByHash`), and on a hit skip the upload AND the server's
  processing entirely. Fails open — a broken dedup endpoint never blocks a send. The hash rides
  on the upload payload so confirms can store the real content hash (`hashStrategy: 'sha256'`).
- **Named presets** (`./algorithms/presets`) — coherent quality bundles per use case: `chat`
  (WhatsApp posture), `llm` (1568px vision-model sweet spot, byte-stable for prompt caching),
  `ecom` (2560px zoomable detail), `editor` (4096px near-lossless, alpha-first — Canva-like),
  `avatar`, `thumbnail`. Pure data, spreadable/overridable.
- **Vision-LLM payload helpers** (`./image/llmPayload`) — `toLlmImagePayload(result)` →
  `{ base64, dataUrl, mediaType, width, height, bytes }` covering Anthropic (`source.data` +
  `media_type`) and OpenAI (`image_url.url`) shapes; plus `blobToBase64`/`blobToDataUrl`/
  `bytesToBase64` (hand-rolled encoder — no btoa/Buffer, runs in browser/worker/Node/RN). The
  STATELESS chat path: compressed image straight into the messages array, no storage provider.
- **`sha256Hex`** (`./algorithms/hash`) — WebCrypto content hash matching media-kit's
  `hashStrategy: 'sha256'` storage format, so client and server agree on identity.
- **media-kit glue** (`./image/uploadHints`) — `toUploadHints(result)` converts a compress result
  into media-kit's exact client-metadata shape (`width`, `height`, `thumbhash` → base64 within the
  128-char zod bound, `dominantColor`), ready to spread into `confirmUpload`/`upload` inputs.
- **`dominantColor` option** — `compressImage(..., { dominantColor: true })` computes the
  alpha-weighted average color (`#rrggbb`, `./algorithms/color`) from the SAME small RGBA sample
  ThumbHash uses (one extraction serves both) — the client-side equivalent of the `dominantColor`
  hint media-kit's server processing derives with sharp.

### Notes

- Zero runtime dependencies. `@jsquash/*` and `thumbhash` are OPTIONAL peers, dynamically imported
  only when used.
- The adapter seam keeps the whole suite green in Node/happy-dom CI (no headless browser needed):
  the pure core is tested directly and `compressImage` is tested through a fake adapter.
- Video transcode (WebCodecs) and a React Native adapter are planned; see the README roadmap.
