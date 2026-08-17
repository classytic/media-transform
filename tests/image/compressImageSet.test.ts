import { describe, expect, it, vi } from 'vitest';
import type { ImageFormat } from '../../src/types';
import type { DecodedImage, ImageIOAdapter } from '../../src/image/ImageIOAdapter';
import { compressImageSet } from '../../src/image/compressImageSet';

/**
 * Same in-memory fake as `compressImage.test.ts` — the adapter seam is what
 * lets the orchestrator be tested with no canvas at all. Encoded blob size is
 * derived from the target so a derivative is distinguishable from the primary.
 */
function makeFakeAdapter(opts: {
  width: number;
  height: number;
  encodable?: ImageFormat[];
  failOn?: (target: { width: number; height: number }) => boolean;
}) {
  const close = vi.fn();
  const decoded: DecodedImage = { handle: {}, width: opts.width, height: opts.height, close };
  const decode = vi.fn(async () => decoded);
  const adapter: ImageIOAdapter = {
    encodable: new Set(opts.encodable ?? ['jpeg', 'webp']),
    decode,
    resizeAndEncode: vi.fn(async (_img, target, _steps, format) => {
      const t = target as { width: number; height: number };
      if (opts.failOn?.(t)) throw new Error(`encoder blew up at ${t.width}`);
      return new Blob([new Uint8Array(t.width * 10)], { type: `image/${format}` });
    }),
    extractRgba: vi.fn(async () => ({ data: new Uint8Array(64), width: 4, height: 4 })),
  };
  return { adapter, decode, close };
}

const srcBlob = (bytes: number, type = 'image/jpeg') => new Blob([new Uint8Array(bytes)], { type });

const SIZES = [
  { name: 'thumbnail', maxEdge: 200 },
  { name: 'medium', maxEdge: 800 },
];

describe('compressImageSet', () => {
  /**
   * THE POINT OF THE WHOLE MODULE. Three outputs from one decode; calling
   * `compressImage` per size would decode three times, on the user's phone.
   */
  it('decodes ONCE for the primary and every derivative', async () => {
    const { adapter, decode } = makeFakeAdapter({ width: 4000, height: 3000 });

    const res = await compressImageSet(adapter, srcBlob(3_000_000), {
      maxEdge: 2560,
      derivatives: SIZES,
    });

    expect(decode).toHaveBeenCalledTimes(1);
    expect(res.derivatives).toHaveLength(2);
    expect(res.width).toBe(2560);
  });

  it('produces each derivative at its own bound, aspect preserved', async () => {
    const { adapter } = makeFakeAdapter({ width: 4000, height: 3000 });

    const res = await compressImageSet(adapter, srcBlob(3_000_000), {
      maxEdge: 2560,
      derivatives: SIZES,
    });

    const thumb = res.derivatives.find((d) => d.name === 'thumbnail');
    const medium = res.derivatives.find((d) => d.name === 'medium');
    expect(thumb).toMatchObject({ width: 200, height: 150 });
    expect(medium).toMatchObject({ width: 800, height: 600 });
  });

  it('releases the decoded bitmap exactly once', async () => {
    const { adapter, close } = makeFakeAdapter({ width: 4000, height: 3000 });
    await compressImageSet(adapter, srcBlob(3_000_000), { maxEdge: 2560, derivatives: SIZES });
    expect(close).toHaveBeenCalledTimes(1);
  });

  /**
   * Never upscale. A 200px "thumbnail" of a 150px source is a bigger file
   * carrying no more information — and nothing would have complained.
   */
  it('SKIPS a derivative larger than the source instead of upscaling', async () => {
    const { adapter } = makeFakeAdapter({ width: 150, height: 100 });

    const res = await compressImageSet(adapter, srcBlob(9_000), {
      maxEdge: 2560,
      derivatives: SIZES,
    });

    expect(res.derivatives).toHaveLength(0);
    expect(res.skipped.map((s) => s.reason)).toEqual(['source-smaller', 'source-smaller']);
    expect(res.skipped[0]?.name).toBe('thumbnail');
  });

  it('SKIPS a derivative whose pixels equal the primary', async () => {
    const { adapter } = makeFakeAdapter({ width: 4000, height: 3000 });

    // Primary bound and derivative bound are the same ⇒ one image, two names.
    const res = await compressImageSet(adapter, srcBlob(3_000_000), {
      maxEdge: 800,
      derivatives: [{ name: 'medium', maxEdge: 800 }],
    });

    expect(res.derivatives).toHaveLength(0);
    expect(res.skipped[0]).toMatchObject({ name: 'medium', reason: 'redundant-with-primary' });
  });

  /**
   * The primary is the asset. Losing the photo the user actually took because a
   * 200px preview failed to encode is a strictly worse outcome than shipping
   * without the preview.
   */
  it('a failing derivative does NOT fail the upload — it is reported', async () => {
    const { adapter } = makeFakeAdapter({
      width: 4000,
      height: 3000,
      failOn: (t) => t.width === 200,
    });

    const res = await compressImageSet(adapter, srcBlob(3_000_000), {
      maxEdge: 2560,
      derivatives: SIZES,
    });

    expect(res.blob.size).toBeGreaterThan(0);
    expect(res.derivatives.map((d) => d.name)).toEqual(['medium']);
    expect(res.skipped[0]).toMatchObject({ name: 'thumbnail', reason: 'encode-failed' });
    expect(res.skipped[0]?.detail).toContain('encoder blew up');
  });

  it('derivatives are produced even when the PRIMARY passed through untouched', async () => {
    const { adapter } = makeFakeAdapter({ width: 900, height: 600 });

    const res = await compressImageSet(adapter, srcBlob(50_000), {
      maxEdge: 2560,
      passthroughUnder: 200_000,
      derivatives: SIZES,
    });

    expect(res.passedThrough).toBe(true);
    // 200 and 800 are both under the 900px source, so both are real work.
    expect(res.derivatives.map((d) => d.name)).toEqual(['thumbnail', 'medium']);
  });

  it('a derivative may override format and quality independently of the primary', async () => {
    const { adapter } = makeFakeAdapter({ width: 4000, height: 3000, encodable: ['jpeg', 'webp'] });

    const res = await compressImageSet(adapter, srcBlob(3_000_000), {
      maxEdge: 2560,
      format: 'webp',
      derivatives: [{ name: 'thumbnail', maxEdge: 200, format: 'jpeg', quality: 0.5 }],
    });

    expect(res.format).toBe('webp');
    expect(res.derivatives[0]?.format).toBe('jpeg');
  });

  it('no derivatives requested ⇒ behaves exactly like compressImage', async () => {
    const { adapter } = makeFakeAdapter({ width: 4000, height: 3000 });
    const res = await compressImageSet(adapter, srcBlob(3_000_000), { maxEdge: 2560 });
    expect(res.derivatives).toEqual([]);
    expect(res.skipped).toEqual([]);
  });

  /** An abort is the caller cancelling — it must NOT be swallowed as a failed derivative. */
  it('propagates an abort rather than recording it as encode-failed', async () => {
    const controller = new AbortController();
    const { adapter } = makeFakeAdapter({ width: 4000, height: 3000 });
    controller.abort();

    await expect(
      compressImageSet(adapter, srcBlob(3_000_000), {
        maxEdge: 2560,
        derivatives: SIZES,
        signal: controller.signal,
      }),
    ).rejects.toThrow(/abort/i);
  });
});
