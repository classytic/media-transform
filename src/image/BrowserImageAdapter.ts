/**
 * The real browser {@link ImageIOAdapter}: `createImageBitmap` for decode
 * (with `imageOrientation: 'from-image'` so EXIF rotation is applied by the
 * platform — no hand-rolled EXIF parser needed), `OffscreenCanvas` for stepped
 * resampling, and `convertToBlob` for encoding. Encodable formats are
 * feature-detected once at construction.
 */
import type { Dimensions, ImageFormat } from '../types.js';
import { FORMAT_MIME } from '../algorithms/format.js';
import type { DecodedImage, ImageIOAdapter } from './ImageIOAdapter.js';

type Canvas = OffscreenCanvas;

function makeCanvas(width: number, height: number): Canvas {
  return new OffscreenCanvas(width, height);
}

function ctx2d(canvas: Canvas): OffscreenCanvasRenderingContext2D {
  const c = canvas.getContext('2d');
  if (!c) throw new Error('[media-transform] 2D canvas context unavailable');
  c.imageSmoothingEnabled = true;
  c.imageSmoothingQuality = 'high';
  return c;
}

/** Synchronously probe which formats this browser's `convertToBlob` can emit. */
async function detectEncodable(): Promise<Set<ImageFormat>> {
  const encodable = new Set<ImageFormat>(['png', 'jpeg']); // universal floor
  const probe = makeCanvas(1, 1);
  ctx2d(probe).fillRect(0, 0, 1, 1);
  for (const fmt of ['webp', 'avif'] as const) {
    try {
      const blob = await probe.convertToBlob({ type: FORMAT_MIME[fmt] });
      if (blob.type === FORMAT_MIME[fmt]) encodable.add(fmt);
    } catch {
      // Not encodable in this browser — leave it out.
    }
  }
  return encodable;
}

class BrowserImageAdapter implements ImageIOAdapter {
  constructor(readonly encodable: ReadonlySet<ImageFormat>) {}

  async decode(source: Blob): Promise<DecodedImage> {
    const bitmap = await createImageBitmap(source, { imageOrientation: 'from-image' });
    return {
      handle: bitmap,
      width: bitmap.width,
      height: bitmap.height,
      close: () => bitmap.close(),
    };
  }

  async resizeAndEncode(
    image: DecodedImage,
    target: Dimensions,
    steps: readonly Dimensions[],
    format: ImageFormat,
    quality: number,
  ): Promise<Blob> {
    let source: ImageBitmap | Canvas = image.handle as ImageBitmap;
    let current: Dimensions = { width: image.width, height: image.height };

    // Resample through each halving step so the final downscale is sharp.
    for (const step of steps) {
      const canvas = makeCanvas(step.width, step.height);
      ctx2d(canvas).drawImage(
        source as CanvasImageSource,
        0,
        0,
        current.width,
        current.height,
        0,
        0,
        step.width,
        step.height,
      );
      source = canvas;
      current = step;
    }

    // No steps (straight re-encode) → draw once at target size.
    if (steps.length === 0) {
      const canvas = makeCanvas(target.width, target.height);
      ctx2d(canvas).drawImage(source as CanvasImageSource, 0, 0, target.width, target.height);
      source = canvas;
    }

    const out = source as Canvas;
    return out.convertToBlob({ type: FORMAT_MIME[format], quality });
  }

  async extractRgba(
    image: DecodedImage,
    max: number,
  ): Promise<{ data: Uint8Array; width: number; height: number } | null> {
    const scale = Math.min(1, max / Math.max(image.width, image.height));
    const w = Math.max(1, Math.round(image.width * scale));
    const h = Math.max(1, Math.round(image.height * scale));
    const canvas = makeCanvas(w, h);
    const c = ctx2d(canvas);
    c.drawImage(image.handle as CanvasImageSource, 0, 0, w, h);
    const { data } = c.getImageData(0, 0, w, h);
    return { data: new Uint8Array(data.buffer.slice(0)), width: w, height: h };
  }
}

/**
 * Construct the browser adapter, feature-detecting encodable formats. Throws
 * if the required browser APIs are absent — call {@link isBrowserImageSupported}
 * first to decide between client compression and an upload-original fallback.
 */
export async function createBrowserImageAdapter(): Promise<ImageIOAdapter> {
  return new BrowserImageAdapter(await detectEncodable());
}
