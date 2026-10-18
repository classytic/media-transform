/**
 * The React Native / Expo {@link ImageIOAdapter}, and `createExpoMediaTransform()`.
 *
 * Same contract, same orchestrator: `compressImage` / `compressImageSet` from
 * the core run unchanged over this adapter, so sizing, presets, passthrough,
 * metadata stripping, format fallback and derivative rules are byte-for-byte
 * the web behaviour. Only the four I/O verbs are native:
 *
 * | verb               | Expo SDK 55 API                                                         |
 * |--------------------|-------------------------------------------------------------------------|
 * | `decode`           | `ImageManipulator.manipulate(uri).renderAsync()` → `ImageRef`           |
 * | `resizeAndEncode`  | `manipulate(ref).resize(step)….renderAsync()` → `saveAsync({ format, compress })` |
 * | `extractRgba`      | the same, saved as a ≤100px PNG and decoded in JS (`algorithms/png`)    |
 * | `fromBytes`        | `new File(Paths.cache, name).write(bytes)` (RN Blobs cannot hold bytes)  |
 *
 * ## Orientation and metadata (verified against the 55.0.x native sources)
 *
 * - iOS: `manipulate()` loads with `UIImage(data:)` and immediately schedules
 *   `ImageFixOrientationTransformer`, so `ImageRef.width/height` are DISPLAY
 *   dimensions. `saveAsync` writes `UIImage.jpegData` / `pngData` /
 *   SDWebImage's WebP coder: the source EXIF dictionary, including GPS, is not
 *   carried into the output.
 * - Android: the image loader is Glide, whose downsampler applies EXIF
 *   orientation while decoding. `saveAsync` is `Bitmap.compress`, which writes
 *   no EXIF at all.
 *
 * So a RE-ENCODED photo never carries the device's location. The passthrough
 * fast path (small files, `passthroughUnder`) does not re-encode; it strips
 * EXIF/XMP/IPTC losslessly with the core sanitizer exactly as on the web, and
 * writes the cleaned bytes to a cache file through {@link ExpoImageAdapter.fromBytes}.
 *
 * ## Encodable formats
 *
 * JPEG and PNG always; WebP when the installed module's `SaveFormat` has it
 * (iOS via SDWebImageWebPCoder, Android natively). AVIF is never offered, so a
 * `['avif', 'webp', 'jpeg']` preference resolves to WebP, never to a silent
 * mislabel. On Expo web the canvas is probed for WebP (Safari cannot encode it),
 * though on the web `createBrowserMediaTransform()` is the better path.
 */

import { computeTargetSize } from '../algorithms/sizing.js';
import { sha256Hex } from '../algorithms/hash.js';
import { decodePngToRgba } from '../algorithms/png.js';
import { compressImage } from '../image/compressImage.js';
import {
  compressImageSet,
  type CompressImageSetOptions,
  type CompressImageSetResult,
  type Derivative,
} from '../image/compressImageSet.js';
import type { DecodedImage, ImageIOAdapter } from '../image/ImageIOAdapter.js';
import type { TransformFacts } from '../policy.js';
import type { CompressImageOptions, CompressImageResult, Dimensions, ImageFormat, MediaTransform } from '../types.js';
import {
  type ExpoFile,
  type ExpoImageManipulatorModule,
  type ExpoImageRef,
  type ExpoManipulatorContext,
  type ExpoModules,
  loadExpoModules,
} from './expoModules.js';

/**
 * What a native caller hands over: a `file://` (or `content://`, `ph://`) URI
 * string, anything with a `uri` (an `expo-image-picker` asset, an
 * `expo-file-system` `File`), or a Blob. Prefer a URI on native: React
 * Native's own Blob cannot expose its bytes to JS.
 */
export type NativeImageSource = string | { readonly uri: string } | Blob;

export interface ExpoImageAdapterOptions {
  /** Inject the Expo modules (tests, custom builds). Default: `import()` the optional peers. */
  modules?: ExpoModules | undefined;
  /** Override format detection, e.g. for a build known to lack WebP. JPEG is always kept as the floor. */
  encodable?: readonly ImageFormat[] | undefined;
}

/** A compress result whose bytes live in a local file (the `blob` IS that `expo-file-system` `File`). */
export interface ExpoCompressImageResult extends CompressImageResult {
  /** `file://` URI of the output: pass to `fetch(url, { method: 'PUT', body })` or an `<Image>`. */
  uri: string;
}

export interface ExpoDerivative extends Derivative {
  uri: string;
}

export interface ExpoCompressImageSetResult extends CompressImageSetResult {
  uri: string;
  derivatives: ExpoDerivative[];
}

/** {@link MediaTransform} over Expo native modules, plus the native-only helpers an upload needs. */
export interface ExpoMediaTransform extends MediaTransform {
  compressImage(source: NativeImageSource, options?: CompressImageOptions): Promise<ExpoCompressImageResult>;
  compressImageSet(source: NativeImageSource, options?: CompressImageSetOptions): Promise<ExpoCompressImageSetResult>;
  /**
   * Lowercase hex SHA-256 of the bytes (the dedup handshake's `sha256`). Hash
   * the OUTPUT you will upload (`result.uri`), not the source. Uses
   * `expo-crypto` when installed, else WebCrypto; throws when neither exists.
   */
  sha256(source: NativeImageSource): Promise<string>;
  /**
   * The bytes of a source or result URI. React Native's global `fetch` cannot
   * send an `expo-file-system` `File` as a body (only its own Blobs, strings
   * and byte arrays), so PUT these; `expo/fetch` accepts the `File` directly.
   */
  bytes(source: NativeImageSource): Promise<Uint8Array>;
  /** The facts `resolveTransformPlan(facts, policy)` needs: mime type and byte size (and the folder you pass). */
  describe(source: NativeImageSource, folder?: string): Promise<TransformFacts>;
  /**
   * Delete the cache files a result produced (primary and derivatives) once
   * they are uploaded. Never deletes a caller's source file, including a
   * passed-through one. Safe to call twice.
   */
  discard(result: ExpoCompressImageResult | ExpoCompressImageSetResult): void;
}

interface NativeHandle {
  readonly ref: ExpoImageRef;
  readonly context: ExpoManipulatorContext;
}

function isNativeHandle(value: unknown): value is NativeHandle {
  return typeof value === 'object' && value !== null && 'ref' in value && 'context' in value;
}

function handleOf(image: DecodedImage): NativeHandle {
  if (!isNativeHandle(image.handle)) {
    throw new Error('[media-transform] ExpoImageAdapter was given an image it did not decode');
  }
  return image.handle;
}

function hasUri(value: unknown): value is { readonly uri: string } {
  return typeof value === 'object' && value !== null && typeof (value as { uri?: unknown }).uri === 'string';
}

function release(target: { release?(): void } | undefined): void {
  try {
    target?.release?.();
  } catch {
    // Already released / runtime torn down: nothing left to free.
  }
}

const SAVE_FORMATS: Readonly<Record<string, ImageFormat>> = { jpeg: 'jpeg', jpg: 'jpeg', png: 'png', webp: 'webp' };

/**
 * Formats this runtime's `expo-image-manipulator` can write. Pure over the
 * module (plus the canvas probe on Expo web), so it is unit-testable.
 */
export function detectExpoEncodable(manipulator: ExpoImageManipulatorModule): Set<ImageFormat> {
  const encodable = new Set<ImageFormat>(['jpeg', 'png']); // every platform's floor
  for (const value of Object.values(manipulator.SaveFormat ?? {})) {
    const format = SAVE_FORMATS[String(value).toLowerCase()];
    if (format) encodable.add(format);
  }
  if (encodable.has('webp') && !webCanvasEncodesWebp()) encodable.delete('webp');
  return encodable;
}

/** On Expo WEB the manipulator encodes with a canvas; Safari's cannot produce WebP. Native: always true. */
function webCanvasEncodesWebp(): boolean {
  if (typeof document === 'undefined' || typeof document.createElement !== 'function') return true;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    return canvas.toDataURL('image/webp').startsWith('data:image/webp');
  } catch {
    return false;
  }
}

const MIME_EXT: Readonly<Record<string, string>> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/heic': 'heic',
  'image/heif': 'heif',
};

let fileCounter = 0;

export class ExpoImageAdapter implements ImageIOAdapter {
  /** Cache files THIS adapter wrote. `discard` deletes only these, so a source is never removed. */
  private readonly produced = new Set<string>();

  constructor(
    private readonly modules: ExpoModules,
    readonly encodable: ReadonlySet<ImageFormat>,
  ) {}

  /** An `expo-file-system` `File` for a URI (Blob-compatible: `size`, `type`, `arrayBuffer()`). */
  file(uri: string): ExpoFile {
    return new this.modules.fileSystem.File(uri);
  }

  /** Normalise a native source to a Blob the core orchestrator can read (`type`, `size`, bytes). */
  toBlob(source: NativeImageSource): Blob {
    if (typeof source === 'string') return this.file(source);
    if (hasUri(source)) return this.file(source.uri);
    return source;
  }

  async decode(source: Blob): Promise<DecodedImage> {
    // A bare Blob has no path the native decoder can open: stage it in the
    // cache for the duration of this decode only.
    const staged = hasUri(source)
      ? undefined
      : await this.fromBytes(new Uint8Array(await source.arrayBuffer()), source.type);
    const uri = hasUri(source) ? source.uri : hasUri(staged) ? staged.uri : '';
    const unstage = () => {
      if (staged) this.discardUri(uri);
    };
    const context = this.modules.manipulator.ImageManipulator.manipulate(uri);
    let ref: ExpoImageRef;
    try {
      ref = await context.renderAsync();
    } catch (err) {
      release(context);
      unstage();
      throw new Error(
        `[media-transform] could not decode image ${uri}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const handle: NativeHandle = { ref, context };
    return {
      handle,
      width: ref.width,
      height: ref.height,
      close: () => {
        release(ref);
        release(context);
        unstage();
      },
    };
  }

  async resizeAndEncode(
    image: DecodedImage,
    target: Dimensions,
    steps: readonly Dimensions[],
    format: ImageFormat,
    quality: number,
  ): Promise<Blob> {
    if (!this.encodable.has(format)) {
      throw new Error(`[media-transform] ${format} is not encodable here (have: ${[...this.encodable].join(', ')})`);
    }
    const { ref } = handleOf(image);
    const context = this.modules.manipulator.ImageManipulator.manipulate(ref);
    // Honour the core's halving plan: Android's resize is a bilinear
    // `createScaledBitmap`, which aliases on a one-shot >2x downscale exactly
    // like a canvas does. The steps run natively, off the JS thread.
    const plan =
      steps.length > 0 ? steps : target.width !== image.width || target.height !== image.height ? [target] : [];
    for (const step of plan) context.resize({ width: step.width, height: step.height });
    let rendered: ExpoImageRef | undefined;
    try {
      rendered = await context.renderAsync();
      const saved = await rendered.saveAsync({ format, compress: quality });
      this.produced.add(saved.uri);
      return this.file(saved.uri);
    } finally {
      release(rendered);
      release(context);
    }
  }

  async extractRgba(
    image: DecodedImage,
    max: number,
  ): Promise<{ data: Uint8Array; width: number; height: number } | null> {
    const { ref } = handleOf(image);
    const small = computeTargetSize({ width: image.width, height: image.height }, { maxEdge: max });
    const context = this.modules.manipulator.ImageManipulator.manipulate(ref);
    let rendered: ExpoImageRef | undefined;
    let tmp: ExpoFile | undefined;
    try {
      if (small.width !== image.width || small.height !== image.height) context.resize(small);
      rendered = await context.renderAsync();
      // PNG: lossless and the one format a JS decoder can read without a codec.
      const saved = await rendered.saveAsync({ format: 'png' });
      tmp = this.file(saved.uri);
      return decodePngToRgba(await tmp.bytes());
    } catch {
      // Placeholders are best-effort: a failure here must never fail the upload.
      return null;
    } finally {
      release(rendered);
      release(context);
      try {
        tmp?.delete();
      } catch {
        // The OS clears the cache directory anyway.
      }
    }
  }

  async fromBytes(bytes: Uint8Array, mimeType: string): Promise<Blob> {
    const ext = MIME_EXT[mimeType.toLowerCase().split(';')[0]?.trim() ?? ''] ?? 'bin';
    fileCounter = (fileCounter + 1) % 1_000_000;
    const name = `media-transform-${Date.now().toString(36)}-${fileCounter}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
    const file = new this.modules.fileSystem.File(this.modules.fileSystem.Paths.cache, name);
    file.create({ overwrite: true });
    file.write(bytes);
    this.produced.add(file.uri);
    return file;
  }

  /** Delete a cache file this adapter wrote. A URI it did not write is left alone. */
  discardUri(uri: string): void {
    if (!this.produced.delete(uri)) return;
    try {
      const file = this.file(uri);
      if (file.exists) file.delete();
    } catch {
      // Best-effort cleanup: the OS evicts the cache directory under pressure.
    }
  }

  /** Bytes of any native source. */
  async bytesOf(source: NativeImageSource): Promise<Uint8Array> {
    const blob = this.toBlob(source);
    if (hasUri(blob)) return this.file(blob.uri).bytes();
    return new Uint8Array(await blob.arrayBuffer());
  }

  /** SHA-256 hex: `expo-crypto` when installed, else WebCrypto. */
  async sha256(source: NativeImageSource): Promise<string> {
    const bytes = await this.bytesOf(source);
    if (this.modules.crypto) return toHex(new Uint8Array(await this.modules.crypto.digest('SHA-256', bytes)));
    if (typeof crypto !== 'undefined' && typeof crypto.subtle?.digest === 'function') return sha256Hex(bytes);
    throw new Error(
      '[media-transform] no SHA-256 available: install expo-crypto (npx expo install expo-crypto) for the dedup hash',
    );
  }
}

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

/** Build the adapter: load (or take) the Expo modules, detect encodable formats once. */
export async function createExpoImageAdapter(options: ExpoImageAdapterOptions = {}): Promise<ExpoImageAdapter> {
  const modules = options.modules ?? (await loadExpoModules());
  const encodable = options.encodable
    ? new Set<ImageFormat>([...options.encodable, 'jpeg'])
    : detectExpoEncodable(modules.manipulator);
  return new ExpoImageAdapter(modules, encodable);
}

function uriOf(blob: Blob): string {
  if (hasUri(blob)) return blob.uri;
  // Only reachable for a Blob source passed through without metadata changes:
  // it never touched the file system, so give it one (upload code wants a URI).
  throw new Error('[media-transform] result has no file URI; pass a URI (not a Blob) as the native source');
}

/**
 * The native {@link MediaTransform}. SYNCHRONOUS to create (call it at module
 * scope); the Expo modules load and formats are detected on the first call,
 * once, and a failed load is retried on the next call rather than cached.
 *
 * ```ts
 * import { PRESETS } from '@classytic/media-transform/algorithms/presets';
 * import { toUploadHints } from '@classytic/media-transform/image/uploadHints';
 * import { createExpoMediaTransform } from '@classytic/media-transform/native/ExpoImageAdapter';
 *
 * const mt = createExpoMediaTransform();
 * const out = await mt.compressImage(asset.uri, PRESETS.chat); // 1600px, q0.82, webp→jpeg, thumbhash
 * const sha256 = await mt.sha256(out.uri);
 * const hints = toUploadHints(out); // { width, height, thumbhash? (base64) }
 * ```
 */
export function createExpoMediaTransform(options: ExpoImageAdapterOptions = {}): ExpoMediaTransform {
  let pending: Promise<ExpoImageAdapter> | undefined;
  const adapter = (): Promise<ExpoImageAdapter> => {
    pending ??= createExpoImageAdapter(options).catch((err: unknown) => {
      pending = undefined;
      throw err;
    });
    return pending;
  };

  return {
    async compressImage(source, compressOptions) {
      const a = await adapter();
      const result = await compressImage(a, a.toBlob(source), compressOptions);
      return { ...result, uri: uriOf(result.blob) };
    },
    async compressImageSet(source, setOptions) {
      const a = await adapter();
      const result = await compressImageSet(a, a.toBlob(source), setOptions);
      return {
        ...result,
        uri: uriOf(result.blob),
        derivatives: result.derivatives.map((d) => ({ ...d, uri: uriOf(d.blob) })),
      };
    },
    async sha256(source) {
      return (await adapter()).sha256(source);
    },
    async bytes(source) {
      return (await adapter()).bytesOf(source);
    },
    async describe(source, folder) {
      const blob = (await adapter()).toBlob(source);
      return { mimeType: blob.type, bytes: blob.size, ...(folder !== undefined ? { folder } : {}) };
    },
    discard(result) {
      // Synchronous by contract. If the adapter never loaded, it produced nothing.
      if (!pending) return;
      pending.then(
        (a) => {
          a.discardUri(result.uri);
          if ('derivatives' in result) for (const d of result.derivatives) a.discardUri(d.uri);
        },
        () => undefined,
      );
    },
  };
}
