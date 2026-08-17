import { describe, expect, it, vi } from 'vitest';
import type { ImageFormat } from '../../src/types';
import type { DecodedImage, ImageIOAdapter } from '../../src/image/ImageIOAdapter';
import { compressImage } from '../../src/image/compressImage';

/**
 * A fully in-memory fake adapter. It records the target/steps/format the
 * orchestrator asks for and returns a Blob whose size is deterministic, so we
 * assert on the CONTROL FLOW (passthrough, sizing, format resolution, stepped
 * plan, abort, resource close) without any real canvas — the whole point of
 * the adapter seam.
 */
function makeFakeAdapter(opts: {
  width: number;
  height: number;
  encodable?: ImageFormat[];
  outBytes?: number;
  rgba?: boolean;
}) {
  const close = vi.fn();
  const decoded: DecodedImage = { handle: {}, width: opts.width, height: opts.height, close };
  const calls = {
    resizeAndEncode: [] as Array<{ target: unknown; steps: unknown; format: ImageFormat; quality: number }>,
    extractRgba: 0,
  };
  const adapter: ImageIOAdapter = {
    encodable: new Set(opts.encodable ?? ['jpeg', 'webp']),
    decode: vi.fn(async () => decoded),
    resizeAndEncode: vi.fn(async (_img, target, steps, format, quality) => {
      calls.resizeAndEncode.push({ target, steps, format, quality });
      return new Blob([new Uint8Array(opts.outBytes ?? 1000)], { type: `image/${format}` });
    }),
    extractRgba: vi.fn(async () => {
      calls.extractRgba++;
      return opts.rgba === false ? null : { data: new Uint8Array(4 * 4 * 4), width: 4, height: 4 };
    }),
  };
  return { adapter, decoded, close, calls };
}

const srcBlob = (bytes: number, type = 'image/jpeg') => new Blob([new Uint8Array(bytes)], { type });

describe('compressImage', () => {
  it('resizes a large image and reports savings', async () => {
    const { adapter, calls } = makeFakeAdapter({ width: 4000, height: 3000, outBytes: 120_000 });
    const res = await compressImage(adapter, srcBlob(3_000_000), { maxEdge: 1600, format: 'webp' });

    expect(res.passedThrough).toBe(false);
    expect(res.width).toBe(1600);
    expect(res.height).toBe(1200);
    expect(res.format).toBe('webp');
    expect(res.bytes).toBe(120_000);
    expect(res.sourceBytes).toBe(3_000_000);
    // A 4000→1600 downscale is >2x, so the plan must be stepped (non-empty).
    expect((calls.resizeAndEncode[0]?.steps as unknown[]).length).toBeGreaterThan(0);
  });

  it('passes through an already-small image under the byte threshold', async () => {
    const { adapter } = makeFakeAdapter({ width: 400, height: 300 });
    const original = srcBlob(50_000, 'image/png');
    const res = await compressImage(adapter, original, { maxEdge: 1600, passthroughUnder: 200_000 });

    expect(res.passedThrough).toBe(true);
    expect(res.blob).toBe(original); // untouched — same reference
    expect(res.format).toBe('png');
    expect(adapter.resizeAndEncode).not.toHaveBeenCalled();
  });

  it('re-encodes (no passthrough) when bytes exceed the threshold even if dimensions fit', async () => {
    const { adapter } = makeFakeAdapter({ width: 400, height: 300 });
    const res = await compressImage(adapter, srcBlob(500_000), { maxEdge: 1600, passthroughUnder: 200_000 });
    expect(res.passedThrough).toBe(false);
    expect(adapter.resizeAndEncode).toHaveBeenCalledOnce();
  });

  it('resolves format against the adapter capabilities (avif→webp fallback)', async () => {
    const { adapter, calls } = makeFakeAdapter({ width: 2000, height: 2000, encodable: ['jpeg', 'webp'] });
    const res = await compressImage(adapter, srcBlob(1_000_000), { format: ['avif', 'webp', 'jpeg'], maxEdge: 1000 });
    expect(res.format).toBe('webp');
    expect(calls.resizeAndEncode[0]?.format).toBe('webp');
  });

  it('clamps quality into [0,1]', async () => {
    const { adapter, calls } = makeFakeAdapter({ width: 1000, height: 1000 });
    await compressImage(adapter, srcBlob(100_000), { quality: 5, maxEdge: 500 });
    expect(calls.resizeAndEncode[0]?.quality).toBe(1);
  });

  it('always releases the decoded image (finally)', async () => {
    const { adapter, close } = makeFakeAdapter({ width: 1000, height: 1000 });
    await compressImage(adapter, srcBlob(100_000), { maxEdge: 500 });
    expect(close).toHaveBeenCalledOnce();
  });

  it('releases the decoded image even when encoding throws', async () => {
    const { adapter, close } = makeFakeAdapter({ width: 1000, height: 1000 });
    (adapter.resizeAndEncode as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('encode boom'));
    await expect(compressImage(adapter, srcBlob(100_000), { maxEdge: 500 })).rejects.toThrow('encode boom');
    expect(close).toHaveBeenCalledOnce();
  });

  it('honors a pre-aborted signal before any work', async () => {
    const { adapter } = makeFakeAdapter({ width: 1000, height: 1000 });
    const controller = new AbortController();
    controller.abort();
    await expect(compressImage(adapter, srcBlob(100_000), { signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(adapter.decode).not.toHaveBeenCalled();
  });

  it('emits a thumbhash when requested and the peer resolves (best-effort otherwise)', async () => {
    const { adapter } = makeFakeAdapter({ width: 2000, height: 2000, rgba: false });
    // rgba:false → extractRgba returns null → thumbhash silently absent, no throw.
    const res = await compressImage(adapter, srcBlob(1_000_000), { maxEdge: 1000, thumbhash: true });
    expect(res.thumbhash).toBeUndefined();
  });
});

describe('compressImage — passthrough metadata stripping', () => {
  /** Minimal JPEG: SOI + APP1(EXIF) + SOS + entropy + EOI. */
  const jpegWithExif = () =>
    new Uint8Array([
      0xff, 0xd8, // SOI
      0xff, 0xe1, 0x00, 0x0a, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00, 0x11, 0x22, // APP1 "Exif\0\0" + gps-ish
      0xff, 0xda, 0x00, 0x04, 0x01, 0x02, // SOS
      0xaa, 0xbb, // entropy
      0xff, 0xd9, // EOI
    ]);

  it('strips EXIF from a passed-through JPEG by default (no location leak)', async () => {
    const { adapter } = makeFakeAdapter({ width: 100, height: 100 });
    const original = new Blob([jpegWithExif() as unknown as BlobPart], { type: 'image/jpeg' });
    const res = await compressImage(adapter, original, { maxEdge: 1600, passthroughUnder: 200_000 });

    expect(res.passedThrough).toBe(true);
    expect(res.blob).not.toBe(original); // rewritten without metadata
    expect(res.blob.type).toBe('image/jpeg');
    const bytes = new Uint8Array(await res.blob.arrayBuffer());
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    expect(hex).not.toContain('457869660000'); // "Exif\0\0" gone
    expect(hex).toContain('aabb'); // pixel data intact
    expect(res.bytes).toBe(res.blob.size);
  });

  it('stripMetadata: false passes the original through untouched (same reference)', async () => {
    const { adapter } = makeFakeAdapter({ width: 100, height: 100 });
    const original = new Blob([jpegWithExif() as unknown as BlobPart], { type: 'image/jpeg' });
    const res = await compressImage(adapter, original, {
      maxEdge: 1600,
      passthroughUnder: 200_000,
      stripMetadata: false,
    });
    expect(res.passedThrough).toBe(true);
    expect(res.blob).toBe(original);
  });

  it('metadata-free passthrough keeps the same reference (no needless copy)', async () => {
    const { adapter } = makeFakeAdapter({ width: 100, height: 100 });
    const clean = new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xd9]) as unknown as BlobPart], { type: 'image/jpeg' });
    const res = await compressImage(adapter, clean, { maxEdge: 1600, passthroughUnder: 200_000 });
    expect(res.blob).toBe(clean);
  });
});

describe('compressImage — dominantColor', () => {
  it('computes dominantColor from the shared RGBA sample when requested', async () => {
    const { adapter } = makeFakeAdapter({ width: 2000, height: 2000 });
    // Fake adapter returns a 4x4 RGBA buffer of zeros with... override extractRgba for a known color:
    (adapter.extractRgba as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: new Uint8Array([200, 100, 50, 255, 200, 100, 50, 255]),
      width: 2,
      height: 1,
    });
    const res = await compressImage(adapter, srcBlob(1_000_000), { maxEdge: 1000, dominantColor: true });
    expect(res.dominantColor).toBe('#c86432');
  });

  it('one RGBA extraction serves both thumbhash and dominantColor', async () => {
    const { adapter } = makeFakeAdapter({ width: 2000, height: 2000 });
    await compressImage(adapter, srcBlob(1_000_000), { maxEdge: 1000, thumbhash: true, dominantColor: true });
    expect(adapter.extractRgba).toHaveBeenCalledTimes(1);
  });

  it('neither requested → no extraction at all', async () => {
    const { adapter } = makeFakeAdapter({ width: 2000, height: 2000 });
    const res = await compressImage(adapter, srcBlob(1_000_000), { maxEdge: 1000 });
    expect(adapter.extractRgba).not.toHaveBeenCalled();
    expect(res.dominantColor).toBeUndefined();
  });
});

/**
 * Passthrough must not claim a format it cannot label, nor a sanitisation it
 * cannot perform.
 *
 * `mimeToFormat` fell back to `'jpeg'` for anything unmapped, so a passed-through
 * HEIC reported `format: 'jpeg'` — and a caller naming the stored file from that
 * wrote HEIC bytes to `.jpg`. Meanwhile the sanitizer returns HEIC/TIFF/BMP
 * UNCHANGED, so `stripMetadata: true` was accepted and silently did nothing:
 * the fast path became the one that leaks the user's location.
 */
describe('compressImage — passthrough eligibility', () => {
  const heic = (bytes: number) => new Blob([new Uint8Array(bytes)], { type: 'image/heic' });

  it('does NOT pass through a format it cannot sanitize — it re-encodes instead', async () => {
    const { adapter, calls } = makeFakeAdapter({ width: 300, height: 200, outBytes: 500 });
    const res = await compressImage(adapter, heic(1000), {
      maxEdge: 4000, // within size, so only eligibility can stop passthrough
      passthroughUnder: 100_000,
      stripMetadata: true,
    });

    expect(res.passedThrough).toBe(false);
    expect(calls.resizeAndEncode).toHaveLength(1);
    // And the reported format is one the encoder actually produced.
    expect(['jpeg', 'webp']).toContain(res.format);
  });

  it('still passes through a JPEG, which it CAN both label and sanitize', async () => {
    const { adapter } = makeFakeAdapter({ width: 300, height: 200 });
    const res = await compressImage(adapter, srcBlob(1000, 'image/jpeg'), {
      maxEdge: 4000,
      passthroughUnder: 100_000,
      stripMetadata: true,
    });

    expect(res.passedThrough).toBe(true);
    expect(res.format).toBe('jpeg');
  });

  it('passes an exotic format through only when sanitisation was NOT requested', async () => {
    const { adapter } = makeFakeAdapter({ width: 300, height: 200 });
    const res = await compressImage(adapter, heic(1000), {
      maxEdge: 4000,
      passthroughUnder: 100_000,
      stripMetadata: false,
    });
    // Still refused: the format cannot be labelled truthfully either.
    expect(res.passedThrough).toBe(false);
  });
});
