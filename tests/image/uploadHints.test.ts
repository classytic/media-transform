import { describe, expect, it } from 'vitest';
import { averageColorHex } from '../../src/algorithms/color';
import { toUploadHints, storedFilename } from '../../src/image/uploadHints';
import type { CompressImageResult } from '../../src/types';

const base = (): CompressImageResult => ({
  blob: new Blob([new Uint8Array(10)], { type: 'image/webp' }),
  format: 'webp',
  width: 1600,
  height: 1200,
  bytes: 10,
  sourceBytes: 100,
  passedThrough: false,
});

describe('averageColorHex', () => {
  it('computes the mean of solid-color pixels', () => {
    // Two fully-opaque pixels: red + blue → purple-ish mean
    const rgba = new Uint8Array([255, 0, 0, 255, 0, 0, 255, 255]);
    expect(averageColorHex(rgba)).toBe('#800080');
  });

  it('alpha-weights: transparent pixels do not skew the result', () => {
    // One opaque white + one fully transparent black → white
    const rgba = new Uint8Array([255, 255, 255, 255, 0, 0, 0, 0]);
    expect(averageColorHex(rgba)).toBe('#ffffff');
  });

  it('empty / fully transparent input → #000000', () => {
    expect(averageColorHex(new Uint8Array(0))).toBe('#000000');
    expect(averageColorHex(new Uint8Array([10, 20, 30, 0]))).toBe('#000000');
  });

  it('always emits media-kit-valid #rrggbb (lowercase, 6 hex digits)', () => {
    const rgba = new Uint8Array([1, 2, 3, 255]);
    expect(averageColorHex(rgba)).toMatch(/^#[0-9a-f]{6}$/);
  });
});

describe('toUploadHints', () => {
  it('maps dimensions and omits absent extras', () => {
    expect(toUploadHints(base())).toEqual({ width: 1600, height: 1200 });
  });

  it('converts thumbhash bytes to base64 within media-kit zod bounds (≤128 chars)', () => {
    // Real thumbhashes are ~21-25 bytes; test with the realistic upper end.
    const result = { ...base(), thumbhash: new Uint8Array(25).map((_, i) => i * 9) };
    const hints = toUploadHints(result);
    expect(hints.thumbhash).toBe(Buffer.from(result.thumbhash!).toString('base64'));
    expect(hints.thumbhash!.length).toBeLessThanOrEqual(128);
  });

  it('passes dominantColor through in media-kit hex shape', () => {
    const hints = toUploadHints({ ...base(), dominantColor: '#a1b2c3' });
    expect(hints.dominantColor).toBe('#a1b2c3');
    expect(hints.dominantColor).toMatch(/^#[0-9a-fA-F]{6}$/); // media-kit's zod regex
  });
});

describe('storedFilename', () => {
  /**
   * A picked `photo.jpg` re-encoded to WebP is WebP bytes. Stored as `.jpg` the
   * name disagrees with the content — and the storage key is generated FROM the
   * filename, so the object is named `.jpg` while holding WebP. Nothing breaks
   * until something trusts the suffix: a CDN, an export, an operator.
   */
  it('rewrites the extension to the ENCODED format', () => {
    expect(storedFilename('photo.jpg', 'webp')).toBe('photo.webp');
    expect(storedFilename('shot.HEIC', 'avif')).toBe('shot.avif');
    expect(storedFilename('a.png', 'jpeg')).toBe('a.jpg');
  });

  it('keeps the stem intact, including dots inside it', () => {
    expect(storedFilename('my.photo.v2.jpg', 'webp')).toBe('my.photo.v2.webp');
  });

  it('handles a name with no extension', () => {
    expect(storedFilename('photo', 'webp')).toBe('photo.webp');
  });

  /** Inventing an extension would be worse than keeping the user's. */
  it('returns the name UNCHANGED for an unknown format', () => {
    expect(storedFilename('photo.jpg', 'jxl')).toBe('photo.jpg');
  });
});
